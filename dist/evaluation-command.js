import { TokenUsageTotals } from "./token-usage.js";
import { randomUUID } from "node:crypto";
import { createPmCliExpectedError, readStringOption } from "@unbrained/pm-cli/sdk";
import { buildUnits, deterministicSample, readPublicCorpus } from "./tracker-evaluation.js";
import { calibrationKey, calibrateObservations, evidenceHash, EVALUATION_VERSION, modelDigest, questionFingerprint, readOpaqueJevSettings, reliability, repositorySplit } from "./decision-calibration.js";
import { bm25Rank, EMBEDDING_MODEL, eligibleExemplars, embedTexts, embeddingAvailable, embeddingRank, exemplarBudget, exemplarContext, knnVote, majorityLabel } from "./exemplar-retrieval.js";
import { createJevClient, requireCallableEndpoint, resolveJevEndpoint, runDecision } from "./index.js";
/** Shared evaluator flags; source paths stay outside every emitted receipt. */
export const EVALUATION_FLAGS = [
    { long: "--task", value_name: "triage|link|dedupe", value_type: "string", required: true, description: "Ground-truth decision task" },
    { long: "--from", value_name: "tracker", value_type: "string", repeatable: true, required: true, description: "Committed public fleet tracker; repeat for multiple repositories" },
    { long: "--model", value_name: "model", value_type: "string", description: "Exact installed local model tag" },
    { long: "--sample", value_name: "N", value_type: "string", description: "Sampled labelled examples per invocation (eval default 40, calibrate 100; hard cap 150)" },
    { long: "--seed", value_name: "seed", value_type: "string", description: "Deterministic repository and example sampling seed (default 0)" },
    { long: "--retrieval", value_name: "lexical|embedding", value_type: "string", description: "Retrieve same-tracker labelled exemplars for every sampled target (default lexical BM25; embedding uses the local qwen3-embedding:0.6b when available, otherwise lexical)" },
    { long: "--exemplars", value_name: "N", value_type: "string", description: "Retrieved exemplar count k, default 4, maximum 8 (requires --retrieval)" },
    { long: "--exemplar-tokens", value_name: "N", value_type: "string", description: "Exemplar context token budget, default 1200 (requires --retrieval)" },
];
/** Alternate host-parser spellings shared by token-budget reads and presence guards. */
const EXEMPLAR_TOKEN_ALIASES = ["exemplar_tokens", "exemplar-tokens"];
/** Validate a bounded positive integer before accessing sources or the model. */
function sampleOption(raw, fallback) {
    const value = Number(raw ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 150)
        throw createPmCliExpectedError("--sample must be an integer from 1 to 150");
    return value;
}
/** Parse and validate the exemplar retrieval flags before accessing any source. */
function exemplarSetting(options, task) {
    const retrieval = readStringOption(options, "retrieval");
    if (retrieval === undefined) {
        if (["exemplars", "exemplarTokens", ...EXEMPLAR_TOKEN_ALIASES].some(/** Refuse every supplied spelling before source reads or inference. */ /** Refuse every supplied spelling before source reads or inference. */ key => options[key] !== undefined))
            throw createPmCliExpectedError("--exemplars and --exemplar-tokens require --retrieval");
        return undefined;
    }
    if (retrieval !== "lexical" && retrieval !== "embedding")
        throw createPmCliExpectedError("--retrieval must be lexical or embedding");
    if (task === "dedupe")
        throw createPmCliExpectedError("Exemplar retrieval supports triage and link tasks");
    const count = Number(readStringOption(options, "exemplars") ?? 4);
    if (!Number.isInteger(count) || count < 1 || count > 8)
        throw createPmCliExpectedError("--exemplars must be an integer from 1 to 8");
    const tokenBudget = Number(readStringOption(options, "exemplarTokens", EXEMPLAR_TOKEN_ALIASES) ?? 1200);
    if (!Number.isInteger(tokenBudget) || tokenBudget < 1 || tokenBudget > 65536)
        throw createPmCliExpectedError("--exemplar-tokens must be an integer from 1 to 65536");
    return retrieval === "embedding" ? { retrieval, count, token_budget: tokenBudget, embedding_model: EMBEDDING_MODEL } : { retrieval, count, token_budget: tokenBudget };
}
/** Retrieval text of one unit; identical composition for BM25 queries and embeddings. */
function retrievalText(unit) {
    return `${unit.title}\n${unit.body}`;
}
/** Label space of one question channel, matching the model's answer schema. */
export function channelLabels(question) {
    if (question.type === "choice")
        return Object.keys(question.criteria);
    if (question.type !== "score" || !Array.isArray(question.criteria))
        throw createPmCliExpectedError("Exemplar baselines need a choice or score question");
    return question.criteria.map(/** Derive score level labels in code. */ (_, index) => String(index));
}
/** Convert one baseline prediction into a content-free pseudo-observation. */
function baselineObservation(example, channel, label, probabilities) {
    return { repository: example.repository, commit: example.commit, data_sha256: example.data_sha256, example_sha256: example.example_sha256,
        question_sha256: questionFingerprint(channel, example.questions[channel]), channel, label, probabilities, latency_ms: 0, input_tokens: 0, output_tokens: 0 };
}
/** Embed every corpus unit once when the local embedding model is available. */
async function embeddedCorpora(corpora, built, config) {
    const available = await embeddingAvailable(config.baseUrl, config.timeoutMs);
    const vectors = new Map();
    let fallbacks = 0;
    if (available)
        for (const [index, corpus] of corpora.entries()) {
            const embedded = await embedTexts(config.baseUrl, built[index].units.map(/** Embed each unit's retrieval text in stable order. */ /** Embed each unit's retrieval text in stable order. */ unit => retrievalText(unit)), config.timeoutMs);
            // A failed corpus batch falls back to lexical for that repository; text never crosses a failed request.
            if (embedded === null) {
                fallbacks += 1;
                continue;
            }
            vectors.set(corpus.repository, { units: built[index].units, vectors: embedded });
        }
    return { available, fallbacks, vectors };
}
/** Rank the eligible same-tracker exemplars for one sampled target. */
function rankExemplars(unit, corpusUnits, sampled, embedded) {
    if (embedded === undefined) {
        const eligible = eligibleExemplars(unit, corpusUnits, sampled);
        return { eligible, ranked: bm25Rank(retrievalText(unit), eligible) };
    }
    const pairs = eligibleExemplars(unit, embedded.units.map(/** Attach each unit's precomputed embedding vector. */ (entry, index) => ({ ...entry, vector: embedded.vectors[index] })), sampled);
    return { eligible: pairs, ranked: embeddingRank(embedded.vectors[embedded.units.indexOf(unit)], pairs) };
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
    const exemplars = exemplarSetting(ctx.options, task);
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
    const built = corpora.map(/** Construct ground truth locally before any inference. */ /** Construct ground truth locally before any inference. */ corpus => buildUnits(corpus, task));
    const units = built.flatMap(/** Gather all eligible labelled units. */ /** Gather all eligible labelled units. */ result => result.units);
    const sampled = deterministicSample(units.map(/** Wrap each unit so sampling identity stays byte-identical without copying. */ /** Wrap each unit so sampling identity stays byte-identical without copying. */ unit => ({ example_sha256: unit.example.example_sha256, repository: unit.example.repository, unit })), sample, seed)
        .map(/** Unwrap the sampled units, preserving object identity for embedding lookups. */ /** Unwrap the sampled units, preserving object identity for embedding lookups. */ wrapper => wrapper.unit);
    if (sampled.length === 0)
        throw createPmCliExpectedError("No eligible ground-truth examples; no model calls made");
    const split = repositorySplit(sampled.map(/** Require independent repositories before fitting. */ /** Require independent repositories before fitting. */ row => row.example.repository), seed);
    if (calibrate && split.validation.length === 0)
        throw createPmCliExpectedError("Calibration needs at least two repositories with sampled labels");
    const digest = await modelDigest(config.baseUrl, config.model, config.timeoutMs);
    const client = createJevClient({ ...resolved, config }, process.env, 0);
    const poolByRepository = new Map(corpora.map(/** Every labelled unit of one repository is a potential exemplar. */ (corpus, index) => [corpus.repository, built[index].units]));
    const sampledIds = new Map();
    for (const unit of sampled) {
        const ids = sampledIds.get(unit.example.repository) ?? new Set();
        for (const id of unit.ids)
            ids.add(id);
        sampledIds.set(unit.example.repository, ids);
    }
    // Exemplar retrieval uses only the target's own repository, so repository splits never share context.
    const embedded = exemplars !== undefined && exemplars.retrieval === "embedding" ? await embeddedCorpora(corpora, built, config) : null;
    const observations = [];
    const exemplarObservations = [];
    const majorityRows = [];
    const knnRows = [];
    const usage = new TokenUsageTotals();
    let elapsed = 0;
    let calls = 0;
    let reusedBaseline = 0;
    let emptyRetrievals = 0;
    let retrievedTotal = 0;
    let budgetClamped = 0;
    for (const unit of sampled) {
        const example = unit.example;
        let eligible = [];
        let retrieved = [];
        if (exemplars !== undefined) {
            // Both maps are built from the same corpora as the sample, so the lookups always hit.
            const context = rankExemplars(unit, poolByRepository.get(example.repository), sampledIds.get(example.repository), embedded?.vectors.get(example.repository));
            eligible = context.eligible;
            retrieved = context.ranked.slice(0, exemplars.count);
            if (context.ranked.length === 0)
                emptyRetrievals += 1;
            retrievedTotal += retrieved.length;
        }
        const started = performance.now();
        const result = await runDecision(client, config, example.state, example.questions);
        const latency = performance.now() - started;
        elapsed += latency;
        calls += 1;
        usage.add(result.usage);
        for (const [channel, label] of Object.entries(example.labels)) {
            const probabilities = result.answers[channel].probabilities;
            observations.push({ repository: example.repository, commit: example.commit, data_sha256: example.data_sha256,
                example_sha256: example.example_sha256, question_sha256: questionFingerprint(channel, example.questions[channel]), channel, label, probabilities,
                latency_ms: latency, input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens });
        }
        if (exemplars === undefined)
            continue;
        // The endpoint never truncates input, so clamp the exemplar budget to the remaining prompt headroom.
        const effectiveBudget = exemplarBudget(JSON.stringify({ state: example.state, questions: example.questions, model: config.model }), exemplars.token_budget, result.usage.input_tokens);
        if (effectiveBudget < exemplars.token_budget)
            budgetClamped += 1;
        const entries = exemplarContext(retrieved, effectiveBudget);
        let exemplarLatency = 0;
        let exemplarResult = result;
        if (entries.length === 0) {
            // With no exemplar context the exemplar arm is exactly the plain model; reuse its validated answer.
            reusedBaseline += 1;
        }
        else {
            const exemplarStarted = performance.now();
            exemplarResult = await runDecision(client, config, { ...example.state, exemplars: entries }, example.questions);
            exemplarLatency = performance.now() - exemplarStarted;
            elapsed += exemplarLatency;
            calls += 1;
            usage.add(exemplarResult.usage);
        }
        for (const [channel, label] of Object.entries(example.labels)) {
            exemplarObservations.push({ repository: example.repository, commit: example.commit, data_sha256: example.data_sha256,
                example_sha256: example.example_sha256, question_sha256: questionFingerprint(channel, example.questions[channel]), channel, label,
                probabilities: exemplarResult.answers[channel].probabilities,
                latency_ms: exemplarLatency, input_tokens: exemplarResult.usage.input_tokens, output_tokens: exemplarResult.usage.output_tokens,
                exemplar_ids: retrieved.map(/** Item ids of each retrieved unit, joined per unit. */ /** Item ids of each retrieved unit, joined per unit. */ exemplar => exemplar.ids.join("+")),
                exemplar_digests: retrieved.map(/** Content digest of each retrieved unit. */ /** Content digest of each retrieved unit. */ exemplar => exemplar.example_sha256),
                context_exemplar_ids: retrieved.slice(0, entries.length).map(/** Only units actually sent to the model. */ /** Only units actually sent to the model. */ exemplar => exemplar.ids.join("+")),
                context_exemplar_digests: retrieved.slice(0, entries.length).map(/** Underlying digests of the budgeted units. */ /** Underlying digests of the budgeted units. */ exemplar => exemplar.example_sha256),
                context_sha256: evidenceHash(entries), effective_exemplar_tokens: effectiveBudget });
            const labels = channelLabels(example.questions[channel]);
            const majority = majorityLabel(eligible, channel);
            if (majority !== null)
                majorityRows.push(baselineObservation(example, channel, label, Object.fromEntries(labels.map(/** The majority class predicts its own label with certainty. */ /** The majority class predicts its own label with certainty. */ option => [option, option === majority ? 1 : 0]))));
            const vote = knnVote(retrieved, channel);
            if (vote !== null)
                knnRows.push(baselineObservation(example, channel, label, Object.fromEntries(labels.map(/** Vote shares over the retrieved exemplars. */ /** Vote shares over the retrieved exemplars. */ option => [option, vote[option] ?? 0]))));
        }
    }
    if (await modelDigest(config.baseUrl, config.model, config.timeoutMs) !== digest)
        throw createPmCliExpectedError("Model digest changed during evaluation; calibration was not saved");
    const channels = [...new Set(observations.map(/** Compute separate metrics for each question. */ /** Compute separate metrics for each question. */ row => row.channel))];
    const report = { version: EVALUATION_VERSION, task: task, model: config.model, model_digest: digest, seed,
        model_calls: calls, sampled_examples: sampled.length,
        eligible_examples: units.length,
        retrieval_misses: built.reduce(/** Keep failed duplicate retrieval visible. */ (sum, result) => sum + result.retrieval_misses, 0), skipped,
        mean_latency_ms: elapsed / calls,
        tokens: { input: usage.inputTokens, output: usage.outputTokens,
            mean_input: usage.inputTokens === null ? null : usage.inputTokens / calls, mean_output: usage.outputTokens === null ? null : usage.outputTokens / calls,
            unknown_calls: usage.unknownCalls, unknown_input_calls: usage.unknownInputCalls, unknown_output_calls: usage.unknownOutputCalls },
        metrics: Object.fromEntries(channels.map(/** Preserve type/priority label spaces rather than mixing them. */ /** Preserve type/priority label spaces rather than mixing them. */ channel => [channel, reliability(observations.filter(/** Select this channel's population. */ /** Select this channel's population. */ row => row.channel === channel))])),
        observations,
        ...(exemplars === undefined ? {} : {
            retrieval: { mode: exemplars.retrieval, count: exemplars.count, token_budget: exemplars.token_budget,
                embedding_model: exemplars.retrieval === "embedding" ? EMBEDDING_MODEL : null,
                embedding_available: embedded === null ? null : embedded.available, embedding_fallbacks: embedded?.fallbacks ?? 0,
                empty_retrievals: emptyRetrievals, reused_baseline_calls: reusedBaseline, budget_clamped_examples: budgetClamped, mean_exemplars: retrievedTotal / sampled.length },
            exemplar_metrics: Object.fromEntries(channels.map(/** The model with exemplars, measured on the same sample. */ /** The model with exemplars, measured on the same sample. */ channel => [channel, reliability(exemplarObservations.filter(/** Select this channel's population. */ /** Select this channel's population. */ row => row.channel === channel))])),
            baselines: Object.fromEntries(channels.map(/** Context-equivalent baselines share the same retrieved evidence. */ /** Context-equivalent baselines share the same retrieved evidence. */ channel => {
                /** Summarize one baseline arm over this channel's population. */
                const arm = (rows) => ({ abstained: sampled.length - rows.filter(/** Select this channel's population. */ /** Select this channel's population. */ row => row.channel === channel).length,
                    reliability: reliability(rows.filter(/** Select this channel's population. */ /** Select this channel's population. */ row => row.channel === channel)) });
                return [channel, { majority: arm(majorityRows), knn: arm(knnRows) }];
            })),
            exemplar_observations: exemplarObservations,
        }) };
    if (!calibrate)
        return report;
    const fitRows = exemplars === undefined ? observations : exemplarObservations;
    const receipt = calibrateObservations(task, config.model, digest, fitRows, seed, target, exemplars);
    // Retrieval failures mean a duplicate calibration does not cover the actual decision pipeline.
    if (report.retrieval_misses > 0)
        for (const channel of Object.values(receipt.channels)) {
            channel.threshold = null;
            channel.reason = "duplicate_retrieval_misses";
        }
    const key = calibrationKey(task, config.model, exemplars);
    const settingsWrite = await ctx.sdk.mutateWorkspaceSettings({ operationId: `jev-calibration-${randomUUID()}`,
        /** Merge only this task/model/exemplar receipt while holding the SDK settings audit lock. */
        mutate: async (current) => {
            const section = await readOpaqueJevSettings(ctx.pm_root);
            const previous = section.calibrations;
            return { ...current, jev: { ...section, calibrations: { ...previous, [key]: receipt } } };
        } });
    return { ...report, calibration: receipt, settings_write: settingsWrite };
}
//# sourceMappingURL=evaluation-command.js.map