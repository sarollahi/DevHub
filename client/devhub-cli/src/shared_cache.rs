//! Optional node-local cache transport. Keep it isolated from the authoritative API.
//! On unsupported systems or with no configured socket, use normal ranged hydration.
use anyhow::{bail, Result};
use sha2::{Digest, Sha256};

const MAX_BYTES: usize = 4 * 1024 * 1024;
const MAX_HEADERS: usize = 16 * 1024;

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

#[cfg(not(unix))]
pub fn fetch(_repository: &str, _id: &str, _bearer: &str) -> Result<Option<Vec<u8>>> {
    // Windows retains verified explicit hydration until a named-pipe transport is available.
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