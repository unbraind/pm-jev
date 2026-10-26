import type { ThresholdInput } from "./threshold.ts";
import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, BeforeMutationHookContext, BeforeMutationHookDecision } from "@unbrained/pm-cli/sdk/authoring";
import type { Questions } from "@typesafe-ai/sdk";
import type { QualityPolicy } from "./duplicate-quality.ts";
/** Complete SDK item evidence retained locally for ranking and revision checks. */
export type PairItem = ItemMetadata & {
    body?: string;
};
/** A lexical candidate with the newer item first and deterministic similarity. */
export interface DuplicatePair {
    a: PairItem;
    b: PairItem;
    score: number;
}
/** Token-lean typed pair verdict; probability zero is unscored when the reason skips inference. */
export interface PairVerdict {
    a: string;
    b: string;
    probability: number;
    related_probability?: number;
    decision: "duplicate" | "related" | "distinct" | "abstain";
    reason: string;
}
/** Historical typed pair propositions retained for versioned benchmark replay. */
export declare const PAIR_QUESTIONS: Questions;
/** Duplicate-only question used by precision-first production and its benchmark. */
export declare const DUPLICATE_QUESTIONS: Questions;
/** Historical v2 dev-F1 points, retained for receipt replay; production uses the precision-first policy. */
export declare const PAIR_CALIBRATION: Readonly<Record<string, {
    threshold: number;
    related_threshold: number;
    digest: string;
}>>;
/** Precision-first duplicate policy; only the train-fitted combined arm may propose duplicates. */
export declare const DUPLICATE_QUALITY_CALIBRATION: Readonly<Record<string, {
    policy: QualityPolicy;
    digest: string;
}>>;
/** Stable unordered pair identity used for de-duplication and labelled controls. */
export declare function pairKey(a: string, b: string): string;
/** Orient ties deterministically; chronology is handled in code, never by the model. */
export declare function orderedPair(a: PairItem, b: PairItem, score: number): DuplicatePair;
/** Bounded top-K per item via trigram, structural and exact semantic/title indexes; retain at most limit global pairs. */
export declare function candidatePairs(items: readonly PairItem[], limit: number, topK?: number): DuplicatePair[];
/** Least-privilege, prompt-bounded pair evidence excludes closure labels, ids and receipts. */
export declare function pairState(pair: DuplicatePair): {
    [k: string]: {
        title: string;
        text: string;
    };
};
/** Inclusive positive and negative cutoffs per typed question, with an explicit central abstention band. */
export declare function pairVerdict(pair: DuplicatePair, probability: number, relatedProbability: number, threshold: ThresholdInput, relatedThreshold: ThresholdInput): PairVerdict;
/** Reject an expired or stale duplicate receipt under the SDK's item mutation lock. */
export declare function guardDedupeMutation(ctx: BeforeMutationHookContext): BeforeMutationHookDecision | void;
/** Scan complete tracker copies sequentially, then optionally persist calibrated links; stale pair evidence becomes a skipped row instead of aborting the batch after earlier writes. */
export declare function runPairDedupe(ctx: CommandHandlerContext): Promise<PairVerdict[]>;
//# sourceMappingURL=dedupe.d.ts.map