import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createExtensionCommandSdk, readSettings } from "@unbrained/pm-cli/sdk";
import { activeCalibration, calibrateObservations, evidenceHash, questionFingerprint } from "../decision-calibration.ts";
import type { CalibrationReceipt, Observation, EvaluationTask } from "../decision-calibration.ts";
import { buildClassificationQuestions, buildDedupeRequest, buildLinkQuestion, rankDedupeCandidates } from "../index.ts";
import type { DedupeDecision, LinkDecision, TriageDecision } from "../index.ts";
import type { Questions } from "@typesafe-ai/sdk";
import { answers, scenario } from "./fixtures.ts";

type Fixture = Parameters<Parameters<typeof scenario>[0]>[0];
type Server = Parameters<Parameters<typeof scenario>[0]>[1];
/** Persist synthetic fitted evidence through the same audited settings SDK as production. */
async function install(fixture: Fixture, task: EvaluationTask, questions: Questions, threshold: number | null = 0.9): Promise<CalibrationReceipt> {
  const rows: Observation[] = ["public/a", "public/b"].flatMap(repository => Array.from({ length: 40 }, (_, index) => Object.keys(questions).map(channel => ({ repository, commit: "a".repeat(40), data_sha256: "b".repeat(64), example_sha256: evidenceHash([repository, index]), question_sha256: questionFingerprint(channel, questions[channel]), channel, label: "yes", probabilities: { yes: 0.65, no: 0.35 }, latency_ms: 1, input_tokens: 1, output_tokens: 1 })))).flat();
  const record = calibrateObservations(task, "tev1:4b", "c".repeat(64), rows, "0", 0.9);
  for (const fit of Object.values(record.channels)) { fit.threshold = threshold; fit.temperature = 0.1; }
  await persist(fixture, record);
  return record;
}
/** Save a synthetic receipt through the real audited settings boundary. */
async function persist(fixture: Fixture, record: CalibrationReceipt): Promise<void> {
  const sdk = createExtensionCommandSdk(fixture.pmRoot, fixture.pm, "fixture", "jev calibrate");
  await sdk.mutateWorkspaceSettings({ operationId: randomUUID(), mutate: current => ({ ...current, jev: { calibrations: { [evidenceHash([record.task, record.model])]: record } } }) });
}
/** Dispatch streaming proposals through the same real harness as single-item decisions. */
async function backlog(fixture: Fixture, task: "triage" | "link", options: Record<string, unknown> = {}) {
  return fixture.harness.runCommand({ command: `jev ${task}`, pmRoot: fixture.pmRoot, options: { open: true, limit: "1", ...options }, global: { quiet: true } });
}
/** Serve an immutable model tag and exact-schema probability distributions. */
function serve(server: Server, weights: Record<string, number>, digest = "c".repeat(64), replaceAfterInference = false, onInference?: (questions: Questions) => void) {
  let inferred = false;
  server.setReply((request, response, body) => {
    if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: replaceAfterInference && inferred ? "d".repeat(64) : digest }] })); return; }
    const questions = (body as { questions: Questions }).questions;
    onInference?.(questions);
    const result = answers(questions);
    for (const [name, question] of Object.entries(questions)) {
      if (question.type === "noul") continue;
      const labels = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
      const probabilities = Object.fromEntries(labels.map(label => [label, weights[label] ?? 0]));
      if (Object.values(probabilities).reduce((sum, p) => sum + p, 0) === 0) continue;
      result.answers[name] = question.type === "choice" ? { type: "choice", choice: labels[0], confidence: 1, probabilities } : { ...result.answers[name] as object, probabilities };
    }
    inferred = true;
    response.end(JSON.stringify(result));
  });
}

