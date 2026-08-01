mod backend;
mod config;
mod disc;
mod gp4;
mod sfo;
mod workflow;

pub use config::{
    CompatibilityDefaults, CompatibilityOptions, DisplayMode, MultitapMode, RenderMode,
    UpscaleMode, apply_compatibility, compatibility_defaults, read_emulator_config,
};
pub use disc::{Serial as DiscInfo, inspect as inspect_disc};
pub use workflow::{
    BuildPhase, EmulatorSettings, Prepared as PreparedProject, Request as ProjectRequest, build,
    build_with_progress, prepare, MAX_DISC_IMAGES,
};
