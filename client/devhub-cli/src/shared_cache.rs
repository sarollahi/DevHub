//! Optional node-local cache transport. Keep it isolated from the authoritative API.
//! On unsupported systems or with no configured socket, use normal ranged hydration.
use anyhow::{bail, Result};
use sha2::{Digest, Sha256};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_HEADERS: usize = 16 * 1024;

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

const MEMORY_LIMIT: usize = 8 * 1024 * 1024;
const MEMORY_ENTRIES: usize = 1024;
#[derive(Default)]
struct Memory {
    entries: HashMap<String, Vec<u8>>,
    recent: VecDeque<String>,
    bytes: usize,
}
static MEMORY: OnceLock<Mutex<Memory>> = OnceLock::new();
fn memory() -> &'static Mutex<Memory> { MEMORY.get_or_init(|| Mutex::new(Memory::default())) }
pub fn memory_get(repository: &str, id: &str) -> Option<Vec<u8>> {
    let key = format!("{repository}/{id}");
    let mut guard = memory().lock().ok()?;
    let bytes = guard.entries.get(&key)?.clone();
    if !verify_blob(id, &bytes) {
        guard.bytes = guard.bytes.saturating_sub(bytes.len());
        guard.entries.remove(&key);
        guard.recent.retain(|x| x != &key);
        return None;
    }
    guard.recent.retain(|x| x != &key);
    guard.recent.push_back(key);
    Some(bytes)
}
pub fn memory_put(repository: &str, id: &str, bytes: &[u8]) {
    if bytes.len() > MEMORY_LIMIT || !verify_blob(id, bytes) { return; }
    if let Ok(mut guard) = memory().lock() {
        let key = format!("{repository}/{id}");
        if let Some(old) = guard.entries.remove(&key) { guard.bytes -= old.len(); }
        guard.recent.retain(|x| x != &key);
        guard.bytes += bytes.len();
        guard.entries.insert(key.clone(), bytes.to_vec());
        guard.recent.push_back(key);
        while guard.bytes > MEMORY_LIMIT || guard.entries.len() > MEMORY_ENTRIES {
            let Some(oldest) = guard.recent.pop_front() else { break };
            if let Some(removed) = guard.entries.remove(&oldest) {
                guard.bytes = guard.bytes.saturating_sub(removed.len());
            }
        }
    }
}

fn verify_blob(id: &str, bytes: &[u8]) -> bool {
    let mut h = Sha256::new();
    h.update(b"BLOB\0");
    h.update(bytes);
    hex::encode(h.finalize()) == id
}

fn decode_response(id: &str, response: &[u8]) -> Result<Option<Vec<u8>>> {
    let Some(separator) = response.windows(4).position(|bytes| bytes == b"\r\n\r\n") else {
        return Ok(None);
    };
    if separator > MAX_HEADERS { return Ok(None); }
    let head = match std::str::from_utf8(&response[..separator]) {
        Ok(head) => head,
        Err(_) => return Ok(None),
    };
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap_or("");
    if status.contains(" 401 ") || status.contains(" 403 ") {
        bail!("Shared cache rejected repository access");
    }
    if status != "HTTP/1.1 200 OK" && status != "HTTP/1.0 200 OK" { return Ok(None); }
    let mut kind = None;
    let mut identity = None;
    let mut size = None;
    for header in lines {
        let Some((name, value)) = header.split_once(':') else { return Ok(None) };
        match name.trim().to_ascii_lowercase().as_str() {
            "x-devhub-object-kind" => kind = Some(value.trim()),
            "x-devhub-object-id" => identity = Some(value.trim()),
            "content-length" => size = value.trim().parse::<usize>().ok(),
            _ => {}
        }
    }
    let bytes = &response[separator + 4..];
    if kind != Some("BLOB") || identity != Some(id) || size != Some(bytes.len()) ||
        bytes.len() > MAX_BYTES || !verify_blob(id, bytes) {
        return Ok(None);
    }
    Ok(Some(bytes.to_vec()))
}

