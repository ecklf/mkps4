use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use image::imageops::FilterType;
use tempfile::Builder;
use zip::ZipArchive;

use crate::{CompatibilityOptions, backend, config, disc, gp4, sfo};

const REQUIRED_TEMPLATE_FILES: &[&str] = &[
    "config-emu-ps4.txt",
    "eboot.bin",
    "formatted.card",
    "ps2-emu-compiler.self",
    "PS20220WD20050620.crack",
    "sce_module/libc.prx",
    "sce_module/libSceFios2.prx",
];
const SELF_MAGIC: [u8; 4] = [0x4f, 0x15, 0x3d, 0x1d];
const REQUIRED_SELF_FILES: &[&str] = &[
    "eboot.bin",
    "ps2-emu-compiler.self",
    "sce_module/libc.prx",
    "sce_module/libSceFios2.prx",
];

#[derive(Debug)]
pub struct Request {
    pub images: Vec<PathBuf>,
    pub disc_info: Option<disc::Serial>,
    pub template: PathBuf,
    pub title: String,
    pub np_title: String,
    pub content_id: Option<String>,
    pub icon: PathBuf,
    pub background: Option<PathBuf>,
    pub emulator: EmulatorSettings,
    pub remote_play_keymap: u8,
}

#[derive(Debug, Default)]
pub struct EmulatorSettings {
    pub config: Option<PathBuf>,
    pub compatibility: CompatibilityOptions,
    pub memory_card: Option<PathBuf>,
    pub patch_files: Vec<PathBuf>,
    pub lua_files: Vec<PathBuf>,
}

pub struct Prepared {
    pub gp4: PathBuf,
    pub content_id: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BuildPhase {
    Preparing,
    Packaging,
    Validating,
    Complete,
}

impl BuildPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Preparing => "preparing",
            Self::Packaging => "packaging",
            Self::Validating => "validating",
            Self::Complete => "complete",
        }
    }

    pub fn percent(self) -> u8 {
        match self {
            Self::Preparing => 10,
            Self::Packaging => 45,
            Self::Validating => 90,
            Self::Complete => 100,
        }
    }
}

pub fn prepare(request: &Request, output: &Path) -> Result<Prepared> {
    ensure!(
        !output.exists(),
        "output directory {} already exists",
        output.display()
    );
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure!(
        parent.is_dir(),
        "output parent {} does not exist",
        parent.display()
    );
    let workspace = Builder::new()
        .prefix("mkps4-prepare-")
        .tempdir_in(parent)
        .with_context(|| {
            format!(
                "failed to create temporary workspace in {}",
                parent.display()
            )
        })?;
    let prepared = prepare_in(request, workspace.path())?;
    let content_id = prepared.content_id;
    let persisted = workspace.keep();
    fs::rename(&persisted, output)
        .with_context(|| format!("failed to move prepared project to {}", output.display()))?;
    Ok(Prepared {
        gp4: output.join("PS2Classics.gp4"),
        content_id,
    })
}

pub fn build(request: &Request, output: &Path, pkg_tool: Option<&Path>, force: bool) -> Result<()> {
    build_with_progress(request, output, pkg_tool, force, |_| {})
}

pub fn build_with_progress<F>(
    request: &Request,
    output: &Path,
    pkg_tool: Option<&Path>,
    force: bool,
    report: F,
) -> Result<()>
where
    F: Fn(BuildPhase),
{
    let parent = output
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    ensure!(
        parent.is_dir(),
        "output parent {} does not exist",
        parent.display()
    );
    if output.exists() && !force {
        bail!(
            "output {} already exists; pass --force to replace it",
            output.display()
        );
    }

    let workspace = Builder::new()
        .prefix("mkps4-")
        .tempdir_in(parent)
        .with_context(|| {
            format!(
                "failed to create temporary workspace in {}",
                parent.display()
            )
        })?;
    report(BuildPhase::Preparing);
    let prepared = prepare_in(request, workspace.path())?;
    let backend_output = workspace.path().join("pkg-output");
    fs::create_dir(&backend_output)?;
    report(BuildPhase::Packaging);
    let package = backend::build(
        pkg_tool,
        &prepared.gp4,
        &backend_output,
        &prepared.content_id,
        || report(BuildPhase::Validating),
    )?;

    fs::rename(&package, output)
        .with_context(|| format!("failed to move generated package to {}", output.display()))?;
    report(BuildPhase::Complete);
    Ok(())
}

