import assert from "node:assert/strict";
import test from "node:test";
import { readSettings } from "@unbrained/pm-cli/sdk";
import type { ChoiceResponse, Questions } from "@typesafe-ai/sdk";
import { buildTriageQuestions, KEEP_CURRENT_TYPE, resolveTriageType, TYPE_MARGIN_THRESHOLD, withCurrentType } from "../index.ts";
import type { TriageDecision } from "../index.ts";
import { project, scenario, typeAnswers } from "./fixtures.ts";

/** Build a normalized answer whose chosen label can differ from its actual maximum. */
function choice(probabilities: Record<string, number>, selected = Object.keys(probabilities)[0]): ChoiceResponse {
  return { type: "choice", choice: selected, probabilities, confidence: 1 };
}

test("registry definitions preserve custom descriptions and folder metadata with canonical built-ins", async () => {
  const fixture = await project();
  try {
    await fixture.pm.schemaAddType("Reference", { description: "Known facts\n with evidence", folder: "references" });
    await fixture.pm.schemaAddType("Execution", { folder: "execution-records" });
    await fixture.pm.schemaAddType("constructor", { folder: "constructor-records" });
    const questions = buildTriageQuestions(await readSettings(fixture.pmRoot));
    assert.equal(questions.type.type, "choice");
    if (questions.type.type !== "choice") throw new Error("missing choice");
    assert.equal(questions.type.criteria.Reference, "Known facts with evidence");
    assert.match(String(questions.type.criteria.Execution), /Execution.*execution-records/);
    assert.match(String(questions.type.criteria.constructor), /constructor-records/);
    assert.match(String(questions.type.criteria.Issue), /defect/);
    assert.match(String(questions.type.criteria[KEEP_CURRENT_TYPE]), /Keep/);
    const bound = withCurrentType(questions, "Execution");
    assert.match(JSON.stringify(bound.type), /Keep current type Execution/);
    assert.notDeepEqual(bound, questions);
    assert.throws(() => withCurrentType({ type: { type: "noul" } }, "Issue"), /choice/);
  } finally { fixture.dispose(); }
});

test("keep-current rule rejects weak changes even when the model confidence is one", () => {
  const weak = resolveTriageType(choice({ Feature: 0.7, Issue: 0.2, [KEEP_CURRENT_TYPE]: 0.1 }), "Issue", {}, 0.1);
  assert.equal(weak.value, "Issue");
  assert.equal(weak.kept_current, true);
  assert.equal(weak.reason, "keep_current_under_weak_evidence");
  const keep = resolveTriageType(choice({ Feature: 0.05, Issue: 0.05, [KEEP_CURRENT_TYPE]: 0.9 }), "Issue", {}, 0.1);
  assert.equal(keep.value, "Issue");
  assert.equal(keep.selected_label, KEEP_CURRENT_TYPE);
  assert.equal(keep.kept_current, true);
  const same = resolveTriageType(choice({ Issue: 0.9, Feature: 0.05, [KEEP_CURRENT_TYPE]: 0.05 }), "Issue", {}, 0.1);
  assert.equal(same.kept_current, false);
  assert.equal(same.reason, null);
  assert.equal(resolveTriageType(choice({ Feature: 0.9, Issue: 0.1 }, "Issue"), "Issue", {}, 0.1).value, "Feature");
  assert.equal(resolveTriageType(choice({ Feature: 0.8, Issue: 0.2 }), "Issue", {}, 0.1).value, "Feature");
});

test("margin abstention has no proposal and an explicit reason before keep-current bias", () => {
  const result = resolveTriageType(choice({ Feature: 0.5, Issue: 0.5 }), "Issue", {}, 0.1);
  assert.equal(result.value, null);
  assert.equal(result.abstained, true);
  assert.equal(result.kept_current, false);
  assert.equal(result.reason, "top_two_margin_below_threshold");
  assert.equal(result.margin, 0);
  const boundary = resolveTriageType(choice({ Feature: 0.75, Issue: 0.25 }), "Issue", {}, 0.5);
  assert.equal(boundary.abstained, false);
  assert.equal(boundary.value, "Issue");
  assert.equal(resolveTriageType(choice({ Feature: 0.9, Issue: 0.1 }), "Issue", {}).margin_threshold, TYPE_MARGIN_THRESHOLD);
});

test("real tracker never writes a type below apply threshold and emits full definitions only on full output", async () => {
  await scenario(async (fixture, server) => {
    const created = await fixture.pm.create({ type: "Feature", title: "Synthetic crash", priority: 0 });
    let probability = 0.99;
    server.setReply((_, response, body) => {
      response.end(JSON.stringify(typeAnswers((body as { questions: Questions }).questions, { Issue: probability, Feature: 1 - probability })));
    });
    const run = async (threshold: string, full = true) => (await fixture.harness.runCommand({ command: "jev triage", args: [created.item.id],
      pmRoot: fixture.pmRoot, global: { json: false }, options: { apply: true, minConfidence: threshold, full } })).result as TriageDecision;
    const below = await run("1");
    assert.equal(below.proposals.type.abstained, false);
    assert.equal(below.proposals.type.value, "Issue");
    assert.equal((await fixture.pm.get(created.item.id)).item.type, "Feature");
    assert.ok(!below.applied.some(field => field.startsWith("type=")));
    assert.ok(below.proposals.type.definitions.Issue);
    assert.equal("definitions" in (await run("1", false)).proposals.type, false);
    probability = 0.7;
    const weak = await run("0.1");
    assert.ok(weak.proposals.type.abstained || weak.proposals.type.value === "Feature");
    assert.equal((await fixture.pm.get(created.item.id)).item.type, "Feature");
    probability = 0.5;
    const abstained = await run("0");
    assert.equal(abstained.proposals.type.value, null);
    assert.equal(abstained.proposals.type.abstained, true);
    assert.equal((await fixture.pm.get(created.item.id)).item.type, "Feature");
    probability = 1;
    assert.ok((await run("1")).applied.includes("type=Issue"));
    assert.equal((await fixture.pm.get(created.item.id)).item.type, "Issue");
  });
});
