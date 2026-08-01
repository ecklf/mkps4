use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use image::imageops::FilterType;
use tempfile::Builder;
use zip::ZipArchive;

use crate::{backend, config, disc, gp4, sfo};

const REQUIRED_TEMPLATE_FILES: &[&str] = &[
    "config-emu-ps4.txt",
    "eboot.bin",
    "formatted.card",
    "ps2-emu-compiler.self",
    "PS20220WD20050620.crack",
    "sce_module/libc.prx",
    "sce_module/libSceFios2.prx",
];

#[derive(Debug)]
pub struct Request {
    pub images: Vec<PathBuf>,
    pub template: PathBuf,
    pub title: Option<String>,
    pub title_id: Option<String>,
    pub content_id: Option<String>,
    pub icon: Option<PathBuf>,
    pub background: Option<PathBuf>,
    pub config: Option<PathBuf>,
    pub lua_files: Vec<PathBuf>,
}

pub struct Prepared {
    pub gp4: PathBuf,
    pub content_id: String,
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
    let prepared = prepare_in(request, workspace.path())?;
    let backend_output = workspace.path().join("pkg-output");
    fs::create_dir(&backend_output)?;
    let package = backend::build(
        pkg_tool,
        &prepared.gp4,
        &backend_output,
        &prepared.content_id,
    )?;

    fs::rename(&package, output)
        .with_context(|| format!("failed to move generated package to {}", output.display()))?;
    Ok(())
}

fn prepare_in(request: &Request, root: &Path) -> Result<Prepared> {
    validate_request(request)?;
    let serials = request
        .images
        .iter()
        .map(|image| disc::inspect(image))
        .collect::<Result<Vec<_>>>()?;
    let primary_serial = &serials[0];
    let title_id = request
        .title_id
        .as_deref()
        .map(normalize_title_id)
        .transpose()?
        .unwrap_or_else(|| primary_serial.title_id.clone());
    let content_id = request
        .content_id
        .clone()
        .unwrap_or_else(|| format!("UP9000-{title_id}_00-{title_id}0000001"));
    validate_content_id(&content_id)?;
    let title = request.title.clone().unwrap_or_else(|| {
        request.images[0]
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("PS2 Classic")
            .to_string()
    });
    ensure!(!title.trim().is_empty(), "title cannot be empty");
    ensure!(
        title.len() < 128 && !title.as_bytes().contains(&0),
        "title must be at most 127 UTF-8 bytes and contain no nulls"
    );

    extract_template(&request.template, root)?;
    let payload = root.join("PS2");
    validate_template(&payload)?;

    if let Some(custom_config) = &request.config {
        copy_file(custom_config, &payload.join("config-emu-ps4.txt"))?;
    }
    config::update(
        &payload.join("config-emu-ps4.txt"),
        &primary_serial.emulator_id,
        request.images.len(),
    )?;

    stage_discs(&request.images, &payload.join("image"))?;
    stage_lua(&request.lua_files, &payload.join("lua_include"))?;
    stage_images(request, &payload)?;
    stage_sfo(&payload, &content_id, &title, &title_id)?;

    let gp4 = gp4::write(root, &payload, &content_id)?;
    Ok(Prepared { gp4, content_id })
}

fn validate_request(request: &Request) -> Result<()> {
    ensure!(
        !request.images.is_empty() && request.images.len() <= 7,
        "provide between 1 and 7 disc images"
    );
    ensure!(
        request.template.is_file(),
        "template ZIP does not exist at {}",
        request.template.display()
    );
    for image in &request.images {
        ensure!(
            image.is_file(),
            "disc image does not exist at {}",
            image.display()
        );
    }
    for path in request
        .icon
        .iter()
        .chain(request.background.iter())
        .chain(request.config.iter())
        .chain(request.lua_files.iter())
    {
        ensure!(
            path.is_file(),
            "input file does not exist at {}",
            path.display()
        );
    }
    Ok(())
}

