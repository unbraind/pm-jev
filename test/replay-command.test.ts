import { installBuiltExtension, runBuiltCommand, cliFailure } from "./replay-fixtures.ts";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { project, trackerSnapshot, endpoint, answers } from "./fixtures.ts";
import { REPLAY_VERSION } from "../index.ts";
import { runReplayCommand } from "../replay-command.ts";

/** Minimal portable recorded choice answer for native command dispatch. */
function recording() {
  const questions = { route: { type: "choice" as const, criteria: { keep: null, change: null } } };
  return { version: REPLAY_VERSION, records: [{ id: "case-1", state: { title: "Synthetic" }, questions, result: answers(questions), policy: { version: "v1", min_probability: 0.5 } }] };
}

test("native command handles compact totals, gaps, aliases and typed refusals with no git or network", async () => {
  const fixture = await project();
  const oldPath = process.env.PATH, oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
  const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  try {
    const file = join(fixture.cwd, "recording.json");
    writeFileSync(file, JSON.stringify(recording()));
    const before = trackerSnapshot(fixture.pmRoot);
    process.env.PATH = ""; process.env.GIT_CEILING_DIRECTORIES = dirname(fixture.cwd);
    for (const json of [false, true]) {
      const response = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options: { recording: file, policyVersion: "v2", minProbability: "1", limit: "0" }, global: { json } });
      const report = response.result as { ok: boolean; disagreement: number; details: unknown[]; omitted_details: number };
      assert.equal(report.ok, true); assert.equal(report.disagreement, 0); assert.equal(report.details.length, 0); assert.equal(report.omitted_details, 1);
    }
    const good = { recording: file, "policy-version": "v2", "min-probability": "0.8" };
    const direct = await runReplayCommand({ command: "jev replay", pm_root: fixture.pmRoot, args: [], options: { ...good, receipt: join(fixture.cwd, "direct.json") }, global: {} });
    assert.ok(direct.ok);
    const normal = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options: good });
    assert.equal((normal.result as { agreement: number }).agreement, 1);
    writeFileSync(file, JSON.stringify({ version: REPLAY_VERSION, records: [{ id: "gap" }] }));
    const partial = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options: good });
    assert.equal((partial.result as { exit_code: number }).exit_code, 2);
    for (const options of [{}, { ...good, recording: "" }, { ...good, "policy-version": "" }, { ...good, "policy-version": undefined }, { ...good, "min-probability": undefined }, { ...good, "min-probability": " " }, { ...good, "min-probability": "NaN" }, { ...good, limit: "101" }, { ...good, limit: " " }, { ...good, model: " " }, { ...good, deadlineMs: " " , model: "tev1:4b" }, { ...good, recording: join(fixture.cwd, "absent") }]) {
      const bad = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options });
      assert.equal((bad.result as { ok: boolean }).ok, false);
      assert.ok((bad.result as { refusal: { remedy: string } }).refusal.remedy.length > 20);
    }
    const directory = join(fixture.cwd, "directory"); mkdirSync(directory);
    for (const invalid of ["not JSON", "x".repeat(4194305), JSON.stringify({ version: "bad" }), JSON.stringify({ version: REPLAY_VERSION, records: [{ id: "null-case", result: null }] })]) {
      writeFileSync(file, invalid);
      const bad = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options: good });
      assert.equal((bad.result as { refusal: { code: string } }).refusal.code, "invalid_recording");
    }
    const badDirectory = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options: { ...good, recording: directory } });
    assert.equal((badDirectory.result as { refusal: { code: string } }).refusal.code, "invalid_recording");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  } finally {
    fetchMock.mock.restore();
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    fixture.dispose();
  }
});

