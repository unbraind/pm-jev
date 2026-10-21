/** Version of fixed-score policy datasets and content-free receipts. */
export declare const COST_POLICY_VERSION = "pm-jev-cost/1";
/** Caller-relative penalties; an incorrect type is charged once, never also as a miss. */
export interface DecisionCosts {
    false_duplicate: number;
    wrong_type: number;
    missed_candidate: number;
}
/** Shared immutable evidence; groups must contain whole repositories or leakage-connected components. */
interface CostEvidence {
    id: string;
    group: string;
    split: "selection" | "heldout";
    confidence: number;
    eligible: boolean;
}
/** Duplicate rows always represent a possible positive proposal; type rows represent one fixed predicted label. */
export type CostObservation = CostEvidence & ({
    task: "duplicate";
    label: boolean;
} | {
    task: "type";
    label: string;
    predicted: string;
});
/** Labels and scores are supplied once; the selector never calls a model or modifies them. */
export interface CostDataset {
    version: typeof COST_POLICY_VERSION;
    provenance: "synthetic" | "public" | "local-unverified";
    observations: readonly CostObservation[];
}
/** Machine-readable failures with actionable recovery; input text is never reflected. */
export type CostRefusalCode = "invalid_costs" | "invalid_dataset" | "split_overlap" | "insufficient_evidence" | "input_unreadable" | "invalid_policy";
/** Expected refusal shared by the SDK and CLI JSON/TOON boundary. */
export declare class CostPolicyRefusal extends Error {
    /** Stable refusal category for agent routing. */
    readonly code: CostRefusalCode;
    /** Recovery guidance safe to include in content-free output. */
    readonly remedy: string;
    /** Preserve a stable code and remedy without retaining source content. */
    constructor(code: CostRefusalCode, message: string, remedy: string);
}
/** Frozen proposal filter; null explicitly disables every proposal, including confidence one. */
export interface AbstentionPolicy {
    version: typeof COST_POLICY_VERSION;
    threshold: number | null;
    mutation_authority: "none";
}
/** Counts refer to the entire population, including unretrieved positive duplicates. */
export interface CostMetrics {
    count: number;
    proposed: number;
    false_duplicates: number;
    wrong_types: number;
    missed_candidates: number;
    coverage: number;
    cost: number;
    cost_per_example: number;
}
/** Every operating point uses the same immutable labelled population. */
export interface CostPoint {
    threshold: number | null;
    selection: CostMetrics;
    heldout: CostMetrics;
}
/** Content-free reproducibility receipt, bounded to 22 operating points. */
export interface CostPolicyReport {
    ok: true;
    version: typeof COST_POLICY_VERSION;
    provenance: CostDataset["provenance"];
    evidence_sha256: string;
    costs: DecisionCosts;
    policy: AbstentionPolicy;
    policy_sha256: string;
    selected: CostPoint;
    curve: CostPoint[];
}
/** Validate untrusted JSON and split independence before selecting or reporting a threshold. */
export declare function parseCostDataset(raw: unknown): CostDataset;
/** Apply a veto to an existing proposal; this function cannot authorize or perform a mutation. */
export declare function abstainWithPolicy(policy: AbstentionPolicy, confidence: number, eligible: boolean, mandatoryChecksPassed: boolean): {
    propose: boolean;
    reason: "mandatory_checks_failed" | "ineligible" | "abstained" | "proposal_only";
};
/** Select on selection labels only; held-out costs are diagnostics and never influence ties or thresholds. */
export declare function selectAbstentionPolicy(input: CostDataset, costs: DecisionCosts): CostPolicyReport;
export {};
//# sourceMappingURL=cost-policy.d.ts.map