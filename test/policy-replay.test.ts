import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import { createOllamaReplayAdapter, parseReplayRecording, replayDecisions, ReplayRefusal, REPLAY_VERSION } from "../index.ts";
import type { ReplayRecording, ReplayPolicy, ReplayAdapter } from "../index.ts";
import { endpoint } from "./fixtures.ts";

const questions: Questions = { route: { type: "choice", criteria: { keep: null, change: null } }, impact: { type: "score", criteria: ["minor", "major"] }, risk: { type: "noul", instructions: "Is this risky?" } };
const policy = { version: "v1", min_probability: 0.5 };
/** Frozen three-kind answer with independently controlled proposal probabilities. */
function result(p = 0.9, q = 0.9, n = 0.1): SystemOneResult<Questions> {
  return { model: "tev1:4b", answers: {
    route: { type: "choice", choice: p >= 0.5 ? "keep" : "change", probabilities: { keep: p, change: 1 - p }, confidence: 0.9 },
    impact: { type: "score", score: 0.2, probabilities: { "0": q, "1": 1 - q }, confidence: 0.9, legend: { "0": "minor", "1": "major" } },
    risk: { type: "noul", noul: n },
  }, usage: { input_tokens: null, output_tokens: null } } as unknown as SystemOneResult<Questions>;
}
/** Fresh recording isolates each mutation and preserves real raw decision shapes. */
function recording(): ReplayRecording {
  return { version: REPLAY_VERSION, records: [{ id: "case-1", state: { title: "Minimized evidence" }, questions, result: result(), policy }] };
}
/** Match typed refusals and ensure they carry a concrete remedy. */
function refusal(code: ReplayRefusal["code"]) {
  return (error: unknown) => { assert.ok(error instanceof ReplayRefusal); assert.equal(error.code, code); assert.ok(error.remedy.length > 20); return true; };
}

test("recorded replay is network-free and exact at inclusive probability boundaries", async () => {
  const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("Network forbidden"); });
  try {
    const doc = recording();
    const unchanged = await replayDecisions(doc, policy);
    assert.match(unchanged.recording_sha256, /^[a-f0-9]{64}$/);
    assert.equal(unchanged.agreement, 3); assert.equal(unchanged.disagreement, 0);
    assert.equal(unchanged.old_abstentions, 0); assert.equal(unchanged.new_abstentions, 0);
    assert.equal(unchanged.adapter, "recorded"); assert.equal(unchanged.complete, true);
    const changed = await replayDecisions(doc, { version: "v2", min_probability: 1 }, undefined, 0);
    assert.equal(changed.compared, 3); assert.equal(changed.disagreement, 3); assert.equal(changed.new_abstentions, 3);
    assert.equal(changed.details.length, 0); assert.equal(changed.omitted_details, 1);
    const boundary = await replayDecisions(doc, { version: "v2", min_probability: 0.9 });
    assert.equal(boundary.agreement, 3); assert.equal(boundary.recording_sha256, unchanged.recording_sha256);
    const abstaining = { ...doc, records: [{ ...doc.records[0], policy: { version: "old", min_probability: 1 } }] };
    const both = await replayDecisions(abstaining, { version: "new", min_probability: 1 });
    assert.equal(both.old_abstentions, 3); assert.equal(both.new_abstentions, 3); assert.equal(both.agreement, 3);
    assert.deepEqual(doc, recording(), "caller snapshot is not mutated");
  } finally { fetchMock.mock.restore(); }
});

test("fixture adapter changes all kinds, counts old abstentions and preserves stable ties", async () => {
  const adapter: ReplayAdapter = { version: "fixture-v2", async decide(row) { (row.state as Record<string, unknown>).title = "mutated"; return result(0.1, 0.1, 0.9); } };
  const doc = recording();
  const report = await replayDecisions(doc, policy, adapter);
  assert.equal(report.agreement, 0); assert.equal(report.disagreement, 3);
  assert.deepEqual(report.details, [{ index: 0, changed: ["route", "impact", "risk"] }]);
  assert.equal(report.old_abstentions, 0); assert.equal(report.new_abstentions, 0);
  assert.equal(report.attempted, 1); assert.equal(report.replayed, 1); assert.ok(report.latency_ms.mean! >= 0);
  assert.deepEqual(doc, recording());
  const ties = { ...doc, records: [{ ...doc.records[0], result: result(0.5, 0.5, 0.5) }] };
  assert.equal((await replayDecisions(ties, policy)).agreement, 3);
  const oldAbstain = { ...doc, records: [{ ...doc.records[0], policy: { version: "old", min_probability: 1 } }] };
  assert.equal((await replayDecisions(oldAbstain, policy, adapter)).old_abstentions, 3);
});

test("missing inputs and adapter failures are gaps, not invented comparisons", async () => {
  const rows = ["state", "questions", "result", "policy"].map((field, i) => {
    const row = { ...recording().records[0], id: `gap-${i}` };
    delete row[field as keyof typeof row]; return row;
  });
  const doc: ReplayRecording = { version: REPLAY_VERSION, records: [...rows, ...recording().records] };
  const adapter: ReplayAdapter = { version: "failing", async decide() { throw new Error("PRIVATE_DETAIL"); } };
  const report = await replayDecisions(doc, policy, adapter, 2);
  assert.equal(report.gaps, 5); assert.equal(report.compared, 0); assert.equal(report.complete, false);
  assert.equal(report.attempted, 1); assert.equal(report.replayed, 0); assert.equal(report.omitted_details, 3);
  assert.deepEqual(report.details, [{ index: 0, gap: "state" }, { index: 1, gap: "questions" }]);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_DETAIL|Minimized evidence/);
  const noInputs = await replayDecisions({ version: REPLAY_VERSION, records: rows }, policy);
  assert.equal(noInputs.latency_ms.mean, null); assert.equal(noInputs.attempted, 0);
  const malformed = await replayDecisions(recording(), policy, { version: "bad", async decide() { return {} as SystemOneResult<Questions>; } });
  assert.equal(malformed.gaps, 1); assert.equal(malformed.details[0].gap, "decision_failed");
  assert.equal((await replayDecisions({ version: REPLAY_VERSION, records: [] }, policy)).complete, true);
});

