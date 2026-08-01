use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

const UNIVERSAL_COMPATIBILITY: &[(&str, &str)] = &[
    ("fpu-no-clamping", "0"),
    ("fpu-clamp-results", "1"),
    ("vu0-no-clamping", "0"),
    ("vu0-clamp-results", "1"),
    ("vu1-no-clamping", "0"),
    ("vu1-clamp-results", "1"),
    ("cop2-no-clamping", "0"),
    ("cop2-clamp-results", "1"),
    ("vu0-opt-flags", "1"),
    ("vu1-opt-flags", "1"),
    ("cop2-opt-flags", "1"),
    ("vu1-jr-cache-policy", "newprog"),
    ("vu1-jalr-cache-policy", "newprog"),
];

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum RenderMode {
    #[default]
    Donor,
    Native,
    Up2x2,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum UpscaleMode {
    #[default]
    Donor,
    None,
    EdgeSmooth,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CompatibilityOptions {
    pub render_mode: RenderMode,
    pub upscale_mode: UpscaleMode,
    pub universal_compatibility: bool,
    pub clut_merge: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompatibilityDefaults {
    pub rendering: String,
    pub upscale: String,
    pub universal_compatibility: bool,
    pub clut_merge: bool,
}

pub fn update(path: &Path, emulator_id: &str, disc_count: usize) -> Result<()> {
    let input =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    let output = update_text(&input, emulator_id, disc_count);
    fs::write(path, output).with_context(|| format!("failed to write {}", path.display()))
}

pub fn apply_compatibility(input: &str, options: CompatibilityOptions) -> String {
    let had_final_newline = input.ends_with('\n');
    let mut overrides = Vec::new();

    match options.render_mode {
        RenderMode::Donor => {}
        RenderMode::Native => overrides.push(("gs-uprender", None)),
        RenderMode::Up2x2 => overrides.push(("gs-uprender", Some("2x2"))),
    }
    match options.upscale_mode {
        UpscaleMode::Donor => {}
        UpscaleMode::None => overrides.push(("gs-upscale", None)),
        UpscaleMode::EdgeSmooth => overrides.push(("gs-upscale", Some("EdgeSmooth"))),
    }
    overrides.push((
        "gs-use-clut-merge",
        Some(if options.clut_merge { "1" } else { "0" }),
    ));
    overrides.extend(
        UNIVERSAL_COMPATIBILITY
            .iter()
            .map(|(name, value)| (*name, options.universal_compatibility.then_some(*value))),
    );

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
        rendering: option_value(input, "gs-uprender").unwrap_or_else(|| "Native".to_string()),
        upscale: option_value(input, "gs-upscale").unwrap_or_else(|| "None".to_string()),
        universal_compatibility: UNIVERSAL_COMPATIBILITY
            .iter()
            .all(|(name, value)| option_value(input, name).as_deref() == Some(*value)),
        clut_merge: option_value(input, "gs-use-clut-merge").as_deref() == Some("1"),
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

fn update_text(input: &str, emulator_id: &str, disc_count: usize) -> String {
    let had_final_newline = input.ends_with('\n');
    let mut found_title = false;
    let mut found_count = false;
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
        } else if disc_count > 1
            && (trimmed.starts_with("#--path-patches=")
                || trimmed.starts_with("#--path-featuredata=")
                || trimmed.starts_with("#--path-toolingscript="))
        {
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

    let mut output = lines.join("\n");
    if had_final_newline || !output.is_empty() {
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_multidisc_config() {
        let input =
            "--ps2-title-id=SCUS-97316\n--max-disc-num=1\n#--path-patches=\"/app0/patches\"\n";
        let output = update_text(input, "SLUS-20909", 2);
        assert!(output.contains("--ps2-title-id=SLUS-20909"));
        assert!(output.contains("--max-disc-num=2"));
        assert!(output.contains("--path-patches=\"/app0/patches\""));
        assert!(!output.contains("#--path-patches"));
    }

    #[test]
    fn applies_native_compatibility_options() {
        let input = "--gs-uprender=2x2\n--gs-upscale=EdgeSmooth\n--gs-use-clut-merge=1\n";
        let output = apply_compatibility(
            input,
            CompatibilityOptions {
                render_mode: RenderMode::Native,
                upscale_mode: UpscaleMode::None,
                universal_compatibility: true,
                clut_merge: false,
            },
        );

        assert!(!output.contains("--gs-uprender"));
        assert!(!output.contains("--gs-upscale"));
        assert!(output.contains("--gs-use-clut-merge=0"));
        assert!(output.contains("--fpu-clamp-results=1"));
        assert!(output.contains("--vu1-jr-cache-policy=newprog"));
    }

    #[test]
    fn reads_donor_compatibility_defaults() {
        let input = "--gs-uprender=2x2\n--gs-upscale=EdgeSmooth\n--gs-use-clut-merge=1\n";
        let defaults = compatibility_defaults(input);

        assert_eq!(defaults.rendering, "2x2");
        assert_eq!(defaults.upscale, "EdgeSmooth");
        assert!(!defaults.universal_compatibility);
        assert!(defaults.clut_merge);
    }
}
