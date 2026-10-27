import { readCanonicalSnapshotForValidation } from "../source-control/canonical";
import { db } from "../lib/prisma";
import { objectId } from "../source-control/storage";
import { Readable } from "node:stream";
import { findReadableObject, verifiedBlobStream } from "../object-store/service";
import { digest } from "./policy";
import { SourceControlError } from "../source-control/contracts";
export type Entry = { path: string; objectId: string; mode: string };
export type Snapshot = { entries: Entry[]; digest: string; dependencyDigest: string };

const locks = /(^|\/)(package(-lock)?\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|Cargo\.toml|go\.mod|go\.sum|pom\.xml|requirements[^/]*\.txt|poetry\.lock|uv\.lock|Gemfile\.lock|gradle\.lockfile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/;
const same = (a: Entry | undefined, b: Entry | undefined) => !a && !b || !!a && !!b && a.objectId === b.objectId && a.mode === b.mode;
function sorted(entries: Iterable<Entry>) { return [...entries].sort((a,b)=>a.path.localeCompare(b.path, "en")); }
export async function snapshotFor(repositoryId: string, changesetId: string, targetId: string | null): Promise<Snapshot> {
  const subject = await readCanonicalSnapshotForValidation(repositoryId, changesetId);
  let entries = sorted(subject.entries.map(e => ({ path: e.path, objectId: e.objectId, mode: "mode" in e ? String(e.mode) : "100644" })));
  if (targetId) {
    const subjectChange = await db.sourceChangeset.findFirst({ where: { id: changesetId, repositoryId },
      include: { parents: { where: { position: 0 } } } });
    if (!subjectChange) throw new SourceControlError(404, "NOT_FOUND", "Changeset does not exist");
    const baseId = subjectChange.parents[0]?.parentId;
    const baseEntries = baseId ? (await readCanonicalSnapshotForValidation(repositoryId, baseId)).entries : [];
    const targetEntries = (await readCanonicalSnapshotForValidation(repositoryId, targetId)).entries;
    const baseline = new Map(baseEntries.map(e => [e.path, { path:e.path, objectId:e.objectId, mode:"mode" in e ? String(e.mode):"100644" }]));
    const desired = new Map(entries.map(e => [e.path, e]));
    const target = new Map(targetEntries.map(e => [e.path, { path:e.path, objectId:e.objectId, mode:"mode" in e ? String(e.mode):"100644" }]));
    for (const path of new Set([...baseline.keys(), ...desired.keys()])) {
      if (same(baseline.get(path), desired.get(path))) continue;
      if (!same(target.get(path), baseline.get(path)) && !same(target.get(path), desired.get(path))) {
        throw new SourceControlError(409, "TARGET_SNAPSHOT_CONFLICT", "Changeset conflicts with target at " + path);
      }
      const update = desired.get(path);
      if (update) target.set(path, update); else target.delete(path);
    }
    entries = sorted(target.values());
  }
  const contents = entries.map(e => [e.path, e.objectId, e.mode]);
  return {
    entries,
    digest: digest(JSON.stringify(contents)),
    dependencyDigest: digest(JSON.stringify(contents.filter(e => locks.test(String(e[0]))))),
  };
}
export async function verifiedBlobSource(objectHash:string,repositoryId:string):Promise<Readable> {
  // Source content is globally addressed, but repository visibility is tenant scoped.
  const [owned,staged]=await Promise.all([
    db.sourceFileOperation.findFirst({where:{objectId:objectHash,changeset:{repositoryId}},select:{objectId:true}}),
    db.sourceObjectGrant.findUnique({where:{repositoryId_objectId:{repositoryId,objectId:objectHash}}})
  ]);
  if(!owned&&!staged)throw new Error("Blob not granted to repository");
  const row=await db.sourceObject.findUnique({where:{id:objectHash}});
  if(!row||row.kind!=="BLOB")throw new Error("Missing immutable blob");
  if(row.data){
    if(objectId("BLOB",row.data)!==row.id)throw new Error("Stored object integrity failure");
    return Readable.from([Buffer.from(row.data)]);
  }
  if(row.externalId!==objectHash)throw new Error("Missing external blob identity");
  const storage=await findReadableObject(repositoryId,objectHash);
  return verifiedBlobStream(storage);
}
