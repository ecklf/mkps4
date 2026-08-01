use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};

const ISO_SECTOR_SIZE: usize = 2048;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Serial {
    pub original: String,
    pub title_id: String,
    pub emulator_id: String,
}

pub fn inspect(path: &Path) -> Result<Serial> {
    let mut source = DiscSource::open(path)?;
    let cnf = read_root_file(&mut source, "SYSTEM.CNF")?;
    parse_system_cnf(&cnf)
        .with_context(|| format!("could not detect a PS2 serial in {}", path.display()))
}

pub fn convert_to_iso(source: &Path, destination: &Path) -> Result<()> {
    match extension(source).as_deref() {
        Some("iso") => {
            std::fs::copy(source, destination).with_context(|| {
                format!(
                    "failed to copy {} to {}",
                    source.display(),
                    destination.display()
                )
            })?;
        }
        Some("cue") => {
            let mut disc = CueDisc::open(source)?;
            let output = File::create(destination)
                .with_context(|| format!("failed to create {}", destination.display()))?;
            let mut output = BufWriter::new(output);
            let mut sector = [0u8; ISO_SECTOR_SIZE];
            for index in 0..disc.sector_count {
                disc.read_sector(index, &mut sector)?;
                output.write_all(&sector)?;
            }
            output.flush()?;
        }
        _ => bail!("{} is not an ISO or CUE file", source.display()),
    }
    Ok(())
}

fn extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
}

enum DiscSource {
    Iso(File),
    Cue(CueDisc),
}

impl DiscSource {
    fn open(path: &Path) -> Result<Self> {
        match extension(path).as_deref() {
            Some("iso") => {
                Ok(Self::Iso(File::open(path).with_context(|| {
                    format!("failed to open {}", path.display())
                })?))
            }
            Some("cue") => Ok(Self::Cue(CueDisc::open(path)?)),
            _ => bail!("{} is not an ISO or CUE file", path.display()),
        }
    }

    fn read_sector(&mut self, sector: u64, output: &mut [u8; ISO_SECTOR_SIZE]) -> Result<()> {
        match self {
            Self::Iso(file) => {
                file.seek(SeekFrom::Start(sector * ISO_SECTOR_SIZE as u64))?;
                file.read_exact(output)
                    .with_context(|| format!("failed to read ISO sector {sector}"))
            }
            Self::Cue(cue) => cue.read_sector(sector, output),
        }
    }
}

#[derive(Debug)]
struct CueDisc {
    file: File,
    file_path: PathBuf,
    start: u64,
    sector_count: u64,
    raw_sector_size: u64,
    user_data_offset: u64,
}

impl CueDisc {
    fn open(cue_path: &Path) -> Result<Self> {
        let cue = File::open(cue_path)
            .with_context(|| format!("failed to open {}", cue_path.display()))?;
        let parsed = parse_cue(BufReader::new(cue), cue_path)?;
        let file = File::open(&parsed.file_path)
            .with_context(|| format!("failed to open {}", parsed.file_path.display()))?;
        let file_size = file.metadata()?.len();
        let start = parsed
            .start_frame
            .checked_mul(parsed.raw_sector_size)
            .context("CUE track offset overflow")?;
        ensure!(
            start < file_size,
            "CUE data track starts beyond the end of the BIN file"
        );

        let end = match parsed.end_frame {
            Some(frame) => frame
                .checked_mul(parsed.raw_sector_size)
                .context("CUE track end overflow")?
                .min(file_size),
            None => file_size,
        };
        ensure!(end > start, "CUE data track is empty");
        ensure!(
            (end - start) % parsed.raw_sector_size == 0,
            "BIN data-track size is not a whole number of sectors"
        );

        Ok(Self {
            file,
            file_path: parsed.file_path,
            start,
            sector_count: (end - start) / parsed.raw_sector_size,
            raw_sector_size: parsed.raw_sector_size,
            user_data_offset: parsed.user_data_offset,
        })
    }

    fn read_sector(&mut self, sector: u64, output: &mut [u8; ISO_SECTOR_SIZE]) -> Result<()> {
        ensure!(
            sector < self.sector_count,
            "sector {sector} is outside the CUE data track"
        );
        let offset = self.start + sector * self.raw_sector_size + self.user_data_offset;
        self.file.seek(SeekFrom::Start(offset))?;
        self.file.read_exact(output).with_context(|| {
            format!(
                "failed to read sector {sector} from {}",
                self.file_path.display()
            )
        })
    }
}

