use std::env;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail, ensure};

pub fn build(
    requested_tool: Option<&Path>,
    gp4: &Path,
    output_directory: &Path,
    content_id: &str,
) -> Result<PathBuf> {
    let tool = resolve(requested_tool)?;
    let status = Command::new(&tool)
        .arg("pkg_build")
        .arg(gp4)
        .arg(output_directory)
        .status()
        .with_context(|| format!("failed to launch native PkgTool at {}", tool.display()))?;
    ensure!(status.success(), "PkgTool failed with {status}");

    let package = output_directory.join(format!("{content_id}.pkg"));
    ensure!(
        package.is_file(),
        "PkgTool exited successfully but did not create {}",
        package.display()
    );
    validate_pkg_header(&package)?;
    validate_pkg(&tool, &package)?;
    Ok(package)
}

fn resolve(requested: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = requested {
        ensure!(
            path.is_file(),
            "PkgTool does not exist at {}",
            path.display()
        );
        return Ok(path.to_path_buf());
    }

    let local = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/pkgtool/PkgTool.Core");
    if local.is_file() {
        return Ok(local);
    }

    for name in ["pkgtool", "PkgTool.Core", "PkgTool"] {
        if let Some(path) = find_on_path(name) {
            return Ok(path);
        }
    }
    bail!(
        "native LibOrbisPkg PkgTool was not found; run scripts/build-pkgtool.sh in `nix develop`, install nixpkgs#liborbispkg-pkgtool, pass --pkg-tool, or set MKPS4_PKG_TOOL"
    )
}

fn find_on_path(name: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|directory| directory.join(name))
            .find(|candidate| candidate.is_file())
    })
}

fn validate_pkg_header(path: &Path) -> Result<()> {
    let mut magic = [0u8; 4];
    File::open(path)
        .with_context(|| format!("failed to open generated package {}", path.display()))?
        .read_exact(&mut magic)?;
    ensure!(
        magic == [0x7f, b'C', b'N', b'T'],
        "PkgTool output is not a PS4 PKG"
    );
    Ok(())
}

fn validate_pkg(tool: &Path, path: &Path) -> Result<()> {
    let output = Command::new(tool)
        .arg("pkg_validate")
        .arg(path)
        .output()
        .with_context(|| {
            format!(
                "failed to validate generated package with {}",
                tool.display()
            )
        })?;
    ensure!(
        output.status.success(),
        "PkgTool validation failed with {}",
        output.status
    );
    let report = String::from_utf8_lossy(&output.stdout);
    ensure!(
        !report.contains("[ERROR]"),
        "generated package failed validation:\n{report}"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_pkg_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bad.pkg");
        std::fs::write(&path, b"nope").unwrap();
        assert!(validate_pkg_header(&path).is_err());
    }
}
