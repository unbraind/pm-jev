import { createHmac, randomBytes, createHash } from "node:crypto";
import { createJevClient, parseQuestionsDocument, runDecision } from "./index.js";
import { TokenUsageTotals } from "./token-usage.js";
/** Versioned sensitivity receipt; no narrative rationale or mutation authority. */
export const COUNTERFACTUAL_VERSION = "pm-jev-counterfactual/1";
/** Caller-correctable refusals happen before any decision request. */
export class CounterfactualRefusal extends Error {
    /** Stable refusal category for agent recovery. */
    code;
    /** Concrete recovery instruction without input or provider error text. */
    remedy;
    /** Construct a redacted, typed refusal. */
    constructor(code, message, remedy) {
        super(message);
        this.name = "CounterfactualRefusal";
        this.code = code;
        this.remedy = remedy;
    }
}
/** Enforce one documented request bound without copying caller content into errors. */
function requireBound(ok) {
    if (!ok)
        throw invalidRequest();
}
/** Share one redacted recovery contract for parse failures and bound violations. */
function invalidRequest() {
    return new CounterfactualRefusal("invalid_request", "Explanation input exceeds its bounds or has an invalid shape.", "Use a JSON object up to 32 KiB, 1..16 distinct own fields (names up to 64 characters), 1..8 typed questions with up to 32 options, and --max-calls 1..17.");
}
/** Freeze caller-owned inputs into JSON snapshots before the first asynchronous call. */
function snapshot(options) {
    try {
        const evidenceText = JSON.stringify(options.evidence);
        const questionText = JSON.stringify(options.questions);
        requireBound(typeof evidenceText === "string" && Buffer.byteLength(evidenceText) <= 32768 && typeof questionText === "string" && Buffer.byteLength(questionText) <= 16384);
        const evidence = JSON.parse(evidenceText);
        requireBound(evidence !== null && typeof evidence === "object" && !Array.isArray(evidence));
        const fields = [...options.fields];
        requireBound(fields.length > 0 && fields.length <= 16 && new Set(fields).size === fields.length);
        for (const field of fields)
            requireBound(typeof field === "string" && field.length > 0 && field.length <= 64 && Object.hasOwn(evidence, field));
        const questions = parseQuestionsDocument(JSON.parse(questionText));
        requireBound(Object.keys(questions).length <= 8);
        for (const [name, question] of Object.entries(questions)) {
            requireBound(name.length <= 64);
            if (question.type === "choice" || question.type === "score") {
                const labels = Object.keys(question.criteria);
                requireBound(labels.length <= 32 && labels.every(/** Keep compact receipts bounded even with caller-defined labels. */ /** Keep compact receipts bounded even with caller-defined labels. */ label => label.length <= 64));
            }
        }
        const limit = options.maxCalls ?? 5;
        requireBound(Number.isSafeInteger(limit) && limit >= 1 && limit <= 17);
        return { evidence, fields, questions, limit };
    }
    catch {
        throw invalidRequest();
    }
}
/** Convert validated responses to typed outcomes plus internal full distributions. */
function outcomes(result, questions) {
    const proposals = Object.create(null);
    const distributions = Object.create(null);
    for (const [name, question] of Object.entries(questions)) {
        if (question.type === "noul") {
            const p = result.answers[name].noul;
            proposals[name] = { kind: "noul", value: p >= 0.5, probability: p };
            distributions[name] = { true: p, false: 1 - p };
        }
        else {
            const answer = result.answers[name];
            const probabilities = answer.probabilities;
            const winner = Object.keys(probabilities).reduce(/** Stable registry-order tie break for score levels. */ (best, label) => probabilities[label] > probabilities[best] ? label : best);
            const value = answer.type === "choice" ? answer.choice : Number(winner);
            proposals[name] = { kind: answer.type, value, probability: probabilities[String(value)] };
            distributions[name] = probabilities;
        }
    }
    return { proposals, distributions };
}
/** Measure local sensitivity with sequential calls, no retries and one shared deadline. */
export async function explainDecision(options, env = process.env) {
    const { evidence, fields, questions, limit } = snapshot(options);
    let client;
    try {
        client = createJevClient(options.endpoint, env, 0);
    }
    catch {
        throw new CounterfactualRefusal("endpoint_refused", "Decision endpoint configuration refused the explanation.", "Run pm jev doctor; use the local provider or explicitly opt in to the hosted provider with runtime credentials.");
    }
    const signal = AbortSignal.timeout(options.endpoint.config.totalDeadlineMs);
    const key = randomBytes(32);
    /** Keyed digests identify exact evidence within this receipt without exposing it. */
    const digest = (state) => createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
    const usage = new TokenUsageTotals();
    let attempted = 0, succeeded = 0;
    let baseline = null;
    let model = null;
    let stopped = null;
    const comparisons = [];
    const omitted = [];
    for (const field of [null, ...fields]) {
        if (signal.aborted)
            stopped = "deadline";
        if (attempted >= limit && stopped === null)
            stopped = "call_limit";
        if (stopped !== null) {
            if (field !== null)
                omitted.push({ field, reason: stopped });
            continue;
        }
        const state = { ...evidence };
        if (field !== null)
            delete state[field];
        attempted++;
        try {
            const result = await runDecision(client, options.endpoint.config, state, questions, signal);
            succeeded++;
            usage.add(result.usage);
            if (model !== null && model !== result.model)
                stopped = "model_changed";
            else {
                model = result.model;
                const current = outcomes(result, questions);
                if (field === null)
                    baseline = current;
                else {
                    const original = baseline;
                    const changed = Object.keys(questions).filter(/** Only typed outcome changes count; probability drift is reported separately. */ /** Only typed outcome changes count; probability drift is reported separately. */ name => original.proposals[name].value !== current.proposals[name].value);
                    const deltas = Object.keys(questions).flatMap(/** Inspect every label, including losers, rather than only the winning probability. */ /** Inspect every label, including losers, rather than only the winning probability. */ name => Object.keys(original.distributions[name]).map(/** Compare identical question labels across the two validated responses. */ /** Compare identical question labels across the two validated responses. */ label => Math.abs(original.distributions[name][label] - current.distributions[name][label])));
                    comparisons.push({ field, evidence_digest: digest(state), changed, proposals: current.proposals, max_probability_delta: Math.max(...deltas) });
                }
            }
        }
        catch {
            stopped = signal.aborted ? "deadline" : "provider_failure";
        }
        if (stopped !== null && field !== null)
            omitted.push({ field, reason: stopped });
    }
    return { version: COUNTERFACTUAL_VERSION, complete: baseline !== null && omitted.length === 0, model,
        questions_sha256: createHash("sha256").update(JSON.stringify(questions)).digest("hex"), evidence_digest: digest(evidence),
        baseline: baseline === null ? null : baseline.proposals, comparisons, omitted,
        calls: { attempted, succeeded, limit, retries: 0 },
        usage: { input_tokens: attempted === succeeded ? usage.inputTokens : null, output_tokens: attempted === succeeded ? usage.outputTokens : null, unknown_calls: usage.unknownCalls + attempted - succeeded },
        uncertainty: ["single_sample_per_state", "model_stochasticity_unmeasured", "field_interactions_unmeasured", "sensitivity_is_not_causation", "only_supplied_evidence_tested"] };
}
//# sourceMappingURL=counterfactual.js.map