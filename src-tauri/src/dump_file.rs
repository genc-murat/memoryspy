//! Read file identity and module metadata directly from an on-disk dump.

use std::fs::{File, Metadata};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

use sha2::{Digest, Sha256};

pub fn fingerprint(path: &Path) -> io::Result<String> {
    if !path.metadata()?.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Choose a memory dump file.",
        ));
    }
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Choose a non-empty memory dump file.",
        ));
    }
    let mut hash = Sha256::new();
    hash.update(path.to_string_lossy().as_bytes());
    hash.update(file_stamp(&metadata));
    // Inspect a small amount of data even for a multi-gigabyte dump.
    let mut block = [0; 4096];
    let size = metadata.len().min(block.len() as u64) as usize;
    file.read_exact(&mut block[..size])?;
    hash.update(&block[..size]);
    if metadata.len() > size as u64 {
        file.seek(SeekFrom::End(-(size as i64)))?;
        file.read_exact(&mut block[..size])?;
        hash.update(&block[..size]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

fn file_stamp(metadata: &Metadata) -> String {
    let stamp = format!(
        "{}|{:?}|{:?}",
        metadata.len(),
        metadata.modified().ok(),
        metadata.created().ok()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{stamp}|{}|{}|{}|{}",
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec()
        )
    }
    #[cfg(not(unix))]
    {
        stamp
    }
}

#[derive(Clone, Copy)]
struct Range {
    address: u64,
    file_offset: u64,
    size: u64,
}

struct DumpMemory {
    file: File,
    ranges: Vec<Range>,
}

pub fn module_mvid(path: &Path, metadata_address: u64, metadata_size: u64) -> io::Result<String> {
    let end = metadata_address
        .checked_add(metadata_size)
        .ok_or_else(|| invalid("Invalid metadata range."))?;
    let mut memory = DumpMemory::open(path, metadata_address..end)?;
    let mut read = |offset: u64, length: usize| {
        if offset
            .checked_add(length as u64)
            .filter(|end| *end <= metadata_size)
            .is_none()
        {
            return Err(invalid("Module metadata is incomplete in the dump."));
        }
        memory.read(
            metadata_address
                .checked_add(offset)
                .ok_or_else(|| invalid("Invalid metadata address."))?,
            length,
        )
    };
    let header = read(0, 16)?;
    if &header[..4] != b"BSJB" {
        return Err(invalid("Module metadata is unavailable in the dump."));
    }
    let version_size = u64::from(le32(&header[12..]));
    let flags_offset = 16 + ((version_size + 3) & !3);
    let stream_count = le16(&read(flags_offset, 4)?[2..]);
    let mut header_offset = flags_offset + 4;
    let mut tables = None;
    let mut guids = None;
    for _ in 0..stream_count {
        let stream = read(header_offset, 8)?;
        let offset = u64::from(le32(&stream));
        let size = u64::from(le32(&stream[4..]));
        let name = read(header_offset + 8, 32)?;
        let length = name
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| invalid("Invalid metadata stream name."))?;
        match &name[..length] {
            b"#~" | b"#-" => tables = Some((offset, size)),
            b"#GUID" => guids = Some((offset, size)),
            _ => {}
        }
        header_offset += 8 + ((length as u64 + 4) & !3);
        if tables.is_some() && guids.is_some() {
            break;
        }
    }

    let ((table_offset, table_size), (guid_offset, guid_size)) = tables
        .zip(guids)
        .ok_or_else(|| invalid("The dump is missing the module identity streams."))?;
    if table_size < 28 {
        return Err(invalid("Invalid metadata table."));
    }
    let table = read(table_offset, 28)?;
    let heap_sizes = table[6];
    let valid_tables = le64(&table[8..]);
    // Module is table zero, so its row is the first after the array of row counts.
    if valid_tables & 1 == 0 || le32(&table[24..]) != 1 {
        return Err(invalid("No module definition in the dump metadata."));
    }
    let string_width = if heap_sizes & 1 == 0 { 2 } else { 4 };
    let guid_width = if heap_sizes & 2 == 0 { 2 } else { 4 };
    let extra_data = if heap_sizes & 0x40 == 0 { 0 } else { 4 };
    let index_offset =
        24 + u64::from(valid_tables.count_ones()) * 4 + extra_data + 2 + string_width;
    if index_offset + guid_width as u64 > table_size {
        return Err(invalid("Invalid module definition."));
    }
    let index_bytes = read(table_offset + index_offset, guid_width)?;
    let guid_index = if guid_width == 2 {
        u32::from(le16(&index_bytes))
    } else {
        le32(&index_bytes)
    };
    let guid_index = guid_index
        .checked_sub(1)
        .ok_or_else(|| invalid("The module has no MVID."))?;
    let position = u64::from(guid_index) * 16;
    if position + 16 > guid_size {
        return Err(invalid("The module MVID is outside the GUID heap."));
    }
    let mvid = read(guid_offset + position, 16)?;
    if mvid.iter().all(|byte| *byte == 0) {
        return Err(invalid("The dump contains an empty module MVID."));
    }
    Ok(format!("mvid:{}", hex(&mvid)))
}