test("malformed recordings and policies refuse before adapter execution", async () => {
  const invalid: unknown[] = [undefined, null, {}, { version: "other", records: [] }, { version: REPLAY_VERSION, records: {} },
    { version: REPLAY_VERSION, records: Array(1001).fill({}) }, { version: REPLAY_VERSION, records: [null] },
    { version: REPLAY_VERSION, records: [...recording().records, ...recording().records] }, { big: "x".repeat(4194305) }];
  for (const patch of [{ id: "bad label" }, { id: 3 }, { state: null }, { state: [] }, { state: { large: "x".repeat(32769) } },
    { questions: {} }, { questions: { bad: { type: "box" } } }, { questions: { "bad label": { type: "noul" } } },
    { questions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, { type: "noul" }])) },
    { questions: { route: { type: "choice", criteria: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`v${i}`, null])) } } },
    { questions: { route: { type: "choice", criteria: { "bad label": null, good: null } } } },
    { questions: { impact: { type: "score", criteria: Array(33).fill("level") } } },
    { result: {} }, { policy: null }, { policy: { version: "v", min_probability: -1 } },
  ]) invalid.push({ version: REPLAY_VERSION, records: [{ ...recording().records[0], ...patch }] });
  for (const doc of invalid) assert.throws(() => parseReplayRecording(doc), refusal("invalid_recording"));
  for (const candidate of [null, { version: "bad label", min_probability: 0.5 }, { version: "v", min_probability: NaN }, { version: "v", min_probability: -1 }, { version: "v", min_probability: 2 }]) {
    await assert.rejects(replayDecisions(recording(), candidate as ReplayPolicy), refusal("invalid_policy"));
  }
  for (const limit of [-1, 101, 1.1, NaN]) await assert.rejects(replayDecisions(recording(), policy, undefined, limit), refusal("invalid_policy"));
  await assert.rejects(replayDecisions(recording(), policy, { version: "bad label", async decide() { return result(); } }), refusal("invalid_policy"));
});

test("Ollama adapter rejects nonlocal URLs, cloud models, unavailable or non-decision inventory", async () => {
  for (const url of ["invalid", "https://127.0.0.1", "http://example.invalid", "http://localhost", "http://u:p@127.0.0.1", "http://127.0.0.1/path", "http://127.0.0.1?q=1", "http://127.0.0.1#fragment"]) {
    await assert.rejects(createOllamaReplayAdapter("tev1:4b", url), refusal("local_only"));
  }
  for (const model of ["bad model", "glm:cloud"]) await assert.rejects(createOllamaReplayAdapter(model), refusal("local_only"));
  for (const deadline of [0, 300001, 1.5, NaN]) await assert.rejects(createOllamaReplayAdapter("tev1:4b", undefined, deadline), refusal("invalid_policy"));
  const server = await endpoint();
  try {
    const digest = "a".repeat(64);
    const good = { name: "tev1:4b", digest, capabilities: ["decision"] };
    for (const card of [undefined, { ...good, remote_host: "cloud" }, { ...good, remote_model: "remote" }, { ...good, capabilities: [] }, { ...good, digest: "bad" }]) {
      server.setReply((_, res) => res.end(JSON.stringify({ models: card === undefined ? [] : [card] })));
      await assert.rejects(createOllamaReplayAdapter("tev1:4b", server.url), refusal("model_unavailable"));
    }
    for (const body of [{}, { models: [null] }]) {
      server.setReply((_, res) => res.end(JSON.stringify(body)));
      await assert.rejects(createOllamaReplayAdapter("tev1:4b", server.url), refusal("model_unavailable"));
    }
    server.setReply((_, res) => { res.statusCode = 500; res.end("unavailable"); });
    await assert.rejects(createOllamaReplayAdapter("tev1:4b", server.url), refusal("model_unavailable"));
    server.setReply((req, res) => {
      if (req.url === "/api/tags") res.end(JSON.stringify({ models: [{ name: "other" }, good] }));
      else res.end(JSON.stringify(result()));
    });
    const adapter = await createOllamaReplayAdapter("tev1:4b", server.url);
    assert.equal(adapter.version, `ollama:${digest}`);
    assert.equal((await replayDecisions(recording(), policy, adapter)).agreement, 3);
    server.setReply((_, res) => res.end(JSON.stringify({ ...result(), model: "changed" })));
    assert.equal((await replayDecisions(recording(), policy, adapter)).gaps, 1);
    const fetchMock = mock.method(globalThis, "fetch", async () => { throw new Error("offline"); });
    try { await assert.rejects(createOllamaReplayAdapter("tev1:4b"), refusal("model_unavailable")); }
    finally { fetchMock.mock.restore(); }
  } finally { await server.close(); }
});
