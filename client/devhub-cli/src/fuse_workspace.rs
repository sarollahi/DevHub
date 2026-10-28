//! Read-only, kernel-visible sparse filesystem. FUSE runs only with an explicit
//! mount; the editable workspace is never overlaid or mutated.
use super::*;
use fuser::{FileAttr, FileType, Filesystem, MountOption, ReplyAttr, ReplyData,
    ReplyDirectory, ReplyEntry, ReplyOpen, Request};
use std::ffi::OsStr;
use std::time::{Duration, SystemTime};

const TTL: Duration = Duration::from_secs(1);
#[derive(Clone)]
struct Node {
    parent: u64,
    name: String,
    path: String,
    entry: Option<Entry>,
    children: Vec<u64>,
}
struct SparseFuse {
    nodes: Vec<Node>,
    api: Api,
    cache_dir: PathBuf,
}
impl SparseFuse {
    fn new(state: &Workspace, cache_dir: PathBuf, remote: Api) -> Result<Self> {
        let mut fs = Self { nodes: vec![
            Node { parent: 1, name: String::new(), path: String::new(),
                   entry: None, children: Vec::new() }
        ], api: remote, cache_dir };
        let mut paths = BTreeMap::from([(String::new(), 1_u64)]);
        for (path, entry) in &state.entries {
            if !valid_path(path) || !selected(path, &state.selectors) { bail!("Invalid FUSE entry path"); }
            let segments: Vec<_> = path.split('/').collect();
            let mut parent = 1;
            let mut current = String::new();
            for (idx, segment) in segments.iter().enumerate() {
                if !current.is_empty() { current.push('/'); }
                current.push_str(segment);
                let last = idx + 1 == segments.len();
                if let Some(inode) = paths.get(&current) {
                    if last || fs.nodes[(*inode - 1) as usize].entry.is_some() {
                        bail!("Conflicting file and directory paths in virtual tree");
                    }
                    parent = *inode;
                    continue;
                }
                let ino = fs.nodes.len() as u64 + 1;
                fs.nodes.push(Node { parent, name: segment.to_string(),
                    path: current.clone(), entry: if last { Some(entry.clone()) } else { None },
                    children: Vec::new() });
                fs.nodes[(parent - 1) as usize].children.push(ino);
                paths.insert(current.clone(), ino);
                parent = ino;
            }
        }
        Ok(fs)
    }
    fn node(&self, ino: u64) -> Option<&Node> {
        self.nodes.get(usize::try_from(ino.checked_sub(1)?).ok()?)
    }
    fn kind(node: &Node) -> FileType {
        match node.entry.as_ref().map(|e| e.mode.as_str()) {
            Some("120000") => FileType::Symlink,
            Some(_) => FileType::RegularFile,
            None => FileType::Directory,
        }
    }
    fn content(&self, node: &Node) -> Result<Vec<u8>> {
        let entry = node.entry.as_ref().ok_or_else(|| anyhow!("Not a file"))?;
        let content = self.api.download_object(&entry.object_id, &self.cache_dir)?;
        // The native client verifies the immutable blob identity on every
        // untrusted transfer, before returning data to the kernel.
        prune_cache(&self.cache_dir, DEFAULT_CACHE)?;
        Ok(content)
    }
    fn attr(&self, ino: u64) -> Result<FileAttr> {
        let node = self.node(ino).ok_or_else(|| anyhow!("Unknown inode"))?;
        let kind = Self::kind(node);
        let size = if node.entry.is_some() { self.content(node)?.len() as u64 } else { 0 };
        let executable = node.entry.as_ref().is_some_and(|e| e.mode == "100755");
        let perm = match kind {
            FileType::Directory => 0o555,
            FileType::Symlink => 0o777,
            _ if executable => 0o555,
            _ => 0o444,
        };
        let now = SystemTime::UNIX_EPOCH;
        Ok(FileAttr {
            ino, size, blocks: size.div_ceil(512), atime: now, mtime: now,
            ctime: now, crtime: now, kind, perm, nlink: 1,
            uid: unsafe { libc::geteuid() }, gid: unsafe { libc::getegid() },
            rdev: 0, blksize: 4096, flags: 0,
        })
    }
}
impl Filesystem for SparseFuse {
    fn lookup(&mut self, _req: &Request<'_>, parent: u64, name: &OsStr, reply: ReplyEntry) {
        let Some(node) = self.node(parent) else { reply.error(libc::ENOENT); return };
        let target = node.children.iter().copied().find(|&ino| {
            self.node(ino).is_some_and(|entry| OsStr::new(&entry.name) == name)
        });
        match target.and_then(|ino| self.attr(ino).ok()) {
            Some(attr) => reply.entry(&TTL, &attr, 0),
            None => reply.error(libc::ENOENT),
        }
    }
    fn getattr(&mut self, _req: &Request<'_>, ino: u64, _fh: Option<u64>, reply: ReplyAttr) {
        match self.attr(ino) {
            Ok(attr) => reply.attr(&TTL, &attr),
            Err(_) => reply.error(libc::EIO),
        }
    }
    fn readdir(&mut self, _req: &Request<'_>, ino: u64, _fh: u64,
               offset: i64, mut reply: ReplyDirectory) {
        let Some(node) = self.node(ino) else { reply.error(libc::ENOENT); return };
        if node.entry.is_some() { reply.error(libc::ENOTDIR); return; }
        let mut entries = vec![
            (ino, FileType::Directory, String::from(".")),
            (node.parent, FileType::Directory, String::from("..")),
        ];
        for &child in &node.children {
            if let Some(n) = self.node(child) {
                entries.push((child, Self::kind(n), n.name.clone()));
            }
        }
        for (i, (child, kind, name)) in entries.into_iter().enumerate().skip(offset.max(0) as usize) {
            if reply.add(child, (i + 1) as i64, kind, name) { break; }
        }
        reply.ok();
    }
    fn open(&mut self, _req: &Request<'_>, ino: u64, flags: i32, reply: ReplyOpen) {
        match self.node(ino) {
            Some(node) if Self::kind(node) == FileType::RegularFile && flags & libc::O_ACCMODE == libc::O_RDONLY =>
                reply.opened(0, 0),
            Some(_) => reply.error(libc::EACCES),
            None => reply.error(libc::ENOENT),
        }
    }
    fn read(&mut self, _req: &Request<'_>, ino: u64, _fh: u64, offset: i64,
            size: u32, _flags: i32, _lock_owner: Option<u64>, reply: ReplyData) {
        let Some(node) = self.node(ino) else { reply.error(libc::ENOENT); return };
        if Self::kind(node) != FileType::RegularFile { reply.error(libc::EISDIR); return; }
        if offset < 0 { reply.error(libc::EINVAL); return; }
        match self.content(node) {
            Ok(bytes) => {
                let start = (offset as usize).min(bytes.len());
                let end = start.saturating_add(size as usize).min(bytes.len());
                reply.data(&bytes[start..end]);
            },
            Err(_) => reply.error(libc::EIO),
        }
    }
    fn readlink(&mut self, _req: &Request<'_>, ino: u64, reply: ReplyData) {
        let Some(node) = self.node(ino) else { reply.error(libc::ENOENT); return };
        if Self::kind(node) != FileType::Symlink { reply.error(libc::EINVAL); return; }
        match self.content(node) {
            Ok(content) => {
                let value = std::str::from_utf8(&content).unwrap_or("");
                if value.is_empty() || value.starts_with('/') || value.contains('\\') ||
                    value.split('/').any(|part| part == ".." || part.is_empty()) {
                    reply.error(libc::EACCES);
                } else { reply.data(&content); }
            },
            Err(_) => reply.error(libc::EIO),
        }
    }
}

