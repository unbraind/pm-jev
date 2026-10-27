import { compareExact, subtractExact } from "./exact.js";
import { reportPriorReceipt, withReceipt } from "./partial-receipt.js";
import { createHash } from "node:crypto";
import { createJevClient, parseQuestionsDocument, runDecision, validateAnswers } from "./index.js";
/** Version of the frozen-input compatibility contract. */
export const REPLAY_VERSION = "pm-jev-replay/1";
/** Redacted, actionable replay failure; input and transport text are never echoed. */
export class ReplayRefusal extends Error {
    /** Stable category suitable for programmatic recovery. */
    code;
    /** Recovery guidance without source evidence or transport details. */
    remedy;
    /** Construct a stable refusal with a recovery instruction. */
    constructor(code, remedy) {
        super(`Decision replay refused: ${code}.`);
        this.name = "ReplayRefusal";
        this.code = code;
        this.remedy = remedy;
    }
}
/** Validate labels without allowing unbounded or path-shaped metadata in receipts. */
function label(value) {
    return typeof value === "string" && /^[a-zA-Z0-9_.:@+-]{1,128}$/.test(value);
}
/** Check versioned policies at both the recording and candidate boundaries. */
function checkPolicy(policy) {
    if (!policy || !label(policy.version) || !Number.isFinite(policy.min_probability) || compareExact(policy.min_probability, 0) < 0 || compareExact(policy.min_probability, 1) > 0) {
        throw new ReplayRefusal("invalid_policy", "Supply a policy version and min_probability between 0 and 1.");
    }
}
/** Parse and snapshot bounded JSON data; missing fields are allowed, malformed fields refuse. */
export function parseReplayRecording(raw) {
    try {
        const text = JSON.stringify(raw);
        if (Buffer.byteLength(text) > 4194304)
            throw new Error();
        const doc = JSON.parse(text);
        if (!doc || doc.version !== REPLAY_VERSION || !Array.isArray(doc.records) || doc.records.length > 1000)
            throw new Error();
        const ids = new Set();
        for (const row of doc.records) {
            if (!row || !label(row.id) || ids.has(row.id))
                throw new Error();
            ids.add(row.id);
            if (row.state !== undefined && (!row.state || typeof row.state !== "object" || Array.isArray(row.state) || Buffer.byteLength(JSON.stringify(row.state)) > 32768))
                throw new Error();
            if (Object.hasOwn(row, "result") && (!row.result || typeof row.result !== "object" || Array.isArray(row.result)))
                throw new Error();
            if (row.questions !== undefined) {
                const questions = parseQuestionsDocument(row.questions);
                if (Object.keys(questions).length > 8 || Object.keys(questions).some(/** Keep question detail labels bounded. */ /** Keep question detail labels bounded. */ name => !label(name)))
                    throw new Error();
                for (const question of Object.values(questions)) {
                    if (question.type === "choice" && (Object.keys(question.criteria).length > 32 || Object.keys(question.criteria).some(/** Bound option labels carried by typed proposals. */ /** Bound option labels carried by typed proposals. */ option => !label(option))))
                        throw new Error();
                    if (question.type === "score" && question.criteria.length > 32)
                        throw new Error();
                }
                if (row.result !== undefined)
                    validateAnswers(questions, row.result);
            }
            if (row.policy !== undefined)
                checkPolicy(row.policy);
        }
        return doc;
    }
    catch {
        throw new ReplayRefusal("invalid_recording", "Supply pm-jev-replay/1 JSON up to 4 MiB with at most 1000 distinct records, 32 KiB states and 1..8 typed questions (32 options maximum). Omit unavailable inputs to report gaps.");
    }
}
/** Reduce the existing validated typed answers to proposals using an explicit policy. */
function proposals(record, result, policy) {
    return Object.entries(record.questions).map(/** Compare the selected value; score uses the stable winning rubric level. */ ([name, question]) => {
        if (question.type === "noul") {
            const p = result.answers[name].noul;
            return compareExact(compareExact(p, 0.5) >= 0 ? p : subtractExact(1, p), policy.min_probability) >= 0 ? compareExact(p, 0.5) >= 0 : null;
        }
        const answer = result.answers[name];
        const distribution = answer.probabilities;
        const winner = Object.keys(distribution).reduce(/** Stable label-order ties match the existing explanation adapter. */ (best, key) => distribution[key] > distribution[best] ? key : best);
        const value = answer.type === "choice" ? answer.choice : Number(winner);
        return compareExact(distribution[String(value)], policy.min_probability) >= 0 ? value : null;
    });
}
/** Dispatch optional durable accounting without changing recorded-score replay. */
export async function replayDecisions(recording, policy, adapter, detailLimit = 20, receipt) {
    if (receipt !== undefined)
        return interruptedReplay(recording, policy, adapter, detailLimit, receipt);
    return replayRun(recording, policy, adapter, detailLimit);
}
/** Execute a replay with durable accounting when the caller selects private storage. */
async function interruptedReplay(recording, policy, adapter, detailLimit, receipt) {
    const previous = reportPriorReceipt(receipt.file);
    if (previous !== undefined)
        return previous;
    parseReplayRecording(recording);
    checkPolicy(policy);
    checkReplayOptions(detailLimit, adapter);
    return withReceipt("replay", receipt, /** Persist replay comparisons as records finish. */ /** Persist replay comparisons as records finish. */ run => replayRun(recording, policy, adapter, detailLimit, run));
}
/** Validate replay bounds before creating a private receipt or invoking an adapter. */
function checkReplayOptions(detailLimit, adapter) {
    if (!Number.isSafeInteger(detailLimit) || detailLimit < 0 || detailLimit > 100 || (adapter !== undefined && !label(adapter.version)))
        throw new ReplayRefusal("invalid_policy", "Use a detail limit from 0 to 100 and a bounded adapter version.");
}
/** Compare frozen decisions and checkpoint each completed record. */
async function replayRun(recording, policy, adapter, detailLimit, run) {
    const doc = parseReplayRecording(recording);
    const selected = { ...policy };
    checkPolicy(selected);
    checkReplayOptions(detailLimit, adapter);
    run?.identify(createHash("sha256").update(JSON.stringify({ doc, selected, adapter: adapter?.version })).digest("hex"), adapter?.version ?? "recorded");
    let attempted = 0, replayed = 0, gaps = 0, compared = 0, agreement = 0, disagreement = 0, oldAbstentions = 0, newAbstentions = 0, elapsed = 0;
    const details = [];
    for (const [index, row] of doc.records.entries()) {
        let gap = ["state", "questions", "result", "policy"].filter(/** Never fetch or infer missing historical inputs. */ /** Never fetch or infer missing historical inputs. */ field => !Object.hasOwn(row, field)).join(",");
        const changed = [];
        if (!gap) {
            const ready = row;
            attempted++;
            const started = performance.now();
            let next;
            try {
                next = adapter === undefined ? ready.result : run === undefined ? await adapter.decide(structuredClone(ready)) : await run.call(/** Validate trusted-adapter answers before marking the call complete. */ async (signal) => {
                    const result = await adapter.decide(structuredClone(ready), signal);
                    validateAnswers(ready.questions, result);
                    return result;
                });
                validateAnswers(ready.questions, next);
            }
            catch (error) {
                if (run !== undefined)
                    throw error;
                gap = "decision_failed";
            }
            elapsed += performance.now() - started;
            if (!gap) {
                const oldValues = proposals(ready, ready.result, ready.policy);
                const newValues = proposals(ready, next, selected);
                for (const [i, name] of Object.keys(ready.questions).entries()) {
                    compared++;
                    if (oldValues[i] === null)
                        oldAbstentions++;
                    if (newValues[i] === null)
                        newAbstentions++;
                    if (oldValues[i] === newValues[i])
                        agreement++;
                    else {
                        disagreement++;
                        changed.push(name);
                    }
                }
                replayed++;
            }
        }
        if (gap)
            gaps++;
        else
            run?.checkpoint(String(index), { attempted, replayed, compared, agreement, disagreement, old_abstentions: oldAbstentions, new_abstentions: newAbstentions });
        if (details.length < detailLimit)
            details.push(gap ? { index, gap } : { index, changed });
    }
    return { version: REPLAY_VERSION, recording_sha256: createHash("sha256").update(JSON.stringify(doc)).digest("hex"), policy: selected, adapter: adapter === undefined ? "recorded" : adapter.version, complete: gaps === 0,
        records: doc.records.length, attempted, replayed, gaps, compared, agreement, disagreement, old_abstentions: oldAbstentions, new_abstentions: newAbstentions,
        latency_ms: { total: elapsed, mean: attempted === 0 ? null : elapsed / attempted }, details, omitted_details: doc.records.length - details.length };
}
/** Bind only a loopback, non-cloud, installed Ollama decision model; ignore hosted settings/env. */
export async function createOllamaReplayAdapter(model, baseUrl = "http://127.0.0.1:11434", deadlineMs = 120000) {
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300000)
        throw new ReplayRefusal("invalid_policy", "Use --deadline-ms from 1 to 300000 (default 120000) for each local input.");
    let origin;
    try {
        const url = new URL(baseUrl);
        if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !label(model) || model.includes("cloud"))
            throw new Error();
        origin = url.origin;
    }
    catch {
        throw new ReplayRefusal("local_only", "Use an installed local decision model and an HTTP numeric loopback origin; hosted providers, cloud models, redirects and configured provider overrides are disabled for replay.");
    }
    const config = { provider: "ollama", baseUrl: origin, model, timeoutMs: deadlineMs, totalDeadlineMs: deadlineMs, minConfidence: 0.5, gateThreshold: 0.5 };
    try {
        const response = await fetch(`${origin}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(5000) });
        if (!response.ok)
            throw new Error();
        const inventory = await response.json();
        const card = inventory.models.find(/** Resolve the exact installed tag before sending any recorded state. */ /** Resolve the exact installed tag before sending any recorded state. */ entry => entry.name === model);
        if (!card || card.remote_host || card.remote_model || !card.capabilities.includes("decision") || !/^[a-f0-9]{64}$/.test(card.digest))
            throw new Error();
        const client = createJevClient({ config, hostedBlocked: null }, {}, 0);
        return { version: `ollama:${card.digest}`,
            /** Reuse the existing typed transport with zero retries and a per-input deadline. */
            async decide(record, signal) {
                const result = await runDecision(client, config, record.state, record.questions, signal === undefined ? undefined : AbortSignal.any([signal, AbortSignal.timeout(deadlineMs)]));
                if (result.model !== model)
                    throw new Error("Replay model changed");
                return result;
            } };
    }
    catch {
        throw new ReplayRefusal("model_unavailable", `Start local Ollama, run ollama pull ${model}, and verify that /api/tags advertises a local decision capability and digest; then retry.`);
    }
}
//# sourceMappingURL=policy-replay.js.map