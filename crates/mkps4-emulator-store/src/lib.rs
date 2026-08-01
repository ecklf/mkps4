use std::collections::HashSet;
use std::env;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use tempfile::Builder;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use zip::ZipArchive;

pub const ARCHIVE_URL: &str =
    "https://github.com/kingkangyu/ps2-classics-emus/archive/refs/heads/main.zip";

const REQUIRED_FILES: &[&str] = &[
    "config-emu-ps4.txt",
    "eboot.bin",
    "ps2-emu-compiler.self",
    "sce_module/libc.prx",
    "sce_module/libSceFios2.prx",
];
const EXPECTED_DOWNLOAD_SIZE: u64 = 335 * 1024 * 1024;
const CONFIG_FILE: &str = "config.json";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallConfig {
    pub version: String,
    pub last_updated: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InstallPhase {
    Preparing,
    Downloading,
    Combining,
    Installing,
    Complete,
}

impl InstallPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Downloading => "downloading",
            Self::Combining => "combining",
            Self::Installing => "installing",
            Self::Complete => "complete",
        }
    }
}

#[derive(Clone, Debug)]
pub struct InstallProgress {
    pub phase: InstallPhase,
    pub completed: u64,
    pub total: Option<u64>,
    pub overall_percent: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Emulator {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct StoreStatus {
    pub home: PathBuf,
    pub emulators_dir: PathBuf,
    pub emulators: Vec<Emulator>,
    pub config: Option<InstallConfig>,
}

impl StoreStatus {
    pub fn is_installed(&self) -> bool {
        !self.emulators.is_empty() && self.config.is_some()
    }
}

#[derive(Clone, Debug)]
pub struct EmulatorStore {
    home: PathBuf,
}

impl EmulatorStore {
    pub fn from_environment() -> Result<Self> {
        if let Some(home) = env::var_os("MKPS4_HOME") {
            return Ok(Self::new(home));
        }

        #[cfg(target_os = "windows")]
        let home = env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("mkps4"));

        #[cfg(not(target_os = "windows"))]
        let home = env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".mkps4"));