pub fn mount(root: &Path, mountpoint: &Path, state: &Workspace) -> Result<()> {
    if state.pending.is_some() { bail!("Cannot mount a workspace with pending publication"); }
    if state.head.is_none() { bail!("Run devhub sync before mounting a sparse revision"); }
    let point = mountpoint.canonicalize().context("Mountpoint must be an existing empty directory")?;
    if point.starts_with(root) { bail!("Mountpoint must be outside the editable workspace"); }
    if fs::read_dir(&point)?.next().is_some() { bail!("Mountpoint must be empty"); }
    let api = api(state)?;
    let fs = SparseFuse::new(state, root.join(".devhub/cache"), api)?;
    fuser::mount2(fs, &point, &[
        MountOption::RO, MountOption::FSName("devhub".into()),
        MountOption::NoSuid, MountOption::NoDev,
    ]).context("FUSE unavailable: install/enable the kernel driver or use explicit hydration")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sparse_tree_exposes_selected_paths_only_without_mounting() -> Result<()> {
        let temp = tempfile::tempdir()?;
        let mut state = Workspace {
            server: "https://example.invalid".into(),
            repository: "00000000-0000-0000-0000-000000000000".into(),
            ref_name: "main".into(), head: Some("a".repeat(64)), generation: Some(1),
            selectors: vec!["d:src".into()], entries: BTreeMap::new(),
            pending: None, max_cache_bytes: DEFAULT_CACHE,
        };
        state.entries.insert("src/a.rs".into(), Entry {
            object_id: "b".repeat(64), mode: "100644".into(), materialized: false,
        });
        state.entries.insert("src/lib/b.rs".into(), Entry {
            object_id: "c".repeat(64), mode: "100644".into(), materialized: false,
        });
        let fs = SparseFuse::new(&state, temp.path().into(), Api::new(&state.server, &state.repository, "fixture-token".to_string())?)?;
        assert_eq!(fs.nodes.len(), 5);
        assert!(fs.nodes.iter().any(|n| n.path == "src/lib/b.rs"));
        assert!(!fs.nodes.iter().any(|n| n.path == "test/hidden.rs"));
        assert_eq!(SparseFuse::kind(&fs.nodes[1]), FileType::Directory);
        Ok(())
    }
}
