import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { runEvaluationCommand, replayDecisions, parseReplayRecording, REPLAY_VERSION } from "../index.ts";
import type { PartialReceipt, ReplayRecording } from "../index.ts";
import { answers, endpoint, trackerSnapshot } from "./fixtures.ts";
import { publicAcceptanceInput, readPublicSample, hideGit } from "./replay-fixtures.ts";

const input = publicAcceptanceInput("node test/partial-receipt.acceptance.ts <public-clone> <empty-scratch> <output>");
const sample = await readPublicSample(input.root, input.scratch, 3);
assert.equal(sample.selected.length, 3);
const server = await endpoint();
const oldUrl = process.env.PM_JEV_BASE_URL;
process.env.PM_JEV_BASE_URL = server.url;
const restore = hideGit(input.scratch);
try {
  let calls = 0;
  server.setReply((request, response, body) => {
    if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: "a".repeat(64) }] })); return; }
    calls++;
    if (calls === 2) { response.statusCode = 503; response.end('{"error":"deterministic interruption"}'); return; }
    response.end(JSON.stringify(answers((body as { questions: Parameters<typeof answers>[0] }).questions)));
  });
  const file = join(input.scratch, "evaluation-receipt.json");
  const context: CommandHandlerContext = { command: "jev eval", pm_root: input.root, source_workspace_root: input.scratch, args: [], global: { json: true },
    options: { task: "triage", from: input.root, localUnverified: true, sample: "3", receipt: file } };
  const report = await runEvaluationCommand(context, false) as { ok: false; receipt: PartialReceipt };
  assert.equal(report.ok, false); assert.equal(report.receipt.attempted_calls, 2); assert.equal(report.receipt.completed_calls, 1);
  assert.equal(report.receipt.completed_cases.length, 1); assert.equal(calls, 2); assert.equal(report.receipt.reason, "provider_error");
  const requestsBeforeRerun = server.requests.length;
  const rerun = await runEvaluationCommand({ ...context, options: { ...context.options, from: join(input.scratch, "unavailable-source"), model: "unavailable-model" } }, false) as { refusal: { code: string } };
  assert.equal(rerun.refusal.code, "receipt_exists"); assert.equal(calls, 2); assert.equal(server.requests.length, requestsBeforeRerun);
  const policy = { version: "v1", min_probability: 0.5 };
  const questions = { route: { type: "choice" as const, criteria: { keep: null, change: null } } };
  const recording: ReplayRecording = parseReplayRecording({ version: REPLAY_VERSION, records: sample.selected.map(item => ({ id: item.id, state: { title: item.title }, questions, result: answers(questions), policy })) });
  let replayCalls = 0;
  const replay = await replayDecisions(recording, { ...policy, version: "v2" }, { version: "deterministic-fixture",
    async decide(row) { replayCalls++; if (replayCalls === 2) throw new Error("fixture interruption"); return row.result; } }, 0,
    { file: join(input.scratch, "replay-receipt.json") });
  assert.ok("receipt" in replay && replay.receipt);
  assert.equal(replay.receipt.attempted_calls, 2); assert.equal(replay.receipt.completed_calls, 1); assert.equal(replay.receipt.completed_cases.length, 1);
  const offline = await replayDecisions(recording, policy);
  assert.equal(offline.replayed, 3);
  assert.deepEqual(trackerSnapshot(input.root), input.before);
  const evidence = { provenance: input.provenance, fixture: "deterministic typed local HTTP decisions; failure on second inference; no inference-quality claim",
    tracker_items: sample.read.items.length, sampled_cases: 3, tracker_artifacts_unchanged: Object.keys(input.before).length,
    git_available: false, evaluation: { attempts: calls, completed_calls: report.receipt.completed_calls, completed_cases: report.receipt.completed_cases.length,
      observations: (report.receipt.evidence as { observations: unknown[] }).observations.length, known_input_tokens: report.receipt.tokens.known_input,
      known_output_tokens: report.receipt.tokens.known_output, unknown_usage_calls: report.receipt.tokens.unknown_calls, cost_usd: report.receipt.cost.amount,
      reason: report.receipt.reason, rerun_new_calls: 0, rerun_new_provider_requests: 0, rerun_with_unavailable_sources_and_model: true }, replay: { attempts: replayCalls, completed_calls: replay.receipt.completed_calls,
      completed_cases: replay.receipt.completed_cases.length, reason: replay.receipt.reason }, recorded_replay: { cases: offline.replayed, new_calls: 0 } };
  writeFileSync(input.output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence));
} finally { restore(); if (oldUrl === undefined) delete process.env.PM_JEV_BASE_URL; else process.env.PM_JEV_BASE_URL = oldUrl; await server.close(); }