/// A Windows heap dump may omit metadata pages. Its minidump module stream can
/// independently identify the matching PDB through the recorded CodeView record.
pub fn codeview(path: &Path, image_base: u64) -> io::Result<String> {
    let mut file = File::open(path)?;
    let (stream, size) =
        minidump_stream(&mut file, 4)?.ok_or_else(|| invalid("No module list in the minidump."))?;
    let count = u64::from(le32(&read_at(&mut file, stream, 4)?));
    if 4 + count * 108 > size {
        return Err(invalid("Invalid minidump module list."));
    }
    for index in 0..count {
        let entry = read_at(&mut file, stream + 4 + index * 108, 84)?;
        if le64(&entry) != image_base {
            continue;
        }
        let length = le32(&entry[76..]);
        let offset = u64::from(le32(&entry[80..]));
        if length < 24 || offset == 0 {
            break;
        }
        let record = read_at(&mut file, offset, 24)?;
        if &record[..4] == b"RSDS" && record[4..20].iter().any(|byte| *byte != 0) {
            return Ok(format!(
                "codeview:{}:{}",
                hex(&record[4..20]),
                le32(&record[20..])
            ));
        }
        break;
    }
    Err(invalid("No matching CodeView record in the minidump."))
}

impl DumpMemory {
    fn open(path: &Path, interest: std::ops::Range<u64>) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let header = read_at(&mut file, 0, 64)?;
        let mut ranges = match &header[..4] {
            b"MDMP" => minidump_ranges(&mut file, &interest)?,
            b"\x7fELF" if header[5] == 1 => elf_ranges(&mut file, &header, &interest)?,
            b"\xcf\xfa\xed\xfe" => macho_ranges(&mut file, &header, &interest)?,
            _ => {
                return Err(invalid(
                    "The dump format does not support module identity verification.",
                ))
            }
        };
        let file_size = file.metadata()?.len();
        ranges.retain(|range| range.size != 0 && range.file_offset < file_size);
        // A partly written dump can still contain readable pages from a descriptor.
        for range in &mut ranges {
            range.size = range.size.min(file_size - range.file_offset);
        }
        ranges.sort_by_key(|range| range.address);
        Ok(Self { file, ranges })
    }

    fn read(&mut self, mut address: u64, length: usize) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::with_capacity(length);
        while bytes.len() < length {
            let range = self.ranges[..self
                .ranges
                .partition_point(|range| range.address <= address)]
                .iter()
                .rev()
                .find(|range| address - range.address < range.size)
                .ok_or_else(|| invalid("Module metadata pages are missing from the dump."))?;
            let offset = address - range.address;
            let available =
                (length - bytes.len()).min((range.size - offset).try_into().unwrap_or(usize::MAX));
            bytes.extend(read_at(
                &mut self.file,
                range.file_offset + offset,
                available,
            )?);
            address = address
                .checked_add(available as u64)
                .ok_or_else(|| invalid("Invalid dump address."))?;
        }
        Ok(bytes)
    }
}

