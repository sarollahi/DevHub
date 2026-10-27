import test from "node:test";
import assert from "node:assert/strict";
import { planIntegration } from "../src/integration/plan.ts";
const file = (path, objectId, mode = "100644") => ({ path, objectId, mode });
const a = "a".repeat(64), b = "b".repeat(64), c = "c".repeat(64);
test("independent concurrent edits produce a deterministic merge delta", () => {
  const original = [file("one", a), file("two", a)];
  const left = [file("one", b), file("two", a)];
  const right = [file("one", a), file("two", c)];
  assert.deepEqual(planIntegration(original, left, right).operations, [{ kind:"MODIFY", path:"two", objectId:c }]);
  assert.deepEqual(planIntegration(original, right, left).operations, [{ kind:"MODIFY", path:"one", objectId:b }]);
});
test("same file edited differently conflicts, same new content is compatible", () => {
  const original = [file("file", a)];
  const changed = [file("file", b)];
  const different = [file("file", c)];
  const collision = planIntegration(original, changed, different);
  assert.deepEqual(collision.conflicts.map(x=>[x.path,x.code]), [["file","EDIT_CONFLICT"]]);
  assert.deepEqual(collision.operations, []);
  assert.deepEqual(planIntegration(original, changed, changed).conflicts, []);
});
test("delete/modify and parent/child collisions fail closed", () => {
  const original = [file("a", a)];
  const collision = planIntegration(original, [], [file("a",b)]);
  assert.equal(collision.conflicts[0].code,"EDIT_CONFLICT");
  assert.deepEqual(planIntegration([], [file("dir",a)], [file("dir/f",b)]).conflicts.map(x=>x.code),["PATH_COLLISION"]);
});
test("modes, symlinks, binary hashes and rollback are exact", () => {
  const original = [file("tool", a)];
  const update = [file("tool", b,"100755")];
  assert.deepEqual(planIntegration(original, original, update).operations, [
    {kind:"MODIFY",path:"tool",objectId:b,mode:"100755"}
  ]);
  assert.deepEqual(planIntegration(update, update, original).operations, [
    {kind:"MODIFY",path:"tool",objectId:a,mode:"100644"}
  ]);
  assert.deepEqual(planIntegration([],[],[file("link",c,"120000")]).operations, [
    {kind:"ADD",path:"link",objectId:c,mode:"120000"}
  ]);
});
test("retrying against changed target only integrates independent paths", () => {
  const base=[file("base",a),file("left",a),file("right",a)];
  const incoming=[file("base",a),file("left",b),file("right",a)];
  const advanced=[file("base",a),file("left",a),file("right",c)];
  assert.equal(planIntegration(base,advanced,incoming).conflicts.length,0);
  const conflict=[file("base",a),file("left",c),file("right",a)];
  assert.equal(planIntegration(base,conflict,incoming).conflicts.length,1);
});
