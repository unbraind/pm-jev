import { LABEL_QUEUE_VERSION } from "./label-schema.ts";
import type { LabelCase, LabelPolicy, LabelCaseRejection } from "./label-schema.ts";
/** Mutually exclusive omission reasons in precedence order. */
export type LabelOmission = "invalid" | "held_out" | "other_cohort" | "human_labeled" | "not_pending" | "below_uncertainty" | "diversity" | "budget" | "limit";
/** A selected reference retains inferred provenance without granting ground-truth status. */
export interface LabelQueueEntry extends LabelCase {
    readonly rank: number;
    readonly uncertainty_display: number;
    readonly ground_truth: false;
}
/** Bounded advisory receipt; integer budget is a per-call cap, never a shared reservation. */
export interface LabelQueueReport {
    readonly ok: true;
    readonly version: typeof LABEL_QUEUE_VERSION;
    readonly input_sha256: string;
    readonly policy: LabelPolicy;
    readonly counts: {
        readonly candidates: number;
        readonly eligible: number;
        readonly selected: number;
        readonly omitted: number;
    };
    readonly omissions: Readonly<Record<LabelOmission, number>>;
    readonly rejected: readonly LabelCaseRejection[];
    readonly rejected_omitted: number;
    readonly spent: number;
    readonly remaining: number;
    readonly queue: readonly LabelQueueEntry[];
    readonly inference_calls: 0;
    readonly mutations: 0;
    readonly mutation_authority: "none";
}
/** Check every emitted numeric field and conservation law before returning an ok receipt. */
export declare function validateLabelQueueReportNumbers(report: LabelQueueReport): LabelQueueReport;
/** Rank explicit labeling candidates without fetching sources, inferring labels or changing any state. */
export declare function selectLabelQueue(raw: unknown): LabelQueueReport;
//# sourceMappingURL=label-queue.d.ts.map