struct ParsedCue {
    file_path: PathBuf,
    start_frame: u64,
    end_frame: Option<u64>,
    raw_sector_size: u64,
    user_data_offset: u64,
}

fn parse_cue(reader: impl BufRead, cue_path: &Path) -> Result<ParsedCue> {
    let mut current_file: Option<PathBuf> = None;
    let mut first_file: Option<PathBuf> = None;
    let mut current_track: Option<(u32, String)> = None;
    let mut data_track: Option<(PathBuf, u64, u64, u64)> = None;
    let mut end_frame = None;

    for (line_number, line) in reader.lines().enumerate() {
        let line = line.with_context(|| format!("failed to read CUE line {}", line_number + 1))?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("REM ") {
            continue;
        }

        if let Some(rest) = strip_keyword(trimmed, "FILE") {
            let name = parse_cue_filename(rest)
                .with_context(|| format!("invalid FILE on CUE line {}", line_number + 1))?;
            let portable_name = name.replace('\\', "/");
            let path = cue_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join(portable_name);
            if let Some(first) = &first_file {
                ensure!(
                    first == &path,
                    "multi-file CUE sheets are not supported; convert this image to ISO first"
                );
            } else {
                first_file = Some(path.clone());
            }
            current_file = Some(path);
            current_track = None;
            continue;
        }

        if let Some(rest) = strip_keyword(trimmed, "TRACK") {
            let mut parts = rest.split_whitespace();
            let number = parts
                .next()
                .context("TRACK is missing its number")?
                .parse::<u32>()
                .context("invalid CUE track number")?;
            let mode = parts
                .next()
                .context("TRACK is missing its mode")?
                .to_ascii_uppercase();
            ensure!(
                current_file.is_some(),
                "TRACK appears before FILE in the CUE sheet"
            );
            current_track = Some((number, mode));
            continue;
        }

        if let Some(rest) = strip_keyword(trimmed, "INDEX") {
            let mut parts = rest.split_whitespace();
            let index = parts.next().context("INDEX is missing its number")?;
            let frame = parse_frame(parts.next().context("INDEX is missing its timestamp")?)?;
            if index != "01" {
                continue;
            }
            let Some((_, mode)) = &current_track else {
                bail!("INDEX appears before TRACK in the CUE sheet");
            };
            if data_track.is_none() {
                if let Some((raw_size, user_offset)) = cue_mode(mode) {
                    data_track = Some((
                        current_file.clone().context("CUE data track has no FILE")?,
                        frame,
                        raw_size,
                        user_offset,
                    ));
                }
            } else if end_frame.is_none() {
                end_frame = Some(frame);
            }
        }
    }

    let (file_path, start_frame, raw_sector_size, user_data_offset) = data_track.context(
        "CUE sheet has no supported data track (MODE1/2048, MODE1/2352, MODE2/2336, or MODE2/2352)",
    )?;
    Ok(ParsedCue {
        file_path,
        start_frame,
        end_frame,
        raw_sector_size,
        user_data_offset,
    })
}

fn strip_keyword<'a>(line: &'a str, keyword: &str) -> Option<&'a str> {
    let (head, rest) = line.split_once(char::is_whitespace)?;
    head.eq_ignore_ascii_case(keyword).then(|| rest.trim())
}

fn parse_cue_filename(rest: &str) -> Result<&str> {
    if let Some(rest) = rest.strip_prefix('"') {
        let end = rest.find('"').context("unterminated quoted CUE filename")?;
        return Ok(&rest[..end]);
    }
    rest.split_whitespace()
        .next()
        .context("missing CUE filename")
}

fn parse_frame(value: &str) -> Result<u64> {
    let mut fields = value.split(':');
    let minutes = fields
        .next()
        .context("missing CUE minutes")?
        .parse::<u64>()?;
    let seconds = fields
        .next()
        .context("missing CUE seconds")?
        .parse::<u64>()?;
    let frames = fields
        .next()
        .context("missing CUE frames")?
        .parse::<u64>()?;
    ensure!(
        fields.next().is_none() && seconds < 60 && frames < 75,
        "invalid CUE timestamp {value}"
    );
    Ok((minutes * 60 + seconds) * 75 + frames)
}

