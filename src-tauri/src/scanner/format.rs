use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// A recognized model/print file format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFormat {
    StlBinary,
    StlAscii,
    Obj,
    ThreeMf,
    Gcode,
}

impl ModelFormat {
    /// Short stable string stored in the DB.
    // Consumed by the upcoming parser/metadata stage.
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            ModelFormat::StlBinary => "stl",
            ModelFormat::StlAscii => "stl",
            ModelFormat::Obj => "obj",
            ModelFormat::ThreeMf => "3mf",
            ModelFormat::Gcode => "gcode",
        }
    }

    /// Whether this format can carry a renderable mesh (vs. gcode toolpath).
    #[allow(dead_code)]
    pub fn is_mesh(self) -> bool {
        !matches!(self, ModelFormat::Gcode)
    }
}

/// Extensions we even bother to look at during a walk.
// Referenced by tests and the future settings UI (allowed-format toggles).
#[allow(dead_code)]
pub const SUPPORTED_EXTENSIONS: &[&str] = &["stl", "obj", "3mf", "gcode", "gco", "g"];

/// Map a lowercased extension to a coarse format, before content sniffing.
pub fn extension_hint(ext: &str) -> Option<ModelFormat> {
    match ext {
        "stl" => Some(ModelFormat::StlBinary), // refined by sniffing
        "obj" => Some(ModelFormat::Obj),
        "3mf" => Some(ModelFormat::ThreeMf),
        "gcode" | "gco" | "g" => Some(ModelFormat::Gcode),
        _ => None,
    }
}

/// Detect the precise format by combining the extension with magic-byte sniffing.
///
/// - 3MF: ZIP container → starts with `PK\x03\x04`.
/// - STL: 80-byte header + u32 triangle count for binary; ASCII starts with `solid`
///   but binary files sometimes also begin with "solid", so we cross-check the file
///   length against the declared triangle count.
/// - OBJ / G-code: trusted by extension (text formats, no reliable magic).
pub fn detect_format(path: &Path) -> std::io::Result<Option<ModelFormat>> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    let Some(ext) = ext else {
        return Ok(None);
    };
    let Some(hint) = extension_hint(&ext) else {
        return Ok(None);
    };

    match hint {
        ModelFormat::ThreeMf => {
            let mut f = File::open(path)?;
            let mut magic = [0u8; 4];
            if f.read(&mut magic)? == 4 && &magic == b"PK\x03\x04" {
                Ok(Some(ModelFormat::ThreeMf))
            } else {
                // Extension says 3mf but it isn't a zip; skip it.
                Ok(None)
            }
        }
        ModelFormat::StlBinary => Ok(Some(sniff_stl(path)?)),
        other => Ok(Some(other)),
    }
}

/// Distinguish binary vs. ASCII STL.
///
/// Binary STL layout: 80-byte header, u32 little-endian triangle count `n`, then
/// `n * 50` bytes of triangle data. We verify `84 + n*50 == file_len`. If that holds
/// it is binary, regardless of whether the header text starts with "solid".
fn sniff_stl(path: &Path) -> std::io::Result<ModelFormat> {
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();

    // Too small to be a valid binary STL header → treat as ASCII.
    if len < 84 {
        return Ok(ModelFormat::StlAscii);
    }

    f.seek(SeekFrom::Start(80))?;
    let mut count_bytes = [0u8; 4];
    f.read_exact(&mut count_bytes)?;
    let tri_count = u32::from_le_bytes(count_bytes) as u64;

    let expected = 84 + tri_count * 50;
    if expected == len {
        return Ok(ModelFormat::StlBinary);
    }

    // Fall back to checking the leading token.
    f.seek(SeekFrom::Start(0))?;
    let mut head = [0u8; 6];
    let read = f.read(&mut head)?;
    if read >= 5 && head[..5].eq_ignore_ascii_case(b"solid") {
        Ok(ModelFormat::StlAscii)
    } else {
        // Ambiguous; assume binary (most STLs in the wild are).
        Ok(ModelFormat::StlBinary)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("catwalk-fmt-{}-{}", std::process::id(), name));
        p
    }

    #[test]
    fn detects_ascii_stl() {
        let p = tmp("a.stl");
        let mut f = File::create(&p).unwrap();
        f.write_all(b"solid cube\nfacet normal 0 0 0\nendsolid cube\n").unwrap();
        assert_eq!(detect_format(&p).unwrap(), Some(ModelFormat::StlAscii));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn detects_binary_stl_by_length() {
        let p = tmp("b.stl");
        let mut f = File::create(&p).unwrap();
        f.write_all(&[0u8; 80]).unwrap(); // header
        f.write_all(&1u32.to_le_bytes()).unwrap(); // 1 triangle
        f.write_all(&[0u8; 50]).unwrap(); // triangle data
        assert_eq!(detect_format(&p).unwrap(), Some(ModelFormat::StlBinary));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn rejects_fake_3mf() {
        let p = tmp("c.3mf");
        let mut f = File::create(&p).unwrap();
        f.write_all(b"not a zip").unwrap();
        assert_eq!(detect_format(&p).unwrap(), None);
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn accepts_real_3mf_zip_magic() {
        let p = tmp("d.3mf");
        let mut f = File::create(&p).unwrap();
        f.write_all(b"PK\x03\x04rest-of-zip").unwrap();
        assert_eq!(detect_format(&p).unwrap(), Some(ModelFormat::ThreeMf));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn gcode_and_obj_by_extension() {
        let g = tmp("e.gcode");
        File::create(&g).unwrap().write_all(b"; orca\nG28\n").unwrap();
        assert_eq!(detect_format(&g).unwrap(), Some(ModelFormat::Gcode));
        std::fs::remove_file(&g).ok();

        let o = tmp("f.obj");
        File::create(&o).unwrap().write_all(b"v 0 0 0\n").unwrap();
        assert_eq!(detect_format(&o).unwrap(), Some(ModelFormat::Obj));
        std::fs::remove_file(&o).ok();
    }

    #[test]
    fn ignores_unknown_extension() {
        let p = tmp("g.txt");
        File::create(&p).unwrap().write_all(b"hi").unwrap();
        assert_eq!(detect_format(&p).unwrap(), None);
        std::fs::remove_file(&p).ok();
    }
}
