use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};

const OMITTED_TEMPLATE_FILES: &[&str] = &[
    "Project.gp4",
    "sce_sys/about/right.sprx",
    "sce_sys/digests",
    "sce_sys/entry_keys",
    "sce_sys/entry_names",
    "sce_sys/general_digests",
    "sce_sys/icon0.dds",
    "sce_sys/icon1.png",
    "sce_sys/image_key",
    "sce_sys/keystone",
    "sce_sys/metas",
    "sce_sys/pic1.dds",
];

pub fn write(project_root: &Path, payload: &Path, content_id: &str) -> Result<PathBuf> {
    let payload_name = payload
        .file_name()
        .and_then(|name| name.to_str())
        .context("template payload directory has no UTF-8 name")?;
    let mut files = Vec::new();
    collect_files(payload, payload, &mut files)?;
    ensure!(!files.is_empty(), "template payload is empty");
    files.sort();

    let mut tree = Directory::default();
    for file in &files {
        if let Some(parent) = file.parent() {
            tree.insert(parent)?;
        }
    }

    let mut xml = String::new();
    xml.push_str("<?xml version=\"1.0\" encoding=\"utf-8\" standalone=\"yes\"?>\n");
    xml.push_str("<psproject fmt=\"gp4\" version=\"1000\">\n");
    xml.push_str("  <volume>\n");
    xml.push_str("    <volume_type>pkg_ps4_app</volume_type>\n");
    xml.push_str("    <volume_id>PS4VOLUME</volume_id>\n");
    xml.push_str("    <volume_ts>2018-03-21 15:37:08</volume_ts>\n");
    xml.push_str(&format!(
        "    <package content_id=\"{}\" passcode=\"00000000000000000000000000000000\" storage_type=\"digital50\" app_type=\"full\"/>\n",
        escape_xml(content_id)
    ));
    xml.push_str("    <chunk_info chunk_count=\"1\" scenario_count=\"1\">\n");
    xml.push_str("      <chunks><chunk id=\"0\" layer_no=\"0\" label=\"Chunk #0\"/></chunks>\n");
    xml.push_str("      <scenarios default_id=\"0\"><scenario id=\"0\" type=\"sp\" initial_chunk_count=\"1\" label=\"Scenario #0\">0</scenario></scenarios>\n");
    xml.push_str("    </chunk_info>\n");
    xml.push_str("  </volume>\n");
    xml.push_str("  <files img_no=\"0\">\n");
    for file in &files {
        let target = slash_path(file)?;
        let origin = format!("{payload_name}/{target}");
        xml.push_str(&format!(
            "    <file targ_path=\"{}\" orig_path=\"{}\"/>\n",
            escape_xml(&target),
            escape_xml(&origin)
        ));
    }
    xml.push_str("  </files>\n");
    xml.push_str("  <rootdir>\n");
    tree.write_xml(&mut xml, 2);
    xml.push_str("  </rootdir>\n");
    xml.push_str("</psproject>\n");

    let path = project_root.join("PS2Classics.gp4");
    fs::write(&path, xml).with_context(|| format!("failed to write {}", path.display()))?;
    Ok(path)
}

fn collect_files(root: &Path, directory: &Path, output: &mut Vec<PathBuf>) -> Result<()> {
    for entry in fs::read_dir(directory)
        .with_context(|| format!("failed to read {}", directory.display()))?
    {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_symlink() {
            bail!(
                "template contains unsupported symbolic link {}",
                path.display()
            );
        }
        if file_type.is_dir() {
            collect_files(root, &path, output)?;
        } else if file_type.is_file() && entry.file_name() != ".DS_Store" {
            let relative = path.strip_prefix(root).unwrap().to_path_buf();
            if !OMITTED_TEMPLATE_FILES
                .iter()
                .any(|omitted| relative == Path::new(omitted))
            {
                output.push(relative);
            }
        }
    }
    Ok(())
}

#[derive(Default)]
struct Directory {
    children: BTreeMap<String, Directory>,
}

impl Directory {
    fn insert(&mut self, path: &Path) -> Result<()> {
        let mut directory = self;
        for component in path.components() {
            let name = component
                .as_os_str()
                .to_str()
                .context("template contains a non-UTF-8 directory name")?;
            ensure!(
                name.is_ascii(),
                "template directory name {name:?} is not ASCII"
            );
            directory = directory.children.entry(name.to_string()).or_default();
        }
        Ok(())
    }

    fn write_xml(&self, output: &mut String, depth: usize) {
        for (name, child) in &self.children {
            let indentation = "  ".repeat(depth);
            if child.children.is_empty() {
                output.push_str(&format!(
                    "{indentation}<dir targ_name=\"{}\"/>\n",
                    escape_xml(name)
                ));
            } else {
                output.push_str(&format!(
                    "{indentation}<dir targ_name=\"{}\">\n",
                    escape_xml(name)
                ));
                child.write_xml(output, depth + 1);
                output.push_str(&format!("{indentation}</dir>\n"));
            }
        }
    }
}

fn slash_path(path: &Path) -> Result<String> {
    let mut output = String::new();
    for (index, component) in path.components().enumerate() {
        let value = component
            .as_os_str()
            .to_str()
            .context("template contains a non-UTF-8 filename")?;
        ensure!(value.is_ascii(), "template filename {value:?} is not ASCII");
        if index > 0 {
            output.push('/');
        }
        output.push_str(value);
    }
    Ok(output)
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_xml_attributes() {
        assert_eq!(escape_xml("A&B\"C"), "A&amp;B&quot;C");
    }

    #[test]
    fn writes_nested_directories() {
        let mut root = Directory::default();
        root.insert(Path::new("sce_sys/trophy")).unwrap();
        let mut xml = String::new();
        root.write_xml(&mut xml, 0);
        assert!(xml.contains("targ_name=\"sce_sys\""));
        assert!(xml.contains("targ_name=\"trophy\""));
    }
}
