import type { DedupeDecision } from "./index.ts";
import type { TokenUsage } from "./token-usage.ts";
/** Proposed create input. The bound defaults to eight positive title matches. */
export interface PreCreateDraft {
    readonly title: string;
    readonly body?: string;
    readonly limit?: number;
}
/** Only a duplicate recommendation names a tracker item. */
export type PreCreateVerdict = {
    decision: "duplicate";
    duplicate_of: string;
} | {
    decision: "no_match";
    reason: "no_title_candidates" | "model_none";
} | {
    decision: "abstain";
    reason: "below_threshold" | "candidate_limit" | "decision_unavailable";
};
/** Content-free receipt. Unknown usage stays null on an inference failure. */
export type PreCreateReceipt = PreCreateVerdict & {
    readonly candidate_count: number;
    readonly has_more: boolean;
    readonly probability: number | null;
    readonly score_kind: "raw" | "calibrated" | null;
    readonly threshold: number | null;
    readonly model: string;
    readonly usage: TokenUsage | null;
};
/** Compact a detailed screen using the guard floor and any stricter compatible fit. */
export declare function preCreateReceipt(receipt: DedupeDecision, minimum: number, hasMore: boolean): PreCreateReceipt;
//# sourceMappingURL=pre-create-policy.d.ts.map