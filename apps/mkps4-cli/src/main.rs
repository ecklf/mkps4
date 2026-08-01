use std::cell::Cell;
use std::env;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;

use anyhow::{Result, bail};
use clap::{Args, Parser, Subcommand, ValueEnum};
use mkps4_core::{
    BuildPhase, CompatibilityOptions, DiscInfo, ProjectRequest, RenderMode, UpscaleMode,
};
use mkps4_emulator_store::{EmulatorStore, InstallPhase, InstallProgress};
use tempfile::NamedTempFile;

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Download and install the community emulator runtime collection.
    Setup {
        /// Redownload and replace an existing runtime collection.
        #[arg(long)]
        force: bool,
    },
    /// Detect the PS2 serial in an ISO or CUE/BIN image.
    Inspect {
        /// PS2 ISO or CUE file.
        image: PathBuf,
    },
    /// Create a complete GP4 project without building a PKG.
    Prepare {
        #[command(flatten)]
        conversion: ConversionArgs,
        /// New directory in which to create the GP4 project.
        #[arg(short, long)]
        output: PathBuf,
    },
    /// Create a GP4 project and build it with native LibOrbisPkg PkgTool.
    Build {
        #[command(flatten)]
        conversion: ConversionArgs,
        /// PKG file to create.
        #[arg(short, long)]
        output: PathBuf,
        /// Path to the native LibOrbisPkg PkgTool executable.
        #[arg(long, env = "MKPS4_PKG_TOOL")]
        pkg_tool: Option<PathBuf>,
        /// Replace an existing output PKG.
        #[arg(long)]
        force: bool,
    },
}

