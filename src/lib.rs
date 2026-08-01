mod backend;
mod config;
mod disc;
mod gp4;
mod sfo;
mod workflow;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Args, Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(version, about)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
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
    /// Create a GP4 project and build it with native macOS PkgTool.
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
    /// PS2 emulator template ZIP. The archive must contain a PS2 directory.
    #[arg(long, env = "MKPS4_TEMPLATE")]
    template: PathBuf,
    /// Display title. Defaults to the first image's filename.
    #[arg(long)]
    title: Option<String>,
    /// Nine-character PS4 title ID, such as SLUS20909.
    #[arg(long)]
    title_id: Option<String>,
    /// Full 36-character PS4 content ID. Derived from the title ID by default.
    #[arg(long)]
    content_id: Option<String>,
    /// Replacement icon image; resized to 512x512 RGB PNG.
    #[arg(long)]
    icon: Option<PathBuf>,
    /// Replacement background image; resized to 1920x1080 RGB PNG.
    #[arg(long)]
    background: Option<PathBuf>,
    /// Replacement config-emu-ps4.txt.
    #[arg(long)]
    config: Option<PathBuf>,
    /// Local emulator Lua file to add. May be specified more than once.
    #[arg(long = "lua")]
    lua_files: Vec<PathBuf>,
}

pub fn run() -> Result<()> {
    match Cli::parse().command {
        Command::Inspect { image } => {
            let serial = disc::inspect(&image)?;
            println!("{}", serial.original);
            println!("title-id: {}", serial.title_id);
            println!("emulator-id: {}", serial.emulator_id);
        }
        Command::Prepare { conversion, output } => {
            let request = conversion.into_request();
            let result = workflow::prepare(&request, &output)?;
            println!("Prepared {}", result.gp4.display());
            println!("Content ID: {}", result.content_id);
        }
        Command::Build {
            conversion,
            output,
            pkg_tool,
            force,
        } => {
            workflow::build(
                &conversion.into_request(),
                &output,
                pkg_tool.as_deref(),
                force,
            )?;
            println!("Created {}", output.display());
        }
    }
    Ok(())
}

impl ConversionArgs {
    fn into_request(self) -> workflow::Request {
        workflow::Request {
            images: self.images,
            template: self.template,
            title: self.title,
            title_id: self.title_id,
            content_id: self.content_id,
            icon: self.icon,
            background: self.background,
            config: self.config,
            lua_files: self.lua_files,
        }
    }
}
