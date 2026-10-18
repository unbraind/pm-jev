import { randomUUID } from "node:crypto";
import { createPmCliExpectedError, readStringOption } from "@unbrained/pm-cli/sdk";
import { buildExamples, deterministicSample, readPublicCorpus } from "./tracker-evaluation.js";
import { calibrateObservations, evidenceHash, EVALUATION_VERSION, modelDigest, questionFingerprint, readOpaqueJevSettings, reliability, repositorySplit } from "./decision-calibration.js";
import { createJevClient, requireCallableEndpoint, resolveJevEndpoint, runDecision } from "./index.js";
/** Shared evaluator flags; source paths stay outside every emitted receipt. */
export const EVALUATION_FLAGS = [
    { long: "--task", value_name: "triage|link|dedupe", value_type: "string", required: true, description: "Ground-truth decision task" },
    { long: "--from", value_name: "tracker", value_type: "string", repeatable: true, required: true, description: "Committed public fleet tracker; repeat for multiple repositories" },
    { long: "--model", value_name: "model", value_type: "string", description: "Exact installed local model tag" },
    { long: "--sample", value_name: "N", value_type: "string", description: "Maximum serial model calls (eval default 40, calibrate 100; hard cap 150)" },
    { long: "--seed", value_name: "seed", value_type: "string", description: "Deterministic repository and example sampling seed (default 0)" },
];
/** Validate a bounded positive integer before accessing sources or the model. */
function sampleOption(raw, fallback) {
    const value = Number(raw ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 150)
        throw createPmCliExpectedError("--sample must be an integer from 1 to 150");
    return value;
}
/** Run deterministic public-only evaluation and optionally persist a held-out calibration through the SDK. */
export async function runEvaluationCommand(ctx, calibrate, readCorpus = readPublicCorpus) {
    const task = readStringOption(ctx.options, "task");
    if (task !== "triage" && task !== "link" && task !== "dedupe")
        throw createPmCliExpectedError("--task must be triage, link or dedupe");
    const rawFrom = ctx.options.from;
    const from = [...(Array.isArray(rawFrom) ? rawFrom : typeof rawFrom === "string" ? [rawFrom] : []), ...ctx.args];
    if (from.length === 0 || !from.every(/** Refuse parser shapes that cannot be tracker paths. */ /** Refuse parser shapes that cannot be tracker paths. */ entry => typeof entry === "string" && entry.trim() !== ""))
        throw createPmCliExpectedError("Provide --from <tracker> for each public fleet repository");
    const sample = sampleOption(readStringOption(ctx.options, "sample"), calibrate ? 100 : 40);
    const seed = readStringOption(ctx.options, "seed") ?? "0";
    const target = Number(readStringOption(ctx.options, "targetPrecision", ["target_precision"]) ?? 0.9);
    if (!Number.isFinite(target) || target <= 0 || target > 1)
        throw createPmCliExpectedError("--target-precision must be in (0,1]");
    if (calibrate && ctx.sdk === undefined)
        throw createPmCliExpectedError("Calibration persistence requires the host command SDK");
    const resolved = await resolveJevEndpoint(ctx.pm_root, process.env);
    const config = { ...requireCallableEndpoint(resolved), model: readStringOption(ctx.options, "model") ?? resolved.config.model };
    if (config.provider !== "ollama" || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(config.baseUrl).hostname))
        throw createPmCliExpectedError("Evaluation requires a local Ollama endpoint");
    const corpora = [];
    const skipped = [];
    for (const source of [...new Set(from)].sort()) {
        const corpus = await readCorpus(source);
        if (corpus === null) {
            skipped.push("private_source");
            continue;
        }
        if (!corpora.some(/** Avoid duplicate repositories masquerading as separate split identities. */ /** Avoid duplicate repositories masquerading as separate split identities. */ previous => previous.repository === corpus.repository))
            corpora.push(corpus);
    }
    const built = corpora.map(/** Construct ground truth locally before any inference. */ /** Construct ground truth locally before any inference. */ corpus => buildExamples(corpus, task));
    const examples = deterministicSample(built.flatMap(/** Gather all eligible labelled decisions. */ /** Gather all eligible labelled decisions. */ result => result.examples), sample, seed);
    if (examples.length === 0)
        throw createPmCliExpectedError("No eligible ground-truth examples; no model calls made");
    const split = repositorySplit(examples.map(/** Require independent repositories before fitting. */ /** Require independent repositories before fitting. */ row => row.repository), seed);
    if (calibrate && split.validation.length === 0)
        throw createPmCliExpectedError("Calibration needs at least two repositories with sampled labels");
    const digest = await modelDigest(config.baseUrl, config.model, config.timeoutMs);
    const client = createJevClient({ ...resolved, config }, process.env, 0);
    const observations = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let elapsed = 0;
    for (const example of examples) {
        const started = performance.now();
        const result = await runDecision(client, config, example.state, example.questions);
        const latency = performance.now() - started;
        elapsed += latency;
        inputTokens += result.usage.input_tokens;
        outputTokens += result.usage.output_tokens;
        for (const [channel, label] of Object.entries(example.labels)) {
            const probabilities = result.answers[channel].probabilities;
            observations.push({ repository: example.repository, commit: example.commit, data_sha256: example.data_sha256,
                example_sha256: example.example_sha256, question_sha256: questionFingerprint(channel, example.questions[channel]), channel, label, probabilities,
                latency_ms: latency, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens });
        }
    }
    if (await modelDigest(config.baseUrl, config.model, config.timeoutMs) !== digest)
        throw createPmCliExpectedError("Model digest changed during evaluation; calibration was not saved");
    const report = { version: EVALUATION_VERSION, task: task, model: config.model, model_digest: digest, seed,
        model_calls: examples.length, eligible_examples: built.reduce(/** Record the sampling denominator. */ (sum, result) => sum + result.examples.length, 0),
        retrieval_misses: built.reduce(/** Keep failed duplicate retrieval visible. */ (sum, result) => sum + result.retrieval_misses, 0), skipped,
        mean_latency_ms: elapsed / examples.length, tokens: { input: inputTokens, output: outputTokens, mean_input: inputTokens / examples.length, mean_output: outputTokens / examples.length },
        metrics: Object.fromEntries([...new Set(observations.map(/** Compute separate metrics for each question. */ /** Compute separate metrics for each question. */ row => row.channel))].map(/** Preserve type/priority label spaces rather than mixing them. */ /** Preserve type/priority label spaces rather than mixing them. */ channel => [channel, reliability(observations.filter(/** Select this channel's population. */ /** Select this channel's population. */ row => row.channel === channel))])), observations };
    if (!calibrate)
        return report;
    const receipt = calibrateObservations(task, config.model, digest, observations, seed, target);
    // Retrieval failures mean a duplicate calibration does not cover the actual decision pipeline.
    if (report.retrieval_misses > 0)
        for (const channel of Object.values(receipt.channels)) {
            channel.threshold = null;
            channel.reason = "duplicate_retrieval_misses";
        }
    const key = evidenceHash([task, config.model]);
    const settingsWrite = await ctx.sdk.mutateWorkspaceSettings({ operationId: `jev-calibration-${randomUUID()}`,
        /** Merge only this task/model receipt while holding the SDK settings audit lock. */
        mutate: async (current) => {
            const section = await readOpaqueJevSettings(ctx.pm_root);
            const previous = section.calibrations;
            return { ...current, jev: { ...section, calibrations: { ...previous, [key]: receipt } } };
        } });
    return { ...report, calibration: receipt, settings_write: settingsWrite };
}
//# sourceMappingURL=evaluation-command.js.map