/** Portable, read-only human labeling queue document version. */
export const LABEL_QUEUE_VERSION = "pm-jev-label-queue/1";
/** Limits bound traversal, agent output, and exact integer cost arithmetic. */
export const LABEL_QUEUE_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, cases: 5000, cohorts: 32, sources: 128, queue: 100, units: 1_000_000, ratio: 1_000_000_000 });
/** Boundary failures always include a concrete remedy and never repeat supplied values. */
export class LabelQueueRefusal extends Error {
    /** Stable machine-readable reason independent of the rejected source content. */
    code;
    /** Concrete next step suitable for compact agent output. */
    remedy;
    /** Preserve a content-free error contract for SDK consumers and native CLI rendering. */
    constructor(code, remedy) {
        super(`Label acquisition refused: ${code}.`);
        this.name = "LabelQueueRefusal";
        this.code = code;
        this.remedy = remedy;
    }
}
/** One schema assertion shared by SDK input, portable producers and CLI documents. */
function requireInput(condition) {
    if (!condition)
        throw new LabelQueueRefusal("invalid_input", "Use pm-jev-label-queue/1 with only documented fields, dense bounded arrays, exact ratios in [0,1], integer costs and explicit label provenance. See examples/label-queue.json.");
}
/** Reject non-plain records, inherited requirements and unknown fields before cloning. */
function record(value, keys) {
    requireInput(value !== null && typeof value === "object" && !Array.isArray(value));
    requireInput(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    requireInput(Reflect.ownKeys(value).length === keys.length && keys.every(/** No prototype field can fulfill the contract. */ /** No prototype field can fulfill the contract. */ key => Object.hasOwn(value, key)));
    for (const key of keys)
        requireInput(Object.getOwnPropertyDescriptor(value, key)?.get === undefined);
    return value;
}
/** Snapshot validated own elements so inherited iteration cannot hide conflicts or cohort declarations. */
function dense(value, maximum) {
    requireInput(Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1);
    const snapshot = [];
    for (let i = 0; i < value.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        requireInput(descriptor !== undefined && descriptor.get === undefined);
        snapshot.push(descriptor.value);
    }
    return snapshot;
}
/** Exact identities retain whitespace and Unicode from previously emitted valid documents. */
function text(value) {
    requireInput(typeof value === "string" && value.length > 0 && value.length <= 96 && value.trim().length > 0);
    return value;
}
/** Labeling costs and bounds use safe integer arithmetic exclusively. */
function integer(value, minimum, maximum) {
    requireInput(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum);
    return value === 0 ? 0 : value;
}
/** Validate a declared count ratio without rounding or silently repairing its denominator. */
function ratio(value) {
    const row = record(value, ["numerator", "denominator"]);
    const denominator = integer(row.denominator, 1, LABEL_QUEUE_LIMITS.ratio);
    return { numerator: integer(row.numerator, 0, denominator), denominator };
}
/** Labels require explicit origin; an inferred value cannot fulfill the human label branch. */
function provenance(value) {
    requireInput(value !== null && typeof value === "object");
    if (Object.getOwnPropertyDescriptor(value, "kind")?.value === "none") {
        record(value, ["kind"]);
        return { kind: "none" };
    }
    const row = record(value, ["kind", "value", "actor", "evidence"]);
    requireInput(row.kind === "human" || row.kind === "inferred");
    return { kind: row.kind, value: text(row.value), actor: text(row.actor), evidence: text(row.evidence) };
}
/** Stable ordinal comparison avoids locale, input enumeration and platform dependencies. */
export function labelOrdinal(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
/** Stable composite identity excludes revision so duplicate revisions cannot buy extra queue slots. */
export function labelCaseKey(row) { return JSON.stringify([row.source, row.id, row.task]); }
/** Read only bounded own data identities, even when the remaining payload is malformed. */
function caseIdentity(value) {
    try {
        requireInput(value !== null && (typeof value === "object" || typeof value === "function"));
        return { source: text(Object.getOwnPropertyDescriptor(value, "source")?.value),
            id: text(Object.getOwnPropertyDescriptor(value, "id")?.value), task: text(Object.getOwnPropertyDescriptor(value, "task")?.value) };
    }
    catch {
        return null;
    }
}
/** Parse once and construct a detached canonical snapshot through the sole strict boundary schema. */
export function parseLabelQueueInput(raw) {
    const doc = record(raw, ["version", "policy", "cohorts", "cases"]);
    requireInput(doc.version === LABEL_QUEUE_VERSION);
    const p = record(doc.policy, ["cohort", "seed", "budget", "limit", "uncertainty", "min_uncertainty", "diversity", "max_per_bucket"]);
    requireInput(p.uncertainty === "declared_ratio_desc" && (p.diversity === "cap" || p.diversity === "balanced"));
    const policy = { cohort: text(p.cohort), seed: text(p.seed), budget: integer(p.budget, 0, LABEL_QUEUE_LIMITS.units), limit: integer(p.limit, 0, LABEL_QUEUE_LIMITS.queue),
        uncertainty: p.uncertainty, min_uncertainty: ratio(p.min_uncertainty), diversity: p.diversity, max_per_bucket: integer(p.max_per_bucket, 1, LABEL_QUEUE_LIMITS.queue) };
    const sourceCohorts = new Map();
    const ids = new Set();
    const cohorts = dense(doc.cohorts, LABEL_QUEUE_LIMITS.cohorts).map(/** Cohort membership is declared before inspecting any candidate labels. */ (value) => {
        const row = record(value, ["id", "role", "sources"]);
        const id = text(row.id);
        requireInput(!ids.has(id) && (row.role === "acquisition" || row.role === "held_out"));
        ids.add(id);
        const sources = dense(row.sources, LABEL_QUEUE_LIMITS.sources).map(text);
        requireInput(sources.length > 0);
        for (const source of sources) {
            if (sourceCohorts.has(source))
                throw new LabelQueueRefusal("cohort_conflict", "Declare each source in exactly one cohort; keep held-out sources separate from acquisition sources, including aliases managed by the caller.");
            sourceCohorts.set(source, id);
        }
        return { id, role: row.role, sources: sources.sort(labelOrdinal) };
    }).sort(/** Canonical cohorts do not depend on object enumeration. */ (a, b) => labelOrdinal(a.id, b.id));
    requireInput(cohorts.some(/** A held-out cohort can never be the acquisition target. */ /** A held-out cohort can never be the acquisition target. */ row => row.id === policy.cohort && row.role === "acquisition"));
    const rejected = [];
    const rows = dense(doc.cases, LABEL_QUEUE_LIMITS.cases);
    const keys = new Map();
    const identified = rows.map(/** Multiplicity precedes payload validity, cohort eligibility and human-label filtering. */ /** Multiplicity precedes payload validity, cohort eligibility and human-label filtering. */ value => {
        const identity = caseIdentity(value);
        const key = identity === null ? null : labelCaseKey(identity);
        if (key !== null)
            keys.set(key, (keys.get(key) ?? 0) + 1);
        return { value, identity, key };
    });
    const cases = [];
    for (const [index, { value, identity, key }] of identified.entries()) {
        if (key !== null && keys.get(key) > 1) {
            rejected.push({ index, code: "duplicate_case" });
            continue;
        }
        try {
            requireInput(identity !== null);
            const row = record(value, ["id", "source", "revision", "cohort", "task", "bucket", "state", "uncertainty", "cost", "label"]);
            const cohort = text(row.cohort);
            requireInput(sourceCohorts.get(identity.source) === cohort && (row.state === "unlabeled" || row.state === "abstained" || row.state === "decided"));
            cases.push({ id: identity.id, source: identity.source, revision: text(row.revision), cohort, task: identity.task, bucket: text(row.bucket), state: row.state,
                uncertainty: ratio(row.uncertainty), cost: integer(row.cost, 1, LABEL_QUEUE_LIMITS.units), label: provenance(row.label) });
        }
        catch {
            rejected.push({ index, code: "invalid_case" });
        }
    }
    cases.sort(/** Canonical cases keep content digests stable across layout and row order. */ (a, b) => labelOrdinal(labelCaseKey(a), labelCaseKey(b)));
    const input = { version: LABEL_QUEUE_VERSION, policy, cohorts, cases };
    requireInput(Buffer.byteLength(JSON.stringify(input)) <= LABEL_QUEUE_LIMITS.bytes);
    return { input, rejected: rejected.sort(/** Row diagnostics use original dense input positions. */ (a, b) => a.index - b.index), candidates: rows.length };
}
//# sourceMappingURL=label-schema.js.map