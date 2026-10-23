import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createOllamaReplayAdapter, parseQuestionsDocument, projectItemState, replayDecisions, REPLAY_VERSION } from "../index.ts";
import type { ReplayRecord, ReplayRecording } from "../index.ts";
import { trackerSnapshot } from "./fixtures.ts";
import { publicAcceptanceInput, readPublicSample, hideGit } from "./replay-fixtures.ts";

const { root, before, scratch, output, provenance } = publicAcceptanceInput("Usage: policy-replay.acceptance.ts <public-clone> <empty-scratch> <report>");
const restoreGit = hideGit(scratch);
try {
  const { read, selected } = await readPublicSample(root, scratch, 12);
  const adapter = await createOllamaReplayAdapter("tev1:4b");
  const questions = parseQuestionsDocument({ route: { type: "choice", instructions: "Does this item describe broken behavior or a new capability?", criteria: { defect: "Existing behavior is broken", capability: "New capability or improvement", other: "Other work" } } });
  const policy = { version: "public-baseline-v1", min_probability: 0.8 };
  const records: ReplayRecord[] = [];
  const recordingStarted = performance.now();
  for (const item of selected) {
    const state = { ...projectItemState(item) };
    const seed = { id: item.id, state, questions, policy, result: {} as NonNullable<ReplayRecord["result"]> };
    records.push({ ...seed, result: await adapter.decide(seed) });
  }
  const recordingMs = performance.now() - recordingStarted;
  records.push({ id: "missing-input-example", questions, policy });
  const doc: ReplayRecording = { version: REPLAY_VERSION, records };
  // Minimized public source inputs stay in the scratch project, outside published artifacts.
  writeFileSync(join(scratch, "recording.json"), JSON.stringify(doc), { mode: 0o600 });
  const candidate = { version: "candidate-v2", min_probability: 0.9 };
  const saved = await replayDecisions(doc, candidate);
  const local = await replayDecisions(doc, candidate, adapter);
  assert.equal(saved.gaps, 1); assert.equal(local.gaps, 1); assert.equal(local.replayed, selected.length);
  assert.equal(local.compared, selected.length); assert.equal(local.agreement + local.disagreement, local.compared);
  const checked = await createOllamaReplayAdapter("tev1:4b"); assert.equal(checked.version, adapter.version);
  assert.deepEqual(trackerSnapshot(root), before);
  const report = { version: "pm-jev-replay-public/1", ...provenance,
    tracker_items: read.items.length, sampled_items: selected.length, authoritative_files_verified: Object.keys(before).length, tracker_unchanged: true,
    git_available_during_replay: false, model: "tev1:4b", model_version: adapter.version, recording_calls: selected.length, recording_ms: recordingMs,
    local_replay_calls: local.attempted, saved_score_network_calls: 0, saved_score_replay: saved, local_model_replay: local,
    limitations: "Twelve sorted public items, one choice question, one recorded answer and one local replay per input. One intentionally incomplete record demonstrates gaps. Agreement counts include abstentions and policy threshold changes. This is compatibility evidence, not labelled accuracy, causal evaluation, or adoption approval. Latency includes transport and validation under concurrent host load. No raw inputs, credentials or provider configuration are published." };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  restoreGit();
}
