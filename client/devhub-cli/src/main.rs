use anyhow::{anyhow, bail, Context, Result};
use clap::{Args, Parser, Subcommand};
use directories::ProjectDirs;
use reqwest::blocking::{Client, Response};
use reqwest::header::{CONTENT_RANGE, ETAG, IF_RANGE, RANGE};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use walkdir::WalkDir;
mod shared_cache;

const MAX_OBJECT: usize = 4 * 1024 * 1024;
const CHUNK: usize = 256 * 1024;
const MAX_JSON: usize = 12 * 1024 * 1024;
const DEFAULT_CACHE: u64 = 64 * 1024 * 1024;

#[derive(Parser)]
#[command(name = "devhub", about = "Native always-connected source control", version)]
struct Cli {
    #[command(subcommand)]
    cmd: Command,
}
#[derive(Subcommand)]
enum Command {
    Auth { #[command(subcommand)] action: AuthCommand },
    Init { #[arg(long)] server: String, #[arg(long)] repository: String, #[arg(long, default_value="main")] r#ref: String },
    Select { #[arg(long="file")] files: Vec<String>, #[arg(long="dir")] directories: Vec<String>,
        #[arg(long)] clear: bool },
    Sync { #[arg(long)] materialize: bool },
    Hydrate { paths: Vec<String> },
    Status { #[arg(long)] json: bool },
    History { #[arg(long)] revision: Option<String>, #[arg(long)] path: Option<String>,
        #[arg(long, default_value_t=30)] limit: usize },
    Diff { #[arg(long)] from: String, #[arg(long)] to: String, #[arg(long)] path: Option<String> },
    Blame { path: String, #[arg(long)] revision: Option<String> },
    Ancestry { #[arg(long)] left: String, #[arg(long)] right: String },
    Merge { #[arg(long)] base: String, #[arg(long)] ours: String, #[arg(long)] theirs: String },
    Changeset { #[command(subcommand)] action: ChangeCommand },
    Review { #[command(subcommand)] action: ReviewCommand },
}
#[derive(Subcommand)]
enum AuthCommand {
    Login { #[arg(long)] server: String, #[arg(long)] repository: String, #[arg(long)] token_stdin: bool },
    Status { #[arg(long)] server: Option<String> },
    Logout { #[arg(long)] server: String },
}
#[derive(Subcommand)]
enum ChangeCommand { Create { #[arg(short, long)] message: Option<String> }, AbortPending }
#[derive(Subcommand)]
enum ReviewCommand {
    Submit { #[arg(long)] changeset: Option<String>, #[arg(long, default_value="main")] target: String,
        #[arg(long)] title: String, #[arg(long, default_value="")] description: String },
    List,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, Debug)]
struct Entry {
    object_id: String,
    mode: String,
    #[serde(default)]
    materialized: bool,
}
#[derive(Clone, Serialize, Deserialize)]
struct Pending {
    parent: Option<String>,
    message: String,
    operations: Vec<Value>,
    expected: BTreeMap<String, String>,
    key: String,
}
#[derive(Serialize, Deserialize)]
struct Workspace {
    server: String,
    repository: String,
    ref_name: String,
    head: Option<String>,
    generation: Option<i64>,
    #[serde(default)]
    selectors: Vec<String>,
    #[serde(default)]
    entries: BTreeMap<String, Entry>,
    #[serde(default)]
    pending: Option<Pending>,
    #[serde(default = "default_cache")]
    max_cache_bytes: u64,
}
fn default_cache() -> u64 { DEFAULT_CACHE }
#[derive(Default, Serialize, Deserialize)]
struct Credentials { #[serde(default)] servers: BTreeMap<String, String> }
#[derive(Deserialize)]
struct Refs { records: Vec<RefRecord> }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct RefRecord { name: String, changeset_id: String, generation: i64 }
#[derive(Deserialize)]
struct Tree { entries: Vec<RemoteEntry> }
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
struct RemoteEntry { path: String, object_id: String, mode: String }
#[derive(Deserialize)]
struct UploadReceipt { received: usize, complete: bool }
#[derive(Deserialize)]
struct Receipt { id: String }
#[derive(Serialize)]
struct OpInput { #[serde(rename="apiVersion")] api_version: u8, parents: Vec<String>,
    description: String, #[serde(rename="idempotencyKey")] idempotency_key: String,
    operations: Vec<Value> }
struct Api { http: Client, server: String, repository: String, token: String }
impl Api {
    fn new(server: &str, repository: &str, token: String) -> Result<Self> {
        validate_server(server)?;
        let http = Client::builder().timeout(Duration::from_secs(90)).build()?;
        Ok(Self { http, server: server.trim_end_matches('/').to_owned(),
            repository: repository.to_owned(), token })
    }
    fn path(&self, version: u8, suffix: &str) -> String {
        format!("{}/api/v{}/repositories/{}{}", self.server, version, self.repository, suffix)
    }
    fn send(&self, request: reqwest::blocking::RequestBuilder) -> Result<Response> {
        let response = request.bearer_auth(&self.token).send()
            .context("Server unavailable: local workspace was not changed")?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().unwrap_or_default();
            bail!("Server returned HTTP {}: {}", status, text.chars().take(700).collect::<String>());
        }
        Ok(response)
    }
    fn read_json<T: DeserializeOwned>(&self, mut response: Response) -> Result<T> {
        let mut body = Vec::new();
        response.by_ref().take((MAX_JSON + 1) as u64).read_to_end(&mut body)?;
        if body.len() > MAX_JSON { bail!("Server response exceeds JSON safety limit"); }
        serde_json::from_slice(&body).context("Invalid server protocol response")
    }
    fn get<T: DeserializeOwned>(&self, version: u8, suffix: &str) -> Result<T> {
        self.read_json(self.send(self.http.get(self.path(version, suffix)))?)
    }
    fn post<T: DeserializeOwned>(&self, version: u8, suffix: &str, value: &impl Serialize) -> Result<T> {
        self.read_json(self.send(self.http.post(self.path(version, suffix)).json(value))?)
    }
    fn refs(&self) -> Result<Refs> { self.get(1, "/refs") }
    fn tree(&self, revision: &str, selectors: &[String]) -> Result<Tree> {
        if selectors.is_empty() { bail!("Select at least one directory or file before syncing"); }
        let mut url = reqwest::Url::parse(&self.path(2, &format!("/changesets/{revision}/tree")))?;
        for s in selectors { url.query_pairs_mut().append_pair("select", s); }
        self.read_json(self.send(self.http.get(url))?)
    }
    fn query(&self, operation: &str, parameters: &[(&str, &str)]) -> Result<Value> {
        let mut url = reqwest::Url::parse(&self.path(2, &format!("/query/{operation}")))?;
        for (key, value) in parameters { url.query_pairs_mut().append_pair(key, value); }
        self.read_json(self.send(self.http.get(url))?)
    }
    fn download_object(&self, object_id: &str, directory: &Path) -> Result<Vec<u8>> {
        check_object_id(object_id)?;
        fs::create_dir_all(directory)?;
        if let Some(bytes) = shared_cache::memory_get(&self.repository, object_id) {
            return Ok(bytes);
        }
        let cache = directory.join(object_id);
        if cache.is_file() {
            let bytes = fs::read(&cache)?;
            if bytes.len() <= MAX_OBJECT && object_hash(&bytes) == object_id {
                touch(&cache)?;
                shared_cache::memory_put(&self.repository, object_id, &bytes);
                return Ok(bytes);
            }
            fs::remove_file(&cache)?;
        }
        // Every local daemon response is verified independently before publication.
        // An unavailable daemon never prevents portable, authenticated hydration.
        if let Some(bytes) = shared_cache::fetch(&self.repository, object_id, &self.token)? {
            let temp = directory.join(format!("{object_id}.cache-{}", std::process::id()));
            {
                let mut file = OpenOptions::new().write(true).create_new(true).open(&temp)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
            }
            if let Err(error) = fs::rename(&temp, &cache) {
                let _ = fs::remove_file(&temp);
                return Err(error.into());
            }
            prune_cache(directory, DEFAULT_CACHE)?;
            shared_cache::memory_put(&self.repository, object_id, &bytes);
            return Ok(bytes);
        }
        let partial = directory.join(format!("{object_id}.part"));
        let mut offset = if partial.exists() { fs::metadata(&partial)?.len() as usize } else { 0 };
        if offset > MAX_OBJECT { fs::remove_file(&partial)?; offset = 0; }
        let mut request = self.http.get(self.path(2, &format!("/objects/{object_id}/raw")));
        if offset > 0 {
            request = request.header(RANGE, format!("bytes={offset}-"))
                .header(IF_RANGE, format!("\"{object_id}\""));
        }
        let mut response = self.send(request)?;
        if offset > 0 {
            if response.status().as_u16() == 206 {
                let expected = format!("bytes {offset}-");
                let actual = response.headers().get(CONTENT_RANGE).and_then(|v| v.to_str().ok()).unwrap_or("");
                if !actual.starts_with(&expected) { bail!("Server returned inconsistent range, refusing partial object"); }
            } else if response.status().as_u16() == 200 {
                offset = 0;
            } else { bail!("Unexpected resume response"); }
        }
        let etag = response.headers().get(ETAG).and_then(|v| v.to_str().ok()).unwrap_or("");
        if etag != format!("\"{object_id}\"") { bail!("Server object ETag mismatch"); }
        let mut stream = OpenOptions::new().create(true).write(true).append(offset > 0).truncate(offset == 0).open(&partial)?;
        let mut chunk = [0u8; 65536];
        let mut length = offset;
        loop {
            let n = response.read(&mut chunk).context("Download interrupted; partial transfer retained")?;
            if n == 0 { break; }
            length += n;
            if length > MAX_OBJECT { bail!("Remote object exceeds 4 MiB limit"); }
            stream.write_all(&chunk[..n])?;
        }
        stream.sync_all()?;
        let bytes = fs::read(&partial)?;
        if object_hash(&bytes) != object_id { bail!("Object digest mismatch; partial transfer retained for diagnosis"); }
        fs::rename(&partial, &cache)?;
        shared_cache::memory_put(&self.repository, object_id, &bytes);
        Ok(bytes)
    }
    fn upload_object(&self, bytes: &[u8]) -> Result<String> {
        if bytes.len() > MAX_OBJECT { bail!("File exceeds current server object limit of 4 MiB"); }
        let id = object_hash(bytes);
        let mut session: UploadReceipt = self.post(2, "/uploads", &json!({ "objectId": id, "byteSize": bytes.len() }))?;
        while !session.complete {
            if session.received >= bytes.len() { bail!("Server returned invalid upload offset"); }
            let end = (session.received + CHUNK).min(bytes.len());
            let response = self.send(self.http.patch(self.path(2, &format!("/uploads/{id}")))
                .header("Upload-Offset", session.received.to_string())
                .header("Content-Type", "application/octet-stream")
                .body(bytes[session.received..end].to_vec()));
            match response {
                Ok(response) => { session = self.read_json(response)?; }
                Err(error) => {
                    // A completed chunk may have reached the server before a connection failed.
                    // The next create request returns the durable offset, never guesses it.
                    session = self.post(2, "/uploads", &json!({ "objectId": id, "byteSize": bytes.len() }))
                        .with_context(|| format!("{error}; upload is resumable by rerunning the command"))?;
                }
            }
        }
        Ok(id)
    }
}
fn check_object_id(id: &str) -> Result<()> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        bail!("Invalid object identity");
    }
    Ok(())
}
fn object_hash(bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(b"BLOB\0"); hash.update(bytes);
    hex::encode(hash.finalize())
}
fn validate_server(server: &str) -> Result<()> {
    let url = reqwest::Url::parse(server)?;
    let local = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        bail!("A secure HTTPS server is required; HTTP is only allowed for loopback");
    }
    if url.username() != "" || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        bail!("Server address must not contain credentials, query, or fragment");
    }
    Ok(())
}
fn credentials_path() -> Result<PathBuf> {
    Ok(ProjectDirs::from("com", "DevHub", "devhub")
        .ok_or_else(|| anyhow!("Cannot locate user configuration directory"))?
        .config_dir().join("credentials.json"))
}
fn read_credentials() -> Result<Credentials> {
    let path = credentials_path()?;
    if !path.exists() { return Ok(Credentials::default()); }
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}
fn atomic_json<T: Serialize>(path: &Path, value: &T, private: bool) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("Missing parent directory"))?;
    fs::create_dir_all(parent)?;
    let temp = parent.join(format!(".{}.{}.tmp", path.file_name().unwrap().to_string_lossy(), std::process::id()));
    {
        let mut file = OpenOptions::new().create_new(true).write(true).open(&temp)?;
        #[cfg(unix)] if private {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(not(unix))] let _ = private;
        serde_json::to_writer_pretty(&mut file, value)?;
        file.write_all(b"\n")?; file.sync_all()?;
    }
    #[cfg(windows)] if path.exists() { fs::remove_file(path)?; }
    fs::rename(temp, path)?;
    Ok(())
}
fn token(server: &str) -> Result<String> {
    if let Ok(value) = std::env::var("DEVHUB_TOKEN") {
        if !value.is_empty() { return Ok(value); }
    }
    read_credentials()?.servers.get(server.trim_end_matches('/')).cloned()
        .ok_or_else(|| anyhow!("No token configured for server; run devhub auth login or set DEVHUB_TOKEN"))
}
fn workspace_root() -> Result<PathBuf> {
    let mut here = std::env::current_dir()?.canonicalize()?;
    loop {
        if here.join(".devhub/workspace.json").exists() { return Ok(here); }
        if !here.pop() { bail!("Not a DevHub workspace; run devhub init"); }
    }
}
fn state_path(root: &Path) -> PathBuf { root.join(".devhub/workspace.json") }
fn load_state(root: &Path) -> Result<Workspace> { Ok(serde_json::from_slice(&fs::read(state_path(root))?)?) }
fn save_state(root: &Path, state: &Workspace) -> Result<()> { atomic_json(&state_path(root), state, false) }
fn api(state: &Workspace) -> Result<Api> { Api::new(&state.server, &state.repository, token(&state.server)?) }
fn valid_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= 512 && !path.starts_with('/') && !path.contains('\\')
        && !path.contains('\0') && path.split('/').all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && !path.split('/').any(|segment| segment.eq_ignore_ascii_case(".devhub"))
        && !path.contains(':')
}
fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    if !valid_path(relative) { bail!("Unsafe workspace path: {relative}"); }
    let mut current = root.to_path_buf();
    for component in relative.split('/') {
        current.push(component);
        if let Ok(info) = fs::symlink_metadata(&current) {
            if info.file_type().is_symlink() { bail!("Symlink traversal is forbidden: {}", current.display()); }
        }
    }
    Ok(current)
}
fn safe_parent(root: &Path, relative: &str) -> Result<PathBuf> {
    let mut path = root.to_path_buf();
    if !valid_path(relative) { bail!("Unsafe workspace path"); }
    let components: Vec<_> = relative.split('/').collect();
    for name in &components[..components.len()-1] {
        path.push(name);
        if path.exists() {
            let info = fs::symlink_metadata(&path)?;
            if !info.is_dir() || info.file_type().is_symlink() { bail!("Unsafe directory in workspace"); }
        } else { fs::create_dir(&path)?; }
    }
    Ok(path.join(components[components.len()-1]))
}
fn selected(path: &str, selectors: &[String]) -> bool {
    selectors.iter().any(|s| {
        if s == "d:." { return true; }
        match s.split_once(':') {
            Some(("f", f)) => path == f,
            Some(("d", d)) => path.starts_with(&format!("{d}/")),
            _ => false,
        }
    })
}
fn fs_bytes(root: &Path, relative: &str) -> Result<Option<(Vec<u8>, String)>> {
    if !valid_path(relative) { bail!("Invalid path"); }
    let location = root.join(relative);
    let info = match fs::symlink_metadata(&location) {
        Ok(value) => value,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    // Parent directories may not be symlinks, but the file itself can be a tracked symlink.
    let mut current = root.to_path_buf();
    let parts: Vec<_> = relative.split('/').collect();
    for part in &parts[..parts.len()-1] {
        current.push(part);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() { bail!("Unsafe parent symlink"); }
    }
    if info.file_type().is_symlink() {
        let target = fs::read_link(location)?.to_str().ok_or_else(|| anyhow!("Non-UTF8 symlink target"))?.to_owned();
        if target.starts_with('/') || target.contains('\\') || target.split('/').any(|s| s == "..") ||
            target.is_empty() || target.len() > 4096 { bail!("Unsafe symlink target"); }
        return Ok(Some((target.into_bytes(), "120000".to_string())));
    }
    if !info.is_file() { bail!("Tracked path is not a regular file"); }
    if info.len() > MAX_OBJECT as u64 { bail!("File {relative} exceeds server 4 MiB limit"); }
    let data = fs::read(location)?;
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        if info.permissions().mode() & 0o111 != 0 { "100755" } else { "100644" }
    };
    #[cfg(not(unix))]
    let mode = "100644";
    Ok(Some((data, mode.to_string())))
}
fn dirty(root: &Path, path: &str, entry: &Entry) -> Result<bool> {
    if !entry.materialized { return Ok(false); }
    Ok(match fs_bytes(root, path)? {
        Some((data, mode)) => object_hash(&data) != entry.object_id || mode != entry.mode,
        None => true,
    })
}
fn touch(path: &Path) -> Result<()> {
    let bytes = fs::read(path)?;
    let mut file = OpenOptions::new().write(true).truncate(true).open(path)?;
    file.write_all(&bytes)?; Ok(())
}
fn prune_cache(dir: &Path, limit: u64) -> Result<()> {
    if !dir.exists() { return Ok(()); }
    let mut items: Vec<(PathBuf, u64, std::time::SystemTime)> = fs::read_dir(dir)?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if check_object_id(name).is_err() { return None; }
            let meta = entry.metadata().ok()?;
            Some((path, meta.len(), meta.modified().ok()?))
        }).collect();
    let mut total: u64 = items.iter().map(|x| x.1).sum();
    items.sort_by_key(|x| x.2);
    for (path, size, _) in items {
        if total <= limit { break; }
        fs::remove_file(path)?;
        total = total.saturating_sub(size);
    }
    Ok(())
}
fn materialize(root: &Path, path: &str, data: &[u8], mode: &str) -> Result<()> {
    let destination = safe_parent(root, path)?;
    if destination.exists() {
        let info = fs::symlink_metadata(&destination)?;
        if info.is_dir() { bail!("Destination is a directory"); }
        fs::remove_file(&destination)?;
    }
    if mode == "120000" {
        let target = std::str::from_utf8(data)?;
        if target.is_empty() || target.starts_with('/') || target.contains('\\') ||
            target.split('/').any(|s| s == "..") { bail!("Unsafe symlink target from server"); }
        #[cfg(unix)] std::os::unix::fs::symlink(target, &destination)?;
        #[cfg(windows)] std::os::windows::fs::symlink_file(target, &destination)
            .context("Windows symlink permission required")?;
        #[cfg(not(any(unix, windows)))] bail!("Symlinks are unsupported on this platform");
    } else {
        let temporary = destination.with_extension(format!("devhub-{}.tmp", std::process::id()));
        fs::write(&temporary, data)?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(if mode == "100755" {0o755} else {0o644}))?;
        }
        fs::rename(temporary, destination)?;
    }
    Ok(())
}
fn discover_files(root: &Path, selectors: &[String]) -> Result<BTreeSet<String>> {
    let mut found = BTreeSet::new();
    for entry in WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| e.depth() == 0 ||
        e.file_name() != ".devhub") {
        let entry = entry?;
        if entry.depth() == 0 || entry.file_type().is_dir() { continue; }
        let path = entry.path().strip_prefix(root)?.to_string_lossy().replace('\\', "/");
        if !valid_path(&path) { continue; }
        if selected(&path, selectors) { found.insert(path); }
    }
    Ok(found)
}
fn status_items(root: &Path, state: &Workspace) -> Result<Vec<(String, &'static str)>> {
    let paths = discover_files(root, &state.selectors)?;
    let mut out = Vec::new();
    for (path, entry) in &state.entries {
        if !entry.materialized { continue; }
        if !paths.contains(path) { out.push((path.clone(), "deleted")); }
        else if dirty(root, path, entry)? { out.push((path.clone(), "modified")); }
    }
    for path in paths {
        if !state.entries.contains_key(&path) { out.push((path, "added")); }
    }
    out.sort(); Ok(out)
}
fn sync(root: &Path, state: &mut Workspace, force_hydrate: bool) -> Result<()> {
    if state.pending.is_some() { bail!("An unpublished changeset is pending; resume or abort it before syncing"); }
    let api = api(state)?;
    let reference = api.refs()?.records.into_iter().find(|r| r.name == state.ref_name)
        .ok_or_else(|| anyhow!("Remote ref not found; no local files were changed"))?;
    let new_tree = api.tree(&reference.changeset_id, &state.selectors)?;
    let mut remote = BTreeMap::new();
    for e in new_tree.entries {
        if !valid_path(&e.path) || !selected(&e.path, &state.selectors) ||
            !matches!(e.mode.as_str(), "100644" | "100755" | "120000") {
            bail!("Untrusted server tree entry");
        }
        check_object_id(&e.object_id)?;
        remote.insert(e.path, Entry { object_id: e.object_id, mode: e.mode, materialized: false });
    }
    for (path, old) in &state.entries {
        if dirty(root, path, old)? { bail!("Unsaved local modifications in {path}; refusing to replace workspace"); }
        let incoming = remote.get(path);
        if !force_hydrate && old.materialized && incoming != Some(old) &&
           incoming.map(|new| new.object_id != old.object_id || new.mode != old.mode).unwrap_or(true) {
            bail!("Server changed hydrated file {path}; run sync --materialize to safely apply it");
        }
    }
    for path in remote.keys() {
        if !state.entries.contains_key(path) && fs::symlink_metadata(root.join(path)).is_ok() {
            bail!("Untracked local path collides with incoming file {path}");
        }
    }
    let cache = root.join(".devhub/cache");
    for (path, entry) in remote.iter_mut() {
        let old = state.entries.get(path);
        let same = old.map(|prev| prev.object_id == entry.object_id && prev.mode == entry.mode).unwrap_or(false);
        if same && old.is_some_and(|old| old.materialized) { entry.materialized = true; continue; }
        if force_hydrate {
            let content = api.download_object(&entry.object_id, &cache)?;
            materialize(root, path, &content, &entry.mode)?;
            entry.materialized = true;
            state.entries.insert(path.clone(), entry.clone());
            save_state(root, state)?;
        }
    }
    if force_hydrate {
        for (path, old) in &state.entries {
            if !remote.contains_key(path) && old.materialized {
                let location = root.join(path);
                if fs::symlink_metadata(&location).is_ok() { fs::remove_file(location)?; }
            }
        }
    }
    state.entries = remote;
    state.head = Some(reference.changeset_id);
    state.generation = Some(reference.generation);
    save_state(root, state)?;
    prune_cache(&cache, state.max_cache_bytes)?;
    println!("Synchronized {} selected files at {}", state.entries.len(), state.head.as_deref().unwrap_or(""));
    Ok(())
}
fn hydrate(root: &Path, state: &mut Workspace, paths: &[String]) -> Result<()> {
    if state.pending.is_some() { bail!("A changeset is pending; cannot materialize a different base"); }
    let head = state.head.as_deref().ok_or_else(|| anyhow!("Run sync first"))?.to_owned();
    let api = api(state)?;
    for path in paths {
        if !valid_path(path) || !selected(path, &state.selectors) { bail!("Path is not in sparse selection: {path}"); }
        let result = api.tree(&head, &[format!("f:{path}")])?;
        let e = result.entries.into_iter().find(|e| e.path == *path)
            .ok_or_else(|| anyhow!("File not found at revision: {path}"))?;
        if let Some(existing) = state.entries.get(path) {
            if !existing.materialized && fs::symlink_metadata(root.join(path)).is_ok() { bail!("Untracked local file would be overwritten: {path}"); }
            if dirty(root, path, existing)? { bail!("Local file modified, refusing overwrite: {path}"); }
        } else if fs::symlink_metadata(root.join(path)).is_ok() { bail!("Untracked file would be overwritten: {path}"); }
        let data = api.download_object(&e.object_id, &root.join(".devhub/cache"))?;
        materialize(root, path, &data, &e.mode)?;
        state.entries.insert(path.clone(), Entry { object_id: e.object_id, mode: e.mode, materialized: true });
        save_state(root, state)?;
        println!("Materialized {path}");
    }
    prune_cache(&root.join(".devhub/cache"), state.max_cache_bytes)
}
fn make_pending(root: &Path, state: &Workspace, message: String) -> Result<Pending> {
    let changed = status_items(root, state)?;
    if changed.is_empty() { bail!("No changes in selected workspace paths"); }
    if changed.len() > 200 { bail!("A changeset supports at most 200 operations"); }
    let mut operations = Vec::new();
    let mut expected = BTreeMap::new();
    for (path, kind) in changed {
        match kind {
            "deleted" => operations.push(json!({"kind":"DELETE", "path":path})),
            "added" | "modified" => {
                let (bytes, mode) = fs_bytes(root, &path)?.ok_or_else(|| anyhow!("File disappeared"))?;
                let object_id = object_hash(&bytes);
                expected.insert(path.clone(), object_id.clone());
                match state.entries.get(&path) {
                    Some(previous) if previous.object_id != object_id && previous.mode != mode =>
                        bail!("Simultaneous content and permission changes require separate changesets: {path}"),
                    Some(previous) if previous.object_id == object_id && previous.mode != mode =>
                        operations.push(json!({"kind":"CHMOD", "path":path, "mode":mode})),
                    Some(_) => operations.push(json!({"kind":"MODIFY", "path":path, "objectId":object_id})),
                    None => operations.push(json!({"kind":"ADD", "path":path, "objectId":object_id, "mode":mode})),
                }
            },
            _ => unreachable!(),
        }
    }
    let parent = state.head.clone();
    let digest = Sha256::digest(serde_json::to_vec(&json!([&parent, &message, &operations]))?);
    Ok(Pending { parent, message, operations, expected, key: hex::encode(digest) })
}
fn publish(root: &Path, state: &mut Workspace, message: Option<String>) -> Result<()> {
    if state.pending.is_none() {
        let text = message.clone().ok_or_else(|| anyhow!("Provide --message for a new changeset"))?;
        if text.trim().is_empty() { bail!("Changeset message cannot be empty"); }
        state.pending = Some(make_pending(root, state, text)?);
        save_state(root, state)?;
    }
    let pending = state.pending.clone().unwrap();
    if let Some(message) = message {
        if message != pending.message { bail!("Pending changeset message differs; resume without --message"); }
    }
    let api = api(state)?;
    for (path, expected) in &pending.expected {
        let (bytes, _) = fs_bytes(root, path)?.ok_or_else(|| anyhow!("Pending file disappeared: {path}"))?;
        if object_hash(&bytes) != *expected {
            bail!("Pending file {path} changed since publication started; refusing to publish");
        }
        api.upload_object(&bytes)?;
    }
    let input = OpInput { api_version: 2, parents: pending.parent.clone().into_iter().collect(),
        description: pending.message.clone(), idempotency_key: pending.key.clone(), operations: pending.operations.clone() };
    let receipt: Receipt = api.post(2, "/changesets", &input)?;
    // A changeset is immutable. This updates the local base only, never the remote ref.
    for op in &pending.operations {
        let path = op["path"].as_str().ok_or_else(|| anyhow!("Invalid stored operation"))?.to_owned();
        match op["kind"].as_str().unwrap_or("") {
            "DELETE" => { state.entries.remove(&path); },
            "ADD" | "MODIFY" => {
                let id = op["objectId"].as_str().ok_or_else(|| anyhow!("Missing object ID"))?.to_owned();
                let mode = op["mode"].as_str().map(str::to_owned)
                    .or_else(|| state.entries.get(&path).map(|e| e.mode.clone()))
                    .unwrap_or_else(|| "100644".to_string());
                state.entries.insert(path, Entry { object_id: id, mode, materialized: true });
            },
            "CHMOD" => if let Some(entry) = state.entries.get_mut(&path) {
                entry.mode = op["mode"].as_str().unwrap_or("100644").to_owned();
            },
            _ => bail!("Invalid stored operation"),
        }
    }
    state.head = Some(receipt.id.clone());
    state.pending = None;
    save_state(root, state)?;
    println!("Published native changeset {} (reference unchanged)", receipt.id);
    Ok(())
}
fn show(value: Value) -> Result<()> { println!("{}", serde_json::to_string_pretty(&value)?); Ok(()) }
fn run(cli: Cli) -> Result<()> {
    match cli.cmd {
        Command::Auth { action } => match action {
            AuthCommand::Login { server, repository, token_stdin } => {
                if !token_stdin { bail!("Use --token-stdin to keep credentials out of shell history"); }
                validate_server(&server)?;
                let server = server.trim_end_matches('/').to_owned();
                let mut raw = String::new();
                io::stdin().read_to_string(&mut raw)?;
                let raw = raw.trim().to_owned();
                if raw.len() < 32 { bail!("Invalid token length"); }
                Api::new(&server, &repository, raw.clone())?.refs().context("Credential validation failed")?;
                let mut creds = read_credentials()?;
                creds.servers.insert(server, raw);
                atomic_json(&credentials_path()?, &creds, true)?;
                println!("Credentials validated and saved");
                Ok(())
            },
            AuthCommand::Status { server } => {
                let creds = read_credentials()?;
                if let Some(server) = server { println!("{}", if token(&server).is_ok() { "Configured" } else { "Not configured" }); }
                else { for server in creds.servers.keys() { println!("{server}"); } }
                Ok(())
            },
            AuthCommand::Logout { server } => {
                let mut creds = read_credentials()?;
                creds.servers.remove(server.trim_end_matches('/'));
                atomic_json(&credentials_path()?, &creds, true)?;
                println!("Local credentials deleted"); Ok(())
            },
        },
        Command::Init { server, repository, r#ref } => {
            validate_server(&server)?;
            if repository.len() != 36 || !repository.chars().all(|x| x.is_ascii_hexdigit() || x == '-') {
                bail!("Repository must be a UUID");
            }
            let root = std::env::current_dir()?.canonicalize()?;
            if root.join(".devhub").exists() { bail!("A .devhub directory already exists"); }
            let state = Workspace { server: server.trim_end_matches('/').to_owned(), repository, ref_name: r#ref,
                head: None, generation: None, selectors: vec![], entries: BTreeMap::new(),
                pending: None, max_cache_bytes: DEFAULT_CACHE };
            api(&state)?.refs().context("Cannot initialize while disconnected or unauthorized")?;
            save_state(&root, &state)?;
            println!("Workspace initialized without cloning repository objects; use select then sync");
            Ok(())
        },
        Command::Select { files, directories, clear } => {
            let root = workspace_root()?;
            let mut state = load_state(&root)?;
            if state.pending.is_some() { bail!("Cannot change sparse selection during pending publication"); }
            let mut selected_paths = if clear { Vec::new() } else { state.selectors.clone() };
            for path in files {
                if !valid_path(&path) { bail!("Invalid file selection: {path}"); }
                selected_paths.push(format!("f:{path}"));
            }
            for path in directories {
                if path != "." && !valid_path(&path) { bail!("Invalid directory selection: {path}"); }
                selected_paths.push(format!("d:{path}"));
            }
            selected_paths.sort(); selected_paths.dedup();
            if selected_paths.len() > 128 { bail!("Selection exceeds 128 selectors"); }
            let removed: Vec<_> = state.entries.iter().filter(|(path, _)| !selected(path, &selected_paths)).collect();
            if !removed.is_empty() {
                bail!("Deselecting tracked paths requires a fresh workspace; refuses to silently abandon local tracking");
            }
            state.selectors = selected_paths;
            save_state(&root, &state)?;
            println!("Selected {} paths/prefixes", state.selectors.len());
            Ok(())
        },
        Command::Sync { materialize } => {
            let root = workspace_root()?; let mut state = load_state(&root)?;
            sync(&root, &mut state, materialize)
        },
        Command::Hydrate { paths } => {
            let root = workspace_root()?; let mut state = load_state(&root)?;
            hydrate(&root, &mut state, &paths)
        },
        Command::Status { json } => {
            let root = workspace_root()?; let state = load_state(&root)?;
            let changes = status_items(&root, &state)?;
            if json { show(json!({ "revision": state.head, "offline": true, "pending": state.pending.is_some(),
                "changes": changes.iter().map(|(p,k)| json!({"path":p,"kind":k})).collect::<Vec<_>>() })) }
            else {
                println!("Workspace base: {}", state.head.as_deref().unwrap_or("(uninitialized)"));
                for (path, kind) in &changes { println!("{:9} {}", kind, path); }
                if state.pending.is_some() { println!("Pending publication can be resumed"); }
                if changes.is_empty() { println!("No materialized file changes"); }
                Ok(())
            }
        },
        Command::History { revision, path, limit } => {
            let root = workspace_root()?; let state = load_state(&root)?;
            let head = revision.or_else(|| state.head.clone()).ok_or_else(|| anyhow!("No revision"))?;
            let mut args = vec![("revision", head.as_str()), ("limit", "")];
            let limit_string = limit.min(100).to_string(); args[1] = ("limit", &limit_string);
            if let Some(p) = path.as_deref() {
                if !valid_path(p) { bail!("Invalid path"); } args.push(("path", p));
            }
            show(api(&state)?.query("history", &args)?)
        },
        Command::Diff { from, to, path } => {
            let root = workspace_root()?; let state = load_state(&root)?;
            let mut args = vec![("from", from.as_str()), ("to", to.as_str())];
            if let Some(p) = path.as_deref() { if !valid_path(p) { bail!("Invalid path"); } args.push(("path", p)); }
            show(api(&state)?.query("diff", &args)?)
        },
        Command::Blame { path, revision } => {
            if !valid_path(&path) { bail!("Invalid path"); }
            let root = workspace_root()?; let state = load_state(&root)?;
            let id = revision.or_else(|| state.head.clone()).ok_or_else(|| anyhow!("No revision"))?;
            show(api(&state)?.query("blame", &[("revision", &id), ("path", &path)])?)
        },
        Command::Ancestry { left, right } => {
            let root = workspace_root()?; let state = load_state(&root)?;
            show(api(&state)?.query("ancestry", &[("left", &left), ("right", &right)])?)
        },
        Command::Merge { base, ours, theirs } => {
            let root = workspace_root()?; let state = load_state(&root)?;
            show(api(&state)?.query("merge", &[("base", &base), ("ours", &ours), ("theirs", &theirs)])?)
        },
        Command::Changeset { action } => {
            let root = workspace_root()?; let mut state = load_state(&root)?;
            match action {
                ChangeCommand::Create { message } => publish(&root, &mut state, message),
                ChangeCommand::AbortPending => {
                    state.pending = None; save_state(&root, &state)?;
                    println!("Local pending publication removed; remote immutable objects remain"); Ok(())
                },
            }
        },
        Command::Review { action } => {
            let root = workspace_root()?; let state = load_state(&root)?;
            let remote = api(&state)?;
            match action {
                ReviewCommand::List => show(remote.get(2, "/reviews")?),
                ReviewCommand::Submit { changeset, target, title, description } => {
                    let id = changeset.or_else(|| state.head.clone()).ok_or_else(|| anyhow!("No changeset to submit"))?;
                    check_object_id(&id)?;
                    let result: Value = remote.post(2, "/reviews", &json!({
                        "changesetId": id, "targetRef": target, "title": title, "description": description,
                    }))?;
                    show(result)
                },
            }
        },
    }
}
fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("error: {error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn object_identity_includes_blob_domain() {
        assert_eq!(object_hash(b"hello"), hex::encode(Sha256::digest(b"BLOB\0hello")));
        assert_ne!(object_hash(b""), hex::encode(Sha256::digest(b"")));
    }
    #[test]
    fn traversal_and_selectors() {
        for p in ["../a", "a/../b", "/a", "a//b", ".devhub/credentials", "C:/Windows", "foo\\bar"] {
            assert!(!valid_path(p), "{p}");
        }
        assert!(selected("src/main.rs", &["d:src".to_owned()]));
        assert!(!selected("src2/main.rs", &["d:src".to_owned()]));
        assert!(selected("Cargo.toml", &["f:Cargo.toml".to_owned()]));
    }
    #[test]
    fn cache_discard_and_status_detects_modified_file() -> Result<()> {
        let temp = tempfile::tempdir()?;
        fs::write(temp.path().join("main.rs"), b"original")?;
        let entry = Entry { object_id: object_hash(b"original"), mode: "100644".to_owned(), materialized: true };
        assert!(!dirty(temp.path(), "main.rs", &entry)?);
        fs::write(temp.path().join("main.rs"), b"changed")?;
        assert!(dirty(temp.path(), "main.rs", &entry)?);
        Ok(())
    }
    #[test]
    fn pending_request_is_stable() -> Result<()> {
        let temp = tempfile::tempdir()?;
        fs::write(temp.path().join("main.rs"), b"new")?;
        let state = Workspace { server: "https://devhub.invalid".to_owned(), repository: "00000000-0000-0000-0000-000000000000".to_owned(),
            ref_name: "main".to_owned(), head: None, generation: None, selectors: vec!["d:.".to_owned()],
            entries: BTreeMap::new(), pending: None, max_cache_bytes: DEFAULT_CACHE };
        let a = make_pending(temp.path(), &state, "add".to_owned())?;
        let b = make_pending(temp.path(), &state, "add".to_owned())?;
        assert_eq!(a.key, b.key);
        assert_eq!(a.operations, b.operations);
        Ok(())
    }
}
