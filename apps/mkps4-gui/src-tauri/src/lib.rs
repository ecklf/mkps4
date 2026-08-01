use std::path::PathBuf;

use mkps4_emulator_store::{EmulatorStore, InstallProgress};
use serde::Serialize;
use tauri::Emitter;

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
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallProgressResponse {
    phase: String,
    completed: u64,
    total: Option<u64>,
    overall_percent: u8,
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
async fn install_emulators(app: tauri::AppHandle) -> Result<SetupStatusResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = EmulatorStore::from_environment().map_err(|error| format!("{error:#}"))?;
        let status = store
            .install(|progress| {
                let _ = app.emit(
                    "emulator-install-progress",
                    InstallProgressResponse::from(progress),
                );
            })
            .map_err(|error| format!("{error:#}"))?;
        Ok(status.into())
    })
    .await
    .map_err(|error| format!("emulator installation task failed: {error}"))?
}

impl From<mkps4_emulator_store::StoreStatus> for SetupStatusResponse {
    fn from(status: mkps4_emulator_store::StoreStatus) -> Self {
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
            inspect_disc,
            install_emulators
        ])
        .run(tauri::generate_context!())
        .expect("failed to run mkps4 desktop application");
}