test("calibrated triage uses hidden labels, fitted probabilities and thresholds; raw weak evidence retains the type", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ title: "Login crashes on expiry", description: "Reject expired sessions safely", type: "Task", priority: "2" })).item;
    const questions = buildClassificationQuestions(await readSettings(fixture.pmRoot));
    await install(fixture, "triage", questions);
    serve(server, { Issue: 0.65, Task: 0.35 });
    const run = async (options: Record<string, unknown> = {}) => (await fixture.harness.runCommand({ command: "jev triage", args: [item.id], pmRoot: fixture.pmRoot, options, global: { json: true } })).result as TriageDecision;
    const result = await run({ apply: true });
    assert.ok(result.proposals.type.probability > 0.99);
    assert.ok(result.applied.includes("type=Issue"));
    assert.equal((await fixture.pm.get(item.id)).item.type, "Issue");
    assert.ok(result.calibration);
    const inference = server.requests.find(r => r.path !== "/api/tags")!.body as { questions: Questions; state: object };
    assert.ok(!JSON.stringify(inference.questions.type).includes("Keep current type Task"));
    assert.ok(!JSON.stringify(inference.state).includes('"type"'));
    assert.ok(((await fixture.pm.get(item.id, { fields: "comments", outputBudget: "unbounded", outputLimit: "unbounded" })) as { item: { comments: { text: string }[] } }).item.comments.some(c => c.text.includes("calibration_sha256=")));
    // Qualified calibrated probabilities also drive the streaming outcome count.
    await fixture.pm.update(item.id, { type: "Task" });
    const streamed = await backlog(fixture, "triage", { apply: true });
    assert.equal((streamed.result as { result: { changed: number } }).result.changed, 1);
    assert.equal((await fixture.pm.get(item.id)).item.type, "Issue");
    const callsBeforeRemoval = server.requests.filter(r => r.path !== "/api/tags").length;
    const sdk = createExtensionCommandSdk(fixture.pmRoot, fixture.pm, "fixture", "jev calibrate");
    await sdk.mutateWorkspaceSettings({ operationId: "remove-synthetic-calibration", mutate: current => ({ ...current, jev: {} }) });
    await backlog(fixture, "triage");
    assert.equal(server.requests.filter(r => r.path !== "/api/tags").length, callsBeforeRemoval + 1);
    await install(fixture, "triage", questions);
    await fixture.pm.update(item.id, { type: "Task" });
    serve(server, { Issue: 0.65, Task: 0.35 }, "d".repeat(64));
    const legacy = await run({ apply: true });
    assert.equal(legacy.calibration, undefined);
    assert.ok(!legacy.applied.some(field => field.startsWith("type=")));
    assert.equal((await fixture.pm.get(item.id)).item.type, "Task");
    serve(server, { Issue: 0.65, Task: 0.35 });
    const strict = await run({ apply: true, minConfidence: "1" });
    assert.ok(!strict.applied.includes("type=Issue"));
    assert.equal((strict.calibration as { type: { threshold: number; fitted_threshold: number } }).type.threshold, 1);
    assert.equal((strict.calibration as { type: { threshold: number; fitted_threshold: number } }).type.fitted_threshold, 0.9);
  });
});

test("unqualified calibration blocks triage type and priority even under an explicit zero legacy threshold", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ title: "Broken session", type: "Task", priority: "2" })).item;
    await install(fixture, "triage", buildClassificationQuestions(await readSettings(fixture.pmRoot)), null);
    serve(server, { Issue: 0.95, Task: 0.05 });
    const result = (await fixture.harness.runCommand({ command: "jev triage", args: [item.id], pmRoot: fixture.pmRoot, options: { apply: true, minConfidence: "0" }, global: { json: true } })).result as TriageDecision;
    assert.deepEqual(result.applied, []);
    assert.equal((await fixture.pm.get(item.id)).item.type, "Task");
    assert.equal((await fixture.pm.get(item.id)).item.priority, 2);
    assert.ok(result.calibration);
    const stream = await backlog(fixture, "triage", { apply: true, minConfidence: "0" });
    assert.equal((stream.result as { result: { changed: number } }).result.changed, 0);
  });
});

test("backlog triage reuses one settings-derived classification snapshot per command", async () => {
  await scenario(async (fixture, server) => {
    await fixture.pm.create({ title: "Session failure one", type: "Task" });
    await fixture.pm.create({ title: "Session failure two", type: "Task" });
    await install(fixture, "triage", buildClassificationQuestions(await readSettings(fixture.pmRoot)));
    const typesPath = join(fixture.pmRoot, "schema/types.json");
    const initial = readFileSync(typesPath, "utf8");
    await fixture.pm.schemaAddType("Knowledge", { description: "Documented reference facts", folder: "knowledge" });
    const edited = readFileSync(typesPath, "utf8");
    writeFileSync(typesPath, initial);
    const wire: Questions[] = [];
    serve(server, {}, "c".repeat(64), false, questions => {
      wire.push(questions);
      // A concurrent schema edit must take effect on the next command, not partway through this batch.
      writeFileSync(typesPath, edited);
    });
    await backlog(fixture, "triage", { limit: "2" });
    assert.equal(wire.length, 2);
    assert.deepEqual(wire[1], wire[0]);
    assert.ok(!JSON.stringify(wire).includes("__keep_current__"));
    assert.ok(!JSON.stringify(wire).includes("Knowledge"));
    wire.length = 0;
    await backlog(fixture, "triage", { limit: "2" });
    assert.equal(wire.length, 2);
    assert.ok(JSON.stringify(wire).includes("Knowledge"));
    assert.ok(JSON.stringify(wire).includes("__keep_current__"));
  });
});

