/** Opt-in packed-host acceptance against a real local decision model and eight synthetic items. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, devNull } from "node:os";
import type { LinkDecision } from "../index.ts";
import { project, trackerSnapshot } from "./fixtures.ts";

const execute = promisify(execFile);

test("packed real host proposes relationships with local tev1:4b", { timeout: 600000 }, async () => {
  const fixture = await project();
  const scratch = mkdtempSync(join(tmpdir(), "jev-link-live-"));
  const root = resolve(".");
  const env = { ...process.env, PM_AUTHOR: "fixture", PM_JEV_BASE_URL: "http://localhost:11434", PM_JEV_MODEL: "tev1:4b", PM_PATH: "", PM_GLOBAL_PATH: join(scratch, "global"), PM_TELEMETRY_OPT_OUT: "1", npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull };
  try {
    const packed = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, env });
    const tarball = join(scratch, JSON.parse(packed.stdout)[0].filename as string);
    writeFileSync(join(fixture.cwd, "package.json"), JSON.stringify({ name: "synthetic-link-consumer", private: true, type: "module" }));
    await execute("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, "@unbrained/pm-cli@2026.10.11"], { cwd: fixture.cwd, env, timeout: 180000 });
    const pmBin = join(fixture.cwd, "node_modules/.bin/pm");
    await execute(pmBin, ["install", tarball], { cwd: fixture.cwd, env, timeout: 120000 });
    const descriptions = [
      ["Login session expiry validation", "Implement login expiry checks. Blocked by the login session database migration because its expiry column must exist first. Blocks the login session rollout. Part of the login session security epic."],
      ["Login session database migration", "Create the expiry column required before login session expiry validation can begin."],
      ["Login session rollout", "Enable login session expiry validation for users after the validation implementation is complete."],
      ["Login session security epic", "Umbrella objective containing login session expiry validation and the database migration."],
      ["Login session expiry tests", "Verify that expired login sessions are rejected by the login session expiry validation implementation."],
      ["Login session documentation", "Explain login session expiry behavior to administrators; no ordering dependency."],
      ["Login session expiry research", "Explore login session expiry alternatives. Background context, no implementation dependency."],
      ["Image upload thumbnail colors", "Adjust thumbnail colors in the image upload screen."],
    ];
    const items = [];
    for (const [index, [title, description]] of descriptions.entries()) items.push((await fixture.pm.create({ type: index === 3 ? "Epic" : "Task", title, description })).item);
    // Pre-existing edge must remain excluded even when the real model selects it.
    await fixture.pm.update(items[0].id, { dep: [`id=${items[1].id},kind=blocked_by`] });
    const before = trackerSnapshot(fixture.pmRoot);
    const started = performance.now();
    const output = await execute(pmBin, ["--json", "jev", "link", items[0].id], { cwd: fixture.cwd, env, timeout: 270000 });
    const latency = Math.round(performance.now() - started);
    const result = JSON.parse(output.stdout) as LinkDecision;
    assert.equal(result.model, "tev1:4b");
    assert.equal(result.proposals.length, 6);
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    assert.deepEqual(result.applied, []);
    for (const proposal of result.proposals) {
      if (proposal.existing) assert.equal(proposal.kind, null);
      console.log(JSON.stringify({ candidate_title: items.find(item => item.id === proposal.candidate)!.title, ...proposal }));
    }
    console.log(JSON.stringify({ model: result.model, catalog_version: result.catalog_version, latency_ms: latency, usage: result.usage, items: items.length, candidates: result.proposals.length, dry_run_authoritative_files_unchanged: true }));
    const failure = await execute(pmBin, ["--json", "jev", "link", "--open", "--limit", "1"], { cwd: fixture.cwd, env: { ...env, PM_JEV_MODEL: "synthetic-nonexistent-decision-model" }, timeout: 30000 })
      .then(() => { throw new Error("Operational backlog failure exited zero"); }, error => error as { code: number; stdout: string });
    assert.equal(failure.code, 1);
    const failedRows = failure.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.equal(failedRows[0].outcome, "failed");
    assert.equal(failedRows[1].failed, 1);
    assert.equal(failedRows[1].exit_code, 1);
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    console.log("Installed host: missing model produced one failed backlog row and exit 1 without authoritative writes.");
    // Activate the installed extension's actual mutation guard through the public host command.
    const expired = `pm-jev link receipt: model=tev1:4b, catalog=pm-jev-link/1, input_sha256=${"0".repeat(64)}, deadline_ms=0, applied=[].`;
    const denied = await execute(pmBin, ["--json", "update", items[0].id, "--comment", expired], { cwd: fixture.cwd, env }).then(() => { throw new Error("Host accepted a stale receipt"); }, error => error as { stdout: string; stderr: string; code: number });
    assert.notEqual(denied.code, 0);
    assert.match(denied.stdout + denied.stderr, /jev_stale_inference/);
    assert.equal((await fixture.pm.comments(items[0].id)).count, 0);
    console.log("Installed host lock guard refused stale receipt; dry-run wrote no authoritative tracker artifact.");
  } finally { fixture.dispose(); rmSync(scratch, { recursive: true, force: true }); }
});
