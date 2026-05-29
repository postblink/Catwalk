//! 3MF parser.
//!
//! A 3MF is a ZIP container. We pull three things out of it:
//!   1. An embedded preview PNG (slicers render one when saving a project).
//!   2. Slicer-specific print metadata (print time, filament weight/type, plate
//!      count, nozzle/layer settings) from the slicer config files.
//!   3. Mesh stats (bounding box, triangle count) from `3D/3dmodel.model`.
//!
//! Everything is best-effort: a plain (non-slicer) 3MF still yields mesh stats,
//! and a malformed sub-document is skipped rather than failing the whole parse.

use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::Read;
use std::path::Path;

/// What we managed to extract from a 3MF file.
#[derive(Debug, Default, Clone)]
pub struct ThreeMfData {
    /// Refined format string for `model_metadata.format`:
    /// `3mf-bambu` | `3mf-orca` | `3mf-prusa` | `3mf-cura` | `3mf`.
    pub format: String,
    pub plate_count: Option<i64>,
    pub print_time_seconds: Option<i64>,
    pub filament_grams: Option<f64>,
    pub filament_types: Vec<String>,
    pub nozzle_diameter: Option<f64>,
    pub layer_height: Option<f64>,
    /// `(min_xyz, max_xyz)` in model units (millimeters).
    pub bbox: Option<([f64; 3], [f64; 3])>,
    pub triangle_count: Option<i64>,
    /// Raw bytes of the best embedded preview PNG, if any.
    pub thumbnail_png: Option<Vec<u8>>,
}

/// Parse a 3MF file at `path`. Returns `Err` only if the file cannot be opened
/// as a ZIP at all; any partial content is otherwise returned best-effort.
pub fn parse(path: &Path) -> std::io::Result<ThreeMfData> {
    let file = std::fs::File::open(path)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    // Snapshot entry names so we can look entries up without fighting the
    // borrow checker over the archive's mutable `by_name`/`by_index`.
    let names: Vec<String> = zip.file_names().map(|s| s.to_string()).collect();

    let mut data = ThreeMfData::default();

    // 1. Embedded thumbnail: pick the PNG with the largest pixel area.
    data.thumbnail_png = pick_thumbnail(&mut zip, &names);

    // 2. Slicer metadata + flavor detection.
    let flavor = detect_flavor(&names, &mut zip);
    data.format = flavor.to_string();

    if let Some(xml) = read_entry_str(&mut zip, &names, "Metadata/slice_info.config") {
        parse_slice_info(&xml, &mut data);
    }
    if let Some(json) = read_entry_str(&mut zip, &names, "Metadata/project_settings.config") {
        parse_project_settings(&json, &mut data);
    }

    // 3. Mesh stats from the model document.
    if let Some(model_name) = find_model_document(&names) {
        if let Some(xml) = read_entry_str(&mut zip, &names, &model_name) {
            parse_model_mesh(&xml, &mut data);
        }
    }

    Ok(data)
}

/// Slicer flavor inferred from container contents.
#[derive(Debug, Clone, Copy)]
enum Flavor {
    Bambu,
    Orca,
    Prusa,
    Cura,
    Generic,
}

impl Flavor {
    fn to_string(self) -> String {
        match self {
            Flavor::Bambu => "3mf-bambu",
            Flavor::Orca => "3mf-orca",
            Flavor::Prusa => "3mf-prusa",
            Flavor::Cura => "3mf-cura",
            Flavor::Generic => "3mf",
        }
        .to_string()
    }
}

