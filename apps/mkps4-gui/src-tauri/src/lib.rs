use std::env;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;

use base64::Engine;
use mkps4_emulator_store::{EmulatorStore, InstallProgress};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiscInfoResponse {
    original: String,
    title_id: String,
    emulator_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmulatorResponse {
    name: String,
    path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupStatusResponse {
    installed: bool,
    home: String,
    emulators_dir: String,
    emulators: Vec<EmulatorResponse>,
    version: Option<String>,
    last_updated: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgressResponse {
    phase: String,
    completed: u64,
    total: Option<u64>,
    overall_percent: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConfigPreviewRequest {
    runtime_path: PathBuf,
    custom_config_path: Option<PathBuf>,
    render_mode: String,
    upscale_mode: String,
    universal_compatibility: bool,
    clut_merge: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmulatorDefaultsResponse {
    rendering: String,
    upscale: String,
    universal_compatibility: bool,
    clut_merge: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildPackageRequest {
    images: Vec<PathBuf>,
    disc_original: String,
    disc_title_id: String,
    disc_emulator_id: String,
    runtime_path: PathBuf,
    title: String,
    np_title: String,
    icon_path: PathBuf,
    background_path: Option<PathBuf>,
    output_path: PathBuf,
    custom_config_path: Option<PathBuf>,
    render_mode: String,
    upscale_mode: String,
    universal_compatibility: bool,
    clut_merge: bool,
    lua_files: Vec<PathBuf>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildProgressResponse {
    phase: String,
    percent: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BuildPackageResponse {
    output_path: String,
}

#[tauri::command]
async fn inspect_disc(path: PathBuf) -> Result<DiscInfoResponse, String> {
    let info = tauri::async_runtime::spawn_blocking(move || mkps4_core::inspect_disc(&path))
        .await
        .map_err(|error| format!("disc inspection task failed: {error}"))?
        .map_err(|error| format!("{error:#}"))?;

    Ok(DiscInfoResponse {
        original: info.original,
        title_id: info.title_id,
        emulator_id: info.emulator_id,
    })
}

#[tauri::command]
async fn load_image_preview(
    path: PathBuf,
    aspect_width: u32,
    aspect_height: u32,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if aspect_width == 0 || aspect_height == 0 {
            return Err("image aspect ratio must be greater than zero".to_string());
        }
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        if metadata.len() > 20 * 1024 * 1024 {
            return Err("image must be smaller than 20 MB".to_string());
        }
        let mime = match path
            .extension()
            .and_then(|extension| extension.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref()
        {
            Some("png") => "image/png",
            Some("jpg" | "jpeg") => "image/jpeg",
            _ => return Err("image must be a PNG or JPEG".to_string()),
        };
        let (width, height) = image::image_dimensions(&path)
            .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
        if u64::from(width) * u64::from(aspect_height)
            != u64::from(height) * u64::from(aspect_width)
        {
            return Err(format!(
                "image must use a {aspect_width}:{aspect_height} aspect ratio"
            ));
        }
        let bytes = fs::read(&path)
            .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .map_err(|error| format!("image preview task failed: {error}"))?
}

#[tauri::command]
async fn open_containing_folder(path: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || reveal_file(&path))
        .await
        .map_err(|error| format!("open folder task failed: {error}"))?
}

#[tauri::command]
async fn open_folder(path: PathBuf) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || open_directory(&path))
        .await
        .map_err(|error| format!("open folder task failed: {error}"))?
}

#[tauri::command]
async fn get_setup_status() -> Result<SetupStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let store = EmulatorStore::from_environment().map_err(|error| format!("{error:#}"))?;
        let status = store.status().map_err(|error| format!("{error:#}"))?;
        Ok(status.into())
    })
    .await
    .map_err(|error| format!("setup status task failed: {error}"))?
}

#[tauri::command]
async fn install_emulators(
    app: tauri::AppHandle,
    update: bool,
) -> Result<SetupStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = EmulatorStore::from_environment().map_err(|error| format!("{error:#}"))?;
        let report = |progress: InstallProgress| {
            let _ = app.emit(
                "emulator-install-progress",
                InstallProgressResponse::from(progress),
            );
        };
        let status = if update {
            store.update(report)
        } else {
            store.install(report)
        }
        .map_err(|error| format!("{error:#}"))?;
        Ok(status.into())
    })
    .await
    .map_err(|error| format!("emulator installation task failed: {error}"))?
}

#[tauri::command]
async fn get_emulator_defaults(runtime_path: PathBuf) -> Result<EmulatorDefaultsResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let config_path = runtime_path.join("config-emu-ps4.txt");
        let input = fs::read_to_string(&config_path)
            .map_err(|error| format!("failed to read {}: {error}", config_path.display()))?;
        let defaults = mkps4_core::compatibility_defaults(&input);
        Ok(EmulatorDefaultsResponse {
            rendering: defaults.rendering,
            upscale: defaults.upscale,
            universal_compatibility: defaults.universal_compatibility,
            clut_merge: defaults.clut_merge,
        })
    })
    .await
    .map_err(|error| format!("emulator defaults task failed: {error}"))?
}

#[tauri::command]
async fn preview_emulator_config(request: ConfigPreviewRequest) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        effective_config(
            &request.runtime_path,
            request.custom_config_path.as_deref(),
            &request.render_mode,
            &request.upscale_mode,
            request.universal_compatibility,
            request.clut_merge,
        )
    })
    .await
    .map_err(|error| format!("config preview task failed: {error}"))?
}