fn prepare_in(request: &Request, root: &Path) -> Result<Prepared> {
    validate_request(request)?;
    let serials = request
        .images
        .iter()
        .map(|image| disc::inspect(image))
        .collect::<Result<Vec<_>>>()?;
    let primary_serial = request.disc_info.as_ref().unwrap_or(&serials[0]);
    validate_disc_info(primary_serial)?;
    let np_title = normalize_np_title(&request.np_title)?;
    let content_id = request
        .content_id
        .clone()
        .unwrap_or_else(|| format!("UP9000-{np_title}_00-{}0000001", primary_serial.title_id));
    validate_content_id(&content_id)?;
    ensure!(
        content_id[7..16] == np_title,
        "content ID NP Title must match --np-title"
    );
    let title = &request.title;
    ensure!(!title.trim().is_empty(), "title cannot be empty");
    ensure!(
        title.len() < 128 && !title.as_bytes().contains(&0),
        "title must be at most 127 UTF-8 bytes and contain no nulls"
    );
    ensure!(
        request.remote_play_keymap <= 7,
        "Remote Play keymap must be between 0 and 7"
    );

    stage_template(&request.template, root)?;
    let payload = root.join("PS2");
    validate_template(&payload)?;

    if let Some(custom_config) = &request.emulator.config {
        copy_file(custom_config, &payload.join("config-emu-ps4.txt"))?;
    }
    let config_path = payload.join("config-emu-ps4.txt");
    let config_input = fs::read_to_string(&config_path)
        .with_context(|| format!("failed to read {}", config_path.display()))?;
    let effective_config =
        config::apply_compatibility(&config_input, request.emulator.compatibility);
    if effective_config != config_input {
        fs::write(&config_path, effective_config)
            .with_context(|| format!("failed to write {}", config_path.display()))?;
    }
    config::update(
        &config_path,
        &primary_serial.emulator_id,
        request.images.len(),
        !request.emulator.patch_files.is_empty(),
        request.emulator.memory_card.is_some(),
    )?;

    stage_discs(&request.images, &payload.join("image"))?;
    stage_patch_files(
        &request.emulator.patch_files,
        &payload.join("patches"),
        &primary_serial.emulator_id,
    )?;
    stage_named_files(
        &request.emulator.lua_files,
        &payload.join("lua_include"),
        Some("lua"),
    )?;
    if let Some(memory_card) = &request.emulator.memory_card {
        stage_memory_card(memory_card, &payload, &primary_serial.emulator_id)?;
    }
    stage_images(request, &payload)?;
    stage_sfo(
        &payload,
        &content_id,
        title,
        &np_title,
        request.remote_play_keymap,
    )?;

    let gp4 = gp4::write(root, &payload, &content_id)?;
    Ok(Prepared { gp4, content_id })
}

fn validate_request(request: &Request) -> Result<()> {
    ensure!(
        !request.images.is_empty() && request.images.len() <= 7,
        "provide between 1 and 7 disc images"
    );
    ensure!(
        request.template.is_file() || request.template.is_dir(),
        "template ZIP or directory does not exist at {}",
        request.template.display()
    );
    ensure!(
        request.icon.is_file(),
        "icon image does not exist at {}",
        request.icon.display()
    );
    validate_image_aspect(&request.icon, 1, 1, "icon")?;
    if let Some(background) = &request.background {
        validate_image_aspect(background, 16, 9, "background")?;
    }
    for image in &request.images {
        ensure!(
            image.is_file(),
            "disc image does not exist at {}",
            image.display()
        );
    }
    for path in request
        .background
        .iter()
        .chain(request.emulator.config.iter())
        .chain(request.emulator.memory_card.iter())
        .chain(request.emulator.patch_files.iter())
        .chain(request.emulator.lua_files.iter())
    {
        ensure!(
            path.is_file(),
            "input file does not exist at {}",
            path.display()
        );
    }
    Ok(())
}

fn validate_image_aspect(
    path: &Path,
    aspect_width: u32,
    aspect_height: u32,
    label: &str,
) -> Result<()> {
    let (width, height) = image::image_dimensions(path)
        .with_context(|| format!("failed to inspect {label} image {}", path.display()))?;
    ensure!(
        u64::from(width) * u64::from(aspect_height) == u64::from(height) * u64::from(aspect_width),
        "{label} image must use a {aspect_width}:{aspect_height} aspect ratio"
    );
    Ok(())
}