fn detect_flavor<R: Read + std::io::Seek>(
    names: &[String],
    zip: &mut zip::ZipArchive<R>,
) -> Flavor {
    let has = |needle: &str| names.iter().any(|n| n.eq_ignore_ascii_case(needle));
    let has_prefix = |prefix: &str| {
        names
            .iter()
            .any(|n| n.to_ascii_lowercase().starts_with(&prefix.to_ascii_lowercase()))
    };

    // Prusa keeps its config under a Slic3r_PE namespace and thumbnails in
    // Metadata/thumbnail/.
    if has("Metadata/Slic3r_PE.config")
        || has("Metadata/Slic3r_PE_model.config")
        || has_prefix("Metadata/thumbnail/")
    {
        return Flavor::Prusa;
    }

    // Bambu Studio and OrcaSlicer share the slice_info.config / project_settings
    // layout. Disambiguate via the "Application" header in slice_info.config.
    if has("Metadata/slice_info.config") || has("Metadata/project_settings.config") {
        if let Some(xml) = read_entry_str(zip, names, "Metadata/slice_info.config") {
            let lower = xml.to_ascii_lowercase();
            if lower.contains("orca") {
                return Flavor::Orca;
            }
            if lower.contains("bambu") {
                return Flavor::Bambu;
            }
        }
        // Default the shared layout to Bambu (its dialect originated it).
        return Flavor::Bambu;
    }

    if has("Metadata/Cura.png") || (has("Metadata/thumbnail.png") && has_prefix("Cura")) {
        return Flavor::Cura;
    }

    Flavor::Generic
}

/// Read a named zip entry as a UTF-8 string, lossily. `None` if missing/unreadable.
fn read_entry_str<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    names: &[String],
    target: &str,
) -> Option<String> {
    let actual = names.iter().find(|n| n.eq_ignore_ascii_case(target))?;
    let mut f = zip.by_name(actual).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// Read a named zip entry as raw bytes.
fn read_entry_bytes<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    name: &str,
) -> Option<Vec<u8>> {
    let mut f = zip.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

/// Choose the embedded preview PNG with the largest pixel area.
fn pick_thumbnail<R: Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    names: &[String],
) -> Option<Vec<u8>> {
    let mut best: Option<(u64, String)> = None;
    for name in names {
        if !name.to_ascii_lowercase().ends_with(".png") {
            continue;
        }
        if let Some(bytes) = read_entry_bytes(zip, name) {
            if let Some((w, h)) = png_dimensions(&bytes) {
                let area = w as u64 * h as u64;
                if best.as_ref().map_or(true, |(b, _)| area > *b) {
                    best = Some((area, name.clone()));
                }
            }
        }
    }
    let (_, name) = best?;
    read_entry_bytes(zip, &name)
}

/// Read width/height from a PNG's IHDR chunk without decoding the image.
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    // 8-byte signature, then a length+type (8 bytes) before IHDR's 13-byte data.
    // Width is at offset 16, height at offset 20 (big-endian u32s).
    const SIG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 24 || &bytes[..8] != SIG || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Some((w, h))
}

/// The primary model document is named in `_rels/.rels`, but in practice it is
/// always `3D/3dmodel.model`. Fall back to any `.model` under `3D/`.
fn find_model_document(names: &[String]) -> Option<String> {
    if let Some(n) = names
        .iter()
        .find(|n| n.eq_ignore_ascii_case("3D/3dmodel.model"))
    {
        return Some(n.clone());
    }
    names
        .iter()
        .find(|n| {
            let l = n.to_ascii_lowercase();
            l.starts_with("3d/") && l.ends_with(".model")
        })
        .cloned()
}

