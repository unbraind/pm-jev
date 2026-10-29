/** Portable, read-only human labeling queue document version. */
export declare const LABEL_QUEUE_VERSION = "pm-jev-label-queue/1";
/** Limits bound traversal, agent output, and exact integer cost arithmetic. */
export declare const LABEL_QUEUE_LIMITS: Readonly<{
    bytes: number;
    cases: 5000;
    cohorts: 32;
    sources: 128;
    queue: 100;
    units: 1000000;
    ratio: 1000000000;
}>;
/** Count-derived uncertainty; no floating point decisions or implicit confidence conversion. */
export interface LabelRatio {
    readonly numerator: number;
    readonly denominator: number;
}
/** Provenance is caller-declared evidence, never verified or promoted by selection. */
export type LabelProvenance = {
    readonly kind: "none";
} | {
    readonly kind: "human" | "inferred";
    readonly value: string;
    readonly actor: string;
    readonly evidence: string;
};
/** A source belongs to exactly one cohort, even when it contains multiple tasks. */
export interface LabelCohort {
    readonly id: string;
    readonly role: "acquisition" | "held_out";
    readonly sources: readonly string[];
}
/** Minimized immutable case reference; no tracker body, status interpretation or prediction needed. */
export interface LabelCase {
    readonly id: string;
    readonly source: string;
    readonly revision: string;
    readonly cohort: string;
    readonly task: string;
    readonly bucket: string;
    readonly state: "unlabeled" | "abstained" | "decided";
    readonly uncertainty: LabelRatio;
    readonly cost: number;
    readonly label: LabelProvenance;
}
/** Explicit integer labeling units and selection order, independent of ambient session focus. */
export interface LabelPolicy {
    readonly cohort: string;
    readonly seed: string;
    readonly budget: number;
    readonly limit: number;
    readonly uncertainty: "declared_ratio_desc";
    readonly min_uncertainty: LabelRatio;
    readonly diversity: "cap" | "balanced";
    readonly max_per_bucket: number;
}
/** All inputs are portable declarations, not grants to fetch a source or change its labels. */
export interface LabelQueueInput {
    readonly version: typeof LABEL_QUEUE_VERSION;
    readonly policy: LabelPolicy;
    readonly cohorts: readonly LabelCohort[];
    readonly cases: readonly LabelCase[];
}
/** Per-case failures are isolated; raw case content is never included in diagnostics. */
export interface LabelCaseRejection {
    readonly index: number;
    readonly code: "invalid_case" | "duplicate_case";
}
/** The normalized portable document and counted omissions are separate from untrusted input. */
export interface ParsedLabelQueueInput {
    readonly input: LabelQueueInput;
    readonly rejected: readonly LabelCaseRejection[];
    readonly candidates: number;
}
/** Stable agent-routing codes without rejected content or local paths. */
export type LabelQueueRefusalCode = "invalid_input" | "input_unreadable" | "cohort_conflict" | "invalid_report";
/** Boundary failures always include a concrete remedy and never repeat supplied values. */
export declare class LabelQueueRefusal extends Error {
    /** Stable machine-readable reason independent of the rejected source content. */
    readonly code: LabelQueueRefusalCode;
    /** Concrete next step suitable for compact agent output. */
    readonly remedy: string;
    /** Preserve a content-free error contract for SDK consumers and native CLI rendering. */
    constructor(code: LabelQueueRefusalCode, remedy: string);
}
/** Stable ordinal comparison avoids locale, input enumeration and platform dependencies. */
export declare function labelOrdinal(a: string, b: string): number;
/** Stable composite identity excludes revision so duplicate revisions cannot buy extra queue slots. */
export declare function labelCaseKey(row: Pick<LabelCase, "source" | "id" | "task">): string;
/** Parse once and construct a detached canonical snapshot through the sole strict boundary schema. */
export declare function parseLabelQueueInput(raw: unknown): ParsedLabelQueueInput;
//# sourceMappingURL=label-schema.d.ts.map