#[derive(Debug, Args)]
struct ConversionArgs {
    /// PS2 ISO or CUE files, in disc order (maximum 7).
    #[arg(required = true, num_args = 1..=7)]
    images: Vec<PathBuf>,
    /// PS2 emulator template ZIP or extracted payload directory.
    #[arg(long, env = "MKPS4_TEMPLATE", default_value_os_t = default_template())]
    template: PathBuf,
    /// Display title shown on the PS4 home screen.
    #[arg(long)]
    title: String,
    /// PS4 NP Title ID with four letters and five digits, such as CHNO00001.
    #[arg(long)]
    np_title: String,
    /// Full 36-character PS4 content ID. Derived from the NP Title and PS2 serial by default.
    #[arg(long)]
    content_id: Option<String>,
    /// Home-screen icon image; resized to 512x512 RGB PNG.
    #[arg(long)]
    icon: PathBuf,
    /// Replacement background image; resized to 1920x1080 RGB PNG.
    #[arg(long)]
    background: Option<PathBuf>,
    /// Replacement config-emu-ps4.txt.
    #[arg(long)]
    config: Option<PathBuf>,
    /// Local emulator Lua file to add. May be specified more than once.
    #[arg(long = "lua")]
    lua_files: Vec<PathBuf>,
    /// Override the detected PS2 serial, such as SLES_523.25.
    #[arg(long)]
    disc_serial: Option<String>,
    /// Override the emulator ID, such as SLES-52325.
    #[arg(long)]
    disc_emulator_id: Option<String>,
    /// Override the compact disc title ID, such as SLES52325.
    #[arg(long)]
    disc_title_id: Option<String>,
    /// Override the donor rendering mode.
    #[arg(long, value_enum)]
    rendering: Option<RenderingArg>,
    /// Override the donor upscale mode.
    #[arg(long, value_enum)]
    upscale: Option<UpscaleArg>,
    /// Enable or disable universal FPU, VU, and COP2 clamps.
    #[arg(long, value_enum)]
    universal_compatibility: Option<ToggleArg>,
    /// Enable or disable palette texture merging.
    #[arg(long, value_enum)]
    clut_merge: Option<ToggleArg>,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum RenderingArg {
    Native,
    #[value(name = "2x2")]
    Up2x2,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum UpscaleArg {
    None,
    EdgeSmooth,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum ToggleArg {
    On,
    Off,
}

impl ToggleArg {
    fn enabled(self) -> bool {
        matches!(self, Self::On)
    }
}

struct PreparedRequest {
    request: ProjectRequest,
    _effective_config: Option<NamedTempFile>,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    match Cli::parse().command {
        Command::Setup { force } => setup_emulators(force)?,
        Command::Inspect { image } => {
            let serial = mkps4_core::inspect_disc(&image)?;
            println!("{}", serial.original);
            println!("title-id: {}", serial.title_id);
            println!("emulator-id: {}", serial.emulator_id);
        }
        Command::Prepare { conversion, output } => {
            let conversion = conversion.into_request()?;
            let result = mkps4_core::prepare(&conversion.request, &output)?;
            println!("Prepared {}", result.gp4.display());
            println!("Content ID: {}", result.content_id);
        }
        Command::Build {
            conversion,
            output,
            pkg_tool,
            force,
        } => {
            let conversion = conversion.into_request()?;
            mkps4_core::build_with_progress(
                &conversion.request,
                &output,
                pkg_tool.as_deref(),
                force,
                |phase| {
                    eprintln!("{} ({}%)", build_phase_label(phase), phase.percent());
                },
            )?;
            println!("Created {}", output.display());
        }
    }
    Ok(())
}

fn setup_emulators(force: bool) -> Result<()> {
    let store = EmulatorStore::from_environment()?;
    let current = store.status()?;
    if current.is_installed() && !force {
        print_emulators("Emulators are already installed", &current);
        return Ok(());
    }

    eprintln!(
        "Installing emulator runtimes in {}",
        current.emulators_dir.display()
    );
    let interactive = io::stderr().is_terminal();
    let last_phase = Cell::new(None);
    let report = |progress: InstallProgress| {
        if interactive {
            let transfer = progress
                .total
                .map(|total| {
                    format!(
                        "  {}/{} MB",
                        progress.completed / 1024 / 1024,
                        total / 1024 / 1024
                    )
                })
                .unwrap_or_default();
            eprint!(
                "\r\x1b[2K{:<18} {:>3}%{}",
                setup_phase_label(progress.phase),
                progress.overall_percent,
                transfer
            );
            let _ = io::stderr().flush();
        } else if last_phase.get() != Some(progress.phase) {
            eprintln!(
                "{} ({}%)",
                setup_phase_label(progress.phase),
                progress.overall_percent
            );
            last_phase.set(Some(progress.phase));
        }
    };
    let result = if force {
        store.update(report)
    } else {
        store.install(report)
    };
    if interactive {
        eprintln!();
    }
    let installed = result?;
    print_emulators("Installed emulator runtimes", &installed);
    Ok(())
}

fn setup_phase_label(phase: InstallPhase) -> &'static str {
    match phase {
        InstallPhase::Preparing => "Preparing",
        InstallPhase::Downloading => "Downloading",
        InstallPhase::Combining => "Combining archive",
        InstallPhase::Installing => "Installing",
        InstallPhase::Complete => "Complete",
    }
}

fn build_phase_label(phase: BuildPhase) -> &'static str {
    match phase {
        BuildPhase::Preparing => "Preparing project",
        BuildPhase::Packaging => "Building package",
        BuildPhase::Validating => "Validating package",
        BuildPhase::Complete => "Package ready",
    }
}

fn print_emulators(heading: &str, status: &mkps4_emulator_store::StoreStatus) {
    println!("{heading} at {}", status.emulators_dir.display());
    println!("{} runtimes available:", status.emulators.len());
    for emulator in &status.emulators {
        println!("  {}", emulator.name);
    }
}

fn default_template() -> PathBuf {
    let development = PathBuf::from("emulators/jak-v2");
    if development.is_dir() {
        return development;
    }

    mkps4_home()
        .map(|home| home.join("emulators/jak-v2"))
        .unwrap_or(development)
}

fn mkps4_home() -> Option<PathBuf> {
    if let Some(path) = env::var_os("MKPS4_HOME") {
        return Some(path.into());
    }

    #[cfg(target_os = "windows")]
    {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join("mkps4"))
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".mkps4"))
    }
}

