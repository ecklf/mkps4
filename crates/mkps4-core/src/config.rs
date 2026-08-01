use std::fs;
use std::path::Path;

use anyhow::{Context, Result};

pub fn update(path: &Path, emulator_id: &str, disc_count: usize) -> Result<()> {
    let input =
        fs::read_to_string(path).with_context(|| format!("failed to read {}", path.display()))?;
    let output = update_text(&input, emulator_id, disc_count);
    fs::write(path, output).with_context(|| format!("failed to write {}", path.display()))
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
}
