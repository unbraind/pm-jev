/** Verify mechanics on immutable public tracker bytes; no inference-quality claim. */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { listAllComplete, PmClient } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { RelationshipGraph } from "@unbrained/pm-cli/sdk/graph";
import { JOINT_VERSION, parseQuestionsDocument, validateJointDecisions } from "../index.ts";
import { publicAcceptanceInput, hideGit } from "./replay-fixtures.ts";
import { answers, trackerSnapshot } from "./fixtures.ts";

const { root, before, scratch, output, provenance } = publicAcceptanceInput("Usage: joint-decisions.acceptance.ts <public-clone> <empty-scratch> <report>");
const restore = hideGit(scratch);
const savedFetch = globalThis.fetch;
let inferenceCalls = 0;
globalThis.fetch = () => { inferenceCalls++; throw new Error("Network forbidden during read-only validation"); };
try {
  const source = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: scratch, noExtensions: true }));
  const client = new PmClient({ pmRoot: root, cwd: scratch, noExtensions: true });
  let conflicts = 0, compatible = 0, twoAnswerWitnesses = 0, unchangedAnswers = 0, existingRelationships = 0;
  for (const item of source.items) {
    assert.ok(item.type);
    const questions = parseQuestionsDocument({ native_type: { type: "choice", criteria: { [item.type]: "The SDK-read configured native type" } }, is_bug: { type: "choice", criteria: { yes: "Existing behavior defect", no: "Not a defect" } }, is_feature: { type: "choice", criteria: { yes: "Exclusively new behavior", no: "Not exclusively new" } } });
    const result = answers(questions);
    const batch = { version: JOINT_VERSION, questions, result, constraints: [{ id: "classification", kind: "exclusive", answers: [{ question: "is_bug", value: "yes" }, { question: "is_feature", value: "yes" }] }] };
    const original = JSON.stringify(batch);
    const report = await validateJointDecisions(batch);
    assert.equal(report.ok, false); assert.equal(report.violations.length, 1); conflicts++;
    assert.equal(report.violations[0].witness.length, 2); twoAnswerWitnesses++;
    assert.equal(JSON.stringify(batch), original); unchangedAnswers++;
    result.answers.is_feature = { type: "choice", choice: "no", probabilities: { yes: 1, no: 0 }, confidence: 1 };
    assert.equal((await validateJointDecisions(batch)).ok, true); compatible++;
  }
  for (const edge of RelationshipGraph.fromItems(source.items).edges()) {
    const questions = parseQuestionsDocument({ selected: { type: "choice", criteria: { yes: "Keep the current native edge", no: "No edge" } } });
    const batch = { version: JOINT_VERSION, questions, result: answers(questions), constraints: [{ id: "existing-edge", kind: "relationship", when: { question: "selected", value: "yes" }, source: edge.source, target: edge.target, relationship: edge.kind }] };
    assert.equal((await validateJointDecisions(batch, { client })).ok, true); existingRelationships++;
  }
  const after = certifyCompleteListResult(await client.listAllComplete({ includeBody: true }));
  assert.deepEqual(after.items, source.items, "exact SDK-read native fields and relationships");
  assert.deepEqual(trackerSnapshot(root), before, "all authoritative bytes unchanged");
  assert.equal(inferenceCalls, 0);
  const report = { version: "pm-jev-joint-public/1", ...provenance, tracker_items: source.items.length, authoritative_files_verified: Object.keys(before).length,
    incompatible_batches: conflicts, compatible_batches: compatible, two_answer_witnesses: twoAnswerWitnesses, unchanged_answer_batches: unchangedAnswers, existing_relationship_batches: existingRelationships,
    tracker_unchanged: true, sdk_readback_equal: true, git_available_during_check: false, inference_calls: inferenceCalls, mutations: 0,
    limitations: "One committed public fleet tracker; native types and existing relationships read through the SDK. Classification conflicts and their explicit corrections are controlled proposals, not model predictions. This measures validation mechanics and zero mutations, not inference accuracy, hosted backends or concurrent apply safety." };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { globalThis.fetch = savedFetch; restore(); }