fn minidump_stream(file: &mut File, kind: u32) -> io::Result<Option<(u64, u64)>> {
    let header = read_at(file, 0, 16)?;
    if &header[..4] != b"MDMP" {
        return Ok(None);
    }
    let count = u64::from(le32(&header[8..]));
    let offset = u64::from(le32(&header[12..]));
    checked_table(file, offset, count, 12)?;
    for index in 0..count {
        let entry = read_at(file, offset + index * 12, 12)?;
        if le32(&entry) == kind {
            return Ok(Some((
                u64::from(le32(&entry[8..])),
                u64::from(le32(&entry[4..])),
            )));
        }
    }
    Ok(None)
}

fn minidump_ranges(file: &mut File, interest: &std::ops::Range<u64>) -> io::Result<Vec<Range>> {
    let mut ranges = Vec::new();
    if let Some((offset, size)) = minidump_stream(file, 9)? {
        let header = read_at(file, offset, 16)?;
        let count = le64(&header);
        let mut file_offset = le64(&header[8..]);
        if count > size.saturating_sub(16) / 16 {
            return Err(invalid("Invalid minidump memory64 list."));
        }
        checked_table(file, offset + 16, count, 16)?;
        for index in 0..count {
            let entry = read_at(file, offset + 16 + index * 16, 16)?;
            let size = le64(&entry[8..]);
            include_range(
                &mut ranges,
                interest,
                Range {
                    address: le64(&entry),
                    file_offset,
                    size,
                },
            );
            file_offset = file_offset
                .checked_add(size)
                .ok_or_else(|| invalid("Invalid minidump memory offset."))?;
        }
    }
    if let Some((offset, size)) = minidump_stream(file, 5)? {
        let count = u64::from(le32(&read_at(file, offset, 4)?));
        if count > size.saturating_sub(4) / 16 {
            return Err(invalid("Invalid minidump memory list."));
        }
        checked_table(file, offset + 4, count, 16)?;
        for index in 0..count {
            let entry = read_at(file, offset + 4 + index * 16, 16)?;
            include_range(
                &mut ranges,
                interest,
                Range {
                    address: le64(&entry),
                    size: u64::from(le32(&entry[8..])),
                    file_offset: u64::from(le32(&entry[12..])),
                },
            );
        }
    }
    Ok(ranges)
}

fn elf_ranges(
    file: &mut File,
    header: &[u8],
    interest: &std::ops::Range<u64>,
) -> io::Result<Vec<Range>> {
    let (offset, stride, mut count, section_offset, info_offset, minimum) = match header[4] {
        2 => (
            le64(&header[32..]),
            le16(&header[54..]),
            u64::from(le16(&header[56..])),
            le64(&header[40..]),
            44,
            56,
        ),
        1 => (
            u64::from(le32(&header[28..])),
            le16(&header[42..]),
            u64::from(le16(&header[44..])),
            u64::from(le32(&header[32..])),
            28,
            32,
        ),
        _ => return Err(invalid("Invalid ELF dump class.")),
    };
    if count == 0xffff {
        let info = section_offset
            .checked_add(info_offset)
            .ok_or_else(|| invalid("Invalid ELF section offset."))?;
        count = u64::from(le32(&read_at(file, info, 4)?));
    }
    if usize::from(stride) < minimum {
        return Err(invalid("Invalid ELF program header."));
    }
    let stride = u64::from(stride);
    checked_table(file, offset, count, stride)?;
    let mut ranges = Vec::new();
    for index in 0..count {
        let entry = read_at(file, offset + index * stride, minimum)?;
        if le32(&entry) != 1 {
            continue;
        }
        include_range(
            &mut ranges,
            interest,
            if header[4] == 2 {
                Range {
                    file_offset: le64(&entry[8..]),
                    address: le64(&entry[16..]),
                    size: le64(&entry[32..]),
                }
            } else {
                Range {
                    file_offset: u64::from(le32(&entry[4..])),
                    address: u64::from(le32(&entry[8..])),
                    size: u64::from(le32(&entry[16..])),
                }
            },
        );
    }
    Ok(ranges)
}