fn validate_disc_info(info: &disc::Serial) -> Result<()> {
    let original = info.original.as_bytes();
    ensure!(
        original.len() == 11
            && original[..4].iter().all(u8::is_ascii_uppercase)
            && original[4] == b'_'
            && original[5..8].iter().all(u8::is_ascii_digit)
            && original[8] == b'.'
            && original[9..].iter().all(u8::is_ascii_digit),
        "PS2 serial must use the format SLES_523.25"
    );
    let title_id = info.title_id.as_bytes();
    ensure!(
        title_id.len() == 9
            && title_id[..4].iter().all(u8::is_ascii_uppercase)
            && title_id[4..].iter().all(u8::is_ascii_digit),
        "PS2 title ID must use the format SLES52325"
    );
    let emulator_id = info.emulator_id.as_bytes();
    ensure!(
        emulator_id.len() == 10
            && emulator_id[..4].iter().all(u8::is_ascii_uppercase)
            && emulator_id[4] == b'-'
            && emulator_id[5..].iter().all(u8::is_ascii_digit),
        "emulator ID must use the format SLES-52325"
    );
    Ok(())
}

fn normalize_np_title(value: &str) -> Result<String> {
    let value = value.to_ascii_uppercase();
    let bytes = value.as_bytes();
    ensure!(
        bytes.len() == 9
            && bytes[..4].iter().all(u8::is_ascii_uppercase)
            && bytes[4..].iter().all(u8::is_ascii_digit),
        "NP Title must be four ASCII letters followed by five digits"
    );
    Ok(value)
}

fn validate_content_id(value: &str) -> Result<()> {
    let bytes = value.as_bytes();
    ensure!(
        bytes.len() == 36 && bytes.is_ascii(),
        "content ID must be exactly 36 ASCII characters"
    );
    ensure!(
        bytes[6] == b'-' && bytes[16] == b'_' && bytes[19] == b'-',
        "content ID has invalid separators"
    );
    ensure!(
        bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 6 | 16 | 19)
                || byte.is_ascii_uppercase()
                || byte.is_ascii_digit()),
        "content ID may contain only uppercase ASCII letters, digits, and standard separators"
    );
    Ok(())
}

fn stage_template(template: &Path, root: &Path) -> Result<()> {
    if template.is_dir() {
        let source = if template.join("PS2").is_dir() {
            template.join("PS2")
        } else {
            template.to_path_buf()
        };
        copy_template_directory(&source, &source, &root.join("PS2"))?;
        return Ok(());
    }

    let file = File::open(template)
        .with_context(|| format!("failed to open template {}", template.display()))?;
    let mut archive = ZipArchive::new(file).context("template is not a valid ZIP archive")?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let enclosed = entry
            .enclosed_name()
            .context("template ZIP contains an unsafe path")?;
        if enclosed.parent() == Some(Path::new("PS2/image"))
            && enclosed
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(is_staged_disc)
        {
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            bail!(
                "template ZIP contains an unsupported symbolic link: {}",
                enclosed.display()
            );
        }
        let destination = root.join(enclosed);
        if entry.is_dir() {
            fs::create_dir_all(&destination)?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut output = File::create(&destination)
            .with_context(|| format!("failed to create {}", destination.display()))?;
        io::copy(&mut entry, &mut output)?;
    }
    ensure!(
        root.join("PS2").is_dir(),
        "template ZIP must contain a top-level PS2 directory"
    );
    Ok(())
}

fn copy_template_directory(source_root: &Path, source: &Path, destination: &Path) -> Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)
        .with_context(|| format!("failed to read template directory {}", source.display()))?
    {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let source_path = entry.path();
        let relative = source_path.strip_prefix(source_root).unwrap();
        let destination_path = destination.join(relative);
        if file_type.is_symlink() {
            bail!(
                "template contains unsupported symbolic link {}",
                source_path.display()
            );
        }
        if file_type.is_dir() {
            fs::create_dir_all(&destination_path)?;
            copy_template_directory(source_root, &source_path, destination)?;
        } else if file_type.is_file() {
            if relative.parent() == Some(Path::new("image"))
                && relative
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(is_staged_disc)
            {
                continue;
            }
            if let Some(parent) = destination_path.parent() {
                fs::create_dir_all(parent)?;
            }
            copy_file(&source_path, &destination_path)?;
        }
    }
    Ok(())
}

