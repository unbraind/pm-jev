import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { removeAdmissionScratch } from "./admission-cleanup.ts";

test("packed cleanup retries ENOTEMPTY and removes a real lock fixture", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "jev-cleanup-"));
  const locks = join(scratch, "global/locks"); mkdirSync(locks, { recursive: true });
  writeFileSync(join(locks, "late-lock"), "synthetic");
  let attempts = 0; const delays: number[] = [];
  try {
    await removeAdmissionScratch(scratch, async (path, options) => {
      assert.equal(existsSync(locks), true);
      if (++attempts === 1) throw Object.assign(new Error("Synthetic nonempty directory"), { code: "ENOTEMPTY" });
      await rm(path, options);
    }, async ms => { delays.push(ms); });
    assert.equal(attempts, 2); assert.deepEqual(delays, [25]); assert.equal(existsSync(scratch), false);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("packed cleanup surfaces exhausted and unrelated errors with a finite retry budget", async () => {
  for (const error of [Object.assign(new Error("nonempty"), { code: "ENOTEMPTY" }), Object.assign(new Error("denied"), { code: "EACCES" }), new Error("unknown"), null]) {
    let attempts = 0; const delays: number[] = [];
    await assert.rejects(removeAdmissionScratch("unused", async () => { attempts++; throw error; }, async ms => { delays.push(ms); }), failure => failure === error);
    assert.equal(attempts, error && 'code' in error && error.code === "ENOTEMPTY" ? 6 : 1);
    assert.deepEqual(delays, attempts === 6 ? [25, 50, 75, 100, 125] : []);
  }
});

test("packed cleanup never converts a failed awaited command into success", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "jev-failed-command-"));
  await assert.rejects(async () => {
    try { await promisify(execFile)(process.execPath, ["-e", "process.exit(23)"]); }
    finally { await removeAdmissionScratch(scratch); }
  }, failure => { assert.equal((failure as { code: number }).code, 23); return true; });
  assert.equal(existsSync(scratch), false);
});