test("link calibration scales every candidate and refuses application after qualification is withdrawn", async () => {
  await scenario(async (fixture, server) => {
    const source = (await fixture.pm.create({ title: "Session migration", type: "Task" })).item;
    await fixture.pm.create({ title: "Session validation", type: "Task" });
    await fixture.pm.create({ title: "Session expiry", type: "Task" });
    await install(fixture, "link", { candidate_0: buildLinkQuestion("candidate_0") });
    serve(server, { blocks: 0.65, none: 0.35 });
    const run = async (apply = false) => (await fixture.harness.runCommand({ command: "jev link", args: [source.id], pmRoot: fixture.pmRoot, options: { apply }, global: { json: true } })).result as LinkDecision;
    const result = await run();
    assert.equal(result.qualifying.length, 2);
    assert.ok(result.proposals.every(p => p.raw_probability === 0.65 && p.probability > 0.99));
    assert.ok(result.calibration);
    const stream = await backlog(fixture, "link");
    assert.equal((stream.result as { result: { would_change: number } }).result.would_change, 1);
    const incompatible = await install(fixture, "link", { candidate_0: buildLinkQuestion("candidate_0") });
    incompatible.channels.candidate_0.question_sha256 = [evidenceHash("different-schema")];
    await persist(fixture, incompatible);
    assert.deepEqual((await run()).qualifying, []);
    const legacyRequest = server.requests.filter(r => r.path !== "/api/tags").at(-1)!.body as { questions: Questions };
    assert.equal(Object.keys(legacyRequest.questions).length, 2);
    await install(fixture, "link", { candidate_0: buildLinkQuestion("candidate_0") }, null);
    assert.deepEqual((await run(true)).applied, []);
    const config = { provider: "ollama", model: "tev1:4b", baseUrl: server.url, timeoutMs: 30_000 };
    assert.ok(await activeCalibration(fixture.pmRoot, "link", config));
  });
});

test("dedupe preserves raw probabilities and exposes calibrated qualification for the exact candidate schema", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ title: "Session expiry crash", type: "Issue" })).item;
    const candidates = rankDedupeCandidates((await fixture.pm.listAllComplete()).items, item.title, 8);
    const request = buildDedupeRequest(item.title, "", candidates);
    await install(fixture, "dedupe", request.questions);
    serve(server, { [item.id]: 0.65, none: 0.35 });
    const result = (await fixture.harness.runCommand({ command: "jev dedupe", pmRoot: fixture.pmRoot, options: { title: item.title }, global: { json: true } })).result as DedupeDecision;
    assert.equal(result.duplicate_of, item.id);
    assert.ok(result.probability > 0.99);
    assert.equal((result.calibration as { qualifies: boolean }).qualifies, true);
    serve(server, { [item.id]: 0.35, none: 0.65 });
    const none = (await fixture.harness.runCommand({ command: "jev dedupe", pmRoot: fixture.pmRoot, options: { title: item.title }, global: { json: true } })).result as DedupeDecision;
    assert.equal(none.duplicate_of, null);
    assert.equal((none.calibration as { qualifies: boolean }).qualifies, false);
  });
});

test("a model replacement during calibrated inference refuses every write", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ title: "Session crash", type: "Task" })).item;
    await install(fixture, "triage", buildClassificationQuestions(await readSettings(fixture.pmRoot)));
    serve(server, { Issue: 0.95, Task: 0.05 }, "c".repeat(64), true);
    await assert.rejects(fixture.harness.runCommand({ command: "jev triage", args: [item.id], pmRoot: fixture.pmRoot, options: { apply: true }, global: { json: true } }), /Model digest changed/);
    assert.equal((await fixture.pm.get(item.id)).item.type, "Task");
    assert.equal((await fixture.pm.comments(item.id)).count, 0);
  });
});

test("missing channels and edited type definitions retain honest legacy thresholds", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ title: "Session failure", type: "Task", priority: "2" })).item;
    const questions = buildClassificationQuestions(await readSettings(fixture.pmRoot));
    const partial = await install(fixture, "triage", questions);
    delete partial.channels.priority;
    await persist(fixture, partial);
    serve(server, { Issue: 0.65, Task: 0.35 });
    const noBacklogChange = async () => {
      const stream = await backlog(fixture, "triage");
      assert.equal((stream.result as { result: { would_change: number } }).result.would_change, 0);
    };
    const run = async () => (await fixture.harness.runCommand({ command: "jev triage", args: [item.id], pmRoot: fixture.pmRoot, options: { apply: true }, global: { json: true } })).result as TriageDecision;
    const first = await run();
    assert.equal((first.calibration as { priority: unknown }).priority, null);
    assert.ok((await fixture.pm.comments(item.id)).comments.at(-1)!.text.includes("priority_threshold=0.8"));
    await noBacklogChange();
    await fixture.pm.update(item.id, { type: "Task", priority: "2" });
    await install(fixture, "triage", questions);
    await fixture.pm.schemaAddType("Knowledge", { description: "Documented facts and reference evidence", folder: "knowledge" });
    const changed = await run();
    assert.equal((changed.calibration as { type: unknown }).type, null);
    assert.equal((await fixture.pm.get(item.id)).item.type, "Task");
    assert.ok((await fixture.pm.comments(item.id)).comments.at(-1)!.text.includes("type_threshold=0.8"));
    await noBacklogChange();
  });
});