fn validate_template(payload: &Path) -> Result<()> {
    for relative in REQUIRED_TEMPLATE_FILES {
        let path = payload.join(relative);
        ensure!(
            path.is_file(),
            "template is missing required file {}",
            path.display()
        );
    }
    ensure!(
        payload.join("sce_sys").is_dir(),
        "template is missing PS2/sce_sys"
    );
    for relative in REQUIRED_SELF_FILES {
        let path = payload.join(relative);
        let mut magic = [0u8; 4];
        File::open(&path)
            .with_context(|| format!("failed to open template executable {}", path.display()))?
            .read_exact(&mut magic)?;
        ensure!(
            magic == SELF_MAGIC,
            "template executable {} is not SELF-wrapped; use a payload extracted from a known-working PS2 FPKG",
            path.display()
        );
    }
    Ok(())
}

fn stage_discs(images: &[PathBuf], image_directory: &Path) -> Result<()> {
    fs::create_dir_all(image_directory)?;
    for entry in fs::read_dir(image_directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.file_type()?.is_file() && is_staged_disc(&name) {
            fs::remove_file(entry.path())?;
        }
    }
    for (index, image) in images.iter().enumerate() {
        let destination = image_directory.join(format!("disc{:02}.iso", index + 1));
        disc::convert_to_iso(image, &destination).with_context(|| {
            format!(
                "failed to stage disc {} from {}",
                index + 1,
                image.display()
            )
        })?;
    }
    Ok(())
}

fn is_staged_disc(name: &str) -> bool {
    name.strip_prefix("disc")
        .and_then(|name| name.strip_suffix(".iso"))
        .is_some_and(|number| {
            !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
        })
}

fn stage_named_files(files: &[PathBuf], directory: &Path, extension: Option<&str>) -> Result<()> {
    fs::create_dir_all(directory)?;
    let mut names = HashSet::new();
    for source in files {
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .context("emulator payload filename is not UTF-8")?;
        ensure!(
            name.is_ascii(),
            "emulator payload files must have ASCII filenames"
        );
        ensure!(
            names.insert(name.to_ascii_lowercase()),
            "multiple emulator payload files use the filename {name}"
        );
        if let Some(extension) = extension {
            ensure!(
                source.extension().and_then(|value| value.to_str()) == Some(extension),
                "emulator payload file {} must use the .{extension} extension",
                source.display()
            );
        }
        copy_file(source, &directory.join(name))?;
    }
    Ok(())
}

fn stage_patch_files(files: &[PathBuf], directory: &Path, emulator_id: &str) -> Result<()> {
    fs::create_dir_all(directory)?;
    let mut extensions = HashSet::new();
    for source in files {
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .map(str::to_ascii_lowercase)
            .context("emulator patch filename has no UTF-8 extension")?;
        ensure!(
            matches!(extension.as_str(), "lua" | "conf"),
            "emulator patch {} must use the .lua or .conf extension",
            source.display()
        );
        ensure!(
            extensions.insert(extension.clone()),
            "only one .{extension} emulator patch may be supplied"
        );
        let destination = match extension.as_str() {
            "lua" => format!("{emulator_id}_config.lua"),
            "conf" => format!("{emulator_id}_cli.conf"),
            _ => unreachable!(),
        };
        copy_file(source, &directory.join(destination))?;
    }
    Ok(())
}

