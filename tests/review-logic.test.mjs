import test from "node:test";
import assert from "node:assert/strict";
import { assessChange, canApprove, canMerge, validPath, retryDelayMs } from "../src/lib/review-logic.ts";

test("file paths block traversal and dangerous segments", () => {
  for (const path of ["../etc/passwd", "a/../../b", "/absolute", "a\\b", "a//b", "a/./b", ""]) assert.equal(validPath(path), false, path);
  assert.equal(validPath("docs/feature.md"), true);
});
test("patch fingerprint ignores path order and CRLF but preserves content", () => {
  const a = assessChange(["src/b.ts", "src/a.ts"], "a\r\nb");
  const b = assessChange(["src/a.ts", "src/b.ts"], "a\nb");
  assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.fingerprint, assessChange(["src/a.ts", "src/b.ts"], "a\nc").fingerprint);
});
test("sensitive paths and possible secrets increase risk", () => {
  const normal = assessChange(["docs/help.md"], "+docs");
  const sensitive = assessChange(["src/auth/access.ts", "infra/deploy.tf"], "+secret = exposed");
  assert.equal(normal.riskTier, "LOW");
  assert.equal(sensitive.riskTier, "CRITICAL");
  assert.ok(sensitive.flags.length >= 2);
});
test("machine approvals never unlock protected merge", () => {
  assert.equal(canApprove("REVIEW_REQUIRED", ["SUCCESS"], false), false);
  assert.equal(canApprove("REVIEW_REQUIRED", ["SUCCESS"], true), true);
  assert.equal(canMerge("APPROVED", ["SUCCESS"], 0, true), false);
  assert.equal(canMerge("APPROVED", ["SUCCESS"], 1, false), false);
  assert.equal(canMerge("APPROVED", ["SUCCESS"], 1, true), true);
  assert.equal(canMerge("APPROVED", ["SUCCESS", "FAILURE"], 1, true), false);
});
test("retry delay is exponentially backed off and capped", () => {
  assert.equal(retryDelayMs(0), 1000);
  assert.equal(retryDelayMs(3), 8000);
  assert.equal(retryDelayMs(20), 60000);
});