fn normalize_title_id(value: &str) -> Result<String> {
    let value = value.to_ascii_uppercase();
    ensure!(
        value.len() == 9
            && value
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit()),
        "title ID must be exactly 9 ASCII letters/digits"
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

fn extract_template(template: &Path, root: &Path) -> Result<()> {
    let file = File::open(template)
        .with_context(|| format!("failed to open template {}", template.display()))?;
    let mut archive = ZipArchive::new(file).context("template is not a valid ZIP archive")?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let enclosed = entry
            .enclosed_name()
            .context("template ZIP contains an unsafe path")?;
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
    Ok(())
}

fn stage_discs(images: &[PathBuf], image_directory: &Path) -> Result<()> {
    fs::create_dir_all(image_directory)?;
    for entry in fs::read_dir(image_directory)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.file_type()?.is_file()
            && name.starts_with("disc")
            && name.ends_with(".iso")
            && name[4..name.len() - 4]
                .bytes()
                .all(|byte| byte.is_ascii_digit())
        {
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

fn stage_lua(lua_files: &[PathBuf], directory: &Path) -> Result<()> {
    fs::create_dir_all(directory)?;
    for source in lua_files {
        let name = source
            .file_name()
            .and_then(|name| name.to_str())
            .context("Lua filename is not UTF-8")?;
        ensure!(
            name.is_ascii() && name.ends_with(".lua"),
            "Lua files must have ASCII .lua filenames"
        );
        copy_file(source, &directory.join(name))?;
    }
    Ok(())
}

fn stage_images(request: &Request, payload: &Path) -> Result<()> {
    let system = payload.join("sce_sys");
    if let Some(icon) = &request.icon {
        resize_png(icon, &system.join("icon0.png"), 512, 512)?;
    }
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

fn stage_sfo(payload: &Path, content_id: &str, title: &str, title_id: &str) -> Result<()> {
    let path = payload.join("sce_sys/param.sfo");
    let mut param = if path.is_file() {
        sfo::ParamSfo::read(&path)?
    } else {
        sfo::ParamSfo::default_game()
    };
    param.update_package(content_id, title, title_id)?;
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
            } else {
                archive.write_all(b"fixture").unwrap();
            }
        }
        archive
            .start_file("PS2/sce_sys/icon0.png", options)
            .unwrap();
        archive.write_all(b"fixture").unwrap();
        archive.finish().unwrap();
    }

    #[test]
    fn validates_derived_content_id() {
        validate_content_id("UP9000-SLUS20909_00-SLUS209090000001").unwrap();
        assert!(validate_content_id("UP9000-bad").is_err());
    }

    #[test]
    fn normalizes_explicit_title_id() {
        assert_eq!(normalize_title_id("slus20909").unwrap(), "SLUS20909");
        assert!(normalize_title_id("SLUS-20909").is_err());
    }

    #[test]
    fn prepares_complete_project() {
        let temporary = tempfile::tempdir().unwrap();
        let iso = temporary.path().join("Game.iso");
        let template = temporary.path().join("PS2.zip");
        let output = temporary.path().join("prepared");
        write_test_iso(&iso);
        write_test_template(&template);

        let result = prepare(
            &Request {
                images: vec![iso],
                template,
                title: Some("Fixture Game".to_string()),
                title_id: None,
                content_id: None,
                icon: None,
                background: None,
                config: None,
                lua_files: Vec::new(),
            },
            &output,
        )
        .unwrap();

        assert_eq!(result.content_id, "UP9000-SLUS20909_00-SLUS209090000001");
        assert!(output.join("PS2/image/disc01.iso").is_file());
        assert!(output.join("PS2/sce_sys/param.sfo").is_file());
        let config = fs::read_to_string(output.join("PS2/config-emu-ps4.txt")).unwrap();
        assert!(config.contains("--ps2-title-id=SLUS-20909"));
        let gp4 = fs::read_to_string(result.gp4).unwrap();
        assert!(gp4.contains("targ_path=\"image/disc01.iso\""));
        assert!(gp4.contains(&result.content_id));
    }

    #[test]
    #[ignore = "requires target/pkgtool/PkgTool.Core or pkgtool on PATH"]
    fn builds_pkg_with_real_backend() {
        let temporary = tempfile::tempdir().unwrap();
        let iso = temporary.path().join("Game.iso");
        let template = temporary.path().join("PS2.zip");
        let output = temporary.path().join("Fixture.pkg");
        write_test_iso(&iso);
        write_test_template(&template);

        build(
            &Request {
                images: vec![iso],
                template,
                title: Some("Fixture Game".to_string()),
                title_id: None,
                content_id: None,
                icon: None,
                background: None,
                config: None,
                lua_files: Vec::new(),
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