fn stage_memory_card(source: &Path, payload: &Path, emulator_id: &str) -> Result<()> {
    const FORMATTED_8_MB_CARD_SIZE: u64 = 8_650_752;
    const RAW_8_MB_CARD_SIZE: u64 = 8_388_608;

    let size = fs::metadata(source)
        .with_context(|| format!("failed to read {}", source.display()))?
        .len();
    ensure!(
        size != RAW_8_MB_CARD_SIZE,
        "memory card {} is a raw 8 MB image without ECC; import a formatted .ps2 or .vm2 image",
        source.display()
    );
    ensure!(
        size == FORMATTED_8_MB_CARD_SIZE,
        "memory card {} must be an 8 MB formatted image ({FORMATTED_8_MB_CARD_SIZE} bytes)",
        source.display()
    );
    let mut superblock = [0u8; 338];
    File::open(source)
        .with_context(|| format!("failed to open {}", source.display()))?
        .read_exact(&mut superblock)?;
    let page_length = u16::from_le_bytes(superblock[40..42].try_into().unwrap());
    let pages_per_cluster = u16::from_le_bytes(superblock[42..44].try_into().unwrap());
    let pages_per_block = u16::from_le_bytes(superblock[44..46].try_into().unwrap());
    let clusters = u32::from_le_bytes(superblock[48..52].try_into().unwrap());
    let allocation_start = u32::from_le_bytes(superblock[52..56].try_into().unwrap());
    let allocation_end = u32::from_le_bytes(superblock[56..60].try_into().unwrap());
    let root_directory = u32::from_le_bytes(superblock[60..64].try_into().unwrap());
    ensure!(
        &superblock[..27] == b"Sony PS2 Memory Card Format"
            && superblock[28..40].starts_with(b"1.")
            && page_length == 512
            && pages_per_cluster == 2
            && pages_per_block == 16
            && clusters == 8192
            && allocation_start < allocation_end
            && allocation_end <= clusters
            && root_directory == 0
            && superblock[336] == 2,
        "memory card {} has an invalid PS2 memory-card superblock",
        source.display()
    );

    let feature_directory = payload.join("feature_data");
    let card_directory = feature_directory.join(emulator_id);
    fs::create_dir_all(&card_directory)?;
    copy_file(source, &card_directory.join("custom.card"))?;

    let script_path = feature_directory.join(format!("{emulator_id}_features.lua"));
    let script_exists = script_path.is_file();
    let mut script = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&script_path)
        .with_context(|| format!("failed to open {}", script_path.display()))?;
    if !script_exists {
        writeln!(script, "apiRequest(1.6)")?;
    }
    writeln!(
        script,
        "\nlocal mkps4EmuObj = getEmuObject()\nmkps4EmuObj.SetFormattedCard(\"custom.card\")"
    )?;
    Ok(())
}

fn stage_images(request: &Request, payload: &Path) -> Result<()> {
    let system = payload.join("sce_sys");
    resize_png(&request.icon, &system.join("icon0.png"), 512, 512)?;
    if let Some(background) = &request.background {
        resize_png(background, &system.join("pic1.png"), 1920, 1080)?;
    }
    Ok(())
}

fn resize_png(source: &Path, destination: &Path, width: u32, height: u32) -> Result<()> {
    let image = image::open(source)
        .with_context(|| format!("failed to decode image {}", source.display()))?;
    let resized = image
        .resize_exact(width, height, FilterType::Lanczos3)
        .to_rgb8();
    resized
        .save_with_format(destination, image::ImageFormat::Png)
        .with_context(|| format!("failed to write {}", destination.display()))
}

fn stage_sfo(
    payload: &Path,
    content_id: &str,
    title: &str,
    title_id: &str,
    remote_play_keymap: u8,
) -> Result<()> {
    let path = payload.join("sce_sys/param.sfo");
    let mut param = if path.is_file() {
        sfo::ParamSfo::read(&path)?
    } else {
        sfo::ParamSfo::default_game()
    };
    param.update_package(content_id, title, title_id, remote_play_keymap)?;
    param.write(&path)
}

