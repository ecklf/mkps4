use std::fs::File;
use std::io::{Read, Write};
use std::path::Path;

use anyhow::{Context, Result, ensure};

const MAGIC: [u8; 4] = [0x00, b'P', b'S', b'F'];
const UTF8_SPECIAL: u16 = 0x0004;
const UTF8: u16 = 0x0204;
const INTEGER: u16 = 0x0404;

#[derive(Clone, Debug)]
pub struct ParamSfo {
    values: Vec<Value>,
}

#[derive(Clone, Debug)]
struct Value {
    name: String,
    format: u16,
    max_len: u32,
    data: Vec<u8>,
}

impl ParamSfo {
    pub fn read(path: &Path) -> Result<Self> {
        let mut bytes = Vec::new();
        File::open(path)
            .with_context(|| format!("failed to open {}", path.display()))?
            .read_to_end(&mut bytes)?;
        Self::parse(&bytes).with_context(|| format!("failed to parse {}", path.display()))
    }

    pub fn default_game() -> Self {
        let mut sfo = Self { values: Vec::new() };
        sfo.set_integer("APP_TYPE", 0);
        sfo.set_string("APP_VER", "01.00", 8);
        sfo.set_integer("ATTRIBUTE", 0);
        sfo.set_string("CATEGORY", "gd", 4);
        sfo.set_string("CONTENT_ID", "UP9000-SLUS20909_00-SLUS209090000001", 48);
        sfo.set_integer("DOWNLOAD_DATA_SIZE", 0);
        sfo.set_string("FORMAT", "obs", 4);
        sfo.set_integer("PARENTAL_LEVEL", 5);
        sfo.set_integer("REMOTE_PLAY_KEY_ASSIGN", 1);
        sfo.set_integer("SYSTEM_VER", 0);
        sfo.set_string("TITLE", "PS2 Classic", 128);
        sfo.set_string("TITLE_ID", "SLUS20909", 12);
        sfo.set_string("VERSION", "01.00", 8);
        sfo
    }

    pub fn update_package(&mut self, content_id: &str, title: &str, title_id: &str) -> Result<()> {
        self.set_string_checked("CONTENT_ID", content_id, 48)?;
        self.set_string_checked("TITLE", title, 128)?;
        self.set_string_checked("TITLE_ID", title_id, 12)?;
        Ok(())
    }

    pub fn write(&self, path: &Path) -> Result<()> {
        let bytes = self.serialize()?;
        let mut output =
            File::create(path).with_context(|| format!("failed to create {}", path.display()))?;
        output.write_all(&bytes)?;
        Ok(())
    }

    fn parse(bytes: &[u8]) -> Result<Self> {
        ensure!(bytes.len() >= 20, "SFO header is truncated");
        ensure!(bytes[..4] == MAGIC, "file is missing SFO magic");
        let keys_offset = le_u32(bytes, 8)? as usize;
        let data_offset = le_u32(bytes, 12)? as usize;
        let count = le_u32(bytes, 16)? as usize;
        ensure!(
            20 + count * 16 <= bytes.len(),
            "SFO index table is truncated"
        );
        ensure!(
            keys_offset <= bytes.len() && data_offset <= bytes.len(),
            "invalid SFO table offset"
        );

        let mut values = Vec::with_capacity(count);
        for index in 0..count {
            let entry = 20 + index * 16;
            let key_offset = le_u16(bytes, entry)? as usize;
            let format = le_u16(bytes, entry + 2)?;
            let len = le_u32(bytes, entry + 4)? as usize;
            let max_len = le_u32(bytes, entry + 8)?;
            let value_offset = le_u32(bytes, entry + 12)? as usize;
            ensure!(
                matches!(format, UTF8_SPECIAL | UTF8 | INTEGER),
                "unsupported SFO value format 0x{format:04x}"
            );

            let key_start = keys_offset
                .checked_add(key_offset)
                .context("SFO key offset overflow")?;
            ensure!(
                key_start < bytes.len(),
                "SFO key offset is outside the file"
            );
            let key_end = bytes[key_start..]
                .iter()
                .position(|byte| *byte == 0)
                .map(|offset| key_start + offset)
                .context("SFO key is not null terminated")?;
            let name = std::str::from_utf8(&bytes[key_start..key_end])
                .context("SFO key is not ASCII/UTF-8")?
                .to_string();

            let value_start = data_offset
                .checked_add(value_offset)
                .context("SFO data offset overflow")?;
            let value_end = value_start
                .checked_add(len)
                .context("SFO value length overflow")?;
            ensure!(value_end <= bytes.len(), "SFO value is truncated");
            values.push(Value {
                name,
                format,
                max_len,
                data: bytes[value_start..value_end].to_vec(),
            });
        }
        Ok(Self { values })
    }

