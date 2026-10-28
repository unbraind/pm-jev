import { parseQuestionsDocument, validateAnswers } from "./index.js";
/** Portable joint constraint document version. */
export const JOINT_VERSION = "pm-jev-joint/1";
/** Hard input and output bounds keep agent receipts predictable. */
export const JOINT_LIMITS = Object.freeze({ bytes: 262144, questions: 32, constraints: 32, options: 32 });
/** Typed invalid-input and unavailable-host failures with actionable remedies. */
export class JointRefusal extends Error {
    /** Stable machine-readable reason independent of source content. */
    code;
    /** Concrete next step that never repeats tracker or proposal data. */
    remedy;
    /** Preserve a stable machine code without leaking input or host error contents. */
    constructor(code, remedy) {
        super(`Joint decision validation refused: ${code}.`);
        this.name = "JointRefusal";
        this.code = code;
        this.remedy = remedy;
    }
}
/** Assert one clause of the single strict document schema. */
function requireInput(condition) {
    if (!condition)
        throw new JointRefusal("invalid_input", "Use pm-jev-joint/1 with 1..32 typed questions, raw validated answers, and 1..32 unique constraints. See examples/joint-decisions.json; use dense JSON arrays, finite numbers and only documented fields.");
}
/** Reject non-JSON values before serialization can erase holes, infinities or extra array keys. */
function jsonValue(value, depth = 0, budget = { remaining: JOINT_LIMITS.bytes }) {
    // Bound traversal before stringify/clone, including shared-reference DAGs supplied by SDK callers.
    budget.remaining -= typeof value === "string" ? value.length : 1;
    requireInput(depth <= 12 && budget.remaining >= 0);
    if (value === null || typeof value === "boolean")
        return;
    if (typeof value === "number") {
        requireInput(Number.isFinite(value));
        return;
    }
    if (typeof value === "string") {
        requireInput(value.length <= 8192);
        return;
    }
    requireInput(typeof value === "object" && value !== null);
    if (Array.isArray(value)) {
        requireInput(value.length <= 256 && Object.keys(value).length === value.length);
        for (let i = 0; i < value.length; i++) {
            requireInput(Object.hasOwn(value, i));
            jsonValue(value[i], depth + 1, budget);
        }
    }
    else {
        requireInput(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
        const entries = Object.entries(value);
        requireInput(entries.length <= 256);
        for (const [key, entry] of entries) {
            budget.remaining -= key.length;
            requireInput(key.length <= 128 && budget.remaining >= 0);
            if (entry !== undefined)
                jsonValue(entry, depth + 1, budget);
        }
    }
}
/** Require an own-field record with exactly the permitted schema keys. */
function record(value, required, optional = []) {
    requireInput(typeof value === "object" && value !== null && !Array.isArray(value));
    requireInput(required.every(/** Mandatory fields cannot come from prototypes. */ /** Mandatory fields cannot come from prototypes. */ key => Object.hasOwn(value, key))
        && Object.keys(value).every(/** Unknown fields are never silently discarded. */ /** Unknown fields are never silently discarded. */ key => required.includes(key) || optional.includes(key)));
    return value;
}
/** Names are exact caller identities; no answer or label is trimmed or rewritten. */
function name(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim().length > 0;
}
/** Validate predicates against the same normalized question catalog used by inference. */
function predicate(value, questions) {
    const p = record(value, ["question", "value"], ["threshold"]);
    requireInput(name(p.question) && Object.hasOwn(questions, p.question));
    const q = questions[p.question];
    if (q.type === "choice")
        requireInput(typeof p.value === "string" && Object.hasOwn(q.criteria, p.value) && !Object.hasOwn(p, "threshold"));
    else if (q.type === "score")
        requireInput(typeof p.value === "number" && p.value >= 0 && p.value <= q.criteria.length - 1 && !Object.hasOwn(p, "threshold"));
    else
        requireInput(typeof p.value === "boolean" && typeof p.threshold === "number" && p.threshold >= 0 && p.threshold <= 1);
    return p;
}
/** Parse once at the SDK/CLI boundary; share producer normalization and validate every raw answer. */
export function parseJointInput(raw) {
    jsonValue(raw);
    requireInput(Buffer.byteLength(JSON.stringify(raw)) <= JOINT_LIMITS.bytes);
    // Detach caller-owned values before asynchronous SDK reads, without changing answer values.
    const doc = record(structuredClone(raw), ["version", "questions", "result", "constraints"]);
    requireInput(doc.version === JOINT_VERSION);
    requireInput(typeof doc.questions === "object" && doc.questions !== null && !Array.isArray(doc.questions));
    const entries = Object.entries(doc.questions);
    requireInput(entries.length >= 1 && entries.length <= JOINT_LIMITS.questions);
    for (const [key, value] of entries) {
        requireInput(name(key));
        const q = record(value, ["type"], ["criteria", "instructions"]);
        requireInput(q.type === "choice" || q.type === "score" || q.type === "noul");
        if (q.type === "choice" || q.type === "score") {
            requireInput(q.criteria !== null && typeof q.criteria === "object" && (q.type === "score" ? Array.isArray(q.criteria) : !Array.isArray(q.criteria)));
            const labels = Object.keys(q.criteria);
            requireInput(labels.length <= JOINT_LIMITS.options && labels.every(name));
        }
        else if (q.criteria !== undefined)
            record(q.criteria, [], ["true", "false"]);
    }
    let questions;
    try {
        questions = parseQuestionsDocument(doc.questions);
    }
    catch {
        requireInput(false);
    }
    const result = record(doc.result, ["model", "answers", "usage"]);
    record(result.usage, ["input_tokens", "output_tokens"]);
    requireInput(typeof result.answers === "object" && result.answers !== null && !Array.isArray(result.answers));
    for (const value of Object.values(result.answers)) {
        const answer = value;
        const fields = answer?.type === "choice" ? ["type", "choice", "probabilities", "confidence"] : answer?.type === "score" ? ["type", "score", "probabilities", "confidence", "legend"] : ["type", "noul"];
        record(value, fields);
    }
    try {
        validateAnswers(questions, result);
    }
    catch {
        requireInput(false);
    }
    requireInput(Array.isArray(doc.constraints) && doc.constraints.length >= 1 && doc.constraints.length <= JOINT_LIMITS.constraints);
    const ids = new Set();
    const constraints = doc.constraints.map(/** Cross-reference only validated own question names. */ (raw) => {
        requireInput(typeof raw === "object" && raw !== null);
        const row = raw;
        requireInput(name(row.id) && !ids.has(row.id));
        ids.add(row.id);
        if (row.kind === "exclusive") {
            record(row, ["id", "kind", "answers"]);
            requireInput(Array.isArray(row.answers) && row.answers.length >= 2 && row.answers.length <= JOINT_LIMITS.questions);
            const answers = row.answers.map(/** Validate each declared alternative. */ /** Validate each declared alternative. */ p => predicate(p, questions));
            requireInput(new Set(answers.map(/** One witness entry per distinct question. */ /** One witness entry per distinct question. */ p => p.question)).size === answers.length);
            return { id: row.id, kind: "exclusive", answers };
        }
        if (row.kind === "requires") {
            record(row, ["id", "kind", "if", "then"]);
            return { id: row.id, kind: "requires", if: predicate(row.if, questions), then: predicate(row.then, questions) };
        }
        requireInput(row.kind === "relationship");
        record(row, ["id", "kind", "when", "source", "target", "relationship"]);
        requireInput(name(row.source) && name(row.target) && name(row.relationship));
        return { id: row.id, kind: "relationship", when: predicate(row.when, questions), source: row.source, target: row.target, relationship: row.relationship };
    });
    return { version: JOINT_VERSION, questions, result, constraints };
}
//# sourceMappingURL=joint-schema.js.map