import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { createExtensionCommandSdk, getSettingsPath, readFileIfExists } from "@unbrained/pm-cli/sdk";
import { channelLabels, runEvaluationCommand } from "../evaluation-command.ts";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import type { CalibrationReceipt, Observation } from "../decision-calibration.ts";
import { activeCalibration, calibrationKey, evidenceHash, readCalibration } from "../decision-calibration.ts";
import { buildUnits, deterministicSample, readPublicCorpus } from "../tracker-evaluation.ts";
import type { TrackerCorpus } from "../tracker-evaluation.ts";
import { EMBEDDING_MODEL, eligibleExemplars, embeddingRank, embedTexts, estimateTokens, majorityLabel } from "../exemplar-retrieval.ts";
import type { ExemplarSetting } from "../exemplar-retrieval.ts";
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
function serve(server: Parameters<Parameters<typeof scenario>[0]>[1], changed = false, inputTokens = 50) {
  let tags = 0;
  server.setReply((request, response, body) => {
    if (request.url === "/api/tags") { tags++; response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: (changed && tags > 1 ? "d" : "c").repeat(64) }] })); return; }
    const result = answers((body as { questions: Questions }).questions);
    result.usage.input_tokens = inputTokens;
    response.end(JSON.stringify(result));
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
      for (const options of [{ task: "triage" }, { ...valid, task: "unknown" }, { ...valid, from: [] }, { ...valid, from: [1] }, { ...valid, from: [""] }, { ...valid, sample: "151" }, { ...valid, sample: "1.5" }, { ...valid, sample: "0" }, { ...valid, targetPrecision: "0" }, { ...valid, target_precision: "NaN" }, { ...valid, targetPrecision: "1.1" },
        { ...valid, retrieval: "vector" }, { ...valid, retrieval: "lexical", exemplars: "0" }, { ...valid, retrieval: "lexical", exemplars: "9" }, { ...valid, retrieval: "lexical", exemplars: "2.5" }, { ...valid, retrieval: "lexical", exemplarTokens: "0" }, { ...valid, retrieval: "lexical", exemplarTokens: "1.5" }, { ...valid, exemplars: "4" }, { ...valid, exemplarTokens: "1200" }, { ...valid, task: "dedupe", retrieval: "lexical" }]) await assert.rejects(runEvaluationCommand(context(fixture, options), false, source));
      assert.throws(() => channelLabels({ type: "noul", instructions: "x", criteria: { true: "a" } }), /choice or score/);
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

test("retrieval option aliases share prerequisite guards and token-budget validation", async () => {
  const origin = await exemplarCorpus();
  try {
    await scenario(async (fixture, server) => {
      serve(server);
      const valid = { task: "triage", from: origin.pmRoot, sample: "1", seed: "fixed" };
      const aliases = ["exemplarTokens", "exemplar_tokens", "exemplar-tokens"];
      for (const calibrate of [false, true]) {
        for (const key of ["exemplars", ...aliases]) for (const value of ["1", "", 0, null]) {
          await assert.rejects(runEvaluationCommand(context(fixture, { ...valid, [key]: value }), calibrate, source), /require --retrieval/);
        }
        for (const key of aliases) for (const value of ["0", "1.5", "65537"]) {
          await assert.rejects(runEvaluationCommand(context(fixture, { ...valid, retrieval: "lexical", [key]: value }), calibrate, source), /--exemplar-tokens must be an integer/);
        }
      }
      assert.equal(server.requests.length, 0);
      for (const key of aliases) {
        const report = await runEvaluationCommand(context(fixture, { ...valid, retrieval: "lexical", exemplars: "2", [key]: "1" }), false, source) as ExemplarReport;
        assert.equal(report.retrieval.count, 2);
        assert.equal(report.retrieval.token_budget, 1);
        assert.equal(report.model_calls, 1);
        assert.equal(report.retrieval.reused_baseline_calls, 1);
      }
    });
  } finally { origin.dispose(); }
});