        let home = home.context("could not determine the mkps4 home directory")?;
        Ok(Self::new(home))
    }

    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    pub fn emulators_dir(&self) -> PathBuf {
        self.home.join("emulators")
    }

    pub fn status(&self) -> Result<StoreStatus> {
        let emulators_dir = self.emulators_dir();
        let emulators = discover_emulators(&emulators_dir)?;
        Ok(StoreStatus {
            home: self.home.clone(),
            emulators_dir,
            emulators,
            config: self.read_install_config()?,
        })
    }

    fn read_install_config(&self) -> Result<Option<InstallConfig>> {
        let path = self.home.join(CONFIG_FILE);
        if !path.exists() {
            return Ok(None);
        }
        ensure!(path.is_file(), "{} is not a file", path.display());
        let contents =
            fs::read(&path).with_context(|| format!("failed to read {}", path.display()))?;
        serde_json::from_slice(&contents)
            .map(Some)
            .with_context(|| format!("failed to parse {}", path.display()))
    }

    fn write_install_config(&self) -> Result<()> {
        let path = self.home.join(CONFIG_FILE);
        let config = InstallConfig {
            version: env!("CARGO_PKG_VERSION").to_string(),
            last_updated: OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .context("failed to format emulator installation timestamp")?,
        };
        let mut temporary = Builder::new()
            .prefix(".config-")
            .tempfile_in(&self.home)
            .with_context(|| format!("failed to create {}", path.display()))?;
        serde_json::to_writer_pretty(temporary.as_file_mut(), &config)
            .with_context(|| format!("failed to write {}", path.display()))?;
        temporary.as_file_mut().write_all(b"\n")?;
        temporary.as_file_mut().sync_all()?;
        temporary
            .persist(&path)
            .map_err(|error| error.error)
            .with_context(|| format!("failed to save {}", path.display()))?;
        Ok(())
    }

    fn prepare_install_destination(&self, current: &StoreStatus) -> Result<()> {
        let destination = self.emulators_dir();
        if destination.is_dir() {
            if current.emulators.is_empty() {
                ensure!(
                    fs::read_dir(&destination)?.next().is_none(),
                    "{} contains files but no valid emulator donors",
                    destination.display()
                );
                fs::remove_dir(&destination)?;
            } else {
                fs::remove_dir_all(&destination).with_context(|| {
                    format!(
                        "failed to remove incomplete installation at {}",
                        destination.display()
                    )
                })?;
            }
        } else {
            ensure!(
                !destination.exists(),
                "{} exists and is not a directory",
                destination.display()
            );
        }
        Ok(())
    }

    fn validate_install_destination(&self, current: &StoreStatus) -> Result<()> {
        let destination = self.emulators_dir();
        if destination.is_dir() && current.emulators.is_empty() {
            ensure!(
                fs::read_dir(&destination)?.next().is_none(),
                "{} contains files but no valid emulator donors",
                destination.display()
            );
        } else if !destination.is_dir() {
            ensure!(
                !destination.exists(),
                "{} exists and is not a directory",
                destination.display()
            );
        }
        Ok(())
    }

    pub fn install<F>(&self, report: F) -> Result<StoreStatus>
    where
        F: Fn(InstallProgress),
    {
        self.install_inner(false, report)
    }

    pub fn update<F>(&self, report: F) -> Result<StoreStatus>
    where
        F: Fn(InstallProgress),
    {
        self.install_inner(true, report)
    }

    fn install_inner<F>(&self, replace: bool, report: F) -> Result<StoreStatus>
    where
        F: Fn(InstallProgress),
    {
        let current = self.status()?;
        if current.is_installed() && !replace {
            report(InstallProgress {
                phase: InstallPhase::Complete,
                completed: 1,
                total: Some(1),
                overall_percent: 100,
            });
            return Ok(current);
        }

        fs::create_dir_all(&self.home)
            .with_context(|| format!("failed to create {}", self.home.display()))?;
        let destination = self.emulators_dir();
        self.validate_install_destination(&current)?;

        report(InstallProgress {
            phase: InstallPhase::Preparing,
            completed: 0,
            total: None,
            overall_percent: 0,
        });

        let workspace = Builder::new()
            .prefix(".emulator-install-")
            .tempdir_in(&self.home)
            .context("failed to create emulator installation workspace")?;
        let source_archive = workspace.path().join("source.zip");
        let combined_archive = workspace.path().join("emulators.zip");
        let staged = workspace.path().join("emulators");

        download_archive(&source_archive, &report)?;
        combine_archive(&source_archive, &combined_archive, &report)?;
        fs::remove_file(&source_archive)?;
        extract_emulators(&combined_archive, &staged, &report)?;
        fs::remove_file(&combined_archive)?;

        let installed = discover_emulators(&staged)?;
        ensure!(
            !installed.is_empty(),
            "downloaded archive contains no valid emulator donors"
        );
        let config_path = self.home.join(CONFIG_FILE);
        if config_path.is_file() {
            fs::remove_file(&config_path)
                .with_context(|| format!("failed to remove {}", config_path.display()))?;
        }
        self.prepare_install_destination(&current)?;
        fs::rename(&staged, &destination).with_context(|| {
            format!(
                "failed to install emulator donors at {}",
                destination.display()
            )
        })?;
        self.write_install_config()?;

        report(InstallProgress {
            phase: InstallPhase::Complete,
            completed: 1,
            total: Some(1),
            overall_percent: 100,
        });
        self.status()
    }
}

