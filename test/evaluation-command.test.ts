import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionCommandSdk, getSettingsPath, readFileIfExists } from "@unbrained/pm-cli/sdk";
import { runEvaluationCommand } from "../evaluation-command.ts";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import type { CalibrationReceipt, Observation } from "../decision-calibration.ts";
import { evidenceHash, readCalibration } from "../decision-calibration.ts";
import { readPublicCorpus } from "../tracker-evaluation.ts";
import { publicInspection, syntheticCorpus } from "./evaluation-fixtures.ts";
import { answers, scenario, trackerSnapshot } from "./fixtures.ts";
import type { Questions } from "@typesafe-ai/sdk";

/** Bind evaluator requests to an actual host SDK and an independent synthetic public source. */
function context(fixture: Parameters<Parameters<typeof scenario>[0]>[0], options: Record<string, unknown>): CommandHandlerContext {
  return { command: "jev eval", args: [], options, global: { json: true }, pm_root: fixture.pmRoot, source_workspace_root: fixture.cwd,
    sdk: createExtensionCommandSdk(fixture.pmRoot, fixture.pm, "fixture", "jev calibrate") };
}
/** Supply a verified synthetic public corpus through the real SDK snapshot reader. */
async function source(from: string) { return readPublicCorpus(from, publicInspection); }
/** Serve exact local model identities and schema-valid deterministic decisions over real HTTP. */
function serve(server: Parameters<Parameters<typeof scenario>[0]>[1], changed = false) {
  let tags = 0;
  server.setReply((request, response, body) => {
    if (request.url === "/api/tags") { tags++; response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: (changed && tags > 1 ? "d" : "c").repeat(64) }] })); return; }
    response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
  });
}

test("eval reports exact schemas and full provenance without modifying source trackers or destination config", async () => {
  const origin = await syntheticCorpus();
  try {
    await scenario(async (fixture, server) => {
      serve(server);
      const before = trackerSnapshot(origin.pmRoot);
      const config = await readFileIfExists(getSettingsPath(fixture.pmRoot));
      const result = await runEvaluationCommand(context(fixture, { task: "triage", from: [origin.pmRoot, origin.pmRoot], sample: "2", seed: "fixed" }), false, source) as { model_calls: number; mean_latency_ms: number; tokens: { input: number }; observations: Observation[]; metrics: Record<string, { count: number }> };
      assert.equal(result.model_calls, 2);
      assert.equal(result.observations.length, 4);
      assert.equal(result.metrics.type.count, 2);
      assert.equal(result.tokens.input, 100);
      assert.ok(result.mean_latency_ms > 0);
      assert.deepEqual(trackerSnapshot(origin.pmRoot), before);
      assert.equal(await readFileIfExists(getSettingsPath(fixture.pmRoot)), config);
      for (const row of result.observations) assert.equal(row.repository, "unbraind/pm-alpha");
      assert.ok(!JSON.stringify(result).includes(origin.cwd));
      const wire = server.requests.filter(r => r.path !== "/api/tags").map(r => r.body);
      assert.equal(wire.length, 2);
      assert.ok(!JSON.stringify(wire).includes("demo-bug"));
      assert.ok(!JSON.stringify(wire).includes("__keep_current__"));
      const link = await runEvaluationCommand(context(fixture, { task: "link", from: origin.pmRoot, sample: "1" }), false, source) as { observations: Observation[] };
      assert.equal(link.observations[0].channel, "candidate_0");
      const dedupe = await runEvaluationCommand(context(fixture, { task: "dedupe", from: origin.pmRoot, sample: "1" }), false, source) as { observations: Observation[] };
      assert.equal(dedupe.observations[0].channel, "duplicate_of");
    });
  } finally { origin.dispose(); }
});

