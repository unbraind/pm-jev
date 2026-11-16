import { testTime } from "./support/time.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { project, trackerSnapshot, withoutGit } from "./fixtures.ts";

for (const [name, paths] of [["native", path], ["win32", path.win32]] as const) {
  test(`trackerSnapshot excludes only the root runtime directory with ${name} paths`, t => {
    const root = mkdtempSync(path.join(tmpdir(), "jev-snapshot-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const files = ["item.toon", "runtime/cache.json", "runtime/nested/usage.json", "runtime-notes/note.txt", "tasks/runtime/item.toon"];
    for (const file of files) {
      const target = path.join(root, ...file.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file);
    }
    const before = trackerSnapshot(root, paths);
    const expected = Object.fromEntries([files[0], files[3], files[4]].map(file => [
      file.split("/").join(paths.sep), createHash("sha256").update(file).digest("hex"),
    ]));
    assert.deepEqual(before, expected);
    writeFileSync(path.join(root, "runtime", "cache.json"), "updated cache");
    assert.deepEqual(trackerSnapshot(root, paths), before);
    writeFileSync(path.join(root, "runtime-notes", "note.txt"), "updated note");
    const after = trackerSnapshot(root, paths);
    assert.notEqual(after[["runtime-notes", "note.txt"].join(paths.sep)], before[["runtime-notes", "note.txt"].join(paths.sep)]);
  });
}

for (const initialized of [false, true]) test(`project owns its temporary tracker inside a Git parent (tracker=${initialized})`, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "jev-parent-"));
  const keys = ["TMPDIR", "TMP", "TEMP", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "PM_PATH", "GIT_COMMON_DIR"];
  const saved = keys.map(key => [key, process.env[key]] as const);
  try {
    const env = { ...process.env };
    for (const key of keys.slice(3)) delete env[key];
    execFileSync("git", ["init", parent], { env, stdio: "pipe" });
    if (initialized) {
      const pm = new PmClient({ cwd: parent, pmRoot: path.join(parent, ".agents/pm"), noExtensions: true, author: "fixture" });
      await withoutGit(parent, () => pm.init("parent", { defaults: true, agentGuidance: "skip" }));
      await pm.create({ type: "Task", title: "Parent sentinel" });
    }
    const before = trackerSnapshot(parent);
    for (const key of keys.slice(0, 3)) process.env[key] = parent;
    process.env.GIT_DIR = path.join(parent, ".git");
    process.env.GIT_WORK_TREE = parent;
    process.env.GIT_INDEX_FILE = path.join(parent, ".git/custom-index");
    process.env.GIT_COMMON_DIR = path.join(parent, ".git");
    process.env.PM_PATH = path.join(parent, ".agents/pm");
    const fixture = await project();
    try {
      assert.equal(path.dirname(fixture.cwd), parent);
      assert.equal(fixture.pmRoot, path.join(fixture.cwd, ".agents/pm"));
      assert.ok(existsSync(path.join(fixture.pmRoot, "settings.json")));
      assert.equal((await fixture.pm.listAllComplete()).items.length, 0);
      for (const key of keys.slice(3)) assert.equal(process.env[key], ["GIT_DIR", "GIT_COMMON_DIR"].includes(key) ? path.join(parent, ".git") : key === "GIT_WORK_TREE" ? parent : key === "GIT_INDEX_FILE" ? path.join(parent, ".git/custom-index") : path.join(parent, ".agents/pm"));
    } finally { fixture.dispose(); }
    assert.deepEqual(trackerSnapshot(parent), before);
  } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(parent, { recursive: true, force: true });
  }
});

test("harness scale validates before spawning and rounds fractional milliseconds", () => {
  const saved = process.env.PM_TEST_TIME_SCALE;
  try {
    delete process.env.PM_TEST_TIME_SCALE;
    assert.equal(testTime(3), 3);
    process.env.PM_TEST_TIME_SCALE = "1.1";
    assert.equal(testTime(3), 4);
    for (const value of ["", "0", "-1", "NaN", "Infinity"]) {
      process.env.PM_TEST_TIME_SCALE = value;
      assert.throws(() => testTime(3), /PM_TEST_TIME_SCALE/);
    }
  } finally {
    if (saved === undefined) delete process.env.PM_TEST_TIME_SCALE;
    else process.env.PM_TEST_TIME_SCALE = saved;
  }
});