/** Type of the four-arm exemplar evaluation report returned by the evaluator. */
interface ExemplarReport {
  model_calls: number;
  sampled_examples: number;
  retrieval: { mode: string; count: number; token_budget: number; embedding_model: string | null; embedding_available: boolean | null; embedding_fallbacks: number; empty_retrievals: number; reused_baseline_calls: number; budget_clamped_examples: number; mean_exemplars: number };
  exemplar_metrics: Record<string, { count: number; accuracy: number | null }>;
  baselines: Record<string, { majority: { abstained: number; reliability: { count: number } }; knn: { abstained: number; reliability: { count: number } } }>;
  exemplar_observations: (Observation & { exemplar_ids: string[]; exemplar_digests: string[] })[];
  metrics: Record<string, { count: number; accuracy: number | null }>;
}
/** Build the richer committed corpus used by the exemplar regressions. */
async function exemplarCorpus(name = "pm-alpha") {
  const origin = await syntheticCorpus(name);
  for (const row of [
    { type: "Issue", title: "Login crashes on mobile browsers", description: "Mobile sessions crash login", priority: "1" },
    { type: "Issue", title: "Login crashes after password reset", description: "Reset flows crash login", priority: "2" },
    { type: "Feature", title: "Export board as PDF", description: "Let users download the board as PDF", priority: "3" },
    { type: "Chore", title: "Update development dependencies", description: "Routine dependency maintenance", priority: "4" },
  ]) await origin.pm.create(row);
  origin.commit();
  return origin;
}

/** Pick a two-target seeded sample with eligible context despite snapshot metadata. */
function contextSampleSeed(units: ReturnType<typeof buildUnits>["units"]): string {
  const seed = Array.from({ length: 100 }, (_, index) => String(index)).find(value => {
    const sampled = deterministicSample(units.map(unit => ({ ...unit.example, unit })), 2, value).map(row => row.unit);
    const excluded = new Set(sampled.flatMap(unit => unit.ids));
    return sampled.some(unit => eligibleExemplars(unit, units, excluded).length > 0);
  });
  assert.notEqual(seed, undefined);
  return seed!;
}

/** Content-free retrieval identity of one exemplar observation. */
function retrievalIdentity(row: { example_sha256: string; exemplar_ids: string[]; exemplar_digests: string[] }): (string | string[])[] {
  return [row.example_sha256, row.exemplar_ids, row.exemplar_digests];
}

/** Serve model identities, optional embedding tags and deterministic embedding batches. */
function embedServe(server: Parameters<Parameters<typeof scenario>[0]>[1], options: { embedModel: boolean; status?: number }): void {
  server.setReply((request, response, body) => {
    if (request.url === "/api/embed") {
      if (options.status !== undefined) { response.statusCode = options.status; response.end("{}"); return; }
      const input = (body as { input: string[] }).input;
      response.end(JSON.stringify({ embeddings: input.map(/** Crash texts and export texts point to opposite directions. */ text => (text.includes("crash") ? [1, 0] : [0, 1])) }));
      return;
    }
    if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: "c".repeat(64) }, ...(options.embedModel ? [{ name: EMBEDDING_MODEL }] : [])] })); return; }
    response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
  });
}

