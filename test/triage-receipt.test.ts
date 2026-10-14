import assert from "node:assert/strict";
import test from "node:test";
import { isHostOutputSuppressed } from "@unbrained/pm-cli/sdk";
import { TRIAGE_CATALOG_VERSION, triageSourceHash } from "../index.ts";
import type { BacklogTriageSummary } from "../index.ts";
import { scenario } from "./fixtures.ts";

/** Run a bounded apply against the real tracker without terminal streaming. */
async function apply(fixture: Parameters<Parameters<typeof scenario>[0]>[0]): Promise<BacklogTriageSummary> {
  const response = await fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot,
    options: { open: true, apply: true }, global: { quiet: true } });
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
        const source = { ...(await fixture.pm.get(item.id, { full: true })).item,
          id: item.id, title: item.title, type: item.type, status: item.status, tags: item.tags };
        await fixture.pm.comments(item.id, { add: `pm-jev triage receipt: model=legacy, catalog=${TRIAGE_CATALOG_VERSION}, source_sha256=${triageSourceHash(source)}, applied=none.` });
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
