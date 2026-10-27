import test from "node:test";
import assert from "node:assert/strict";
import { assessNativeChangeset, changedRegion, regionOverlap, cosineSimilarity } from "../src/review/analysis.ts";

const entry = id => ({ objectId: id, mode: "100644" });
const idA = "a".repeat(64), idB = "b".repeat(64), idC = "c".repeat(64);
function assess(path, source, content, options = {}) {
  return assessNativeChangeset({
    parents: ["d".repeat(64)], description: options.description || "candidate",
    operations: [{ kind: source ? "MODIFY" : "ADD", path, objectId: idB }],
    before: new Map(source ? [[path, entry(idA)]] : []),
    after: new Map([[path, entry(idB)]]),
    bytes: new Map([[idA, Buffer.from(source || "")], [idB, Buffer.from(content)]]),
  });
}
test("native exact identity excludes free-form descriptions but includes base graph", () => {
  const a = assess("src/a.ts", "old", "new", { description: "first" });
  const b = assess("src/a.ts", "old", "new", { description: "second" });
  assert.equal(a.fingerprint, b.fingerprint);
  const differentBase = assessNativeChangeset({
    parents: [idC], description: "first", operations: [{ kind: "MODIFY", path: "src/a.ts", objectId: idB }],
    before: new Map([["src/a.ts", entry(idA)]]), after: new Map([["src/a.ts", entry(idB)]]),
    bytes: new Map([[idA, Buffer.from("old")], [idB, Buffer.from("new")]]),
  });
  assert.notEqual(a.fingerprint, differentBase.fingerprint);
});
test("deterministic security score overrides innocuous wording", () => {
  const harmless = assess("docs/notes.md", "", "This is a harmless document.");
  assert.equal(harmless.riskTier, "LOW");
  const secret = assess("docs/notes.md", "", 'const api_key = "' + 'A'.repeat(32) + '";');
  assert.equal(secret.riskTier, "CRITICAL");
  assert.ok(secret.findings.some(f => f.code === "POTENTIAL_SECRET"));
  assert.ok(secret.findings.every(f => f.advisory));
  assert.equal(assess("src/auth/policy.ts", "x", "y").riskTier, "HIGH");
});
test("conservative line regions distinguish independent and conflicting edits", () => {
  const base = Buffer.from("first\nsecond\nthird\n");
  const first = changedRegion(base, Buffer.from("FIRST\nsecond\nthird\n"));
  const second = changedRegion(base, Buffer.from("first\nSECOND\nthird\n"));
  const ref = idA;
  const left = [{ path: "src/f.ts", ...first, baseObject: ref }];
  const right = [{ path: "src/f.ts", ...second, baseObject: ref }];
  assert.equal(regionOverlap(left, right), "FILE");
  assert.equal(regionOverlap(left, [{ path: "src/f.ts", ...first, baseObject: ref }]), "REGION");
  assert.equal(regionOverlap(left, [{ path: "src/other.ts", ...first, baseObject: ref }]), "NONE");
  assert.equal(regionOverlap(left, [{ path: "src/f.ts", ...second, baseObject: idB }]), "REGION");
  assert.equal(changedRegion(Buffer.from([0,1]), Buffer.from([0,2])).binary, true);
});
test("semantic cosine scores reject malformed or mismatched model output", () => {
  assert.equal(cosineSimilarity([1,0], [1,0]), 1);
  assert.equal(cosineSimilarity([1,0], [0,1]), 0);
  assert.equal(cosineSimilarity([1,0], [1]), 0);
  assert.equal(cosineSimilarity([NaN], [1]), 0);
});