test("exemplar evaluation wires budgeted same-tracker exemplars and reports four content-free arms", async () => {
  const origin = await exemplarCorpus();
  try {
    await scenario(async (fixture, server) => {
      serve(server);
      const corpus = await source(origin.pmRoot) as TrackerCorpus;
      const units = buildUnits(corpus, "triage").units;
      const options = { task: "triage", from: origin.pmRoot, sample: "2", seed: contextSampleSeed(units), retrieval: "lexical" };
      const baselineRequests = server.requests.length;
      const result = await runEvaluationCommand(context(fixture, options), false, source) as ExemplarReport;
      const afterFirst = server.requests.length;
      const sampledUnits = units.filter(/** Select the units the evaluator actually sampled. */ unit => result.exemplar_observations.some(row => row.example_sha256 === unit.example.example_sha256));
      assert.equal(result.sampled_examples, sampledUnits.length);
      assert.equal(result.retrieval.mode, "lexical");
      assert.equal(result.retrieval.count, 4);
      assert.equal(result.retrieval.token_budget, 1200);
      assert.equal(result.retrieval.embedding_model, null);
      assert.equal(result.retrieval.embedding_available, null);
      assert.equal(result.retrieval.embedding_fallbacks, 0);
      assert.equal(result.model_calls, 2 * result.sampled_examples - result.retrieval.reused_baseline_calls);
      assert.equal(result.exemplar_observations.length, 2 * result.sampled_examples);
      assert.ok(result.retrieval.mean_exemplars > 0 || result.retrieval.reused_baseline_calls === result.sampled_examples);
      const sampledIds = new Set(sampledUnits.flatMap(/** Evaluation-sample items never serve as exemplars. */ unit => unit.ids));
      for (const row of result.exemplar_observations) {
        const target = units.find(/** Match the row to its target unit. */ unit => unit.example.example_sha256 === row.example_sha256)!;
        const item = corpus.items.find(/** Resolve the target item's creation timestamp. */ entry => entry.id === target.ids[0])!;
        assert.equal(row.exemplar_ids.length, row.exemplar_digests.length);
        assert.equal(row.context_exemplar_ids!.length, row.context_exemplar_digests!.length);
        assert.ok(row.exemplar_ids.every(/** Every retrieved unit has a nonempty identity. */ id => id !== ""));
        for (const [index, joined] of row.exemplar_ids.entries()) {
          const ids = joined.split("+");
          const exemplar = units.find(/** Resolve the retrieved exemplar unit by digest. */ unit => unit.example_sha256 === row.exemplar_digests[index]);
          assert.deepEqual(ids, exemplar!.ids);
          assert.ok(ids.every(/** The target itself never becomes context. */ id => !target.ids.includes(id)));
          assert.ok(ids.every(/** Evaluation-sample items never become context. */ id => !sampledIds.has(id)));
          for (const id of ids) assert.ok(corpus.items.find(/** Future items never become context. */ entry => entry.id === id)!.created_at <= item.created_at);
        }
      }
      for (const [channel, arms] of Object.entries(result.baselines)) {
        assert.equal(arms.majority.abstained, result.sampled_examples - arms.majority.reliability.count);
        assert.equal(arms.knn.abstained, result.sampled_examples - arms.knn.reliability.count);
        assert.ok(["type", "priority"].includes(channel));
      }
      assert.equal(Object.keys(result.exemplar_metrics).sort().join(","), "priority,type");
      // Deterministic retrieval order and budget: rerun on identical inputs.
      const again = await runEvaluationCommand(context(fixture, options), false, source) as ExemplarReport;
      assert.deepEqual(again.exemplar_observations.map(retrievalIdentity), result.exemplar_observations.map(retrievalIdentity));
      const wire = server.requests.slice(baselineRequests, afterFirst).filter(r => r.path !== "/api/tags").map(r => r.body as { state: { exemplars?: { title: string; body: string; type: string; priority: string }[] } });
      assert.equal(wire.length, result.model_calls);
      for (const request of wire) {
        if (request.state.exemplars === undefined) continue;
        assert.ok(request.state.exemplars.length <= 4);
        assert.ok(estimateTokens(JSON.stringify(request.state.exemplars)) <= 1200);
        for (const entry of request.state.exemplars) {
          assert.ok(entry.title.length > 0);
          assert.ok(["Issue", "Task", "Feature", "Chore", "Decision", "Knowledge", "Run"].includes(entry.type));
        }
      }
      const encoded = JSON.stringify(result);
      assert.ok(!encoded.includes("Mobile sessions crash login"));
      assert.ok(!encoded.includes("instead of returning an error"));
      assert.ok(!encoded.includes("Routine dependency maintenance"));
      assert.ok(!encoded.includes(origin.cwd));
      // A tiny budget sends no context, with receipts recording that distinction.
      const tiny = await runEvaluationCommand(context(fixture, { ...options, exemplarTokens: "1" }), false, source) as ExemplarReport;
      assert.equal(tiny.retrieval.reused_baseline_calls, tiny.sampled_examples);
      assert.ok(tiny.exemplar_observations.some(row => row.exemplar_ids.length > 0));
      for (const row of tiny.exemplar_observations) {
        assert.deepEqual(row.context_exemplar_ids, []);
        assert.deepEqual(row.context_exemplar_digests, []);
        assert.equal(row.context_sha256, evidenceHash([]));
        assert.equal(row.effective_exemplar_tokens, 1);
      }
      // Link exemplars follow the same leakage rules over item pairs.
      const linked = await runEvaluationCommand(context(fixture, { task: "link", from: origin.pmRoot, sample: "2", seed: "fixed", retrieval: "lexical", exemplarTokens: "10000" }), false, source) as ExemplarReport;
      assert.equal(linked.exemplar_observations.length, linked.sampled_examples);
      assert.equal(linked.baselines.candidate_0.knn.abstained, linked.sampled_examples - linked.baselines.candidate_0.knn.reliability.count);
      // A budget above the remaining prompt headroom is clamped for every target.
      assert.equal(linked.retrieval.budget_clamped_examples, linked.sampled_examples);
      // A full sample leaves no eligible exemplars: the arms degrade honestly.
      const saturated = await runEvaluationCommand(context(fixture, { ...options, sample: "150" }), false, source) as ExemplarReport;
      assert.equal(saturated.sampled_examples, units.length);
      assert.equal(saturated.retrieval.empty_retrievals, units.length);
      assert.equal(saturated.retrieval.reused_baseline_calls, units.length);
      assert.equal(saturated.model_calls, units.length);
      assert.equal(saturated.retrieval.mean_exemplars, 0);
      for (const arms of Object.values(saturated.baselines)) {
        assert.equal(arms.majority.reliability.count, 0);
        assert.equal(arms.knn.reliability.count, 0);
        assert.equal(arms.majority.abstained, units.length);
        assert.equal(arms.knn.abstained, units.length);
      }
      for (const [channel, metric] of Object.entries(saturated.exemplar_metrics)) assert.deepEqual(metric, saturated.metrics[channel]);
    });
  } finally { origin.dispose(); }
});