fn macho_ranges(
    file: &mut File,
    header: &[u8],
    interest: &std::ops::Range<u64>,
) -> io::Result<Vec<Range>> {
    let count = le32(&header[16..]);
    let end = 32 + u64::from(le32(&header[20..]));
    if end > file.metadata()?.len() {
        return Err(invalid("Invalid Mach-O load commands."));
    }
    let mut offset = 32;
    let mut ranges = Vec::new();
    for _ in 0..count {
        let command = read_at(file, offset, 8)?;
        let size = u64::from(le32(&command[4..]));
        if size < 8 || offset + size > end {
            return Err(invalid("Invalid Mach-O segment."));
        }
        if le32(&command) == 0x19 && size >= 72 {
            let entry = read_at(file, offset, 56)?;
            include_range(
                &mut ranges,
                interest,
                Range {
                    address: le64(&entry[24..]),
                    file_offset: le64(&entry[40..]),
                    size: le64(&entry[48..]),
                },
            );
        }
        offset += size;
    }
    Ok(ranges)
}

fn include_range(ranges: &mut Vec<Range>, interest: &std::ops::Range<u64>, range: Range) {
    if range.address < interest.end && range.address.saturating_add(range.size) > interest.start {
        ranges.push(range);
    }
}

fn checked_table(file: &File, offset: u64, count: u64, stride: u64) -> io::Result<()> {
    let length = file.metadata()?.len();
    if offset > length || count > (length - offset) / stride {
        return Err(invalid("Invalid dump table size."));
    }
    Ok(())
}

fn read_at(file: &mut File, offset: u64, length: usize) -> io::Result<Vec<u8>> {
    let mut data = vec![0; length];
    file.seek(SeekFrom::Start(offset))?;
    file.read_exact(&mut data)?;
    Ok(data)
}

fn le16(bytes: &[u8]) -> u16 {
    u16::from_le_bytes(bytes[..2].try_into().unwrap())
}

fn le32(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes[..4].try_into().unwrap())
}

