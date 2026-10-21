import { evidenceHash } from "./decision-calibration.js";
/** Version of fixed-score policy datasets and content-free receipts. */
export const COST_POLICY_VERSION = "pm-jev-cost/1";
/** Expected refusal shared by the SDK and CLI JSON/TOON boundary. */
export class CostPolicyRefusal extends Error {
    /** Stable refusal category for agent routing. */
    code;
    /** Recovery guidance safe to include in content-free output. */
    remedy;
    /** Preserve a stable code and remedy without retaining source content. */
    constructor(code, message, remedy) {
        super(message);
        this.name = "CostPolicyRefusal";
        this.code = code;
        this.remedy = remedy;
    }
}
/** Reject undefined, nonfinite, negative and overflow-prone penalties before arithmetic. */
function validateCosts(costs) {
    if (!costs || [costs.false_duplicate, costs.wrong_type, costs.missed_candidate].some(/** Bound each penalty independently. */ /** Bound each penalty independently. */ cost => typeof cost !== "number" || !Number.isFinite(cost) || cost < 0 || cost > 1e6) || costs.false_duplicate + costs.wrong_type + costs.missed_candidate === 0) {
        throw new CostPolicyRefusal("invalid_costs", "Costs must be finite numbers from 0 to 1000000, with at least one positive cost.", "Declare all three relative costs, for example 20, 10, 1.");
    }
}
/** Validate untrusted JSON and split independence before selecting or reporting a threshold. */
export function parseCostDataset(raw) {
    const data = raw;
    if (!data || data.version !== COST_POLICY_VERSION || !["synthetic", "public", "local-unverified"].includes(data.provenance) || !Array.isArray(data.observations) || data.observations.length > 5000) {
        throw new CostPolicyRefusal("invalid_dataset", "Expected a versioned dataset with at most 5000 observations.", "Use the documented fixed-score dataset format and provenance marker.");
    }
    const ids = new Set();
    const groups = new Map();
    const splits = new Set();
    for (const row of data.observations) {
        if (!row || typeof row.id !== "string" || row.id.length < 1 || row.id.length > 256 || ids.has(row.id) || typeof row.group !== "string" || row.group.length < 1 || row.group.length > 256 ||
            !["selection", "heldout"].includes(row.split) || typeof row.confidence !== "number" || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1 || typeof row.eligible !== "boolean" ||
            !(row.task === "duplicate" && typeof row.label === "boolean" || row.task === "type" && typeof row.label === "string" && row.label.length > 0 && row.label.length <= 256 && typeof row.predicted === "string" && row.predicted.length > 0 && row.predicted.length <= 256)) {
            throw new CostPolicyRefusal("invalid_dataset", "An observation has invalid identity, task, label, confidence or eligibility.", "Use unique ids, nonempty group ids, explicit splits, typed labels and confidence in [0,1].");
        }
        if (groups.has(row.group) && groups.get(row.group) !== row.split)
            throw new CostPolicyRefusal("split_overlap", "A group occurs in both selection and held-out data.", "Assign each whole repository or connected component to one split before examining labels or scores.");
        ids.add(row.id);
        groups.set(row.group, row.split);
        splits.add(row.split);
    }
    if (splits.size !== 2)
        throw new CostPolicyRefusal("insufficient_evidence", "Both selection and held-out observations are required.", "Add independently held-out labelled groups; do not copy selection rows into validation.");
    return data;
}
/** Apply a veto to an existing proposal; this function cannot authorize or perform a mutation. */
export function abstainWithPolicy(policy, confidence, eligible, mandatoryChecksPassed) {
    if (!policy || policy.version !== COST_POLICY_VERSION || policy.mutation_authority !== "none" || !(policy.threshold === null || typeof policy.threshold === "number" && Number.isFinite(policy.threshold) && policy.threshold >= 0 && policy.threshold <= 1) || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 || typeof eligible !== "boolean" || typeof mandatoryChecksPassed !== "boolean") {
        throw new CostPolicyRefusal("invalid_policy", "Invalid proposal filter or decision evidence.", "Use a selected policy, confidence in [0,1], and explicit eligibility and mandatory-check verdicts.");
    }
    if (!mandatoryChecksPassed)
        return { propose: false, reason: "mandatory_checks_failed" };
    if (!eligible)
        return { propose: false, reason: "ineligible" };
    if (policy.threshold === null || confidence < policy.threshold)
        return { propose: false, reason: "abstained" };
    return { propose: true, reason: "proposal_only" };
}
/** Measure fixed-score proposals; abstaining on a negative duplicate incurs no missed-candidate cost. */
function measure(rows, threshold, costs) {
    let proposed = 0, falseDuplicates = 0, wrongTypes = 0, missedCandidates = 0;
    for (const row of rows) {
        const accepted = row.eligible && threshold !== null && row.confidence >= threshold;
        if (accepted) {
            proposed++;
            if (row.task === "duplicate") {
                if (!row.label)
                    falseDuplicates++;
            }
            else if (row.predicted !== row.label)
                wrongTypes++;
        }
        else if (row.task === "type" || row.label)
            missedCandidates++;
    }
    const cost = falseDuplicates * costs.false_duplicate + wrongTypes * costs.wrong_type + missedCandidates * costs.missed_candidate;
    // The validated dataset guarantees nonempty populations for both splits.
    return { count: rows.length, proposed, false_duplicates: falseDuplicates, wrong_types: wrongTypes, missed_candidates: missedCandidates, coverage: proposed / rows.length, cost, cost_per_example: cost / rows.length };
}
/** Rank explicit disable as stricter than every inclusive numeric threshold. */
function strictness(threshold) { return threshold ?? 2; }
/** Select on selection labels only; held-out costs are diagnostics and never influence ties or thresholds. */
export function selectAbstentionPolicy(input, costs) {
    validateCosts(costs);
    const data = parseCostDataset(input);
    const rows = [...data.observations].sort(/** Canonical evidence ignores input enumeration order. */ (a, b) => a.id < b.id ? -1 : 1)
        .map(/** Hash only normalized contract fields, independent of JSON property order or extra caller metadata. */ /** Hash only normalized contract fields, independent of JSON property order or extra caller metadata. */ row => {
        const common = { id: row.id, group: row.group, split: row.split, confidence: row.confidence, eligible: row.eligible };
        return row.task === "duplicate" ? { ...common, task: row.task, label: row.label } : { ...common, task: row.task, label: row.label, predicted: row.predicted };
    });
    const selection = rows.filter(/** Freeze the fitting population. */ /** Freeze the fitting population. */ row => row.split === "selection");
    const heldout = rows.filter(/** Never select with these outcomes. */ /** Never select with these outcomes. */ row => row.split === "heldout");
    // A fixed 0.05 grid bounds compute/output and avoids deriving candidates from held-out scores.
    const thresholds = [null, ...Array.from({ length: 21 }, /** Include zero and one exactly. */ (_, index) => index / 20)];
    const curve = thresholds.map(/** Compare policies on the identical population, including retrieval misses. */ /** Compare policies on the identical population, including retrieval misses. */ threshold => ({ threshold, selection: measure(selection, threshold, costs), heldout: measure(heldout, threshold, costs) }));
    const selected = [...curve].sort(/** Lowest empirical cost, then fewer errors, higher coverage, then stricter cutoff. */ (a, b) => a.selection.cost - b.selection.cost ||
        a.selection.false_duplicates + a.selection.wrong_types - b.selection.false_duplicates - b.selection.wrong_types || b.selection.proposed - a.selection.proposed || strictness(b.threshold) - strictness(a.threshold))[0];
    const policy = { version: COST_POLICY_VERSION, threshold: selected.threshold, mutation_authority: "none" };
    const evidence = { version: data.version, provenance: data.provenance, observations: rows };
    const declared = { false_duplicate: costs.false_duplicate, wrong_type: costs.wrong_type, missed_candidate: costs.missed_candidate };
    const evidenceSha256 = evidenceHash(evidence);
    return { ok: true, version: COST_POLICY_VERSION, provenance: data.provenance, evidence_sha256: evidenceSha256, costs: declared, policy,
        policy_sha256: evidenceHash({ policy, costs: declared, evidence_sha256: evidenceSha256 }), selected, curve };
}
//# sourceMappingURL=cost-policy.js.map