test("embedding retrieval ranks through the local embedding endpoint and falls back to lexical deterministically", async () => {
  const origin = await exemplarCorpus();
  try {
    await scenario(async (fixture, server) => {
      serve(server);
      const request = { task: "triage", from: origin.pmRoot, sample: "2", seed: "fixed" };
      const lexical = await runEvaluationCommand(context(fixture, { ...request, retrieval: "lexical" }), false, source) as ExemplarReport;
      embedServe(server, { embedModel: true });
      const corpus = await source(origin.pmRoot) as TrackerCorpus;
      const units = buildUnits(corpus, "triage").units;
      const embedded = await runEvaluationCommand(context(fixture, { ...request, retrieval: "embedding" }), false, source) as ExemplarReport;
      assert.equal(embedded.retrieval.embedding_available, true);
      assert.equal(embedded.retrieval.embedding_model, EMBEDDING_MODEL);
      assert.equal(embedded.retrieval.embedding_fallbacks, 0);
      const batches = server.requests.filter(r => r.path === "/api/embed").map(r => r.body as { input: string[] });
      assert.equal(batches.length, 1);
      assert.equal(batches[0].input.length, units.length);
      const vectors = (await embedTexts(server.url, units.map(/** Reproduce the batch the evaluator sent. */ unit => `${unit.title}\n${unit.body}`), 5000))!;
      const sampled = new Set(embedded.exemplar_observations.flatMap(/** Evaluation-sample items never serve as exemplars. */ observation => units.find(/** Resolve the observation's target unit. */ unit => unit.example.example_sha256 === observation.example_sha256)!.ids));
      for (const row of embedded.exemplar_observations) {
        const target = units.find(/** Match the row to its target unit. */ unit => unit.example.example_sha256 === row.example_sha256)!;
        const eligible = eligibleExemplars(target, units.map((unit, index) => ({ ...unit, vector: vectors[index] })), sampled);
        assert.deepEqual(row.exemplar_ids, embeddingRank(vectors[units.indexOf(target)], eligible).slice(0, 4).map(/** Joined unit ids. */ unit => unit.ids.join("+")));
      }
      // A failed embedding batch falls back to lexical ranking for that repository.
      embedServe(server, { embedModel: true, status: 503 });
      const failed = await runEvaluationCommand(context(fixture, { ...request, retrieval: "embedding" }), false, source) as ExemplarReport;
      assert.equal(failed.retrieval.embedding_available, true);
      assert.equal(failed.retrieval.embedding_fallbacks, 1);
      assert.deepEqual(failed.exemplar_observations.map(retrievalIdentity), lexical.exemplar_observations.map(retrievalIdentity));
      // A missing embedding model falls back to lexical for every repository.
      embedServe(server, { embedModel: false });
      const absent = await runEvaluationCommand(context(fixture, { ...request, retrieval: "embedding" }), false, source) as ExemplarReport;
      assert.equal(absent.retrieval.embedding_available, false);
      assert.equal(absent.retrieval.embedding_fallbacks, 0);
      assert.deepEqual(absent.exemplar_observations.map(retrievalIdentity), lexical.exemplar_observations.map(retrievalIdentity));
    });
  } finally { origin.dispose(); }
});