/// Parse Bambu/Orca `slice_info.config` (XML): plate count, print time, weight,
/// filament types.
fn parse_slice_info(xml: &str, data: &mut ThreeMfData) {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut plate_count = 0i64;
    let mut total_seconds = 0i64;
    let mut total_grams = 0f64;
    let mut saw_time = false;
    let mut saw_weight = false;
    let mut filaments: Vec<String> = Vec::new();

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let tag = e.name();
                let tag = tag.as_ref();
                if tag == b"plate" {
                    plate_count += 1;
                } else if tag == b"metadata" {
                    let (mut key, mut value) = (None, None);
                    for attr in e.attributes().flatten() {
                        match attr.key.as_ref() {
                            b"key" => key = Some(attr.unescape_value().unwrap_or_default().into_owned()),
                            b"value" => {
                                value = Some(attr.unescape_value().unwrap_or_default().into_owned())
                            }
                            _ => {}
                        }
                    }
                    if let (Some(k), Some(v)) = (key, value) {
                        match k.as_str() {
                            "prediction" => {
                                if let Ok(s) = v.parse::<f64>() {
                                    total_seconds += s.round() as i64;
                                    saw_time = true;
                                }
                            }
                            "weight" => {
                                if let Ok(g) = v.parse::<f64>() {
                                    total_grams += g;
                                    saw_weight = true;
                                }
                            }
                            _ => {}
                        }
                    }
                } else if tag == b"filament" {
                    for attr in e.attributes().flatten() {
                        if attr.key.as_ref() == b"type" {
                            let t = attr.unescape_value().unwrap_or_default().into_owned();
                            if !t.is_empty() && !filaments.contains(&t) {
                                filaments.push(t);
                            }
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    if plate_count > 0 {
        data.plate_count = Some(plate_count);
    }
    if saw_time {
        data.print_time_seconds = Some(total_seconds);
    }
    if saw_weight {
        data.filament_grams = Some(total_grams);
    }
    if !filaments.is_empty() {
        data.filament_types = filaments;
    }
}

/// Parse Bambu/Orca `project_settings.config` (JSON): nozzle diameter, layer
/// height, and filament types (fallback if slice_info had none).
fn parse_project_settings(json: &str, data: &mut ThreeMfData) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return;
    };

    // Values are often strings or arrays-of-strings in slicer JSON.
    let first_f64 = |val: &serde_json::Value| -> Option<f64> {
        match val {
            serde_json::Value::String(s) => s.parse::<f64>().ok(),
            serde_json::Value::Number(n) => n.as_f64(),
            serde_json::Value::Array(a) => a.first().and_then(|x| match x {
                serde_json::Value::String(s) => s.parse::<f64>().ok(),
                serde_json::Value::Number(n) => n.as_f64(),
                _ => None,
            }),
            _ => None,
        }
    };

    if data.nozzle_diameter.is_none() {
        if let Some(d) = v.get("nozzle_diameter").and_then(first_f64) {
            data.nozzle_diameter = Some(d);
        }
    }
    if data.layer_height.is_none() {
        if let Some(h) = v.get("layer_height").and_then(first_f64) {
            data.layer_height = Some(h);
        }
    }
    if data.filament_types.is_empty() {
        if let Some(serde_json::Value::Array(arr)) = v.get("filament_type") {
            let types: Vec<String> = arr
                .iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .filter(|s| !s.is_empty())
                .collect();
            if !types.is_empty() {
                data.filament_types = dedup_preserve(types);
            }
        }
    }
}

fn dedup_preserve(items: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    items.into_iter().filter(|i| seen.insert(i.clone())).collect()
}

/// Stream the model document, accumulating the bounding box over all `<vertex>`
/// elements and counting `<triangle>` elements.
fn parse_model_mesh(xml: &str, data: &mut ThreeMfData) {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    let mut saw_vertex = false;
    let mut triangles = 0i64;

    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                match e.name().as_ref() {
                    b"vertex" => {
                        let mut xyz = [0f64; 3];
                        for attr in e.attributes().flatten() {
                            let val = attr.unescape_value().unwrap_or_default();
                            let parsed = val.parse::<f64>().ok();
                            match attr.key.as_ref() {
                                b"x" => xyz[0] = parsed.unwrap_or(0.0),
                                b"y" => xyz[1] = parsed.unwrap_or(0.0),
                                b"z" => xyz[2] = parsed.unwrap_or(0.0),
                                _ => {}
                            }
                        }
                        for i in 0..3 {
                            if xyz[i] < min[i] {
                                min[i] = xyz[i];
                            }
                            if xyz[i] > max[i] {
                                max[i] = xyz[i];
                            }
                        }
                        saw_vertex = true;
                    }
                    b"triangle" => triangles += 1,
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    if saw_vertex {
        data.bbox = Some((min, max));
    }
    if triangles > 0 {
        data.triangle_count = Some(triangles);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    /// Build a minimal slicer-style 3MF in a temp file and return its path.
    fn write_3mf(name: &str, entries: &[(&str, &[u8])]) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("catwalk-3mf-{}-{}", std::process::id(), name));
        let f = std::fs::File::create(&p).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (n, bytes) in entries {
            zw.start_file(*n, opts).unwrap();
            zw.write_all(bytes).unwrap();
        }
        zw.finish().unwrap();
        p
    }

    /// A 1x1 (tiny) and a larger fake PNG: valid signature + IHDR with given dims.
    fn fake_png(w: u32, h: u32) -> Vec<u8> {
        let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        v.extend_from_slice(&13u32.to_be_bytes()); // IHDR length
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&[8, 6, 0, 0, 0]); // bit depth/color/etc.
        v
    }

    const MODEL_XML: &str = r#"<?xml version="1.0"?>
<model unit="millimeter">
 <resources>
  <object id="1" type="model">
   <mesh>
    <vertices>
     <vertex x="0" y="0" z="0"/>
     <vertex x="10" y="20" z="5"/>
     <vertex x="-3" y="2" z="8"/>
    </vertices>
    <triangles>
     <triangle v1="0" v2="1" v3="2"/>
    </triangles>
   </mesh>
  </object>
 </resources>
</model>"#;

    const SLICE_INFO: &str = r##"<?xml version="1.0"?>
<config>
 <header>
  <header_item key="X-BBL-Application" value="BambuStudio-1.8"/>
 </header>
 <plate>
  <metadata key="index" value="1"/>
  <metadata key="prediction" value="3600"/>
  <metadata key="weight" value="12.5"/>
  <filament id="1" type="PLA" color="#000" used_g="12.5"/>
 </plate>
</config>"##;

    const PROJECT_SETTINGS: &str = r#"{
  "nozzle_diameter": ["0.4"],
  "layer_height": "0.2",
  "filament_type": ["PLA", "PLA"]
}"#;

    #[test]
    fn parses_full_bambu_3mf() {
        let p = write_3mf(
            "full.3mf",
            &[
                ("3D/3dmodel.model", MODEL_XML.as_bytes()),
                ("Metadata/slice_info.config", SLICE_INFO.as_bytes()),
                ("Metadata/project_settings.config", PROJECT_SETTINGS.as_bytes()),
                ("Metadata/plate_1.png", &fake_png(512, 512)),
                ("Metadata/plate_1_small.png", &fake_png(64, 64)),
            ],
        );

        let d = parse(&p).unwrap();
        assert_eq!(d.format, "3mf-bambu");
        assert_eq!(d.plate_count, Some(1));
        assert_eq!(d.print_time_seconds, Some(3600));
        assert_eq!(d.filament_grams, Some(12.5));
        assert_eq!(d.filament_types, vec!["PLA".to_string()]);
        assert_eq!(d.nozzle_diameter, Some(0.4));
        assert_eq!(d.layer_height, Some(0.2));
        assert_eq!(d.triangle_count, Some(1));

        let (min, max) = d.bbox.unwrap();
        assert_eq!(min, [-3.0, 0.0, 0.0]);
        assert_eq!(max, [10.0, 20.0, 8.0]);

        // Largest PNG (512x512) wins over the small one.
        let thumb = d.thumbnail_png.unwrap();
        assert_eq!(png_dimensions(&thumb), Some((512, 512)));

        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn parses_plain_3mf_mesh_only() {
        let p = write_3mf("plain.3mf", &[("3D/3dmodel.model", MODEL_XML.as_bytes())]);
        let d = parse(&p).unwrap();
        assert_eq!(d.format, "3mf");
        assert_eq!(d.triangle_count, Some(1));
        assert!(d.bbox.is_some());
        assert!(d.thumbnail_png.is_none());
        assert!(d.print_time_seconds.is_none());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn detects_orca_flavor() {
        let orca = SLICE_INFO.replace("BambuStudio", "OrcaSlicer");
        let p = write_3mf(
            "orca.3mf",
            &[
                ("3D/3dmodel.model", MODEL_XML.as_bytes()),
                ("Metadata/slice_info.config", orca.as_bytes()),
            ],
        );
        let d = parse(&p).unwrap();
        assert_eq!(d.format, "3mf-orca");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn errors_on_non_zip() {
        let mut p = std::env::temp_dir();
        p.push(format!("catwalk-3mf-bad-{}.3mf", std::process::id()));
        std::fs::write(&p, b"not a zip").unwrap();
        assert!(parse(&p).is_err());
        std::fs::remove_file(&p).ok();
    }
}