fn cue_mode(mode: &str) -> Option<(u64, u64)> {
    match mode {
        "MODE1/2048" => Some((2048, 0)),
        "MODE1/2352" => Some((2352, 16)),
        "MODE2/2336" => Some((2336, 8)),
        "MODE2/2352" => Some((2352, 24)),
        _ => None,
    }
}

fn read_root_file(source: &mut DiscSource, requested_name: &str) -> Result<Vec<u8>> {
    let mut sector = [0u8; ISO_SECTOR_SIZE];
    let mut found_primary = false;
    for index in 16..64 {
        source.read_sector(index, &mut sector)?;
        ensure!(
            &sector[1..6] == b"CD001",
            "invalid ISO9660 volume descriptor"
        );
        if sector[0] == 1 {
            found_primary = true;
            break;
        }
        if sector[0] == 255 {
            break;
        }
    }
    ensure!(
        found_primary,
        "disc does not contain an ISO9660 primary volume descriptor"
    );
    let root = parse_directory_record(&sector[156..])?;
    ensure!(
        root.size <= 16 * 1024 * 1024,
        "ISO root directory is unreasonably large"
    );

    let sectors = (root.size as usize).div_ceil(ISO_SECTOR_SIZE);
    let mut directory = vec![0u8; sectors * ISO_SECTOR_SIZE];
    for index in 0..sectors {
        source.read_sector(root.extent as u64 + index as u64, &mut sector)?;
        directory[index * ISO_SECTOR_SIZE..(index + 1) * ISO_SECTOR_SIZE].copy_from_slice(&sector);
    }

    let mut offset = 0usize;
    while offset < root.size as usize {
        let length = directory[offset] as usize;
        if length == 0 {
            offset = (offset / ISO_SECTOR_SIZE + 1) * ISO_SECTOR_SIZE;
            continue;
        }
        ensure!(
            offset + length <= directory.len(),
            "invalid ISO directory record"
        );
        let record = parse_directory_record(&directory[offset..offset + length])?;
        let name = record.name.split(';').next().unwrap_or(&record.name);
        if name.eq_ignore_ascii_case(requested_name) {
            ensure!(
                record.size <= 1024 * 1024,
                "{requested_name} is unreasonably large"
            );
            let mut output = vec![0u8; record.size as usize];
            let file_sectors = (record.size as usize).div_ceil(ISO_SECTOR_SIZE);
            for index in 0..file_sectors {
                source.read_sector(record.extent as u64 + index as u64, &mut sector)?;
                let start = index * ISO_SECTOR_SIZE;
                let end = (start + ISO_SECTOR_SIZE).min(output.len());
                output[start..end].copy_from_slice(&sector[..end - start]);
            }
            return Ok(output);
        }
        offset += length;
    }
    bail!("ISO root directory does not contain {requested_name}")
}

struct DirectoryRecord {
    extent: u32,
    size: u32,
    name: String,
}

fn parse_directory_record(bytes: &[u8]) -> Result<DirectoryRecord> {
    ensure!(bytes.len() >= 34, "truncated ISO directory record");
    let length = bytes[0] as usize;
    ensure!(
        length >= 34 && length <= bytes.len(),
        "invalid ISO directory record length"
    );
    let name_length = bytes[32] as usize;
    ensure!(33 + name_length <= length, "invalid ISO filename length");
    let name = String::from_utf8_lossy(&bytes[33..33 + name_length]).into_owned();
    Ok(DirectoryRecord {
        extent: u32::from_le_bytes(bytes[2..6].try_into().unwrap()),
        size: u32::from_le_bytes(bytes[10..14].try_into().unwrap()),
        name,
    })
}

fn parse_system_cnf(bytes: &[u8]) -> Result<Serial> {
    let text = String::from_utf8_lossy(bytes);
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.trim().eq_ignore_ascii_case("BOOT2") && !key.trim().eq_ignore_ascii_case("BOOT") {
            continue;
        }
        let executable = value
            .trim()
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or(value)
            .split(';')
            .next()
            .unwrap_or(value)
            .trim();
        if let Some(serial) = normalize_serial(executable) {
            return Ok(serial);
        }
    }
    bail!("SYSTEM.CNF has no recognized BOOT/BOOT2 serial")
}