test("real tracker exemplar context truncates escaped text and refuses prompts without headroom", async () => {
  const origin = await syntheticCorpus();
  try {
    await origin.pm.create({ type: "Issue", title: "Escaped session crash", description: "\\\"".repeat(1000), priority: "1" });
    const target = await origin.pm.create({ type: "Issue", title: "Escaped session crash on startup", priority: "1" });
    const future = await origin.pm.create({ type: "Issue", title: target.item.title, description: "A later report of the same startup symptom", priority: "1" });
    assert.ok(future.item.created_at > target.item.created_at);
    origin.commit();
    const corpus = await source(origin.pmRoot) as TrackerCorpus;
    const units = buildUnits(corpus, "triage").units;
    const seed = Array.from({ length: 100 }, (_, index) => String(index)).find(value => deterministicSample(units.map(unit => unit.example), 1, value)[0].example_sha256 === units.find(unit => unit.ids[0] === target.item.id)!.example_sha256)!;
    assert.ok(seed);
    await scenario(async (fixture, server) => {
      serve(server);
      const options = { task: "triage", from: origin.pmRoot, sample: "1", seed, retrieval: "lexical", exemplarTokens: "60" };
      const result = await runEvaluationCommand(context(fixture, options), false, source) as ExemplarReport;
      for (const row of result.exemplar_observations) {
        assert.ok(!row.exemplar_ids.includes(target.item.id));
        assert.ok(!row.exemplar_ids.includes(future.item.id));
      }
      const request = server.requests.find(row => (row.body as { state?: { exemplars?: unknown } } | null)?.state?.exemplars !== undefined)!;
      const entries = (request.body as { state: { exemplars: { title: string; body: string }[] } }).state.exemplars;
      assert.ok(entries[0].body.endsWith("…[truncated]"));
      const sent = result.exemplar_observations[0];
      assert.deepEqual([sent.context_sha256, sent.context_exemplar_ids!.length], [evidenceHash(entries), entries.length]);
      assert.ok(estimateTokens(JSON.stringify(entries)) <= Number(options.exemplarTokens));
      // The exact same tracker and ranking must reuse the plain answer when input usage consumes the headroom.
      serve(server, false, 2050);
      const clamped = await runEvaluationCommand(context(fixture, options), false, source) as ExemplarReport;
      assert.equal(clamped.model_calls, 1);
      assert.equal(clamped.retrieval.reused_baseline_calls, 1);
      assert.equal(clamped.retrieval.budget_clamped_examples, 1);
      assert.deepEqual(clamped.exemplar_observations[0].context_exemplar_ids, []);
      assert.equal(clamped.exemplar_observations[0].effective_exemplar_tokens, 0);
      assert.ok(!JSON.stringify(result).includes("Escaped session crash"));
    });
  } finally { origin.dispose(); }
});