test("native local model selection uses the fixture adapter transport and preserves redacted refusals", async () => {
  const fixture = await project();
  const server = await endpoint();
  const previous = globalThis.fetch;
  const fetchMock = mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => previous(String(input).replace("http://127.0.0.1:11434", server.url), init));
  try {
    let failDecision = false;
    server.setReply((req, res, body) => {
      if (req.url === "/api/tags") res.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: "b".repeat(64), capabilities: ["decision"] }] }));
      else if (failDecision) { res.statusCode = 503; res.end('{"error":"PRIVATE_TRANSPORT_TEXT"}'); }
      else res.end(JSON.stringify(answers((body as { questions: Parameters<typeof answers>[0] }).questions)));
    });
    const file = join(fixture.cwd, "recording.json"); writeFileSync(file, JSON.stringify(recording()));
    const options = { recording: file, policy_version: "v2", min_probability: "0.8", model: "tev1:4b" };
    const good = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options });
    assert.equal((good.result as { agreement: number }).agreement, 1);
    failDecision = true;
    const stopped = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options: { ...options, receipt: join(fixture.cwd, "failed-replay.json") } });
    const interrupted = stopped.result as { ok: boolean; exit_code: number; receipt: { attempted_calls: number; completed_calls: number; reason: string } };
    assert.equal(interrupted.ok, false); assert.equal(interrupted.exit_code, 2);
    assert.equal(interrupted.receipt.attempted_calls, 1); assert.equal(interrupted.receipt.completed_calls, 0);
    assert.equal(interrupted.receipt.reason, "provider_error");
    assert.doesNotMatch(JSON.stringify(interrupted), /PRIVATE_TRANSPORT_TEXT/);
    const requestsBeforeReport = server.requests.length;
    const prior = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options: { ...options, recording: join(fixture.cwd, "unavailable-recording.json"), model: "unavailable-model", receipt: join(fixture.cwd, "failed-replay.json") } });
    assert.equal((prior.result as { refusal: { code: string } }).refusal.code, "receipt_exists");
    assert.equal(server.requests.length, requestsBeforeReport);
    const bad = await fixture.harness.runCommand({ command: "jev replay", pmRoot: fixture.pmRoot, options: { ...options, model: "absent", deadlineMs: "5000" } });
    assert.equal((bad.result as { refusal: { code: string } }).refusal.code, "model_unavailable");
    // Unexpected host failures remain visible rather than becoming success-shaped receipts.
    const unexpected = { ...options, get recording(): string { throw new Error("unexpected"); } };
    await assert.rejects(runReplayCommand({ command: "jev replay", pm_root: fixture.pmRoot, args: [], options: unexpected, global: {} }), /unexpected/);
  } finally { fetchMock.mock.restore(); await server.close(); fixture.dispose(); }
});


test("built replay command renders bounded TOON/JSON and gap exits through the actual host parser without Git", async () => {
  const fixture = await project();
  try {
    installBuiltExtension(fixture.pmRoot);
    const file = join(fixture.cwd, "recording.json"); writeFileSync(file, JSON.stringify(recording()));
    const before = trackerSnapshot(fixture.pmRoot);
    const base = ["jev", "replay", "--recording", file, "--policy-version", "v2", "--min-probability", "0.8", "--limit", "0"];
    const overrides = { PM_JEV_BASE_URL: "https://external.invalid", TYPESAFE_API_KEY: "synthetic-secret" };
    const json = await runBuiltCommand(fixture, [...base, "--json"], overrides);
    const receipt = JSON.parse(json.stdout) as { agreement: number; compared: number; details: unknown[] };
    assert.equal(receipt.agreement, 1); assert.equal(receipt.compared, 1); assert.deepEqual(receipt.details, []);
    const toon = await runBuiltCommand(fixture, base, overrides);
    assert.match(toon.stdout, /agreement: 1/); assert.match(toon.stdout, /adapter: "?recorded/);
    for (const output of [json.stdout, toon.stdout]) { assert.ok(Buffer.byteLength(output) < 1500); assert.doesNotMatch(output, /Synthetic|synthetic-secret|external.invalid/); }
    writeFileSync(file, JSON.stringify({ version: REPLAY_VERSION, records: [{ id: "gap" }] }));
    await assert.rejects(runBuiltCommand(fixture, [...base, "--json"], overrides), cliFailure({ gaps: 1 }));
    const invalid = [...base]; invalid[invalid.indexOf("--min-probability") + 1] = "2";
    await assert.rejects(runBuiltCommand(fixture, [...invalid, "--json"], overrides), cliFailure({ refusal: {
      code: "invalid_policy", message: "Decision replay refused: invalid_policy.", remedy: "Supply a policy version and min_probability between 0 and 1.",
    } }));
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  } finally { fixture.dispose(); }
});