fn normalize_serial(value: &str) -> Option<Serial> {
    let upper = value.to_ascii_uppercase();
    let compact: String = upper
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .collect();
    if compact.len() != 9
        || !compact[..4].bytes().all(|byte| byte.is_ascii_alphabetic())
        || !compact[4..].bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    Some(Serial {
        original: value.to_string(),
        emulator_id: format!("{}-{}", &compact[..4], &compact[4..]),
        title_id: compact,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directory_record(extent: u32, size: u32, name: &[u8], directory: bool) -> Vec<u8> {
        let length = 33 + name.len() + usize::from(name.len().is_multiple_of(2));
        let mut record = vec![0u8; length];
        record[0] = length as u8;
        record[2..6].copy_from_slice(&extent.to_le_bytes());
        record[6..10].copy_from_slice(&extent.to_be_bytes());
        record[10..14].copy_from_slice(&size.to_le_bytes());
        record[14..18].copy_from_slice(&size.to_be_bytes());
        record[25] = u8::from(directory) * 2;
        record[28..30].copy_from_slice(&1u16.to_le_bytes());
        record[30..32].copy_from_slice(&1u16.to_be_bytes());
        record[32] = name.len() as u8;
        record[33..33 + name.len()].copy_from_slice(name);
        record
    }

    fn synthetic_iso() -> Vec<u8> {
        let mut iso = vec![0u8; 24 * ISO_SECTOR_SIZE];
        let pvd = 16 * ISO_SECTOR_SIZE;
        iso[pvd] = 1;
        iso[pvd + 1..pvd + 6].copy_from_slice(b"CD001");
        iso[pvd + 6] = 1;
        let root = directory_record(20, ISO_SECTOR_SIZE as u32, &[0], true);
        iso[pvd + 156..pvd + 156 + root.len()].copy_from_slice(&root);

        let directory = 20 * ISO_SECTOR_SIZE;
        let file = directory_record(21, 48, b"SYSTEM.CNF;1", false);
        iso[directory..directory + file.len()].copy_from_slice(&file);
        let contents = b"BOOT2 = cdrom0:\\SLUS_209.09;1\r\nVER = 1.00\r\n";
        iso[21 * ISO_SECTOR_SIZE..21 * ISO_SECTOR_SIZE + contents.len()].copy_from_slice(contents);
        iso
    }

    #[test]
    fn parses_system_cnf_serial() {
        let serial = parse_system_cnf(b"VER = 1.00\r\nBOOT2 = cdrom0:\\SLUS_209.09;1\r\n").unwrap();
        assert_eq!(serial.original, "SLUS_209.09");
        assert_eq!(serial.title_id, "SLUS20909");
        assert_eq!(serial.emulator_id, "SLUS-20909");
    }

    #[test]
    fn parses_quoted_cue() {
        let cue = b"FILE \"game disc.bin\" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:02:00\n  TRACK 02 AUDIO\n    INDEX 01 12:00:00\n";
        let parsed = parse_cue(&cue[..], Path::new("/tmp/game.cue")).unwrap();
        assert_eq!(parsed.file_path, Path::new("/tmp/game disc.bin"));
        assert_eq!(parsed.start_frame, 150);
        assert_eq!(parsed.end_frame, Some(54_000));
        assert_eq!(parsed.user_data_offset, 24);
    }

    #[test]
    fn rejects_invalid_serial() {
        assert!(normalize_serial("NOT_A_SERIAL").is_none());
    }

    #[test]
    fn inspects_iso9660_root_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("game.iso");
        std::fs::write(&path, synthetic_iso()).unwrap();
        assert_eq!(inspect(&path).unwrap().title_id, "SLUS20909");
    }

    #[test]
    fn inspects_raw_mode1_cue() {
        let directory = tempfile::tempdir().unwrap();
        let bin_path = directory.path().join("game.bin");
        let cue_path = directory.path().join("game.cue");
        let mut raw = Vec::new();
        for sector in synthetic_iso().chunks_exact(ISO_SECTOR_SIZE) {
            raw.extend_from_slice(&[0u8; 16]);
            raw.extend_from_slice(sector);
            raw.extend_from_slice(&[0u8; 288]);
        }
        std::fs::write(bin_path, raw).unwrap();
        std::fs::write(
            &cue_path,
            "FILE \"game.bin\" BINARY\n  TRACK 01 MODE1/2352\n    INDEX 01 00:00:00\n",
        )
        .unwrap();
        assert_eq!(inspect(&cue_path).unwrap().title_id, "SLUS20909");
    }
}