fn download_archive<F>(destination: &Path, report: &F) -> Result<()>
where
    F: Fn(InstallProgress),
{
    let client = reqwest::blocking::Client::builder()
        .user_agent("mkps4/0.1")
        .build()?;
    let mut response = client
        .get(ARCHIVE_URL)
        .send()
        .context("failed to download emulator archive")?
        .error_for_status()
        .context("emulator archive download failed")?;
    let total = response.content_length();
    let mut output = File::create(destination)?;
    let mut buffer = vec![0; 256 * 1024];
    let mut completed = 0u64;

    loop {
        let read = response.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        completed += read as u64;
        let mut update = progress(
            InstallPhase::Downloading,
            completed,
            total.or(Some(EXPECTED_DOWNLOAD_SIZE)),
            0,
            40,
        );
        update.total = total;
        report(update);
    }
    output.flush()?;
    ensure!(completed > 0, "emulator archive download was empty");
    report(progress(
        InstallPhase::Downloading,
        completed,
        Some(completed),
        0,
        40,
    ));
    Ok(())
}

fn combine_archive<F>(source: &Path, destination: &Path, report: &F) -> Result<()>
where
    F: Fn(InstallProgress),
{
    let mut archive = ZipArchive::new(File::open(source)?)?;
    let mut pieces = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let name = entry.name().to_string();
        if let Some(piece) = split_piece_number(&name) {
            pieces.push((piece, name, entry.size()));
        }
    }
    pieces.sort_by_key(|(piece, _, _)| *piece);
    ensure!(
        !pieces.is_empty(),
        "downloaded archive has no emulator data"
    );
    for (index, (piece, _, _)) in pieces.iter().enumerate() {
        ensure!(
            *piece == index + 1,
            "downloaded archive is missing emulator data part {}",
            index + 1
        );
    }

    let total = pieces.iter().map(|(_, _, size)| size).sum::<u64>();
    let mut output = File::create(destination)?;
    let mut buffer = vec![0; 256 * 1024];
    let mut completed = 0u64;
    for (_, name, _) in pieces {
        let mut entry = archive.by_name(&name)?;
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            output.write_all(&buffer[..read])?;
            completed += read as u64;
            report(progress(
                InstallPhase::Combining,
                completed,
                Some(total),
                40,
                15,
            ));
        }
    }
    output.flush()?;
    Ok(())
}

fn split_piece_number(name: &str) -> Option<usize> {
    if !name.contains("/emus/emus.zip.") {
        return None;
    }
    name.rsplit_once('.')?.1.parse().ok()
}

fn extract_emulators<F>(source: &Path, destination: &Path, report: &F) -> Result<()>
where
    F: Fn(InstallProgress),
{
    fs::create_dir(destination)?;
    let mut archive = ZipArchive::new(File::open(source)?)?;
    ensure!(
        archive.len() <= 10_000,
        "emulator archive has too many entries"
    );
    let total = (0..archive.len()).try_fold(0u64, |total, index| {
        let entry = archive.by_index(index)?;
        Ok::<_, zip::result::ZipError>(total + entry.size())
    })?;
    ensure!(
        total <= 4 * 1024 * 1024 * 1024,
        "emulator archive is too large"
    );

    let mut completed = 0u64;
    let mut paths = HashSet::new();
    let mut buffer = vec![0; 256 * 1024];
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            bail!("emulator archive contains a symbolic link");
        }
        let enclosed = entry
            .enclosed_name()
            .context("emulator archive contains an unsafe path")?
            .to_path_buf();
        let relative = enclosed
            .strip_prefix("emus")
            .context("emulator archive has an unexpected layout")?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        ensure!(
            paths.insert(relative.to_path_buf()),
            "emulator archive contains duplicate path {}",
            relative.display()
        );

        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut file = File::create(&output)?;
        loop {
            let read = entry.read(&mut buffer)?;
            if read == 0 {
                break;
            }
            file.write_all(&buffer[..read])?;
            completed += read as u64;
            report(progress(
                InstallPhase::Installing,
                completed,
                Some(total),
                55,
                44,
            ));
        }
    }
    Ok(())
}

fn discover_emulators(directory: &Path) -> Result<Vec<Emulator>> {
    if !directory.is_dir() {
        return Ok(Vec::new());
    }

    let mut emulators = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let path = entry.path();
        if !entry.file_type()?.is_dir()
            || !REQUIRED_FILES
                .iter()
                .all(|required| path.join(required).is_file())
        {
            continue;
        }
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("emulator folder name is not valid UTF-8"))?;
        emulators.push(Emulator { name, path });
    }
    emulators.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(emulators)
}