test("exemplar calibration identity separates exemplar-fit receipts from legacy channels", async () => {
  const alpha = await exemplarCorpus();
  const beta = await exemplarCorpus("pm-beta");
  try {
    // Distinguish the second synthetic repository inside one committed identity.
    await beta.pm.create({ type: "Issue", title: "Second repository crash report", description: "Beta corpus crash", priority: "1" });
    beta.commit();
    const setting: ExemplarSetting = { retrieval: "lexical", count: 4, token_budget: 1200 };
    const different: ExemplarSetting = { retrieval: "embedding", count: 2, token_budget: 800, embedding_model: EMBEDDING_MODEL };
    assert.notEqual(calibrationKey("triage", "tev1:4b"), calibrationKey("triage", "tev1:4b", setting));
    assert.notEqual(calibrationKey("triage", "tev1:4b", setting), calibrationKey("triage", "tev1:4b", different));
    await scenario(async (fixture, server) => {
      serve(server);
      const options = { task: "triage", from: [alpha.pmRoot, beta.pmRoot], sample: "4", model: "tev1:4b", seed: "fixed", targetPrecision: "0.9", retrieval: "lexical" };
      const result = await runEvaluationCommand(context(fixture, options), true, source) as { calibration: CalibrationReceipt };
      assert.deepEqual(result.calibration.exemplars, setting);
      assert.equal(await readCalibration(fixture.pmRoot, "triage", "tev1:4b"), undefined);
      const receipt = await readCalibration(fixture.pmRoot, "triage", "tev1:4b", setting);
      assert.deepEqual(receipt, result.calibration);
      assert.ok(receipt!.calibration_repositories.length > 0);
      const raw = JSON.parse((await readFileIfExists(getSettingsPath(fixture.pmRoot)))!);
      assert.ok(raw.jev.calibrations[calibrationKey("triage", "tev1:4b", setting)]);
      assert.ok(!raw.jev.calibrations[calibrationKey("triage", "tev1:4b")]);
      // The production decision path never activates an exemplar-fit receipt.
      const config = { provider: "ollama", baseUrl: server.url, model: "tev1:4b", timeoutMs: 30_000 };
      assert.equal(await activeCalibration(fixture.pmRoot, "triage", config), undefined);
      assert.ok(await activeCalibration(fixture.pmRoot, "triage", config, setting));
      // A legacy fit coexists under the historical task/model key.
      const legacy = await runEvaluationCommand(context(fixture, { ...options, retrieval: undefined }), true, source) as { calibration: CalibrationReceipt };
      assert.equal(legacy.calibration.exemplars, undefined);
      assert.ok(await readCalibration(fixture.pmRoot, "triage", "tev1:4b"));
      const saved = JSON.parse((await readFileIfExists(getSettingsPath(fixture.pmRoot)))!) as { jev: { calibrations: Record<string, CalibrationReceipt> } };
      const legacyKey = calibrationKey("triage", "tev1:4b");
      const exemplarKey = calibrationKey("triage", "tev1:4b", setting);
      const exemplarReceipt = saved.jev.calibrations[exemplarKey];
      const legacyReceipt = saved.jev.calibrations[legacyKey];
      // Identity mismatches never activate: an exemplar receipt under the legacy key and vice versa.
      saved.jev.calibrations[legacyKey] = exemplarReceipt;
      saved.jev.calibrations[exemplarKey] = legacyReceipt;
      writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify(saved));
      assert.equal(await readCalibration(fixture.pmRoot, "triage", "tev1:4b"), undefined);
      assert.equal(await readCalibration(fixture.pmRoot, "triage", "tev1:4b", setting), undefined);
      // A malformed persisted exemplar setting refuses activation instead of authorizing.
      saved.jev.calibrations[exemplarKey] = { ...legacyReceipt, exemplars: { ...setting, count: 0 } };
      writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify(saved));
      await assert.rejects(readCalibration(fixture.pmRoot, "triage", "tev1:4b", setting), /Saved calibration/);
      saved.jev.calibrations[exemplarKey] = { ...exemplarReceipt, exemplars: { ...setting, count: 3 } };
      writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify(saved));
      assert.equal(await readCalibration(fixture.pmRoot, "triage", "tev1:4b", setting), undefined);
    });
  } finally { alpha.dispose(); beta.dispose(); }
});