    fn serialize(&self) -> Result<Vec<u8>> {
        let mut values = self.values.clone();
        values.sort_by(|left, right| left.name.cmp(&right.name));
        for value in &values {
            ensure!(value.name.is_ascii(), "SFO key {} is not ASCII", value.name);
            ensure!(
                value.data.len() <= value.max_len as usize,
                "SFO value {} exceeds its reserved size",
                value.name
            );
        }

        let keys_offset = 20 + values.len() * 16;
        let key_size: usize = values.iter().map(|value| value.name.len() + 1).sum();
        let data_offset = align_up(keys_offset + key_size, 4);
        let data_size: usize = values.iter().map(|value| value.max_len as usize).sum();
        let mut output = vec![0u8; data_offset + data_size];
        output[..4].copy_from_slice(&MAGIC);
        output[4..8].copy_from_slice(&0x0000_0101u32.to_le_bytes());
        output[8..12].copy_from_slice(&(keys_offset as u32).to_le_bytes());
        output[12..16].copy_from_slice(&(data_offset as u32).to_le_bytes());
        output[16..20].copy_from_slice(&(values.len() as u32).to_le_bytes());

        let mut key_cursor = 0usize;
        let mut data_cursor = 0usize;
        for (index, value) in values.iter().enumerate() {
            let entry = 20 + index * 16;
            output[entry..entry + 2].copy_from_slice(&(key_cursor as u16).to_le_bytes());
            output[entry + 2..entry + 4].copy_from_slice(&value.format.to_le_bytes());
            output[entry + 4..entry + 8].copy_from_slice(&(value.data.len() as u32).to_le_bytes());
            output[entry + 8..entry + 12].copy_from_slice(&value.max_len.to_le_bytes());
            output[entry + 12..entry + 16].copy_from_slice(&(data_cursor as u32).to_le_bytes());

            let key_start = keys_offset + key_cursor;
            output[key_start..key_start + value.name.len()].copy_from_slice(value.name.as_bytes());
            let value_start = data_offset + data_cursor;
            output[value_start..value_start + value.data.len()].copy_from_slice(&value.data);
            key_cursor += value.name.len() + 1;
            data_cursor += value.max_len as usize;
        }
        Ok(output)
    }

    fn set_string_checked(&mut self, name: &str, value: &str, default_max_len: u32) -> Result<()> {
        ensure!(
            !value.as_bytes().contains(&0),
            "SFO value {name} contains a null byte"
        );
        let required = value.len() + 1;
        let max_len = self
            .values
            .iter()
            .find(|entry| entry.name == name)
            .map(|entry| entry.max_len)
            .unwrap_or(default_max_len);
        ensure!(
            required <= max_len as usize,
            "{name} is too long for the SFO field ({required} > {max_len} bytes)"
        );
        self.set_string(name, value, max_len);
        Ok(())
    }

    fn set_string(&mut self, name: &str, value: &str, max_len: u32) {
        let mut data = value.as_bytes().to_vec();
        data.push(0);
        self.set(Value {
            name: name.to_string(),
            format: UTF8,
            max_len,
            data,
        });
    }

    fn set_integer(&mut self, name: &str, value: u32) {
        self.set(Value {
            name: name.to_string(),
            format: INTEGER,
            max_len: 4,
            data: value.to_le_bytes().to_vec(),
        });
    }

    fn set(&mut self, value: Value) {
        self.values.retain(|entry| entry.name != value.name);
        self.values.push(value);
    }
}

fn le_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let value = bytes
        .get(offset..offset + 2)
        .context("truncated 16-bit SFO field")?;
    Ok(u16::from_le_bytes(value.try_into().unwrap()))
}

fn le_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let value = bytes
        .get(offset..offset + 4)
        .context("truncated 32-bit SFO field")?;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}

fn align_up(value: usize, alignment: usize) -> usize {
    value.div_ceil(alignment) * alignment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_sfo_round_trips() {
        let original = ParamSfo::default_game();
        let bytes = original.serialize().unwrap();
        let parsed = ParamSfo::parse(&bytes).unwrap();
        assert_eq!(parsed.values.len(), original.values.len());
        assert!(parsed.values.iter().any(|value| value.name == "TITLE_ID"));
    }

    #[test]
    fn rejects_oversized_title_id() {
        let mut sfo = ParamSfo::default_game();
        assert!(
            sfo.update_package(
                "UP9000-SLUS20909_00-SLUS209090000001",
                "Title",
                "TOO-LONG-TITLE-ID"
            )
            .is_err()
        );
    }
}
