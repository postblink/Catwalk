use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// Buffer size for streaming reads (256 KiB).
const CHUNK: usize = 256 * 1024;

/// Compute the SHA-256 of a file's bytes, streaming so we never load the whole
/// file into memory. Returns the lowercase hex digest.
pub fn hash_file(path: &Path) -> std::io::Result<String> {
    let file = File::open(path)?;
    let mut reader = BufReader::with_capacity(CHUNK, file);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];

    loop {
        let n = match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            // Retry on EINTR rather than aborting the hash.
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        hasher.update(&buf[..n]);
    }

    Ok(hex::encode(hasher.finalize()))
}

/// Minimal hex encoder so we don't pull in another crate.
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        let bytes = bytes.as_ref();
        let mut s = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
            s.push(char::from_digit((b & 0xf) as u32, 16).unwrap());
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn write_temp(bytes: &[u8]) -> std::path::PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut p = std::env::temp_dir();
        p.push(format!("catwalk-hash-{}-{}.bin", std::process::id(), n));
        File::create(&p).unwrap().write_all(bytes).unwrap();
        p
    }

    #[test]
    fn hashes_known_vector_abc() {
        let p = write_temp(b"abc");
        assert_eq!(
            hash_file(&p).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn hashes_empty_file() {
        let p = write_temp(&[]);
        assert_eq!(
            hash_file(&p).unwrap(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn hashes_file_larger_than_chunk() {
        // 300 KiB > 256 KiB CHUNK, exercising the multi-read loop.
        let data = vec![0xABu8; 300 * 1024];
        let p = write_temp(&data);

        let mut oneshot = Sha256::new();
        oneshot.update(&data);
        let expected = hex::encode(oneshot.finalize());

        assert_eq!(hash_file(&p).unwrap(), expected);
        std::fs::remove_file(&p).ok();
    }
}