#[tauri::command]
async fn build_package(
    app: tauri::AppHandle,
    request: BuildPackageRequest,
) -> Result<BuildPackageResponse, String> {
    let pkg_tool = bundled_pkg_tool(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let effective_config = effective_config(
            &request.runtime_path,
            request.custom_config_path.as_deref(),
            &request.render_mode,
            &request.upscale_mode,
            request.universal_compatibility,
            request.clut_merge,
        )?;
        let mut config_file = tempfile::NamedTempFile::new()
            .map_err(|error| format!("failed to create temporary config: {error}"))?;
        config_file
            .write_all(effective_config.as_bytes())
            .map_err(|error| format!("failed to write temporary config: {error}"))?;

        let project = mkps4_core::ProjectRequest {
            images: request.images,
            disc_info: Some(mkps4_core::DiscInfo {
                original: request.disc_original,
                title_id: request.disc_title_id,
                emulator_id: request.disc_emulator_id,
            }),
            template: request.runtime_path,
            title: request.title,
            np_title: request.np_title,
            content_id: None,
            icon: request.icon_path,
            background: request.background_path,
            config: Some(config_file.path().to_path_buf()),
            lua_files: request.lua_files,
        };
        mkps4_core::build_with_progress(
            &project,
            &request.output_path,
            pkg_tool.as_deref(),
            true,
            |phase| {
                let _ = app.emit(
                    "package-build-progress",
                    BuildProgressResponse {
                        phase: phase.as_str().to_string(),
                        percent: phase.percent(),
                    },
                );
            },
        )
        .map_err(|error| format!("{error:#}"))?;

        Ok(BuildPackageResponse {
            output_path: request.output_path.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|error| format!("package build task failed: {error}"))?
}

fn effective_config(
    runtime_path: &Path,
    custom_config_path: Option<&Path>,
    render_mode: &str,
    upscale_mode: &str,
    universal_compatibility: bool,
    clut_merge: bool,
) -> Result<String, String> {
    let input = mkps4_core::read_emulator_config(runtime_path, custom_config_path)
        .map_err(|error| format!("{error:#}"))?;
    let render_mode = match render_mode {
        "donor" => mkps4_core::RenderMode::Donor,
        "native" => mkps4_core::RenderMode::Native,
        "2x2" => mkps4_core::RenderMode::Up2x2,
        value => return Err(format!("unsupported render mode {value}")),
    };
    let upscale_mode = match upscale_mode {
        "donor" => mkps4_core::UpscaleMode::Donor,
        "none" => mkps4_core::UpscaleMode::None,
        "edge-smooth" => mkps4_core::UpscaleMode::EdgeSmooth,
        value => return Err(format!("unsupported upscale mode {value}")),
    };
    Ok(mkps4_core::apply_compatibility(
        &input,
        mkps4_core::CompatibilityOptions {
            render_mode,
            upscale_mode,
            universal_compatibility,
            clut_merge,
        },
    ))
}

fn bundled_pkg_tool(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(path) = env::var_os("MKPS4_PKG_TOOL") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    let resources = app.path().resource_dir().ok()?;
    ["PkgTool.Core", "PkgTool.Core.exe"]
        .into_iter()
        .map(|name| resources.join("bin").join(name))
        .find(|path| path.is_file())
}

fn reveal_file(path: &Path) -> Result<(), String> {
    if !path.is_file() {
        return Err(format!("{} does not exist", path.display()));
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg("-R").arg(path).status();

    #[cfg(target_os = "windows")]
    let status = Command::new("explorer")
        .arg(format!("/select,{}", path.display()))
        .status();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = Command::new("xdg-open")
        .arg(path.parent().unwrap_or_else(|| Path::new(".")))
        .status();

    let status = status.map_err(|error| format!("failed to open containing folder: {error}"))?;
    if !status.success() {
        return Err(format!("folder command failed with {status}"));
    }
    Ok(())
}

fn open_directory(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(format!("{} does not exist", path.display()));
    }

    #[cfg(target_os = "macos")]
    let status = Command::new("open").arg(path).status();

    #[cfg(target_os = "windows")]
    let status = Command::new("explorer").arg(path).status();

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let status = Command::new("xdg-open").arg(path).status();

    let status = status.map_err(|error| format!("failed to open folder: {error}"))?;
    if !status.success() {
        return Err(format!("folder command failed with {status}"));
    }
    Ok(())
}

impl From<mkps4_emulator_store::StoreStatus> for SetupStatusResponse {
    fn from(status: mkps4_emulator_store::StoreStatus) -> Self {
        let version = status.config.as_ref().map(|config| config.version.clone());
        let last_updated = status
            .config
            .as_ref()
            .map(|config| config.last_updated.clone());
        Self {
            installed: status.is_installed(),
            home: status.home.to_string_lossy().into_owned(),
            emulators_dir: status.emulators_dir.to_string_lossy().into_owned(),
            emulators: status
                .emulators
                .into_iter()
                .map(|emulator| EmulatorResponse {
                    name: emulator.name,
                    path: emulator.path.to_string_lossy().into_owned(),
                })
                .collect(),
            version,
            last_updated,
        }
    }
}

impl From<InstallProgress> for InstallProgressResponse {
    fn from(progress: InstallProgress) -> Self {
        Self {
            phase: progress.phase.as_str().to_string(),
            completed: progress.completed,
            total: progress.total,
            overall_percent: progress.overall_percent,
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_setup_status,
            get_emulator_defaults,
            inspect_disc,
            load_image_preview,
            open_containing_folder,
            open_folder,
            install_emulators,
            preview_emulator_config,
            build_package
        ])
        .run(tauri::generate_context!())
        .expect("failed to run mkps4 desktop application");
}
