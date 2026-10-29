/** Measure labeling selection mechanics on verified public tracker bytes, without inference or writes. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { listAllComplete, PmClient } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { selectLabelQueue, LABEL_QUEUE_VERSION } from "../index.ts";
import type { LabelQueueInput, LabelCase } from "../index.ts";
import { publicAcceptanceInput, hideGit } from "./replay-fixtures.ts";
import { trackerSnapshot } from "./fixtures.ts";

const { root, before, scratch, output, provenance } = publicAcceptanceInput("Usage: label-queue.acceptance.ts <public-clone> <empty-scratch> <report>");
const restore = hideGit(scratch); const savedFetch = globalThis.fetch; let inferenceCalls = 0;
globalThis.fetch = () => { inferenceCalls++; throw new Error("Network forbidden during queue generation"); };
try {
  const source = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: scratch, noExtensions: true }));
  const items = [...source.items].sort((a, b) => a.id < b.id ? -1 : 1);
  const cases: LabelCase[] = items.map((item, index) => ({ id: item.id, source: provenance.repository, revision: provenance.commit, cohort: "acquisition", task: "human-review", bucket: item.type,
    state: index % 2 ? "abstained" : "unlabeled", uncertainty: { numerator: 1 + index % 10, denominator: 10 }, cost: 1 + index % 3, label: { kind: "none" } }));
  const input: LabelQueueInput = { version: LABEL_QUEUE_VERSION,
    policy: { cohort: "acquisition", seed: "public-label-42", budget: 30, limit: 20, uncertainty: "declared_ratio_desc", min_uncertainty: { numerator: 1, denominator: 2 }, diversity: "balanced", max_per_bucket: 5 },
    cohorts: [{ id: "acquisition", role: "acquisition", sources: [provenance.repository] }], cases };
  const report = selectLabelQueue(input);
  assert.deepEqual(selectLabelQueue({ ...input, cases: [...cases].reverse() }), report);
  assert.ok(report.spent <= 30 && report.queue.length <= 20); assert.ok(report.queue.every(r => r.ground_truth === false));
  const control: LabelCase = { ...cases[0], id: "held-out-control", source: "synthetic-held-out", cohort: "held-out", uncertainty: { numerator: 1, denominator: 1 }, cost: 1 };
  const heldOut = selectLabelQueue({ ...input, cohorts: [...input.cohorts, { id: "held-out", role: "held_out", sources: [control.source] }], cases: [...cases, control] });
  assert.equal(heldOut.omissions.held_out, 1); assert.deepEqual(heldOut.queue, report.queue);
  const inferred = selectLabelQueue({ ...input, cases: cases.map(r => ({ ...r, label: { kind: "inferred", value: "controlled-proposal", actor: "synthetic-model", evidence: "controlled-decision" } })) });
  assert.equal(inferred.queue.length, report.queue.length); assert.ok(inferred.queue.every(r => r.label.kind === "inferred" && r.ground_truth === false));
  const human = selectLabelQueue({ ...input, cases: cases.map(r => ({ ...r, label: { kind: "human", value: "controlled-explicit-label", actor: "synthetic-reviewer", evidence: "controlled-review" } })) });
  assert.equal(human.queue.length, 0); assert.equal(human.omissions.human_labeled + human.omissions.below_uncertainty, cases.length);
  const malformedDuplicates = selectLabelQueue({ ...input, cases: cases.flatMap(r => [r, { ...r, cost: 0, label: { kind: "human", value: "controlled-explicit-label", actor: "synthetic-reviewer", evidence: "controlled-review" } }]) });
  assert.equal(malformedDuplicates.counts.selected, 0); assert.equal(malformedDuplicates.counts.eligible, 0);
  assert.equal(malformedDuplicates.omissions.invalid, cases.length * 2); assert.ok(malformedDuplicates.rejected.every(row => row.code === "duplicate_case"));
  const client = new PmClient({ pmRoot: root, cwd: scratch, noExtensions: true });
  assert.deepEqual(certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items, source.items);
  assert.deepEqual(trackerSnapshot(root), before); assert.equal(inferenceCalls, 0);
  const evidence = { version: "pm-jev-label-queue-public/1", ...provenance, tracker_items: cases.length, authoritative_files_verified: Object.keys(before).length,
    counts: report.counts, omissions: report.omissions, budget: report.policy.budget, spent: report.spent, remaining: report.remaining,
    selected_buckets: new Set(report.queue.map(r => r.bucket)).size, inferred_provenance_preserved: inferred.queue.length, held_out_controls_omitted: heldOut.omissions.held_out,
    human_controls_omitted: human.omissions.human_labeled, deterministic_reordered_replay: true, tracker_unchanged: true, sdk_readback_equal: true,
    malformed_duplicate_controls: { ...malformedDuplicates.counts, reported_diagnostics: malformedDuplicates.rejected.length, omitted_diagnostics: malformedDuplicates.rejected_omitted },
    git_available_during_selection: false, inference_calls: inferenceCalls, mutations: 0, report_json_bytes: Buffer.byteLength(JSON.stringify(report)),
    limitations: "One committed public fleet tracker. Native identifiers/types and exact source revision are SDK-read references; pending states, uncertainties, costs and control labels are declared test annotations, not model predictions or source ground truth. Held-out controls are synthetic. This proves deterministic selection mechanics and state preservation, not label quality, source alias verification, live revision freshness or a persistent budget reservation." };
  writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n"); console.log(JSON.stringify(evidence));
} finally { globalThis.fetch = savedFetch; restore(); }
