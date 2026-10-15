import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { trackerSnapshot } from "./fixtures.ts";

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
