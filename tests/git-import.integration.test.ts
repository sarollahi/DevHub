import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { db } from "../src/lib/prisma";
import { createGitImport, runGitImport, requestGitImport, verifyGitImport } from "../src/source-control/git-importer";
import { getCanonicalSnapshot } from "../src/source-control/canonical";
import { getObject } from "../src/source-control/service";

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env,
    GIT_AUTHOR_NAME: "History Author", GIT_AUTHOR_EMAIL: "historian@example.test",
    GIT_COMMITTER_NAME: "History Committer", GIT_COMMITTER_EMAIL: "committer@example.test",
    GIT_AUTHOR_DATE: "2021-06-11T12:20:00+02:00",
    GIT_COMMITTER_DATE: "2021-06-12T16:30:00+02:00" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

test("real repository with merges, symlinks, executable mode and >4 MiB blobs survives native migration and resume", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "native-git-migration-"));
  const directory = join(root, "history");
  const previousRoot = process.env.GIT_IMPORT_ROOT;
  try {
    await mkdir(directory);
    process.env.GIT_IMPORT_ROOT = root;
    git(directory, "init", "-b", "main");
    await writeFile(join(directory, "README.md"), "initial\n");
    git(directory, "add", "."); git(directory, "commit", "-m", "Initial commit");
    const rootSha = git(directory, "rev-parse", "HEAD");
    git(directory, "checkout", "-b", "feature");
    await writeFile(join(directory, "feature.txt"), "feature\n");
    git(directory, "add", "."); git(directory, "commit", "-m", "Feature branch");
    git(directory, "checkout", "main");
    await writeFile(join(directory, "run.sh"), "#!/bin/sh\necho ok\n");
    await chmod(join(directory, "run.sh"), 0o755);
    await symlink("README.md", join(directory, "readme-link"));
    const large = randomBytes(5 * 1024 * 1024 + 11);
    await writeFile(join(directory, "large.bin"), large);
    git(directory, "add", "."); git(directory, "commit", "-m", "Binary and file modes");
    git(directory, "merge", "--no-ff", "feature", "-m", "Merge feature");
    git(directory, "tag", "-a", "v1.0.0", "-m", "Initial release");
    git(directory, "checkout", "-b", "parallel", rootSha);
    await writeFile(join(directory, "parallel.txt"), "parallel branch");
    git(directory, "add", "."); git(directory, "commit", "-m", "Parallel branch");
    git(directory, "checkout", "main");
    git(directory, "merge", "--no-ff", "parallel", "-m", "Merge parallel branch");
    git(directory, "mv", "feature.txt", "renamed.txt");
    git(directory, "commit", "-m", "Rename feature");

    const suffix = randomBytes(6).toString("hex");
    const user = await db.user.create({ data: { handle: "gitimport-" + suffix, email: "import-" + suffix + "@example.test" } });
    const repo = await db.repository.create({ data: { ownerId: user.id, slug: "gitimport-" + suffix, name: "Git import test" } });
    const job = await createGitImport(repo.id, directory);
    const first = await runGitImport(job.id);
    assert.ok(first.commits >= 7);
    assert.ok(first.treesVerified >= 2);
    assert.equal((await db.gitImportJob.findUniqueOrThrow({ where: { id: job.id } })).status, "COMPLETED");
    const gitHead = git(directory, "rev-parse", "main");
    const mapped = await db.gitImportCommit.findUniqueOrThrow({
      where: { repositoryId_gitSha: { repositoryId: repo.id, gitSha: gitHead } },
    });
    assert.equal(mapped.authorEmail, "historian@example.test");
    assert.equal(mapped.authorTimezone, "+0200");
    assert.equal(mapped.committerEmail, "committer@example.test");
    const snapshot = await getCanonicalSnapshot(repo.id, mapped.changesetId);
    assert.equal(snapshot.entries.find(e => e.path === "run.sh")?.mode, "100755");
    assert.equal(snapshot.entries.find(e => e.path === "readme-link")?.mode, "120000");
    assert.ok(snapshot.entries.some(e => e.path === "renamed.txt"));
    assert.ok(!snapshot.entries.some(e => e.path === "feature.txt"));
    const binaryId = snapshot.entries.find(e => e.path === "large.bin")?.objectId;
    assert.ok(binaryId);
    const binary = await db.sourceObject.findUniqueOrThrow({ where: { id: binaryId } });
    assert.equal(binary.data, null);
    assert.equal(binary.byteSize, BigInt(large.length));
    await assert.rejects(() => getObject(repo.id, binaryId), /STREAM_REQUIRED|streaming endpoint|stream large stored blobs/);
    const ref = await db.sourceReference.findUniqueOrThrow({
      where: { repositoryId_name: { repositoryId: repo.id, name: "tags/v1.0.0" } },
    });
    assert.ok(ref.changesetId);
    const count = await db.gitImportCommit.count({ where: { repositoryId: repo.id } });
    await requestGitImport(job.id);
    const replay = await runGitImport(job.id);
    assert.equal(replay.commits, count);
    assert.equal(await db.gitImportCommit.count({ where: { repositoryId: repo.id } }), count);

    // Incremental Git activity doesn't invalidate the old SHA map.
    await writeFile(join(directory, "fresh.txt"), "created after first import");
    git(directory, "add", "."); git(directory, "commit", "-m", "New incremental commit");
    await requestGitImport(job.id);
    const changed = await runGitImport(job.id);
    assert.equal(changed.commits, count + 1);
    assert.equal(await db.gitImportCommit.count({ where: { repositoryId: repo.id } }), count + 1);
    assert.equal((await verifyGitImport(job.id)).commits, count + 1);
  } finally {
    if (previousRoot === undefined) delete process.env.GIT_IMPORT_ROOT;
    else process.env.GIT_IMPORT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
