import { createHash } from "node:crypto";
import { getSettingsPath, readFileIfExists } from "@unbrained/pm-cli/sdk";
/** Versioned contract shared by evaluation, persisted calibration and live decisions. */
export const EVALUATION_VERSION = "pm-jev-eval/1";
/** Canonical SHA-256 for ordered JSON evidence, never an absolute path. */
export function evidenceHash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
/**
 * Stable settings key of one calibrated channel identity.
 *
 * The exemplar setting is part of the calibrated channel identity: an
 * exemplar-augmented fit never silently authorizes exemplar-free decisions,
 * and legacy receipts keep their historical task/model key.
 *
 * @param task - Ground-truth decision task of the channel.
 * @param model - Exact decision model tag.
 * @param exemplars - Exemplar retrieval setting, or undefined without exemplars.
 * @returns The settings key under which this channel's receipt is stored.
 */
export function calibrationKey(task, model, exemplars) {
    return exemplars === undefined ? evidenceHash([task, model])
        : evidenceHash([task, model, "exemplars", exemplars.retrieval, exemplars.count, exemplars.token_budget, exemplars.embedding_model ?? null]);
}
/** Validate the persisted shape of an exemplar setting without trusting it. */
export function validExemplarSetting(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const setting = value;
    return (setting.retrieval === "lexical" || setting.retrieval === "embedding") &&
        Number.isInteger(setting.count) && setting.count >= 1 && setting.count <= 8 &&
        Number.isInteger(setting.token_budget) && setting.token_budget >= 1 && setting.token_budget <= 65536 &&
        (setting.retrieval === "lexical" ? setting.embedding_model === undefined : typeof setting.embedding_model === "string" && setting.embedding_model !== "");
}
/** Fingerprint fixed decision semantics while treating duplicate candidate identities as exchangeable evidence. */
export function questionFingerprint(channel, question) {
    const q = question;
    if (channel === "duplicate_of")
        return evidenceHash({ type: q.type, instructions: q.instructions, candidate_count: Object.keys(q.criteria).length, none: q.criteria.none });
    const encoded = JSON.stringify(question);
    return evidenceHash(JSON.parse(channel.startsWith("candidate_") ? encoded.replaceAll(/candidate_\d+/g, "candidate_0") : encoded));
}
/** Stable probability ranking; ties preserve key enumeration order (integer-like keys ascend numerically). */
export function ranked(probabilities) {
    return Object.entries(probabilities).sort(/** Preserve key enumeration order on equal probabilities. */ ([, a], [, b]) => b - a);
}
/** Temperature scaling on log probabilities; zero mass remains zero. */
export function scaleProbabilities(probabilities, temperature) {
    const entries = Object.entries(probabilities);
    const max = Math.log(ranked(probabilities)[0][1]);
    const weights = entries.map(/** Subtract the maximum logit for numerical stability. */ ([label, p]) => [label, Math.exp((Math.log(p) - max) / temperature)]);
    const sum = weights.reduce(/** Normalize the transformed categorical distribution. */ (total, [, weight]) => total + weight, 0);
    return Object.fromEntries(weights.map(/** Return the original schema labels in order. */ ([label, weight]) => [label, weight / sum]));
}
/** One-sided 95% Wilson lower bound; empty evidence cannot qualify. */
export function precisionLower(correct, count) {
    if (count === 0)
        return 0;
    const z = 1.6448536269514722;
    const p = correct / count;
    return Math.max(0, (p + z * z / (2 * count) - z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count))) / (1 + z * z / count));
}
/** Threshold coverage and precision, including a conservative uncertainty bound. */
export function atThreshold(rows, threshold) {
    const accepted = rows.filter(/** Include equality at the authorization boundary. */ /** Include equality at the authorization boundary. */ row => ranked(row.probabilities)[0][1] >= threshold);
    const correct = accepted.filter(/** Score the probability winner, never the model choice string. */ /** Score the probability winner, never the model choice string. */ row => ranked(row.probabilities)[0][0] === row.label).length;
    return { threshold, count: accepted.length, coverage: rows.length === 0 ? 0 : accepted.length / rows.length,
        precision: accepted.length === 0 ? null : correct / accepted.length, precision_lower_95: precisionLower(correct, accepted.length) };
}
/** Compute categorical accuracy, per-class metrics, ten-bin ECE, NLL and threshold curves. */
export function reliability(rows) {
    const predictions = rows.map(/** Derive confidence and correctness from the full validated distribution. */ /** Derive confidence and correctness from the full validated distribution. */ row => ({ row, top: ranked(row.probabilities)[0] }));
    const correct = predictions.filter(/** Count exact class matches. */ /** Count exact class matches. */ p => p.top[0] === p.row.label).length;
    const labels = [...new Set(rows.flatMap(/** Include unsupported predicted classes in the report. */ /** Include unsupported predicted classes in the report. */ row => Object.keys(row.probabilities)))].sort();
    const bins = Array.from({ length: 10 }, /** Use half-open bins except the final bin includes one. */ (_, index) => {
        const members = predictions.filter(/** Put exactly-one confidence in bin nine. */ /** Put exactly-one confidence in bin nine. */ p => Math.min(9, Math.floor(p.top[1] * 10)) === index);
        return { lower: index / 10, upper: (index + 1) / 10, count: members.length,
            confidence: members.length === 0 ? null : members.reduce(/** Sum model confidence. */ (sum, p) => sum + p.top[1], 0) / members.length,
            accuracy: members.length === 0 ? null : members.filter(/** Count correct predictions in this bin. */ /** Count correct predictions in this bin. */ p => p.top[0] === p.row.label).length / members.length };
    });
    return { count: rows.length, accuracy: rows.length === 0 ? null : correct / rows.length,
        ece: rows.length === 0 ? null : bins.reduce(/** Weight absolute reliability gaps by population. */ (sum, bin) => sum + bin.count * Math.abs((bin.confidence ?? 0) - (bin.accuracy ?? 0)), 0) / rows.length,
        nll: rows.length === 0 ? null : rows.reduce(/** Clip zero only for a finite log-loss diagnostic. */ (sum, row) => sum - Math.log(Math.max(1e-15, row.probabilities[row.label] ?? 0)), 0) / rows.length,
        bins, classes: labels.map(/** Report null precision/recall when the denominator has no evidence. */ /** Report null precision/recall when the denominator has no evidence. */ label => {
            const support = rows.filter(/** Count ground truth class membership. */ /** Count ground truth class membership. */ row => row.label === label).length;
            const predicted = predictions.filter(/** Count predicted class membership. */ /** Count predicted class membership. */ p => p.top[0] === label);
            const tp = predicted.filter(/** Count true positives for this class. */ /** Count true positives for this class. */ p => p.row.label === label).length;
            return { label, support, precision: predicted.length === 0 ? null : tp / predicted.length, recall: support === 0 ? null : tp / support };
        }), thresholds: Array.from({ length: 11 }, /** Report coverage at fixed decile boundaries, including the legacy 0.8. */ (_, index) => atThreshold(rows, index / 10)) };
}
/** Fit one parameter on calibration labels only using a fixed log-spaced NLL grid. */
export function fitTemperature(rows) {
    let best = 1;
    let loss = Infinity;
    for (let index = 0; index <= 200; index++) {
        const candidate = Math.exp(Math.log(20) * (index - 100) / 100);
        const nll = rows.reduce(/** Evaluate only the calibration split. */ (sum, row) => sum - Math.log(Math.max(1e-15, scaleProbabilities(row.probabilities, candidate)[row.label] ?? 0)), 0);
        if (nll < loss) {
            loss = nll;
            best = candidate;
        }
    }
    return best;
}
/** Apply a fitted temperature without changing labels or provenance. */
export function scaledRows(rows, temperature) {
    return rows.map(/** Preserve immutable evidence while replacing the probability view. */ /** Preserve immutable evidence while replacing the probability view. */ row => ({ ...row, probabilities: scaleProbabilities(row.probabilities, temperature) }));
}
/** Deterministic repository partition independent of item labels and model outcomes. */
export function repositorySplit(repositories, seed) {
    const ordered = [...new Set(repositories)].sort(/** Hash the seed with public repository identity only. */ (a, b) => evidenceHash([seed, a]).localeCompare(evidenceHash([seed, b])));
    const cut = Math.ceil(ordered.length / 2);
    return { calibration: ordered.slice(0, cut).sort(), validation: ordered.slice(cut).sort() };
}
/** Fit channels and freeze candidate thresholds before inspecting validation outcomes. */
export function calibrateObservations(task, model, digest, rows, seed, target, exemplars) {
    const split = repositorySplit(rows.map(/** Partition all channels from a repository together. */ /** Partition all channels from a repository together. */ row => row.repository), seed);
    const channels = {};
    for (const channel of [...new Set(rows.map(/** Fit type and priority separately. */ /** Fit type and priority separately. */ row => row.channel))].sort()) {
        const cal = rows.filter(/** Keep validation labels out of fitting and threshold selection. */ /** Keep validation labels out of fitting and threshold selection. */ row => row.channel === channel && split.calibration.includes(row.repository));
        const val = rows.filter(/** Validate only on unseen repositories. */ /** Validate only on unseen repositories. */ row => row.channel === channel && split.validation.includes(row.repository));
        const temperature = fitTemperature(cal);
        const calibrated = scaledRows(cal, temperature);
        const validation = scaledRows(val, temperature);
        const actionableCal = calibrated.filter(/** Abstention predictions cannot establish proposal precision. */ /** Abstention predictions cannot establish proposal precision. */ row => ranked(row.probabilities)[0][0] !== "none");
        const actionableVal = validation.filter(/** Validate actual proposals separately from confident no-op decisions. */ /** Validate actual proposals separately from confident no-op decisions. */ row => ranked(row.probabilities)[0][0] !== "none");
        const thresholds = [...new Set(actionableCal.map(/** Candidate thresholds originate exclusively in calibration predictions. */ /** Candidate thresholds originate exclusively in calibration predictions. */ row => ranked(row.probabilities)[0][1]))].sort(/** Prefer the highest coverage that meets the bound. */ (a, b) => a - b);
        const candidate = thresholds.find(/** Require uncertainty-aware precision before validation. */ /** Require uncertainty-aware precision before validation. */ threshold => atThreshold(actionableCal, threshold).precision_lower_95 >= target);
        const checked = candidate === undefined ? null : atThreshold(actionableVal, candidate);
        const qualified = checked !== null && checked.precision_lower_95 >= target;
        channels[channel] = { temperature, threshold: qualified ? candidate : null,
            reason: candidate === undefined ? "insufficient_calibration_precision_evidence" : qualified ? "qualified_on_held_out_repositories" : "held_out_precision_not_met",
            question_sha256: [...new Set(cal.map(/** Restrict reuse to question schemas observed during fitting. */ /** Restrict reuse to question schemas observed during fitting. */ row => row.question_sha256))].sort(),
            calibration: { raw: reliability(cal), calibrated: reliability(calibrated) }, validation: { raw: reliability(val), calibrated: reliability(validation) }, validation_at_threshold: checked };
    }
    const data = [...new Map(rows.map(/** Collapse provenance once per repository snapshot. */ /** Collapse provenance once per repository snapshot. */ row => [row.repository, { repository: row.repository, commit: row.commit, data_sha256: row.data_sha256 }])).values()].sort(/** Keep receipt encoding independent of read order. */ (a, b) => a.repository.localeCompare(b.repository));
    return { version: EVALUATION_VERSION, method: "temperature_scaling_nll_grid", task, model, model_digest: digest, target_precision: target, seed,
        ...(exemplars === undefined ? {} : { exemplars }),
        calibration_repositories: split.calibration, validation_repositories: split.validation, data, observations_sha256: evidenceHash(rows), channels };
}
/** Read package-private settings through the SDK; normalized host settings intentionally omit them. */
export async function readOpaqueJevSettings(pmRoot) {
    const raw = await readFileIfExists(getSettingsPath(pmRoot));
    let settings;
    try {
        settings = JSON.parse(raw ?? "{}");
    }
    catch {
        return {};
    }
    if (typeof settings !== "object" || settings === null)
        return {};
    const section = settings.jev;
    return typeof section === "object" && section !== null ? section : {};
}
/** Read and validate the task/model calibration without exposing other project settings. */
export async function readCalibration(pmRoot, task, model, exemplars) {
    const section = await readOpaqueJevSettings(pmRoot);
    const record = section.calibrations?.[calibrationKey(task, model, exemplars)];
    if (record?.version !== EVALUATION_VERSION || record.task !== task || record.model !== model)
        return undefined;
    // The exemplar setting is channel identity: a receipt fitted under one setting never applies to another.
    if ((exemplars === undefined) !== (record.exemplars === undefined))
        return undefined;
    if (record.exemplars !== undefined && !validExemplarSetting(record.exemplars))
        throw new Error("Saved calibration is invalid; rerun jev calibrate");
    if (calibrationKey(task, model, record.exemplars) !== calibrationKey(task, model, exemplars))
        return undefined;
    if (typeof record.channels !== "object" || record.channels === null || !/^[a-f0-9]{64}$/.test(record.model_digest) ||
        Object.values(record.channels).some(/** Malformed persisted arithmetic must never authorize writes. */ /** Malformed persisted arithmetic must never authorize writes. */ fit => !fit || !Number.isFinite(fit.temperature) || fit.temperature < 0.05 || fit.temperature > 20 ||
            (fit.threshold !== null && (!Number.isFinite(fit.threshold) || fit.threshold < 0 || fit.threshold > 1)) ||
            !Array.isArray(fit.question_sha256) || !fit.question_sha256.every(/** Require stable schema fingerprints. */ /** Require stable schema fingerprints. */ hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash))))
        throw new Error("Saved calibration is invalid; rerun jev calibrate");
    return record;
}
/** Read the immutable local model identity with no prompts or hosted credentials. */
export async function modelDigest(baseUrl, model, timeoutMs) {
    const response = await fetch(`${baseUrl}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok)
        throw new Error("Cannot verify local model digest");
    const payload = await response.json();
    const digest = payload.models.find(/** Match an exact installed model tag. */ /** Match an exact installed model tag. */ entry => entry.name === model)?.digest;
    if (!digest || !/^[a-f0-9]{64}$/.test(digest))
        throw new Error("Local model digest missing or invalid");
    return digest;
}
/** Activate a saved record only for the exact local digest; aliases and replacements do not silently reuse it. */
export async function activeCalibration(pmRoot, task, config, exemplars) {
    const record = await readCalibration(pmRoot, task, config.model, exemplars);
    if (record === undefined || config.provider !== "ollama")
        return undefined;
    if (await modelDigest(config.baseUrl, config.model, config.timeoutMs) !== record.model_digest)
        return undefined;
    return { record, receipt_sha256: evidenceHash(record) };
}
/** Apply a compatible channel and keep an unqualified threshold closed. */
export function calibratedAnswer(active, channel, questions, probabilities, fallback, minimum = 0) {
    const fit = active?.record.channels[channel.startsWith("candidate_") ? "candidate_0" : channel];
    if (fit === undefined || !fit.question_sha256.includes(questionFingerprint(channel, questions)))
        return { probabilities, threshold: fallback, calibration: null };
    const threshold = fit.threshold === null ? null : Math.max(fit.threshold, minimum);
    return { probabilities: scaleProbabilities(probabilities, fit.temperature), threshold: threshold ?? Infinity,
        calibration: { receipt_sha256: active.receipt_sha256, temperature: fit.temperature, threshold, fitted_threshold: fit.threshold, qualified: fit.threshold !== null, reason: fit.reason } };
}
//# sourceMappingURL=decision-calibration.js.map