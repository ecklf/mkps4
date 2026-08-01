use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result, ensure};
use zip::ZipArchive;

const GRAPHICS_FIX: &[(&str, &str)] = &[
    ("fpu-no-clamping", "0"),
    ("fpu-clamp-results", "1"),
    ("vu0-no-clamping", "0"),
    ("vu0-clamp-results", "1"),
    ("vu1-no-clamping", "0"),
    ("vu1-clamp-results", "1"),
    ("cop2-no-clamping", "0"),
    ("cop2-clamp-results", "1"),
];

const SPEED_FIX: &[(&str, &str)] = &[
    ("vu0-opt-flags", "1"),
    ("vu1-opt-flags", "1"),
    ("cop2-opt-flags", "1"),
    ("vu0-const-prop", "1"),
    ("vu1-const-prop", "1"),
    ("vu1-jr-cache-policy", "newprog"),
    ("vu1-jalr-cache-policy", "newprog"),
    ("vu0-jr-cache-policy", "newprog"),
    ("vu0-jalr-cache-policy", "newprog"),
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RenderMode {
    Native,
    Up2x2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpscaleMode {
    None,
    EdgeSmooth,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DisplayMode {
    Normal,
    Full,
    Aspect4x3,
    Aspect16x9,
}

impl DisplayMode {
    fn value(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Full => "full",
            Self::Aspect4x3 => "4:3",
            Self::Aspect16x9 => "16:9",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MultitapMode {
    Disabled,
    Port1,
    Port2,
    Both,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CompatibilityOptions {
    pub render_mode: Option<RenderMode>,
    pub upscale_mode: Option<UpscaleMode>,
    pub display_mode: Option<DisplayMode>,
    pub graphics_fix: Option<bool>,
    pub speed_fix: Option<bool>,
    pub disable_mtvu: Option<bool>,
    pub disable_instant_vif1: Option<bool>,
    pub clut_merge: Option<bool>,
    pub multitap: Option<MultitapMode>,
    pub reset_on_disc_change: Option<bool>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompatibilityDefaults {
    pub rendering: String,
    pub upscale: String,
    pub display_mode: String,
    pub graphics_fix: bool,
    pub speed_fix: bool,
    pub disable_mtvu: bool,
    pub disable_instant_vif1: bool,
    pub clut_merge: bool,
    pub multitap: MultitapMode,
    pub reset_on_disc_change: bool,
}

pub fn read_emulator_config(template: &Path, custom_config: Option<&Path>) -> Result<String> {
    if let Some(custom_config) = custom_config {
        return fs::read_to_string(custom_config)
            .with_context(|| format!("failed to read {}", custom_config.display()));
    }

    if template.is_dir() {
        let path = if template.join("PS2").is_dir() {
            template.join("PS2/config-emu-ps4.txt")
        } else {
            template.join("config-emu-ps4.txt")
        };
        return fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()));
    }

    let file = File::open(template)
        .with_context(|| format!("failed to open template {}", template.display()))?;
    let mut archive = ZipArchive::new(file).context("template is not a valid ZIP archive")?;
    let mut entry = archive
        .by_name("PS2/config-emu-ps4.txt")
        .context("template ZIP is missing PS2/config-emu-ps4.txt")?;
    ensure!(
        !entry.is_dir(),
        "template ZIP config-emu-ps4.txt is not a file"
    );
    let mut input = String::new();
    entry
        .read_to_string(&mut input)
        .context("template config-emu-ps4.txt is not valid UTF-8")?;
    Ok(input)
}

pub fn update(
    path: &Path,
    emulator_id: &str,
    disc_count: usize,
    enable_patches: bool,
    enable_features: bool,
) -> Result<()> {
    let input =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    let output = update_text(
        &input,
        emulator_id,
        disc_count,
        enable_patches,
        enable_features,
    );
    fs::write(path, output).with_context(|| format!("failed to write {}", path.display()))
}

pub fn apply_compatibility(input: &str, options: CompatibilityOptions) -> String {
    let had_final_newline = input.ends_with('\n');
    let mut overrides = Vec::new();

    match options.render_mode {
        Some(RenderMode::Native) => overrides.push(("gs-uprender", Some("none"))),
        Some(RenderMode::Up2x2) => overrides.push(("gs-uprender", Some("2x2"))),
        None => {}
    }
    match options.upscale_mode {
        Some(UpscaleMode::None) => overrides.push(("gs-upscale", Some("none"))),
        Some(UpscaleMode::EdgeSmooth) => overrides.push(("gs-upscale", Some("EdgeSmooth"))),
        None => {}
    }
    if let Some(display_mode) = options.display_mode {
        overrides.push(("host-display-mode", Some(display_mode.value())));
    }
    add_preset(&mut overrides, GRAPHICS_FIX, options.graphics_fix);
    add_preset(&mut overrides, SPEED_FIX, options.speed_fix);
    if let Some(disable_mtvu) = options.disable_mtvu {
        overrides.push(("vu1", disable_mtvu.then_some("jit-sync")));
    }
    if let Some(disable_instant_vif1) = options.disable_instant_vif1 {
        overrides.push((
            "vif1-instant-xfer",
            Some(if disable_instant_vif1 { "0" } else { "1" }),
        ));
    }
    if let Some(clut_merge) = options.clut_merge {
        overrides.push((
            "gs-use-clut-merge",
            Some(if clut_merge { "1" } else { "0" }),
        ));
    }
    if let Some(multitap) = options.multitap {
        overrides.push((
            "mtap1",
            Some(if matches!(multitap, MultitapMode::Port1 | MultitapMode::Both) {
                "always"
            } else {
                "Disabled"
            }),
        ));
        overrides.push((
            "mtap2",
            Some(if matches!(multitap, MultitapMode::Port2 | MultitapMode::Both) {
                "always"
            } else {
                "Disabled"
            }),
        ));
    }
    if let Some(reset_on_disc_change) = options.reset_on_disc_change {
        overrides.push((
            "switch-disc-reset",
            Some(if reset_on_disc_change { "1" } else { "0" }),
        ));
    }

    let mut lines = input
        .lines()
        .filter(|line| {
            let trimmed = line.trim_start();
            !overrides
                .iter()
                .any(|(name, _)| trimmed.starts_with(&format!("--{name}=")))
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.extend(
        overrides
            .into_iter()
            .filter_map(|(name, value)| value.map(|value| format!("--{name}={value}"))),
    );

    let mut output = lines.join("\n");
    if had_final_newline || !output.is_empty() {
        output.push('\n');
    }
    output
}

pub fn compatibility_defaults(input: &str) -> CompatibilityDefaults {
    CompatibilityDefaults {
        rendering: match option_value(input, "gs-uprender").as_deref() {
            None | Some("none") => "Native".to_string(),
            Some(value) => value.to_string(),
        },
        upscale: option_value(input, "gs-upscale").unwrap_or_else(|| "None".to_string()),
        display_mode: option_value(input, "host-display-mode")
            .unwrap_or_else(|| "full".to_string()),
        graphics_fix: GRAPHICS_FIX
            .iter()
            .all(|(name, value)| option_value(input, name).as_deref() == Some(*value)),
        speed_fix: SPEED_FIX
            .iter()
            .all(|(name, value)| option_value(input, name).as_deref() == Some(*value)),
        disable_mtvu: option_value(input, "vu1").as_deref() == Some("jit-sync"),
        disable_instant_vif1: option_value(input, "vif1-instant-xfer").as_deref() == Some("0"),
        clut_merge: option_value(input, "gs-use-clut-merge").as_deref() == Some("1"),
        multitap: match (
            option_value(input, "mtap1").as_deref() == Some("always"),
            option_value(input, "mtap2").as_deref() == Some("always"),
        ) {
            (true, true) => MultitapMode::Both,
            (true, false) => MultitapMode::Port1,
            (false, true) => MultitapMode::Port2,
            (false, false) => MultitapMode::Disabled,
        },
        reset_on_disc_change: option_value(input, "switch-disc-reset").as_deref() != Some("0"),
    }
}

fn add_preset(
    overrides: &mut Vec<(&'static str, Option<&'static str>)>,
    preset: &'static [(&'static str, &'static str)],
    enabled: Option<bool>,
) {
    if let Some(enabled) = enabled {
        overrides.extend(
            preset
                .iter()
                .map(|(name, value)| (*name, enabled.then_some(*value))),
        );
    }
}

fn option_value(input: &str, name: &str) -> Option<String> {
    let prefix = format!("--{name}=");
    input.lines().find_map(|line| {
        line.trim_start()
            .strip_prefix(&prefix)
            .map(|value| value.trim().trim_matches('"').to_string())
    })
}

fn update_text(
    input: &str,
    emulator_id: &str,
    disc_count: usize,
    enable_patches: bool,
    enable_features: bool,
) -> String {
    let had_final_newline = input.ends_with('\n');
    let mut found_title = false;
    let mut found_count = false;
    let mut found_patches = false;
    let mut found_features = false;
    let mut lines = Vec::new();

    for line in input.lines() {
        let trimmed = line.trim_start();
        let indentation = &line[..line.len() - trimmed.len()];
        if trimmed.starts_with("--ps2-title-id=") {
            lines.push(format!("{indentation}--ps2-title-id={emulator_id}"));
            found_title = true;
        } else if trimmed.starts_with("--max-disc-num=") {
            lines.push(format!("{indentation}--max-disc-num={disc_count}"));
            found_count = true;
        } else if trimmed.starts_with("--path-patches=") || trimmed.starts_with("#--path-patches=")
        {
            found_patches = true;
            if enable_patches {
                lines.push(format!("{indentation}--path-patches=\"/app0/patches\""));
            } else if disc_count > 1 && trimmed.starts_with('#') {
                lines.push(format!("{indentation}{}", &trimmed[1..]));
            } else {
                lines.push(line.to_string());
            }
        } else if trimmed.starts_with("--path-featuredata=")
            || trimmed.starts_with("#--path-featuredata=")
        {
            found_features = true;
            if enable_features {
                lines.push(format!(
                    "{indentation}--path-featuredata=\"/app0/feature_data\""
                ));
            } else if disc_count > 1 && trimmed.starts_with('#') {
                lines.push(format!("{indentation}{}", &trimmed[1..]));
            } else {
                lines.push(line.to_string());
            }
        } else if disc_count > 1 && trimmed.starts_with("#--path-toolingscript=") {
            lines.push(format!("{indentation}{}", &trimmed[1..]));
        } else {
            lines.push(line.to_string());
        }
    }

    if !found_title {
        lines.push(format!("--ps2-title-id={emulator_id}"));
    }
    if !found_count {
        lines.push(format!("--max-disc-num={disc_count}"));
    }
    if enable_patches && !found_patches {
        lines.push("--path-patches=\"/app0/patches\"".to_string());
    }
    if enable_features && !found_features {
        lines.push("--path-featuredata=\"/app0/feature_data\"".to_string());
    }

    let mut output = lines.join("\n");
    if had_final_newline || !output.is_empty() {
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    #[test]
    fn updates_multidisc_config() {
        let input =
            "--ps2-title-id=SCUS-97316\n--max-disc-num=1\n#--path-patches=\"/app0/patches\"\n";
        let output = update_text(input, "SLUS-20909", 2, false, false);
        assert!(output.contains("--ps2-title-id=SLUS-20909"));
        assert!(output.contains("--max-disc-num=2"));
        assert!(output.contains("--path-patches=\"/app0/patches\""));
        assert!(!output.contains("#--path-patches"));
    }

    #[test]
    fn enables_requested_payload_paths_for_single_disc() {
        let input = "#--path-patches=\"/wrong/patches\"\n--path-featuredata=\"/wrong/features\"\n";
        let output = update_text(input, "SLUS-20909", 1, true, true);
        assert!(output.contains("--path-patches=\"/app0/patches\""));
        assert!(output.contains("--path-featuredata=\"/app0/feature_data\""));
        assert!(!output.contains("/wrong/"));
    }

    #[test]
    fn applies_native_compatibility_options() {
        let input = "--gs-uprender=2x2\n--gs-upscale=EdgeSmooth\n--gs-use-clut-merge=1\n";
        let output = apply_compatibility(
            input,
            CompatibilityOptions {
                render_mode: Some(RenderMode::Native),
                upscale_mode: Some(UpscaleMode::None),
                graphics_fix: Some(true),
                clut_merge: Some(false),
                ..CompatibilityOptions::default()
            },
        );

        assert!(output.contains("--gs-uprender=none"));
        assert!(output.contains("--gs-upscale=none"));
        assert!(output.contains("--gs-use-clut-merge=0"));
        assert!(output.contains("--fpu-clamp-results=1"));
        assert!(output.contains("--cop2-clamp-results=1"));
    }

    #[test]
    fn reads_donor_compatibility_defaults() {
        let input = "--gs-uprender=2x2\n--gs-upscale=EdgeSmooth\n--gs-use-clut-merge=1\n";
        let defaults = compatibility_defaults(input);

        assert_eq!(defaults.rendering, "2x2");
        assert_eq!(defaults.upscale, "EdgeSmooth");
        assert!(!defaults.graphics_fix);
        assert!(!defaults.speed_fix);
        assert!(defaults.clut_merge);
    }

    #[test]
    fn reads_explicit_native_rendering() {
        let defaults = compatibility_defaults("--gs-uprender=none\n--gs-upscale=none\n");

        assert_eq!(defaults.rendering, "Native");
        assert_eq!(defaults.upscale, "none");
    }

    #[test]
    fn empty_compatibility_options_preserve_config() {
        let input = "--host-display-mode=16:9\n--vu1=jit-sync\n--custom=value\n";
        assert_eq!(
            apply_compatibility(input, CompatibilityOptions::default()),
            input
        );
    }

    #[test]
    fn applies_extended_compatibility_options() {
        let output = apply_compatibility(
            "--mtap1=always\n--switch-disc-reset=0\n",
            CompatibilityOptions {
                display_mode: Some(DisplayMode::Aspect4x3),
                speed_fix: Some(true),
                disable_mtvu: Some(true),
                disable_instant_vif1: Some(true),
                multitap: Some(MultitapMode::Both),
                reset_on_disc_change: Some(true),
                ..CompatibilityOptions::default()
            },
        );

        assert!(output.contains("--host-display-mode=4:3"));
        assert!(output.contains("--vu0-const-prop=1"));
        assert!(output.contains("--vu1-const-prop=1"));
        assert!(output.contains("--vu1=jit-sync"));
        assert!(output.contains("--vif1-instant-xfer=0"));
        assert!(output.contains("--mtap1=always"));
        assert!(output.contains("--mtap2=always"));
        assert!(output.contains("--switch-disc-reset=1"));
    }

    #[test]
    fn writes_documented_disabled_values() {
        let output = apply_compatibility(
            "--vif1-instant-xfer=0\n--mtap1=always\n--mtap2=always\n--switch-disc-reset=0\n",
            CompatibilityOptions {
                disable_instant_vif1: Some(false),
                multitap: Some(MultitapMode::Disabled),
                reset_on_disc_change: Some(true),
                ..CompatibilityOptions::default()
            },
        );

        assert!(output.contains("--vif1-instant-xfer=1"));
        assert!(output.contains("--mtap1=Disabled"));
        assert!(output.contains("--mtap2=Disabled"));
        assert!(output.contains("--switch-disc-reset=1"));
    }

    #[test]
    fn reads_config_from_template_zip() {
        let temporary = tempfile::tempdir().unwrap();
        let template = temporary.path().join("template.zip");
        let mut archive = ZipWriter::new(File::create(&template).unwrap());
        archive
            .start_file("PS2/config-emu-ps4.txt", SimpleFileOptions::default())
            .unwrap();
        archive.write_all(b"--gs-uprender=2x2\n").unwrap();
        archive.finish().unwrap();

        assert_eq!(
            read_emulator_config(&template, None).unwrap(),
            "--gs-uprender=2x2\n"
        );
    }
}
