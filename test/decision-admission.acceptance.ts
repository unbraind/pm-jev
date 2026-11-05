/** Measure exact admission on a verified read-only public tracker copy with Git hidden. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { admitDecision, createJevClient, runDecision, projectItemState } from "../index.ts";
import type { JevConfig, Questions } from "../index.ts";
import { publicAcceptanceInput, readPublicSample, hideGit } from "./replay-fixtures.ts";
import { trackerSnapshot } from "./fixtures.ts";

const input = publicAcceptanceInput("node test/decision-admission.acceptance.ts <public source> <empty scratch> <report>");
const restore = hideGit(input.scratch);
const config: JevConfig = { provider: "ollama", baseUrl: "http://localhost:11434", model: "tev1:4b", timeoutMs: 30000, totalDeadlineMs: 120000, minConfidence: 0.9, gateThreshold: 0.5 };
const questions: Questions = { route: { type: "choice", instructions: "Choose the next step", criteria: { review: "Review the evidence", wait: "Wait for evidence", none: null } }, impact: { type: "score", criteria: ["minor", "major"] }, short: { type: "noul", instructions: "Is it short?" } };
try {
  const { read, selected } = await readPublicSample(input.root, input.scratch, 8);
  const reports = [];
  for (const item of selected) {
    const state = projectItemState(item);
    const { receipt } = await admitDecision(config, state, questions);
    assert.equal(receipt.ok, true); assert.equal(receipt.questions, 3); assert.equal(receipt.options, 7);
    reports.push({ input_bytes: Buffer.byteLength(JSON.stringify({ state, questions })), receipt });
  }
  // Native usage for one complete prompt independently confirms the in-process renderer/tokenizer.
  const state = projectItemState(selected[0]);
  const single: Questions = { short: questions.short };
  const decision = await runDecision(createJevClient({ config, hostedBlocked: null }, {}), config, state, single);
  assert.equal(decision.usage.input_tokens, decision.admission?.max_prompt_tokens);
  const long = "漢😀é".repeat(3500);
  const stress = await admitDecision(config, long, questions);
  assert.equal(stress.receipt.ok, false);
  assert.ok(Buffer.byteLength(JSON.stringify({ state: long, questions })) < 65536);
  const after = trackerSnapshot(input.root); assert.deepEqual(after, input.before);
  const report = { version: "pm-jev-admission-evidence/1", provenance: input.provenance, tracker_items_read: read.items.length, sampled_items: selected.length,
    questions_retained: reports.reduce((sum, r) => sum + r.receipt.questions, 0), options_retained: reports.reduce((sum, r) => sum + r.receipt.options, 0),
    prompt_tokens_min: Math.min(...reports.map(r => r.receipt.max_prompt_tokens)), prompt_tokens_max: Math.max(...reports.map(r => r.receipt.max_prompt_tokens)),
    receipt_bytes_max: Math.max(...reports.map(r => Buffer.byteLength(JSON.stringify(r.receipt)))), all_samples_fit: true,
    native_parity: { input_tokens: decision.usage.input_tokens, counted_prompt_tokens: decision.admission?.max_prompt_tokens, inference_calls: 1 },
    multibyte_stress: { input_bytes: Buffer.byteLength(JSON.stringify({ state: long, questions })), receipt: stress.receipt },
    no_git: true, tracker_changed: false, admission_inference_calls: 0, mutations: 0, reports };
  writeFileSync(input.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ items: report.tracker_items_read, samples: report.sampled_items, min: report.prompt_tokens_min, max: report.prompt_tokens_max, receipt_bytes: report.receipt_bytes_max, native_parity: report.native_parity, stress: report.multibyte_stress.receipt, unchanged: true }));
} finally { restore(); }
