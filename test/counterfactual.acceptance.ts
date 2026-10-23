import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createExtensionCommandSdk, PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { explainDecision, parseQuestionsDocument, projectItemState, resolveJevEndpoint } from "../index.ts";
import type { CounterfactualReceipt } from "../index.ts";
import { trackerSnapshot } from "./fixtures.ts";
import { publicAcceptanceInput, readPublicSample, hideGit } from "./replay-fixtures.ts";

const { root, before, scratch, output, provenance } = publicAcceptanceInput("Usage: counterfactual.acceptance.ts <public-clone> <empty-scratch> <report>");
const restoreGit = hideGit(scratch);
try {
  const { read, selected } = await readPublicSample(root, scratch, 6);
  const endpoint = await resolveJevEndpoint(root, process.env);
  const inventory = await (await fetch(`${endpoint.config.baseUrl}/api/tags`)).json() as { models: { name: string; digest: string }[] };
  const modelDigest = inventory.models.find(model => model.name === endpoint.config.model)!.digest;
  const questions = parseQuestionsDocument({ route: { type: "choice", instructions: "Does this item describe broken behavior or a new capability?", criteria: { defect: "Existing behavior is broken", capability: "New capability or improvement", other: "Other work" } } });
  const rows = [];
  for (const item of selected) {
    const started = Date.now();
    const receipt = await explainDecision({ endpoint, evidence: { ...projectItemState(item) }, fields: ["tags", "title", "description"], questions, maxCalls: 4 });
    assert.equal(receipt.complete, true);
    assert.equal(receipt.calls.attempted, 4);
    assert.equal(receipt.comparisons.length, 3);
    rows.push({ item: item.id, elapsed_ms: Date.now() - started, json_bytes: Buffer.byteLength(JSON.stringify(receipt)), receipt });
  }
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "hooks"] });
  const pm = new PmClient({ cwd: scratch, pmRoot: root, noExtensions: true, author: "validation" });
  const file = join(scratch, "questions.json"); writeFileSync(file, JSON.stringify(questions));
  const cli = await harness.runCommand({ command: "jev explain", pmRoot: root, args: [selected[0].id],
    options: { questions: file, fields: "tags,title,description", maxCalls: "2" }, global: { json: true }, sdk: createExtensionCommandSdk(root, pm, "validation", "jev explain") });
  const bounded = cli.result as CounterfactualReceipt;
  assert.equal(bounded.calls.attempted, 2); assert.equal(bounded.omitted.length, 2);
  assert.ok(bounded.omitted.every(row => row.reason === "call_limit"));
  const afterInventory = await (await fetch(`${endpoint.config.baseUrl}/api/tags`)).json() as typeof inventory;
  assert.equal(afterInventory.models.find(model => model.name === endpoint.config.model)!.digest, modelDigest);
  assert.deepEqual(trackerSnapshot(root), before);
  const comparisons = rows.flatMap(row => row.receipt.comparisons);
  const report = { version: "pm-jev-counterfactual-public/1", ...provenance,
    tracker_items: read.items.length, sampled_items: selected.length, authoritative_files_verified: Object.keys(before).length, tracker_unchanged: true, git_available_during_decisions: false,
    model: endpoint.config.model, model_digest: modelDigest, sdk_calls: rows.reduce((sum, row) => sum + row.receipt.calls.attempted, 0), cli_calls: bounded.calls.attempted,
    comparisons: comparisons.length, changed_comparisons: comparisons.filter(row => row.changed.length > 0).length,
    stable_comparisons: comparisons.filter(row => row.changed.length === 0).length, omitted_cli_comparisons: bounded.omitted.length,
    empty_tags_stable: rows.filter(row => selected.find(item => item.id === row.item)!.tags.length === 0 && row.receipt.comparisons[0].changed.length === 0).length,
    limitations: "Six public items, one choice question, one sample per state. Observed sensitivity is not causal attribution, model accuracy, noise stability or held-out quality. No tracker evidence or provider credentials are included in this report. Built parser TOON/JSON and synthetic choice/score/noul contracts are covered separately by regression tests.", rows, bounded_cli_receipt: bounded };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ ...report, rows: undefined, bounded_cli_receipt: undefined }, null, 2));
} finally { restoreGit(); }