impl ConversionArgs {
    fn into_request(self) -> Result<PreparedRequest> {
        let disc_info = self.disc_info()?;
        let compatibility_requested = self.rendering.is_some()
            || self.upscale.is_some()
            || self.universal_compatibility.is_some()
            || self.clut_merge.is_some();
        let mut effective_config = None;
        let config = if compatibility_requested {
            let input = mkps4_core::read_emulator_config(&self.template, self.config.as_deref())?;
            let defaults = mkps4_core::compatibility_defaults(&input);
            let output = mkps4_core::apply_compatibility(
                &input,
                CompatibilityOptions {
                    render_mode: match self.rendering {
                        Some(RenderingArg::Native) => RenderMode::Native,
                        Some(RenderingArg::Up2x2) => RenderMode::Up2x2,
                        None => RenderMode::Donor,
                    },
                    upscale_mode: match self.upscale {
                        Some(UpscaleArg::None) => UpscaleMode::None,
                        Some(UpscaleArg::EdgeSmooth) => UpscaleMode::EdgeSmooth,
                        None => UpscaleMode::Donor,
                    },
                    universal_compatibility: self
                        .universal_compatibility
                        .map(ToggleArg::enabled)
                        .unwrap_or(defaults.universal_compatibility),
                    clut_merge: self
                        .clut_merge
                        .map(ToggleArg::enabled)
                        .unwrap_or(defaults.clut_merge),
                },
            );
            let mut file = NamedTempFile::new()?;
            file.write_all(output.as_bytes())?;
            file.flush()?;
            let path = file.path().to_path_buf();
            effective_config = Some(file);
            Some(path)
        } else {
            self.config
        };

        Ok(PreparedRequest {
            request: ProjectRequest {
                images: self.images,
                disc_info,
                template: self.template,
                title: self.title,
                np_title: self.np_title,
                content_id: self.content_id,
                icon: self.icon,
                background: self.background,
                config,
                lua_files: self.lua_files,
            },
            _effective_config: effective_config,
        })
    }

    fn disc_info(&self) -> Result<Option<DiscInfo>> {
        if self.disc_serial.is_none()
            && self.disc_emulator_id.is_none()
            && self.disc_title_id.is_none()
        {
            return Ok(None);
        }

        let detected = mkps4_core::inspect_disc(&self.images[0])?;
        let original = self
            .disc_serial
            .as_deref()
            .map(str::to_ascii_uppercase)
            .unwrap_or_else(|| detected.original.clone());
        let (derived_title_id, derived_emulator_id) = if self.disc_serial.is_some() {
            derive_disc_ids(&original)?
        } else {
            (detected.title_id.clone(), detected.emulator_id.clone())
        };
        Ok(Some(DiscInfo {
            original,
            title_id: self
                .disc_title_id
                .as_deref()
                .map(str::to_ascii_uppercase)
                .unwrap_or(derived_title_id),
            emulator_id: self
                .disc_emulator_id
                .as_deref()
                .map(str::to_ascii_uppercase)
                .unwrap_or(derived_emulator_id),
        }))
    }
}

fn derive_disc_ids(serial: &str) -> Result<(String, String)> {
    let bytes = serial.as_bytes();
    if bytes.len() != 11
        || !bytes[..4].iter().all(u8::is_ascii_uppercase)
        || bytes[4] != b'_'
        || !bytes[5..8].iter().all(u8::is_ascii_digit)
        || bytes[8] != b'.'
        || !bytes[9..].iter().all(u8::is_ascii_digit)
    {
        bail!("disc serial must use the format SLES_523.25");
    }
    let digits = format!("{}{}", &serial[5..8], &serial[9..11]);
    Ok((
        format!("{}{}", &serial[..4], digits),
        format!("{}-{digits}", &serial[..4]),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_ids_from_overridden_serial() {
        assert_eq!(
            derive_disc_ids("SLES_523.25").unwrap(),
            ("SLES52325".to_string(), "SLES-52325".to_string())
        );
        assert!(derive_disc_ids("invalid").is_err());
    }
}
