import assert from "node:assert/strict";
import test from "node:test";
import { isHostOutputSuppressed } from "@unbrained/pm-cli/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { TRIAGE_CATALOG_VERSION, triageSourceHash } from "../index.ts";
import type { BacklogTriageSummary, ProjectableItem } from "../index.ts";
import { scenario, typeAnswers } from "./fixtures.ts";

/** Run a bounded apply against the real tracker without terminal streaming. */
async function apply(fixture: Parameters<Parameters<typeof scenario>[0]>[0], minConfidence = "0.8"): Promise<BacklogTriageSummary> {
  const response = await fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot,
    options: { open: true, apply: true, minConfidence }, global: { quiet: true } });
  assert.ok(isHostOutputSuppressed(response.result));
  const result = response.result.result as BacklogTriageSummary;
  assert.equal(result.failed, 0);
  return result;
}

for (const change of ["unchanged registry", "edited custom description", "added type", "legacy receipt", "normalized definitions skip redundant inference"] as const) {
  test(`type receipt fingerprint: ${change}`, async () => {
    await scenario(async (fixture, server) => {
      await fixture.pm.schemaAddType("Reference", { description: "Known facts with evidence", folder: "references" });
      const item = (await fixture.pm.create({ type: "Feature", title: "Synthetic crash", priority: 3 })).item;
      if (change === "legacy receipt") {
        // Seed an old receipt by appending it; never rewrite a historical comment.
        const projected = await fixture.pm.get(item.id, { fields: "id,title,type,status,priority,tags,description,body,updated_at,comments",
          outputBudget: "unbounded", outputLimit: "unbounded" });
        assert.ok("item" in projected);
        const source = projected.item as ProjectableItem;
        assert.equal(triageSourceHash(source), triageSourceHash((await fixture.pm.get(item.id, { full: true })).item as ProjectableItem));
        await fixture.pm.comments(item.id, { add: `pm-jev triage receipt: model=legacy, catalog=${TRIAGE_CATALOG_VERSION}, source_sha256=${triageSourceHash(source)}, expected_type="Feature", apply_threshold=0.8, applied=none.` });
      } else {
        assert.equal((await apply(fixture)).changed, 1);
        assert.equal(server.requests.length, 1);
      }
      const before = (await fixture.pm.comments(item.id)).comments;
      if (change === "edited custom description") {
        await fixture.pm.schemaAddType("Reference", { description: "An architectural choice requiring approval", folder: "references", force: true });
      } else if (change === "added type") {
        await fixture.pm.schemaAddType("Execution", { folder: "execution-records" });
      } else if (change === "normalized definitions skip redundant inference") {
        await fixture.pm.schemaAddType("Reference", { description: "Known facts\n with evidence", folder: "references", force: true });
      }
      const result = await apply(fixture);
      const after = (await fixture.pm.comments(item.id)).comments;
      const unchanged = change === "unchanged registry" || change === "normalized definitions skip redundant inference";
      assert.equal(server.requests.length, change === "legacy receipt" ? 1 : unchanged ? 1 : 2);
      assert.deepEqual(after.slice(0, before.length), before);
      assert.equal(after.length, before.length + (unchanged ? 0 : 1));
      assert.equal(result.changed, change === "legacy receipt" ? 1 : 0);
      assert.match(after[after.length - 1].text, /type_question_sha256=[a-f0-9]{64},/);
      if (change === "edited custom description" || change === "added type") {
        assert.notEqual(after[0].text.match(/type_question_sha256=([a-f0-9]{64})/)?.[1],
          after[1].text.match(/type_question_sha256=([a-f0-9]{64})/)?.[1]);
      }
      await apply(fixture);
      assert.equal(server.requests.length, change === "legacy receipt" ? 1 : unchanged ? 1 : 2);
      assert.deepEqual((await fixture.pm.comments(item.id)).comments, after);
    });
  });
}

test("external type change invalidates receipt while triage's own type apply rerun skips", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ type: "Feature", title: "Synthetic crash", priority: 0 })).item;
    assert.equal((await apply(fixture)).changed, 1);
    assert.equal((await fixture.pm.get(item.id)).item.type, "Issue");
    assert.match((await fixture.pm.comments(item.id)).comments[0].text, /expected_type="Issue",/);
    assert.equal((await apply(fixture)).skipped, 1);
    assert.equal(server.requests.length, 1);
    await fixture.pm.update(item.id, { type: "Task" });
    assert.equal((await apply(fixture)).changed, 1);
    assert.equal(server.requests.length, 2);
    assert.equal((await fixture.pm.get(item.id)).item.type, "Issue");
    assert.equal((await apply(fixture)).skipped, 1);
    assert.equal(server.requests.length, 2);
  });
});

test("lowered full-precision threshold revisits proposals while equal or raised thresholds skip", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ type: "Feature", title: "Synthetic crash", priority: 0 })).item;
    server.setReply((_, response, body) => response.end(JSON.stringify(typeAnswers(
      (body as { questions: Questions }).questions, { Issue: 0.9, Feature: 0.1 }))));
    assert.equal((await apply(fixture, "0.9000000000000001")).changed, 0);
    assert.equal((await fixture.pm.get(item.id)).item.type, "Feature");
    const receipt = (await fixture.pm.comments(item.id)).comments[0].text;
    assert.match(receipt, /expected_type="Feature", apply_threshold=0.9000000000000001,/);
    await apply(fixture, "0.9000000000000001");
    await apply(fixture, "1");
    assert.equal(server.requests.length, 1);
    assert.equal((await apply(fixture, "0.9")).changed, 1);
    assert.equal(server.requests.length, 2);
    assert.equal((await fixture.pm.get(item.id)).item.type, "Issue");
    await apply(fixture, "0.9");
    await apply(fixture, "1");
    assert.equal(server.requests.length, 2);
    await apply(fixture, "0.8");
    assert.equal(server.requests.length, 3);
  });
});

test("receipts without valid apply thresholds are revisited", async () => {
  for (const field of ["", "apply_threshold=NaN, ", "apply_threshold=-1, ", "apply_threshold= , ", "apply_threshold=, ", "apply_threshold=2, "]) {
    await scenario(async (fixture, server) => {
      const donor = (await fixture.pm.create({ type: "Issue", title: "Synthetic crash", priority: 0 })).item;
      await apply(fixture);
      const receipt = (await fixture.pm.comments(donor.id)).comments[0].text;
      const target = (await fixture.pm.create({ type: "Issue", title: donor.title, priority: 0 })).item;
      await fixture.pm.comments(target.id, { add: receipt.replace("apply_threshold=0.8, ", field) });
      await apply(fixture);
      assert.equal(server.requests.length, 2);
      assert.equal((await fixture.pm.comments(target.id)).comments.length, 2);
    });
  }
});
