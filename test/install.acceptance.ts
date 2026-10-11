/** Exercise direct packed installation and deterministic HTTP decisions with matched host SDKs. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir, devNull } from "node:os";
import test from "node:test";
import { answers, endpoint, project } from "./fixtures.ts";
import { triageSourceHash } from "../dist/index.js";
import type { Questions } from "@typesafe-ai/sdk";

const execute = promisify(execFile);

test("packed npm and Bun consumers install the tarball directly and run host triage", { timeout: 1800000 }, async () => {
  const root = resolve(".");
  const scratch = mkdtempSync(join(tmpdir(), "jev-install-"));
  const fixture = await project();
  const server = await endpoint();
  server.setReply((_, response, body) => {
    const request = body as { state: string; questions: Questions };
    const result = answers(request.questions);
    if (result.answers.proposition) result.answers.proposition = { type: "noul", noul: request.state.includes("ghp_") ? 0.95 : 0.1 };
    response.end(JSON.stringify(result));
  });
  /** Bind consumers to the same public SDK release used to initialize and mutate their tracker. */
  const installed = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@unbrained/pm-cli/package.json"), "utf8")) as { readonly version?: unknown };
  assert.ok(typeof installed.version === "string");
  assert.match(installed.version, /^\d+\.\d+\.\d+$/);
  /** Explicit peer installation prevents npm from selecting a newer incompatible mutation host. */
  const sdk = `@unbrained/pm-cli@${installed.version}`;
  const env: Record<string, string | undefined> = { ...process.env, PM_JEV_BASE_URL: server.url, PM_AUTHOR: "fixture", PM_JEV_MODEL: "tev1:4b", PM_PATH: "", PM_GLOBAL_PATH: join(scratch, "global"), PM_TELEMETRY_OPT_OUT: "1", npm_config_cache: join(scratch, "npm-cache"), npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
  try {
    console.log("packing the built consumer artifact");
    const packed = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, env, timeout: 120000 });
    const tarball = join(scratch, (JSON.parse(packed.stdout) as { filename: string }[])[0].filename);
    for (const runtime of ["npm", "bun"]) {
      const cwd = runtime === "npm" ? fixture.cwd : join(scratch, runtime);
      if (runtime === "bun") mkdirSync(cwd);
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "synthetic-consumer", private: true, type: "module" }));
      const args = runtime === "npm" ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, sdk] : ["add", "--ignore-scripts", tarball, sdk];
      console.log(`${runtime}: installing the packed artifact and matching host`);
      await execute(runtime, args, { cwd, env, timeout: 600000, killSignal: "SIGKILL" });
      const code = 'import {projectItemState,parseQuestionsDocument} from "pm-jev"; const state=projectItemState({id:"synthetic",title:"Synthetic",type:"Issue",status:"open",tags:[]});if(state.title!=="Synthetic"||parseQuestionsDocument({safe:{type:"noul"}}).safe.type!=="noul")throw new Error("library contract failed");console.log("packed consumer passed");';
      const result = await execute(runtime === "npm" ? process.execPath : "bun", ["--input-type=module", "-e", code], { cwd, env });
      assert.match(result.stdout, /packed consumer passed/);
      assert.match(readFileSync(join(cwd, "node_modules", "pm-jev", "docs", "batch-triage.md"), "utf8"), /Batch backlog triage/);
      console.log(`${runtime}: packed library import passed`);
    }
    // Exercise the archive path itself through the public installer, without extraction.
    console.log("host: installing the archive directly");
    await execute(join(fixture.cwd, "node_modules/.bin/pm"), ["install", tarball], { cwd: fixture.cwd, env, timeout: 120000 });
    const created = await fixture.pm.create({ type: "Feature", title: "Every login crashes with an unhandled exception", description: "Regression: the application closes and users cannot sign in", priority: 3 });
    for (const runtime of ["npm", "bun"]) {
      const executable = runtime === "npm" ? "npx" : "bunx";
      const args = [...(runtime === "bun" ? ["--bun"] : []), "--no-install", "pm", "--json", "jev", "triage", created.item.id];
      const result = await execute(executable, args, { cwd: fixture.cwd, env: { ...env, PATH: `${join(fixture.cwd, "node_modules/.bin")}:${env.PATH}` }, timeout: 120000 });
      const decision = JSON.parse(result.stdout) as { proposals: { type: { value: string } }; applied: string[]; model: string };
      assert.ok(["Issue", "Bug"].includes(decision.proposals.type.value));
      assert.deepEqual(decision.applied, []);
      assert.equal(decision.model, "tev1:4b");
      console.log(`${executable}: installed tarball host triage passed`);
    }
    const pmBin = join(fixture.cwd, "node_modules/.bin/pm");
    const compact = await execute(pmBin, ["jev", "triage", created.item.id], { cwd: fixture.cwd, env, timeout: 120000 });
    assert.match(compact.stdout, /omitted_options: 8/);
    const full = await execute(pmBin, ["jev", "triage", created.item.id, "--full"], { cwd: fixture.cwd, env, timeout: 120000 });
    assert.doesNotMatch(full.stdout, /omitted_options/);
    assert.match(full.stdout, /Reminder: /);
    console.log("installed CLI: compact TOON and full flag passed");
    const safetyArgs = ["--json", "jev", "gate", "--noul", "The text contains a credential, API key or password.", "--expect", "false", "--text"];
    const secret = await execute(pmBin, [...safetyArgs, "Deploy with token ghp_SYNTHETIC_EXAMPLE_ONLY; password=synthetic-password"], { cwd: fixture.cwd, env }).then(() => { throw new Error("secret safety gate unexpectedly exited 0"); }, error => error as { code: number; stdout: string });
    assert.equal(secret.code, 1);
    const unsafe = JSON.parse(secret.stdout) as { holds: boolean; expected: boolean; ok: boolean };
    assert.deepEqual([unsafe.holds, unsafe.expected, unsafe.ok], [true, false, false]);
    const clean = await execute(pmBin, [...safetyArgs, "Please adjust the blue button alignment."], { cwd: fixture.cwd, env });
    const safe = JSON.parse(clean.stdout) as { holds: boolean; expected: boolean; ok: boolean };
    assert.deepEqual([safe.holds, safe.expected, safe.ok], [false, false, true]);
    console.log("installed CLI: secret safety gate exited 1; clean safety gate exited 0");
    const negative = await execute(pmBin, ["--json", "jev", "gate", "--noul", "Does this text contain a password?", "--text", "A blue button needs alignment."], { cwd: fixture.cwd, env }).then(() => { throw new Error("negative gate unexpectedly passed"); }, error => error as { code: number; stdout: string });
    assert.equal(negative.code, 1);
    assert.equal((JSON.parse(negative.stdout) as { holds: boolean }).holds, false);
    console.log("installed CLI: negative gate emitted JSON and exited 1");
    for (const runtime of ["npx", "bunx"]) {
      const args = [...(runtime === "bunx" ? ["--bun"] : []), "--no-install", "pm", "--json", "jev", "triage", "--open", "--limit", "1"];
      const response = await execute(runtime, args, { cwd: fixture.cwd, env, timeout: 120000 });
      const lines = response.stdout.trim().split("\n").map(line => JSON.parse(line) as { outcome?: string; selected?: number; would_change?: number });
      assert.equal(lines.length, 2);
      assert.equal(lines[0].outcome, "would_change");
      assert.equal(lines[1].selected, 1);
      assert.equal(lines[1].would_change, 1);
      console.log(`${runtime}: direct tarball batch JSON lines passed`);
    }
    const applyArgs = ["--json", "jev", "triage", "--open", "--apply", "--limit", "1"];
    const applied = await execute(pmBin, applyArgs, { cwd: fixture.cwd, env, timeout: 120000 });
    assert.equal((JSON.parse(applied.stdout.trim().split("\n")[1]) as { changed: number }).changed, 1);
    const requestCount = server.requests.length;
    const reused = await execute("bunx", ["--bun", "--no-install", "pm", ...applyArgs], { cwd: fixture.cwd, env, timeout: 120000 });
    assert.equal((JSON.parse(reused.stdout.trim().split("\n")[1]) as { skipped: number }).skipped, 1);
    assert.equal(server.requests.length, requestCount);
    const receipt = (await fixture.pm.comments(created.item.id)).comments[0].text;
    server.setReply((_, response, body) => {
      void fixture.pm.update(created.item.id, { title: "Changed source during the request" }).then(() => response.end(JSON.stringify(answers((body as { questions: Questions }).questions))));
    });
    const stale = await execute(pmBin, [...applyArgs, "--refresh"], { cwd: fixture.cwd, env, timeout: 120000 });
    assert.equal((JSON.parse(stale.stdout.trim().split("\n")[0]) as { reason: string }).reason, "jev_stale_inference");
    const staleReceipt = receipt.replace(/deadline_ms=\d+/, `deadline_ms=${Number.MAX_SAFE_INTEGER}`);
    const denied = await execute(pmBin, ["--json", "update", created.item.id, "--type", "Feature", "--priority", "3", "--comment", staleReceipt], { cwd: fixture.cwd, env, timeout: 120000 }).then(() => { throw new Error("host accepted a stale triage receipt"); }, error => error as { code: number; stdout: string; stderr: string });
    assert.notEqual(denied.code, 0);
    assert.match(`${denied.stdout}${denied.stderr}`, /jev_stale_inference/);
    assert.equal((await fixture.pm.get(created.item.id)).item.type, "Issue");
    assert.equal((await fixture.pm.comments(created.item.id)).count, 1);
    console.log("installed host: apply, zero-request Bun receipt reuse, stale inference and stale-receipt refusal passed");
    const current = (await fixture.pm.get(created.item.id, { full: true })).item;
    assert.ok(typeof current.title === "string" && typeof current.type === "string" && typeof current.status === "string" && Array.isArray(current.tags));
    assert.equal(typeof current.updated_at, "string");
    const sourceHash = triageSourceHash({ ...current, title: current.title, type: current.type, status: current.status, tags: current.tags });
    const inputHash = createHash("sha256").update(JSON.stringify([sourceHash, current.updated_at, current.type, current.priority])).digest("hex");
    const expiredReceipt = receipt
      .replace(/source_sha256=[a-f0-9]{64}/, `source_sha256=${sourceHash}`)
      .replace(/input_sha256=[a-f0-9]{64}/, `input_sha256=${inputHash}`)
      .replace(/deadline_ms=\d+/, "deadline_ms=0");
    const updateArgs = ["--json", "update", created.item.id, "--type", "Feature", "--priority", "3", "--comment"];
    const expired = await execute(pmBin, [...updateArgs, expiredReceipt], { cwd: fixture.cwd, env, timeout: 120000 }).then(() => { throw new Error("host accepted an expired triage receipt with matching current-source hashes"); }, error => error as { code: number; stdout: string; stderr: string });
    assert.notEqual(expired.code, 0);
    assert.match(`${expired.stdout}${expired.stderr}`, /jev_stale_inference/);
    assert.match(`${expired.stdout}${expired.stderr}`, /run deadline expired/);
    assert.deepEqual((await fixture.pm.get(created.item.id, { full: true })).item, current);
    const validReceipt = expiredReceipt.replace("deadline_ms=0", `deadline_ms=${Number.MAX_SAFE_INTEGER}`);
    await execute(pmBin, [...updateArgs, validReceipt], { cwd: fixture.cwd, env, timeout: 120000 });
    assert.equal((await fixture.pm.get(created.item.id)).item.type, "Feature");
    assert.equal((await fixture.pm.get(created.item.id)).item.priority, 3);
    assert.equal((await fixture.pm.comments(created.item.id)).count, 2);
    console.log("installed host: matching current-source expired receipt refused without mutation; future deadline accepted");
  } finally { await server.close(); fixture.dispose(); rmSync(scratch, { recursive: true, force: true }); }
});