#[cfg(unix)]
pub fn fetch(repository: &str, id: &str, bearer: &str) -> Result<Option<Vec<u8>>> {
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;
    use std::time::Duration;
    let path = match std::env::var("DEVHUB_CACHE_SOCKET") {
        Ok(p) if !p.is_empty() => p,
        _ => return Ok(None),
    };
    // Never let environment-provided credentials inject HTTP request headers.
    if bearer.is_empty() || bearer.bytes().any(|b| b < 0x21 || b > 0x7e) {
        bail!("Invalid bearer token for shared cache transport");
    }
    if !repository.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') || repository.len() != 36 ||
        id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        bail!("Invalid shared cache identity");
    }
    let mut stream = match UnixStream::connect(path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
    let request = format!(
        "GET /v1/objects/{repository}/{id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {bearer}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() { return Ok(None); }
    let mut raw = Vec::new();
    if stream.take((MAX_BYTES + MAX_HEADERS + 4 + 1) as u64).read_to_end(&mut raw).is_err() {
        return Ok(None);
    }
    decode_response(id, &raw)
}

#[cfg(windows)]
pub fn fetch(repository: &str, id: &str, bearer: &str) -> Result<Option<Vec<u8>>> {
    use std::fs::OpenOptions;
    use std::io::{Read, Write};
    use std::os::windows::fs::OpenOptionsExt;
    const SECURITY_IDENTIFICATION: u32 = 0x00010000;
    let pipe = match std::env::var("DEVHUB_CACHE_SOCKET") {
        Ok(value) if !value.is_empty() => value,
        _ => return Ok(None),
    };
    if !pipe.starts_with(r"\\.\pipe\devhub-") || pipe.len() > 256 {
        bail!("Cache pipe must be a trusted local DevHub pipe");
    }
    if bearer.is_empty() || bearer.bytes().any(|c| c < 0x21 || c > 0x7e) ||
        repository.len() != 36 || !repository.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') ||
        id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()) {
        bail!("Invalid cache request identity");
    }
    let mut pipe = match OpenOptions::new().read(true).write(true)
        .security_qos_flags(SECURITY_IDENTIFICATION).open(&pipe) {
        Ok(file) => file,
        Err(_) => return Ok(None),
    };
    let request = format!(
        "GET /v1/objects/{repository}/{id} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {bearer}\r\nConnection: close\r\n\r\n"
    );
    if pipe.write_all(request.as_bytes()).is_err() { return Ok(None); }
    let mut raw = Vec::new();
    if pipe.take((MAX_BYTES + MAX_HEADERS + 5) as u64).read_to_end(&mut raw).is_err() {
        return Ok(None);
    }
    decode_response(id, &raw)
}

#[cfg(not(any(unix, windows)))]
pub fn fetch(_repository: &str, _id: &str, _bearer: &str) -> Result<Option<Vec<u8>>> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn id(bytes: &[u8]) -> String {
        let mut h = Sha256::new(); h.update(b"BLOB\0"); h.update(bytes);
        hex::encode(h.finalize())
    }
    #[test]
    fn process_cache_is_repo_scoped_and_refuses_invalid_bytes() {
        let expected = id(b"private");
        memory_put("repo-one", &expected, b"private");
        assert_eq!(memory_get("repo-one", &expected), Some(b"private".to_vec()));
        assert_eq!(memory_get("repo-two", &expected), None);
        memory_put("repo-one", &expected, b"tampered");
        assert_eq!(memory_get("repo-one", &expected), Some(b"private".to_vec()));
    }
    #[test]
    fn accepts_only_verified_framed_blobs() -> Result<()> {
        let expected = id(b"hello");
        let valid = format!("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nX-Devhub-Object-Kind: BLOB\r\nX-Devhub-Object-Id: {expected}\r\n\r\nhello");
        assert_eq!(decode_response(&expected, valid.as_bytes())?, Some(b"hello".to_vec()));
        assert!(decode_response(&expected, valid.replace("hello", "other").as_bytes())?.is_none());
        assert!(decode_response(&expected, valid.replace("BLOB", "TREE").as_bytes())?.is_none());
        assert!(decode_response(&expected, valid.replace("Content-Length: 5", "Content-Length: 12").as_bytes())?.is_none());
        assert!(decode_response(&expected, b"HTTP/1.1 403 Forbidden\r\n\r\n") .is_err());
        Ok(())
    }
}