fn le64(bytes: &[u8]) -> u64 {
    u64::from_le_bytes(bytes[..8].try_into().unwrap())
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut text = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(text, "{byte:02x}").unwrap();
    }
    text
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Self {
            Self(
                std::env::temp_dir()
                    .join(format!("memoryspy-dump-{name}-{}.dmp", std::process::id())),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    const GUID: [u8; 16] = [0x12; 16];
    const MVID: &str = "mvid:12121212121212121212121212121212";

    fn put(buffer: &mut [u8], offset: usize, bytes: &[u8]) {
        buffer[offset..offset + bytes.len()].copy_from_slice(bytes);
    }

    fn metadata() -> Vec<u8> {
        let mut bytes = vec![0; 144];
        put(&mut bytes, 0, b"BSJB");
        put(&mut bytes, 12, &12u32.to_le_bytes());
        put(&mut bytes, 30, &2u16.to_le_bytes());
        put(&mut bytes, 32, &80u32.to_le_bytes());
        put(&mut bytes, 36, &40u32.to_le_bytes());
        put(&mut bytes, 40, b"#~\0");
        put(&mut bytes, 44, &128u32.to_le_bytes());
        put(&mut bytes, 48, &16u32.to_le_bytes());
        put(&mut bytes, 52, b"#GUID\0");
        put(&mut bytes, 88, &1u64.to_le_bytes()); // Module is the only valid table.
        put(&mut bytes, 104, &1u32.to_le_bytes()); // One Module row.
        put(&mut bytes, 112, &1u16.to_le_bytes()); // One-based GUID index.
        put(&mut bytes, 128, &GUID);
        bytes
    }

    #[test]
    fn reads_minidump_metadata_and_codeview_without_loading_the_dump() {
        let file = Fixture::new("minidump");
        // A sparse fixture exercises 64-bit offsets without allocating tens of GB.
        let data_offset: u64 = if cfg!(unix) {
            25 * 1024 * 1024 * 1024
        } else {
            512
        };
        let mut header = vec![0; 288];
        put(&mut header, 0, b"MDMP");
        put(&mut header, 8, &2u32.to_le_bytes());
        put(&mut header, 12, &32u32.to_le_bytes());
        put(&mut header, 32, &9u32.to_le_bytes()); // Memory64ListStream.
        put(&mut header, 36, &32u32.to_le_bytes());
        put(&mut header, 40, &64u32.to_le_bytes());
        put(&mut header, 44, &4u32.to_le_bytes()); // ModuleListStream.
        put(&mut header, 48, &112u32.to_le_bytes());
        put(&mut header, 52, &96u32.to_le_bytes());
        put(&mut header, 64, &1u64.to_le_bytes());
        put(&mut header, 72, &data_offset.to_le_bytes());
        put(&mut header, 80, &0x1000u64.to_le_bytes());
        put(&mut header, 88, &144u64.to_le_bytes());
        put(&mut header, 96, &1u32.to_le_bytes());
        put(&mut header, 100, &0x2000u64.to_le_bytes());
        put(&mut header, 176, &24u32.to_le_bytes());
        put(&mut header, 180, &256u32.to_le_bytes());
        put(&mut header, 256, b"RSDS");
        put(&mut header, 260, &GUID);
        put(&mut header, 276, &2u32.to_le_bytes());
        {
            let mut writer = File::create(&file.0).unwrap();
            writer.write_all(&header).unwrap();
            writer.seek(SeekFrom::Start(data_offset)).unwrap();
            writer.write_all(&metadata()).unwrap();
        }
        assert_eq!(module_mvid(&file.0, 0x1000, 144).unwrap(), MVID);
        assert!(module_mvid(&file.0, 0x4000, 144).is_err());
        assert_eq!(
            codeview(&file.0, 0x2000).unwrap(),
            "codeview:12121212121212121212121212121212:2"
        );
        assert!(codeview(&file.0, 0x3000).is_err());
    }

    #[test]
    fn reads_elf_metadata_across_two_mapped_ranges() {
        let file = Fixture::new("elf");
        let mut bytes = vec![0; 512];
        put(&mut bytes, 0, b"\x7fELF\x02\x01");
        put(&mut bytes, 32, &64u64.to_le_bytes());
        put(&mut bytes, 54, &56u16.to_le_bytes());
        put(&mut bytes, 56, &2u16.to_le_bytes());
        for (header, address, offset, size) in
            [(64, 0x1000u64, 256u64, 70u64), (120, 0x1046, 400, 74)]
        {
            put(&mut bytes, header, &1u32.to_le_bytes()); // PT_LOAD.
            put(&mut bytes, header + 8, &offset.to_le_bytes());
            put(&mut bytes, header + 16, &address.to_le_bytes());
            put(&mut bytes, header + 32, &size.to_le_bytes());
        }
        let metadata = metadata();
        put(&mut bytes, 256, &metadata[..70]);
        put(&mut bytes, 400, &metadata[70..]);
        std::fs::write(&file.0, bytes).unwrap();
        assert_eq!(module_mvid(&file.0, 0x1000, 144).unwrap(), MVID);
    }
}
