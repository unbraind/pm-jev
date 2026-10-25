import { evidenceHash } from "./decision-calibration.js";
/** Versioned population diagnostic; no provider or tracker mutation is involved. */
export const DRIFT_VERSION = "pm-jev-drift/1";
/** Content-free refusal with an actionable remedy, safe for compact agent output. */
export class DriftRefusal extends Error {
    /** Stable routing code, independent of source text. */
    code;
    /** Safe recovery instructions that do not reflect input values. */
    remedy;
    /** Retain only typed diagnostics, never the rejected input. */
    constructor(code, remedy) {
        super(`Calibration drift check refused: ${code}`);
        this.name = "DriftRefusal";
        this.code = code;
        this.remedy = remedy;
    }
}
/** Require exact own fields so misspellings and accidental private payloads fail closed. */
function exact(value, keys) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(/** Inherited fields cannot satisfy the schema. */ /** Inherited fields cannot satisfy the schema. */ key => Object.hasOwn(value, key));
}
/** Bound categories without silently trimming or normalizing caller evidence. */
function category(value) { return typeof value === "string" && value.length > 0 && value.length <= 96 && value.trim() === value; }
/** One strict boundary schema for both SDK inputs and command JSON; return a detached validated snapshot. */
export function parseDriftInput(raw) {
    const data = raw;
    let valid = exact(data, ["version", "provenance", "thresholds", "calibration", "current"]);
    if (valid) {
        const input = data;
        const policy = input.thresholds;
        valid = input.version === DRIFT_VERSION && ["synthetic", "public", "local-unverified"].includes(input.provenance) && exact(policy, ["population_tv", "error_increase", "min_population", "min_labels"]);
        if (valid) {
            valid = [policy.population_tv, policy.error_increase].every(/** Positive cutoffs avoid flagging unchanged cohorts at zero. */ /** Positive cutoffs avoid flagging unchanged cohorts at zero. */ value => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1) &&
                [policy.min_population, policy.min_labels].every(/** Both populations require meaningful bounded denominators. */ /** Both populations require meaningful bounded denominators. */ value => Number.isSafeInteger(value) && value >= 2 && value <= 5000);
        }
        for (const cohort of [input.calibration, input.current]) {
            if (!exact(cohort, ["identity", "observations"])) {
                valid = false;
                break;
            }
            const identity = cohort.identity;
            if (!exact(identity, ["model_digest", "question_digest"]) || ![identity.model_digest, identity.question_digest].every(/** Bind SHA-256 identities, never mutable model tags. */ /** Bind SHA-256 identities, never mutable model tags. */ value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) {
                valid = false;
                break;
            }
            const rows = cohort.observations;
            if (!Array.isArray(rows) || rows.length > 5000 || Object.keys(rows).length !== rows.length) {
                valid = false;
                break;
            }
            const ids = new Set();
            for (const row of rows) {
                if (!exact(row, ["id", "task", "type", "input_bucket", "predicted", "label"]) || ![row.id, row.task, row.type, row.input_bucket, row.predicted].every(category) || !(row.label === null || category(row.label)) || ids.has(row.id)) {
                    valid = false;
                    break;
                }
                ids.add(row.id);
            }
        }
    }
    if (!valid)
        throw new DriftRefusal("invalid_input", "Use pm-jev-drift/1 with exact documented fields, dense cohorts of at most 5000 unique rows, SHA-256 identities, bounded categories, finite thresholds in (0,1], and integer minima in [2,5000].");
    const input = data;
    return { version: DRIFT_VERSION, provenance: input.provenance,
        thresholds: { population_tv: input.thresholds.population_tv, error_increase: input.thresholds.error_increase, min_population: input.thresholds.min_population, min_labels: input.thresholds.min_labels },
        calibration: canonicalCohort(input.calibration), current: canonicalCohort(input.current) };
}
/** Canonical field and row order makes evidence hashes independent of JSON layout. */
function canonicalCohort(cohort) {
    return { identity: { model_digest: cohort.identity.model_digest, question_digest: cohort.identity.question_digest },
        observations: [...cohort.observations].sort(/** Stable ids define evidence enumeration. */ (a, b) => a.id < b.id ? -1 : 1)
            .map(/** Copy only the validated minimized contract fields. */ /** Copy only the validated minimized contract fields. */ row => ({ id: row.id, task: row.task, type: row.type, input_bucket: row.input_bucket, predicted: row.predicted, label: row.label })) };
}
/** Total variation on a predeclared category union: zero is identical, one is disjoint. */
function totalVariation(a, b, key) {
    if (a.length === 0 || b.length === 0)
        return null;
    const counts = new Map();
    for (const [index, rows] of [a, b].entries()) {
        for (const row of rows) {
            const pair = counts.get(row[key]) ?? [0, 0];
            pair[index]++;
            counts.set(row[key], pair);
        }
    }
    return Math.min(1, [...counts.values()].reduce(/** Integer category counts preserve exact zero for an unchanged cohort. */ (sum, pair) => sum + Math.abs(pair[0] / a.length - pair[1] / b.length), 0) / 2);
}
/** Observe only explicit labels; predictions and status names never supply ground truth. */
function labelMetrics(rows) {
    const labelled = rows.filter(/** A missing judgement cannot count as correct. */ /** A missing judgement cannot count as correct. */ row => row.label !== null);
    return { count: labelled.length, coverage: rows.length === 0 ? 0 : labelled.length / rows.length,
        error: labelled.length === 0 ? null : labelled.filter(/** Compare caller's explicit outcome with its recorded prediction. */ /** Compare caller's explicit outcome with its recorded prediction. */ row => row.label !== row.predicted).length / labelled.length };
}
/** Assert all emitted numbers have documented finite domains before exposing an ok result. */
export function validateDriftReportNumbers(report) {
    const { population: p, labels: l } = report;
    const counts = [p.calibration_count, p.current_count, l.calibration_count, l.current_count];
    const rates = [p.task_tv, p.type_tv, p.input_tv, l.calibration_coverage, l.current_coverage, l.calibration_error, l.current_error];
    if (!counts.every(/** Counts cannot exceed the schema's cohort bound. */ /** Counts cannot exceed the schema's cohort bound. */ value => Number.isSafeInteger(value) && value >= 0 && value <= 5000) || !rates.every(/** Null explicitly denotes unavailable evidence. */ /** Null explicitly denotes unavailable evidence. */ value => value === null || Number.isFinite(value) && value >= 0 && value <= 1) || !(l.error_increase === null || Number.isFinite(l.error_increase) && l.error_increase >= -1 && l.error_increase <= 1)) {
        throw new DriftRefusal("invalid_output", "Do not adopt this diagnostic; report a numeric invariant failure and retain the frozen evidence for inspection.");
    }
    return report;
}
/** Compare frozen operating populations and later labels with zero inference, I/O or mutation. */
export function checkCalibrationDrift(raw) {
    const data = parseDriftInput(raw);
    const { calibration: a, current: b, thresholds: t } = data;
    if (a.identity.model_digest !== b.identity.model_digest || a.identity.question_digest !== b.identity.question_digest)
        throw new DriftRefusal("identity_mismatch", "Collect a separate calibration cohort for the exact current model and question digest; do not transfer thresholds across identities.");
    const task = totalVariation(a.observations, b.observations, "task");
    const type = totalVariation(a.observations, b.observations, "type");
    const input = totalVariation(a.observations, b.observations, "input_bucket");
    const populationStatus = Math.min(a.observations.length, b.observations.length) < t.min_population ? "insufficient_evidence" : [task, type, input].some(/** Thresholds are inclusive and frozen in the input. */ /** Thresholds are inclusive and frozen in the input. */ value => value >= t.population_tv) ? "drift" : "stable";
    const ca = labelMetrics(a.observations), cb = labelMetrics(b.observations);
    const increase = ca.error === null || cb.error === null ? null : cb.error - ca.error;
    const labelStatus = Math.min(ca.count, cb.count) < t.min_labels ? "insufficient_evidence" : increase >= t.error_increase ? "drift" : "stable";
    const status = populationStatus === "drift" || labelStatus === "drift" ? "drift" : populationStatus === "insufficient_evidence" || labelStatus === "insufficient_evidence" ? "insufficient_evidence" : "stable";
    return validateDriftReportNumbers({ ok: true, version: DRIFT_VERSION, provenance: data.provenance, identity: a.identity, evidence_sha256: evidenceHash(data), calibration_sha256: evidenceHash(a), thresholds: t, status,
        population: { status: populationStatus, calibration_count: a.observations.length, current_count: b.observations.length, task_tv: task, type_tv: type, input_tv: input },
        labels: { status: labelStatus, calibration_count: ca.count, current_count: cb.count, calibration_coverage: ca.coverage, current_coverage: cb.coverage, calibration_error: ca.error, current_error: cb.error, error_increase: increase },
        recommendation: status === "drift" ? "abstain_and_recalibrate" : status === "insufficient_evidence" ? "abstain_pending_evidence" : "retain_policy_and_monitor", inference_calls: 0, mutation_authority: "none" });
}
//# sourceMappingURL=calibration-drift.js.map