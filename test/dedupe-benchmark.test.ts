import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("one-shot benchmark refuses non-empty scratch before source collection and preserves evidence", t => {
  const root = mkdtempSync(join(tmpdir(), "jev-benchmark-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "report.json");
  writeFileSync(output, "existing report");
  for (const name of ["corpora.json", "tev1-4b-observations.json", "report-progress.json", ".partial", "pm-source"]) {
    const scratch = join(root, name.replaceAll(".", "-") + "-scratch");
    mkdirSync(scratch);
    const entry = join(scratch, name);
    if (name === "pm-source") mkdirSync(entry);
    else writeFileSync(entry, "retained evidence");
    const result = spawnSync(process.execPath, ["test/dedupe-calibration.acceptance.ts", join(root, "missing-fleet"), scratch, output], {
      cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 30_000,
      env: { ...process.env, PATH: "" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Error: Benchmark is one-shot; failed runs require a new empty scratch directory\. Non-empty scratch directory refused\./);
    assert.equal(result.stdout, "");
    assert.deepEqual(readdirSync(scratch), [name]);
    if (name === "pm-source") assert.deepEqual(readdirSync(entry), []);
    else assert.equal(readFileSync(entry, "utf8"), "retained evidence");
    assert.equal(readFileSync(output, "utf8"), "existing report");
  }
});

test("precision-first benchmark refuses reused collection and inference before tools or evidence writes", t => {
  const scratch = mkdtempSync(join(tmpdir(), "jev-quality-once-"));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  mkdirSync(join(scratch, "inference"));
  writeFileSync(join(scratch, "inference", "observations.json"), "checkpoint");
  const output = join(scratch, "report.json");
  writeFileSync(output, "report retained");
  for (const mode of ["collect", "infer"]) {
    const result = spawnSync(process.execPath, ["test/duplicate-quality.acceptance.ts", mode, "missing-public-fleet", scratch, output], { encoding: "utf8", timeout: 60_000, cwd: new URL("..", import.meta.url), env: { ...process.env, PATH: "" } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, mode === "collect" ? /Collection requires an empty scratch directory/ : /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), "report retained");
    assert.equal(readFileSync(join(scratch, "inference", "observations.json"), "utf8"), "checkpoint");
  }
});