test("calibrate persists audited task/model receipts through the SDK while preserving existing settings", async () => {
  const alpha = await syntheticCorpus();
  const beta = await syntheticCorpus("pm-beta");
  try {
    await scenario(async (fixture, server) => {
      serve(server);
      const ctx = context(fixture, { task: "triage", from: [alpha.pmRoot, beta.pmRoot], sample: "4", model: "tev1:4b", seed: "fixed", targetPrecision: "0.9" });
      await ctx.sdk!.mutateWorkspaceSettings({ operationId: "existing-jev-settings", mutate: current => ({ ...current, jev: { keep_alive: "3m", min_confidence: 0.85 } }) });
      const result = await runEvaluationCommand(ctx, true, source) as { calibration: CalibrationReceipt; settings_write: { changed: boolean } };
      assert.equal(result.settings_write.changed, true);
      const receipt = await readCalibration(fixture.pmRoot, "triage", "tev1:4b");
      assert.deepEqual(receipt, result.calibration);
      assert.ok(receipt!.calibration_repositories.every(repo => !receipt!.validation_repositories.includes(repo)));
      assert.equal(receipt!.channels.type.threshold, null);
      assert.equal(receipt!.channels.priority.threshold, null);
      const raw = JSON.parse((await readFileIfExists(getSettingsPath(fixture.pmRoot)))!);
      assert.equal(raw.id_prefix, "synthetic-");
      assert.equal(raw.jev.keep_alive, "3m");
      assert.equal(raw.jev.min_confidence, 0.85);
      assert.ok(raw.jev.calibrations[evidenceHash(["triage", "tev1:4b"])]);
      const again = await runEvaluationCommand({ ...ctx, options: { ...ctx.options, task: "link" } }, true, source) as { calibration: CalibrationReceipt };
      assert.equal(again.calibration.task, "link");
      assert.ok(await readCalibration(fixture.pmRoot, "triage", "tev1:4b"));
      assert.ok(await readCalibration(fixture.pmRoot, "link", "tev1:4b"));
      await alpha.pm.create({ id: "demo-missing", type: "Issue", title: "Another session crash", status: "closed", closeReason: "duplicate of demo-unknown" });
      alpha.commit();
      const duplicates = await runEvaluationCommand({ ...ctx, options: { ...ctx.options, task: "dedupe" } }, true, source) as { calibration: CalibrationReceipt; retrieval_misses: number };
      assert.equal(duplicates.retrieval_misses, 1);
      assert.equal(duplicates.calibration.channels.duplicate_of.threshold, null);
      assert.equal(duplicates.calibration.channels.duplicate_of.reason, "duplicate_retrieval_misses");
      serve(server, true);
      await assert.rejects(runEvaluationCommand(ctx, true, source), /digest changed/);
    });
  } finally { alpha.dispose(); beta.dispose(); }
});

test("synthetic dedupe evaluation excludes sibling duplicates while retaining canonical targets and negative controls", async () => {
  const origin = await syntheticCorpus();
  try {
    await origin.pm.create({ id: "demo-sibling", type: "Issue", title: "Login crashes when session expires", status: "closed", closeReason: "duplicate of demo-bug" });
    origin.commit();
    const before = trackerSnapshot(origin.pmRoot);
    await scenario(async (fixture, server) => {
      let positives = 0;
      let negatives = 0;
      const candidateLists: string[][] = [];
      server.setReply((request, response, body) => {
        if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: "c".repeat(64) }] })); return; }
        const questions = (body as { questions: Questions }).questions;
        const question = questions.duplicate_of;
        assert.equal(question.type, "choice");
        const criteria = (question as { criteria: Record<string, string> }).criteria;
        candidateLists.push(Object.keys(criteria));
        const label = "demo-bug" in criteria ? "demo-bug" : "none";
        if (label === "demo-bug") positives++; else negatives++;
        const result = answers(questions);
        result.answers.duplicate_of = { type: "choice", choice: label, confidence: 1,
          probabilities: Object.fromEntries(Object.keys(criteria).map(candidate => [candidate, candidate === label ? 1 : 0])) };
        response.end(JSON.stringify(result));
      });
      const result = await runEvaluationCommand(context(fixture, { task: "dedupe", from: origin.pmRoot, sample: "150" }), false, source) as {
        model_calls: number; eligible_examples: number; retrieval_misses: number; metrics: Record<string, { count: number; accuracy: number; nll: number }>;
      };
      assert.equal(result.model_calls, 4);
      assert.equal(result.eligible_examples, 4);
      assert.equal(result.retrieval_misses, 0);
      assert.equal(result.metrics.duplicate_of.count, 4);
      assert.equal(result.metrics.duplicate_of.accuracy, 1);
      assert.equal(result.metrics.duplicate_of.nll, 0);
      assert.ok(candidateLists.every(candidates => !candidates.includes("demo-copy") && !candidates.includes("demo-sibling")));
      assert.equal(positives, 2);
      assert.equal(negatives, 2);
    });
    assert.deepEqual(trackerSnapshot(origin.pmRoot), before);
  } finally { origin.dispose(); }
});

