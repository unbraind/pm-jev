import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionCommandSdk, isHostOutputSuppressed } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import compiledExtension, { projectTriageState, triageSourceHash } from "../dist/index.js";
import type { BacklogTriageSummary, ProjectableItem } from "../dist/index.js";
import { scenario } from "./fixtures.ts";

const evidence: ProjectableItem = { id: "synthetic", title: "Login regression", description: "The login page crashes.", body: "The login page crashes.", type: "Feature", priority: 3, status: "open", tags: [] };

test("compiled triage sends minimal independent evidence without duplicated body", () => {
  assert.deepEqual(projectTriageState(evidence), { title: evidence.title, description: evidence.description });
});

test("compiled receipt identity survives applied routing and detects truncated-away changes", () => {
  assert.equal(triageSourceHash(evidence), triageSourceHash({ ...evidence, type: "Issue", priority: 0 }));
  const full = { ...evidence, description: "context".repeat(1000) };
  assert.notEqual(triageSourceHash(full), triageSourceHash({ ...full, description: `${full.description}Changed intent` }));
});

test("compiled batch receipt reuse makes no second model request after apply", async () => {
  await scenario(async (fixture, server) => {
    await fixture.pm.create({ type: evidence.type, title: evidence.title, description: evidence.description, body: evidence.body, priority: evidence.priority });
    const harness = await createExtensionTestHarness(compiledExtension, { capabilities: ["commands", "schema", "hooks"] });
    const run = async (): Promise<BacklogTriageSummary> => {
      const response = await harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot,
        sdk: createExtensionCommandSdk(fixture.pmRoot, fixture.pm, "fixture", "jev triage"), options: { open: true, apply: true } });
      assert.ok(isHostOutputSuppressed(response.result));
      return response.result.result as BacklogTriageSummary;
    };
    assert.equal((await run()).changed, 1);
    assert.equal((await run()).skipped, 1);
    assert.equal(server.requests.length, 1);
  });
});
