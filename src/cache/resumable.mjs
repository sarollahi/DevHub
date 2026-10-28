// Crash-recoverable content-addressed transfer journal.
// A journal checks local chunk integrity; the canonical BLOB hash validates the
// complete object before any bytes become visible to cache readers.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, truncate, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const CHUNK_BYTES = 256 * 1024;
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const hashObject = async (path, kind) => {
  const hash = createHash('sha256').update(kind).update('\0');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
export function journalPaths(p) {
  return { part: p.bin + '.resume', ledger: p.meta + '.resume' };
}
export async function removeJournal(p) {
  const { part, ledger } = journalPaths(p);
  await Promise.all([rm(part, { force: true }), rm(ledger, { force: true })]);
}
async function storeLedger(path, state) {
  const temp = path + '.' + process.pid + '.tmp';
  try {
    const file = await open(temp, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify(state));
      await file.sync();
    } finally { await file.close(); }
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}
export async function readJournal(p, repositoryId, id, maxBytes) {
  const { part, ledger } = journalPaths(p);
  try {
    const state = JSON.parse(await readFile(ledger, 'utf8'));
    if (state.version !== 1 || state.repositoryId !== repositoryId ||
        state.id !== id || state.kind !== 'BLOB' ||
        !Array.isArray(state.chunks) || state.chunks.length > Math.ceil(maxBytes / CHUNK_BYTES) ||
        !state.chunks.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x))) {
      throw new Error('Invalid journal metadata');
    }
    const offset = state.chunks.length * CHUNK_BYTES;
    if (offset > maxBytes || (await stat(part)).size < offset) throw new Error('Invalid journal length');
    const file = await open(part, 'r');
    try {
      const buffer = Buffer.alloc(CHUNK_BYTES);
      for (let i = 0; i < state.chunks.length; i++) {
        let total = 0;
        while (total < CHUNK_BYTES) {
          const { bytesRead } = await file.read(buffer, total, CHUNK_BYTES - total, i * CHUNK_BYTES + total);
          if (!bytesRead) throw new Error('Truncated staged chunk');
          total += bytesRead;
        }
        if (sha(buffer) !== state.chunks[i]) throw new Error('Corrupt staged chunk');
      }
    } finally { await file.close(); }
    await truncate(part, offset); // remove any uncommitted tail
    return { offset, chunks: [...state.chunks], part, ledger };
  } catch {
    await removeJournal(p);
    return { offset: 0, chunks: [], part, ledger };
  }
}
export async function publishVerified(p, { repositoryId, id, kind, bytes }) {
  const meta = p.meta + '.' + process.pid + '.tmp';
  try {
    const file = await open(meta, 'w', 0o600);
    try {
      await file.writeFile(JSON.stringify({ id, repositoryId, kind, size: bytes }));
      await file.sync();
    } finally { await file.close(); }
    const { part } = journalPaths(p);
    await rename(part, p.bin);
    await rename(meta, p.meta);
    await rm(journalPaths(p).ledger, { force: true });
    return { id, repositoryId, kind, size: bytes, time: Date.now() };
  } finally { await rm(meta, { force: true }); }
}
export async function receiveToJournal(response, p, { repositoryId, id, kind, maxBytes, offset, chunks }) {
  await mkdir(p.dir, { recursive: true, mode: 0o700 });
  const { part, ledger } = journalPaths(p);
  if (offset === 0) await removeJournal(p);
  const state = { version: 1, repositoryId, id, kind: 'BLOB', chunks: [...chunks] };
  // Existing files were verified by readJournal. Position writes explicitly.
  const file = await open(part, offset ? 'r+' : 'w', 0o600);
  let written = offset;
  let tail = Buffer.alloc(0);
  try {
    for await (const data of response.body) {
      const bytes = Buffer.from(data);
      if (written + tail.length + bytes.length > maxBytes) throw new Error('Cache object size exceeded');
      tail = Buffer.concat([tail, bytes]);
      while (tail.length >= CHUNK_BYTES) {
        const block = tail.subarray(0, CHUNK_BYTES);
        let done = 0;
        while (done < block.length) {
          const { bytesWritten } = await file.write(block, done, block.length - done, written + done);
          if (!bytesWritten) throw new Error('Journal write stopped');
          done += bytesWritten;
        }
        await file.sync();
        state.chunks.push(sha(block));
        await storeLedger(ledger, state);
        written += block.length;
        tail = tail.subarray(CHUNK_BYTES);
      }
    }
    if (tail.length) {
      let done = 0;
      while (done < tail.length) {
        const { bytesWritten } = await file.write(tail, done, tail.length - done, written + done);
        if (!bytesWritten) throw new Error('Journal write stopped');
        done += bytesWritten;
      }
      written += tail.length;
      await file.sync();
    }
  } finally { await file.close(); }
  if (await hashObject(part, kind) !== id) {
    await removeJournal(p);
    throw new Error('Upstream content digest mismatch');
  }
  return publishVerified(p, { repositoryId, id, kind, bytes: written });
}
export async function pruneJournals(root, maxBytes, activeKeys = new Set(), minAgeMs = 0) {
  const items = [];
  let total = 0;
  const shards = await readdir(join(root, 'objects'), { withFileTypes: true }).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e));
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
    const folder = join(root, 'objects', shard.name);
    for (const item of await readdir(folder)) {
      if (!/^[a-f0-9]{64}\.bin\.resume$/.test(item)) continue;
      if (activeKeys.has(item.slice(0, 64))) continue;
      const part = join(folder, item), ledger = join(folder, item.slice(0, 64) + '.json.resume');
      try {
        const info = await stat(part);
        // Live transfers may begin after a pruning pass takes its flight snapshot.
        // Never touch a recently written stage during routine cleanup.
        if (Date.now() - info.mtimeMs < minAgeMs) continue;
        await stat(ledger);
        items.push({ part, ledger, time: info.mtimeMs, bytes: info.size });
        total += info.size;
      } catch { await Promise.all([rm(part, { force: true }), rm(ledger, { force: true })]); }
    }
  }
  items.sort((a, b) => a.time - b.time);
  for (const item of items) {
    if (total <= maxBytes) break;
    await Promise.all([rm(item.part, { force: true }), rm(item.ledger, { force: true })]);
    total -= item.bytes;
  }
  return total;
}
