/** Prove packed CLI decisions against public tracker bytes without changing their item/history files. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { projectItemState } from "../dist/index.js";
import type { AdmissionReceipt, AskDecision } from "../index.ts";
import { npmInvocation, unpackOfflineConsumer } from "./admission-install-fixtures.ts";
import { removeAdmissionScratch } from "./admission-cleanup.ts";
import { copyPublicTracker, readPublicSample } from "./replay-fixtures.ts";
import { trackerSnapshot } from "./fixtures.ts";

const [source, scratch, output] = process.argv.slice(2);
assert.ok(source && scratch && output, "Pass public package source, empty scratch and report destination");
const root = resolve("."); const execute = promisify(execFile);
const url = "http://127.0.0.1:11434";
const inventory = await fetch(`${url}/api/tags`).then(response => response.json()) as { models: { name: string; digest: string }[] };
const installed = inventory.models.find(model => model.name === "tev1:4b");
if (!installed) { console.log("SKIP: supported local tev1:4b is not installed; no model was pulled"); process.exit(0); }
const alias = "custom-tev1:latest";
assert.equal(inventory.models.some(model => model.name === alias), false, "Do not replace an existing alias");
let ownsAlias = false;
try {
  const consumer = join(scratch, "consumer"); mkdirSync(consumer, { recursive: true });
  const publicCopy = join(scratch, "public");
  const copy = copyPublicTracker(source, publicCopy, "unbraind/pm-jev");
  const original = trackerSnapshot(copy.root);
  symlinkSync(resolve(root, "node_modules"), join(publicCopy, "node_modules"), "junction");
  const env = { PATH: process.env.PATH, HOME: scratch, PM_AUTHOR: "fixture", PM_GLOBAL_PATH: join(scratch, "global"), PM_TELEMETRY_OPT_OUT: "1",
    PM_JEV_BASE_URL: url, PM_JEV_MODEL: installed.name, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull, NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_CACHE: join(scratch, "npm-cache"), GIT_CEILING_DIRECTORIES: scratch };
  const npm = npmInvocation("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch]);
  const packed = await execute(npm.bin, npm.args, { cwd: root, env });
  const archive = join(scratch, (JSON.parse(packed.stdout) as { filename: string }[])[0].filename);
  const artifactSha512 = createHash("sha512").update(readFileSync(archive)).digest("hex");
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  await unpackOfflineConsumer(root, consumer, archive);
  const cli = resolve(consumer, "node_modules/@unbrained/pm-cli/dist/cli.js");
  // Package registration prepares only the disposable copy; source item/history bytes remain public and read-only.
  chmodSync(join(copy.root, "settings.json"), 0o644);
  await execute(process.execPath, [cli, "--pm-path", copy.root, "package", "install", "./node_modules/pm-jev"], { cwd: consumer, env, timeout: 120000 });
  const { read } = await readPublicSample(copy.root, publicCopy, 1);
  const selected = read.items.find(item => item.id === "pm-jev-github-21e139da0658-94"); assert.ok(selected);
  chmodSync(join(copy.root, "settings.json"), 0o444);
  const before = trackerSnapshot(copy.root);
  for (const [path, bytes] of Object.entries(original)) if (path !== "settings.json") assert.equal(before[path], bytes);
  const questions = { defect: { type: "noul", instructions: "Does this issue report a software defect in existing behavior?" } };
  const questionsFile = join(scratch, "questions.json"); writeFileSync(questionsFile, JSON.stringify(questions));
  const batchFile = join(scratch, "batch.json"); writeFileSync(batchFile, JSON.stringify({ version: "pm-jev-admission/1", state: projectItemState(selected), questions }));
  const response = await fetch(`${url}/api/copy`, { method: "POST", body: JSON.stringify({ source: installed.name, destination: alias }) });
  assert.equal(response.ok, true); ownsAlias = true;
  const reports = [];
  for (const model of ["custom-tev1", alias, "tev1:4b", "registry.ollama.ai/library/tev1:4b", "REGISTRY.OLLAMA.AI/Library/Tev1:4B"]) {
    const options = { cwd: consumer, env: { ...env, PATH: "", PM_JEV_MODEL: model }, timeout: 300000, maxBuffer: 1024 * 1024 };
    const admissionStart = performance.now();
    const admitted = await execute(process.execPath, [cli, "--pm-path", copy.root, "jev", "admit", "--batch", batchFile, "--json"], options);
    const admissionMs = Math.round(performance.now() - admissionStart);
    const receipt = JSON.parse(admitted.stdout) as AdmissionReceipt; assert.equal(receipt.ok, true); assert.equal(receipt.model_digest, installed.digest);
    const started = performance.now();
    const result = await execute(process.execPath, [cli, "--pm-path", copy.root, "jev", "ask", selected.id, "--questions", questionsFile, "--json"], options);
    const latencyMs = Math.round(performance.now() - started);
    const decision = JSON.parse(result.stdout) as AskDecision;
    assert.equal(decision.model, `sha256:${installed.digest}`); assert.equal(decision.usage.input_tokens, receipt.max_prompt_tokens);
    assert.deepEqual(trackerSnapshot(copy.root), before);
    reports.push({ reference: model, admission_ms: admissionMs, cli_decision_ms: latencyMs, admission: receipt, decision });
    console.log(JSON.stringify(reports.at(-1)));
  }
  assert.equal(createHash("sha512").update(readFileSync(archive)).digest("hex"), artifactSha512);
  writeFileSync(output, JSON.stringify({ version: "pm-jev-admission-reference-evidence/1", provenance: { repository: "unbraind/pm-jev", commit: copy.commit },
    artifact_sha512: artifactSha512, item: selected.id, tracker_items_read: read.items.length, git_available_during_commands: false, tracker_changed_by_decisions: false,
    registration_prepared_before_readonly_snapshot: true, reports, snapshot_excludes: ["runtime"],
    latency_scope: "Wall-clock CLI duration including startup, metadata inspection, tokenizer construction and inference; not isolated provider latency.",
    proof_scope: "One public issue, one installed Tev1 digest, five reference spellings; token parity and durable tracker immutability, not an accuracy or throughput benchmark." }, null, 2) + "\n");
} finally {
  if (ownsAlias) {
    const current = await fetch(`${url}/api/tags`).then(response => response.json()) as typeof inventory;
    assert.equal(current.models.find(model => model.name === alias)?.digest, installed.digest, "Only remove this run's unchanged alias");
    const removed = await fetch(`${url}/api/delete`, { method: "DELETE", body: JSON.stringify({ model: alias }) }); assert.equal(removed.ok, true);
  }
  if (existsSync(scratch)) await removeAdmissionScratch(scratch);
}
