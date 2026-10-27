import test from "node:test";
import assert from "node:assert/strict";
import { mergeIndependentText } from "../src/integration/text-resolution.ts";

test("merges nonoverlapping line edits deterministically",()=>{
 const base="alpha\nbeta\ngamma\ndelta\n";
 const ours="ALPHA\nbeta\ngamma\ndelta\n";
 const theirs="alpha\nbeta\ngamma\nDELTA\n";
 assert.equal(mergeIndependentText(base,ours,theirs),"ALPHA\nbeta\ngamma\nDELTA\n");
 assert.equal(mergeIndependentText(base,theirs,ours),"ALPHA\nbeta\ngamma\nDELTA\n");
});
test("refuses overlapping replacements, adjacent insertion boundaries and large inputs",()=>{
 assert.equal(mergeIndependentText("x\ny\n","a\ny\n","b\ny\n"),null);
 assert.equal(mergeIndependentText("x\ny\n","a\ny\n","extra\nx\ny\n"),null);
 assert.equal(mergeIndependentText("a\n".repeat(1600),"b\n".repeat(1600),"c\n".repeat(1600)),null);
});
test("identical overlapping edits are deduplicated",()=>{
 assert.equal(mergeIndependentText("a\nb\n","B\nb\n","B\nb\n"),"B\nb\n");
});
