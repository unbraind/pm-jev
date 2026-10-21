import type { ItemMetadata } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, BeforeMutationHookContext, BeforeMutationHookDecision } from "@unbrained/pm-cli/sdk/authoring";
import type { Questions } from "@typesafe-ai/sdk";
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
/** Token-lean typed pair verdict, with deterministic explanation rather than invented rationale. */
export interface PairVerdict {
    a: string;
    b: string;
    probability: number;
    related_probability: number;
    decision: "duplicate" | "related" | "distinct" | "abstain";
    reason: string;
}
/** Typed propositions shared byte-for-byte by the benchmark and production command. */
export declare const PAIR_QUESTIONS: Questions;
/** Dev-F1 operating points with an unchanged 0.8 safety floor; see the real-label report. */
export declare const PAIR_CALIBRATION: Readonly<Record<string, {
    threshold: number;
    related_threshold: number;
    digest: string;
}>>;
/** Stable unordered pair identity used for de-duplication and labelled controls. */
export declare function pairKey(a: string, b: string): string;
/** Orient ties deterministically; chronology is handled in code, never by the model. */
export declare function orderedPair(a: PairItem, b: PairItem, score: number): DuplicatePair;
/** Bounded top-K per item via inverted trigram, tag and linked-file indexes; retain at most limit global pairs. */
export declare function candidatePairs(items: readonly PairItem[], limit: number, topK?: number): DuplicatePair[];
/** Least-privilege, prompt-bounded pair evidence excludes closure labels, ids and receipts. */
export declare function pairState(pair: DuplicatePair): {
    [k: string]: {
        title: string;
        text: string;
    };
};
/** Inclusive positive and negative cutoffs per typed question, with an explicit central abstention band. */
export declare function pairVerdict(pair: DuplicatePair, probability: number, relatedProbability: number, threshold: number, relatedThreshold: number): PairVerdict;
/** Reject an expired or stale duplicate receipt under the SDK's item mutation lock. */
export declare function guardDedupeMutation(ctx: BeforeMutationHookContext): BeforeMutationHookDecision | void;
/** Scan complete tracker copies sequentially, then optionally persist approved links and closures; stale pair evidence becomes a skipped row instead of aborting the batch after earlier writes. */
export declare function runPairDedupe(ctx: CommandHandlerContext): Promise<PairVerdict[]>;
//# sourceMappingURL=dedupe.d.ts.map