test("evaluation validation rejects bad flags, hosted providers, private-only data and single-repository fitting before inference", async () => {
  const origin = await syntheticCorpus();
  try {
    await scenario(async (fixture, server) => {
      serve(server);
      const valid = { task: "triage", from: [origin.pmRoot], sample: "1" };
      for (const options of [{ task: "triage" }, { ...valid, task: "unknown" }, { ...valid, from: [] }, { ...valid, from: [1] }, { ...valid, from: [""] }, { ...valid, sample: "151" }, { ...valid, sample: "1.5" }, { ...valid, sample: "0" }, { ...valid, targetPrecision: "0" }, { ...valid, target_precision: "NaN" }, { ...valid, targetPrecision: "1.1" }]) await assert.rejects(runEvaluationCommand(context(fixture, options), false, source));
      await assert.rejects(runEvaluationCommand({ ...context(fixture, valid), sdk: undefined }, true, source), /host command SDK/);
      await assert.rejects(runEvaluationCommand(context(fixture, valid), true, source), /at least two repositories/);
      await assert.rejects(runEvaluationCommand(context(fixture, { ...valid, task: "dedupe" }), false, async () => null), /No eligible/);
      const empty = await source(origin.pmRoot);
      await assert.rejects(runEvaluationCommand(context(fixture, { task: "triage", from: origin.pmRoot }), false, async () => ({ ...empty!, items: [] })), /No eligible/);
      await assert.rejects(runEvaluationCommand(context(fixture, valid), false, async () => ({ ...empty!, items: [] })), /No eligible/);
      await assert.rejects(runEvaluationCommand(context(fixture, { task: "triage", from: origin.pmRoot }), true, async () => ({ ...empty!, items: [] })), /No eligible/);
      assert.equal(server.requests.length, 0);
      const cfg = context(fixture, valid).sdk!;
      await cfg.mutateWorkspaceSettings({ operationId: "hosted-evaluation-refusal", mutate: current => ({ ...current, jev: { provider: "ollama", allow_external: true } }) });
      const previous = process.env.PM_JEV_BASE_URL;
      process.env.PM_JEV_BASE_URL = "https://synthetic.example";
      try { await assert.rejects(runEvaluationCommand(context(fixture, valid), false, source), /local Ollama/); }
      finally { process.env.PM_JEV_BASE_URL = previous; }
      await cfg.mutateWorkspaceSettings({ operationId: "typesafe-evaluation-refusal", mutate: current => ({ ...current, jev: { provider: "typesafe", allow_external: true } }) });
      const previousKey = process.env.TYPESAFE_API_KEY;
      process.env.TYPESAFE_API_KEY = "synthetic-only";
      process.env.PM_JEV_BASE_URL = "https://synthetic.example";
      try { await assert.rejects(runEvaluationCommand(context(fixture, valid), false, source), /local Ollama/); }
      finally { process.env.PM_JEV_BASE_URL = previous; if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey; }
      // Registered commands share the same validation and host output boundary.
      await assert.rejects(fixture.harness.runCommand({ command: "jev eval", pmRoot: fixture.pmRoot, options: { task: "invalid" } }), /--task/);
      await assert.rejects(fixture.harness.runCommand({ command: "jev calibrate", pmRoot: fixture.pmRoot, options: { task: "invalid" } }), /--task/);
    });
  } finally { origin.dispose(); }
});