fn progress(
    phase: InstallPhase,
    completed: u64,
    total: Option<u64>,
    base: u8,
    weight: u8,
) -> InstallProgress {
    let ratio = total
        .filter(|total| *total > 0)
        .map(|total| completed.min(total) as f64 / total as f64)
        .unwrap_or(0.0);
    InstallProgress {
        phase,
        completed,
        total,
        overall_percent: base + (ratio * f64::from(weight)).round() as u8,
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    #[test]
    fn discovers_only_complete_emulators() {
        let temporary = tempfile::tempdir().unwrap();
        let store = EmulatorStore::new(temporary.path());
        let complete = store.emulators_dir().join("Jak v2");
        let incomplete = store.emulators_dir().join("Incomplete");
        fs::create_dir_all(complete.join("sce_module")).unwrap();
        fs::create_dir_all(&incomplete).unwrap();
        for required in REQUIRED_FILES {
            fs::write(complete.join(required), b"fixture").unwrap();
        }

        let status = store.status().unwrap();
        assert!(!status.is_installed());
        assert_eq!(status.emulators.len(), 1);
        assert_eq!(status.emulators[0].name, "Jak v2");

        store.write_install_config().unwrap();
        let status = store.status().unwrap();
        assert!(status.is_installed());
        let config_path = temporary.path().join(CONFIG_FILE);
        let config: serde_json::Value =
            serde_json::from_slice(&fs::read(&config_path).unwrap()).unwrap();
        assert_eq!(config["version"], env!("CARGO_PKG_VERSION"));
        assert!(config["lastUpdated"].as_str().unwrap().contains('T'));

        assert_eq!(status.config.unwrap().version, env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn recognizes_split_archive_parts() {
        assert_eq!(
            split_piece_number("ps2-classics-emus-main/emus/emus.zip.014"),
            Some(14)
        );
        assert_eq!(split_piece_number("README.md"), None);
    }

    #[test]
    fn removes_unmarked_installation_before_retry() {
        let temporary = tempfile::tempdir().unwrap();
        let store = EmulatorStore::new(temporary.path());
        let emulator = store.emulators_dir().join("Jak v2");
        fs::create_dir_all(emulator.join("sce_module")).unwrap();
        for required in REQUIRED_FILES {
            fs::write(emulator.join(required), b"fixture").unwrap();
        }

        let status = store.status().unwrap();
        assert!(!status.is_installed());
        store.prepare_install_destination(&status).unwrap();
        assert!(!store.emulators_dir().exists());
    }

    #[test]
    fn combines_and_extracts_split_archive() {
        let temporary = tempfile::tempdir().unwrap();
        let mut inner = ZipWriter::new(Cursor::new(Vec::new()));
        for required in REQUIRED_FILES {
            inner
                .start_file(
                    format!("emus/Jak v2/{required}"),
                    SimpleFileOptions::default(),
                )
                .unwrap();
            inner.write_all(b"fixture").unwrap();
        }
        let inner = inner.finish().unwrap().into_inner();
        let split = inner.len() / 2;

        let source = temporary.path().join("source.zip");
        let mut outer = ZipWriter::new(File::create(&source).unwrap());
        for (part, bytes) in [&inner[..split], &inner[split..]].into_iter().enumerate() {
            outer
                .start_file(
                    format!("repository/emus/emus.zip.{:03}", part + 1),
                    SimpleFileOptions::default(),
                )
                .unwrap();
            outer.write_all(bytes).unwrap();
        }
        outer.finish().unwrap();

        let combined = temporary.path().join("combined.zip");
        let installed = temporary.path().join("installed");
        combine_archive(&source, &combined, &|_| {}).unwrap();
        extract_emulators(&combined, &installed, &|_| {}).unwrap();

        let emulators = discover_emulators(&installed).unwrap();
        assert_eq!(emulators.len(), 1);
        assert_eq!(emulators[0].name, "Jak v2");
    }
}