fn copy_file(source: &Path, destination: &Path) -> Result<()> {
    fs::copy(source, destination).with_context(|| {
        format!(
            "failed to copy {} to {}",
            source.display(),
            destination.display()
        )
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::process::Command;
    use zip::write::SimpleFileOptions;

    fn directory_record(extent: u32, size: u32, name: &[u8], directory: bool) -> Vec<u8> {
        let length = 33 + name.len() + usize::from(name.len().is_multiple_of(2));
        let mut record = vec![0u8; length];
        record[0] = length as u8;
        record[2..6].copy_from_slice(&extent.to_le_bytes());
        record[10..14].copy_from_slice(&size.to_le_bytes());
        record[25] = u8::from(directory) * 2;
        record[32] = name.len() as u8;
        record[33..33 + name.len()].copy_from_slice(name);
        record
    }

    fn write_test_iso(path: &Path) {
        const SECTOR: usize = 2048;
        let mut iso = vec![0u8; 24 * SECTOR];
        let pvd = 16 * SECTOR;
        iso[pvd] = 1;
        iso[pvd + 1..pvd + 6].copy_from_slice(b"CD001");
        let root = directory_record(20, SECTOR as u32, &[0], true);
        iso[pvd + 156..pvd + 156 + root.len()].copy_from_slice(&root);
        let file = directory_record(21, 48, b"SYSTEM.CNF;1", false);
        iso[20 * SECTOR..20 * SECTOR + file.len()].copy_from_slice(&file);
        let contents = b"BOOT2 = cdrom0:\\SLUS_209.09;1\r\nVER = 1.00\r\n";
        iso[21 * SECTOR..21 * SECTOR + contents.len()].copy_from_slice(contents);
        fs::write(path, iso).unwrap();
    }

    fn write_test_template(path: &Path) {
        let output = File::create(path).unwrap();
        let mut archive = zip::ZipWriter::new(output);
        let options = SimpleFileOptions::default();
        for relative in REQUIRED_TEMPLATE_FILES {
            archive
                .start_file(format!("PS2/{relative}"), options)
                .unwrap();
            if *relative == "config-emu-ps4.txt" {
                archive
                    .write_all(b"--ps2-title-id=SCUS-97316\n--max-disc-num=1\n")
                    .unwrap();
            } else if REQUIRED_SELF_FILES.contains(relative) {
                archive.write_all(&SELF_MAGIC).unwrap();
            } else {
                archive.write_all(b"fixture").unwrap();
            }
        }
        archive
            .start_file("PS2/sce_sys/icon0.png", options)
            .unwrap();
        archive.write_all(b"fixture").unwrap();
        for relative in ["PS2/sce_sys/icon1.png", "PS2/sce_discmap.plt"] {
            archive.start_file(relative, options).unwrap();
            archive.write_all(b"not packaged").unwrap();
        }
        archive.finish().unwrap();
    }

    #[test]
    fn validates_derived_content_id() {
        validate_content_id("UP9000-SLUS20909_00-SLUS209090000001").unwrap();
        assert!(validate_content_id("UP9000-bad").is_err());
    }

    #[test]
    fn normalizes_np_title() {
        assert_eq!(normalize_np_title("chno00001").unwrap(), "CHNO00001");
        assert!(normalize_np_title("CHNO-00001").is_err());
        assert!(normalize_np_title("CON000001").is_err());
        assert!(normalize_np_title("CHN000001").is_err());
    }

    #[test]
    fn validates_disc_identity_overrides() {
        validate_disc_info(&disc::Serial {
            original: "SLES_523.25".to_string(),
            title_id: "SLES52325".to_string(),
            emulator_id: "SLES-52325".to_string(),
        })
        .unwrap();
        assert!(
            validate_disc_info(&disc::Serial {
                original: "SLES52325".to_string(),
                title_id: "SLES-52325".to_string(),
                emulator_id: "SLES52325".to_string(),
            })
            .is_err()
        );
    }

    #[test]
    fn prepares_complete_project() {
        let temporary = tempfile::tempdir().unwrap();
        let iso = temporary.path().join("Game.iso");
        let template = temporary.path().join("PS2.zip");
        let icon = temporary.path().join("icon.png");
        let memory_card = temporary.path().join("memory.ps2");
        let patch = temporary.path().join("fix.lua");
        let output = temporary.path().join("prepared");
        write_test_iso(&iso);
        write_test_template(&template);
        image::RgbImage::new(1, 1).save(&icon).unwrap();
        let mut superblock = [0u8; 338];
        superblock[..28].copy_from_slice(b"Sony PS2 Memory Card Format ");
        superblock[28..36].copy_from_slice(b"1.2.0.0\0");
        superblock[40..42].copy_from_slice(&512u16.to_le_bytes());
        superblock[42..44].copy_from_slice(&2u16.to_le_bytes());
        superblock[44..46].copy_from_slice(&16u16.to_le_bytes());
        superblock[48..52].copy_from_slice(&8192u32.to_le_bytes());
        superblock[52..56].copy_from_slice(&42u32.to_le_bytes());
        superblock[56..60].copy_from_slice(&8135u32.to_le_bytes());
        superblock[336] = 2;
        let mut memory_card_file = File::create(&memory_card).unwrap();
        memory_card_file.write_all(&superblock).unwrap();
        memory_card_file.set_len(8_650_752).unwrap();
        fs::write(&patch, b"apiRequest(0.1)\n").unwrap();

        let result = prepare(
            &Request {
                images: vec![iso],
                disc_info: None,
                template,
                title: "Fixture Game".to_string(),
                np_title: "TEST00001".to_string(),
                content_id: None,
                icon,
                background: None,
                emulator: EmulatorSettings {
                    memory_card: Some(memory_card),
                    patch_files: vec![patch],
                    ..EmulatorSettings::default()
                },
                remote_play_keymap: 2,
            },
            &output,
        )
        .unwrap();

        assert_eq!(result.content_id, "UP9000-TEST00001_00-SLUS209090000001");
        assert!(output.join("PS2/image/disc01.iso").is_file());
        assert!(output.join("PS2/sce_sys/param.sfo").is_file());
        let config = fs::read_to_string(output.join("PS2/config-emu-ps4.txt")).unwrap();
        assert!(config.contains("--ps2-title-id=SLUS-20909"));
        assert!(config.contains("--path-patches=\"/app0/patches\""));
        assert!(config.contains("--path-featuredata=\"/app0/feature_data\""));
        assert!(output.join("PS2/patches/SLUS-20909_config.lua").is_file());
        assert!(
            output
                .join("PS2/feature_data/SLUS-20909/custom.card")
                .is_file()
        );
        let feature =
            fs::read_to_string(output.join("PS2/feature_data/SLUS-20909_features.lua")).unwrap();
        assert!(feature.contains("SetFormattedCard(\"custom.card\")"));
        let gp4 = fs::read_to_string(result.gp4).unwrap();
        assert!(gp4.contains("targ_path=\"image/disc01.iso\""));
        assert!(gp4.contains(&result.content_id));
        assert!(!gp4.contains("icon1.png"));
        assert!(gp4.contains("sce_discmap.plt"));
    }

    #[test]
    fn stages_extracted_template_without_old_disc() {
        let temporary = tempfile::tempdir().unwrap();
        let template = temporary.path().join("reference");
        for relative in REQUIRED_TEMPLATE_FILES {
            let path = template.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let data: &[u8] = if REQUIRED_SELF_FILES.contains(relative) {
                &SELF_MAGIC
            } else {
                b"fixture"
            };
            fs::write(path, data).unwrap();
        }
        fs::create_dir_all(template.join("sce_sys")).unwrap();
        fs::create_dir_all(template.join("image")).unwrap();
        fs::write(template.join("image/disc01.iso"), b"old disc").unwrap();

        let output = temporary.path().join("staged");
        stage_template(&template, &output).unwrap();

        validate_template(&output.join("PS2")).unwrap();
        assert!(!output.join("PS2/image/disc01.iso").exists());
    }

    #[test]
    fn rejects_duplicate_payload_filenames() {
        let temporary = tempfile::tempdir().unwrap();
        let first_directory = temporary.path().join("first");
        let second_directory = temporary.path().join("second");
        fs::create_dir_all(&first_directory).unwrap();
        fs::create_dir_all(&second_directory).unwrap();
        let first = first_directory.join("fix.lua");
        let second = second_directory.join("FIX.lua");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();

        let result = stage_named_files(
            &[first, second],
            &temporary.path().join("staged"),
            Some("lua"),
        );
        assert!(result.is_err());
    }

    #[test]
    #[ignore = "requires target/pkgtool/PkgTool.Core or pkgtool on PATH"]
    fn builds_pkg_with_real_backend() {
        let temporary = tempfile::tempdir().unwrap();
        let iso = temporary.path().join("Game.iso");
        let template = temporary.path().join("PS2.zip");
        let icon = temporary.path().join("icon.png");
        let output = temporary.path().join("Fixture.pkg");
        write_test_iso(&iso);
        write_test_template(&template);
        image::RgbImage::new(1, 1).save(&icon).unwrap();

        build(
            &Request {
                images: vec![iso],
                disc_info: None,
                template,
                title: "Fixture Game".to_string(),
                np_title: "TEST00001".to_string(),
                content_id: None,
                icon,
                background: None,
                emulator: EmulatorSettings::default(),
                remote_play_keymap: 0,
            },
            &output,
            None,
            false,
        )
        .unwrap();

        assert_eq!(&fs::read(&output).unwrap()[..4], &[0x7f, b'C', b'N', b'T']);
        let pkgtool = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/pkgtool/PkgTool.Core");
        let validation = Command::new(pkgtool)
            .arg("pkg_validate")
            .arg(&output)
            .output()
            .unwrap();
        assert!(validation.status.success());
        let report = String::from_utf8_lossy(&validation.stdout);
        assert!(!report.contains("[ERROR]"), "{report}");
    }
}
