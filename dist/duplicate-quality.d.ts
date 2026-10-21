import type { DuplicatePair } from "./dedupe.ts";
/** Repository-only assignment frozen before labels, scores or model outcomes. */
export declare function duplicateSplit(repository: string): "train" | "heldout";
/** Title-focused semantic evidence; generic shared tags alone cannot score as duplicates. */
export declare function duplicateSimilarity(pair: DuplicatePair): number;
/** Raw benchmark evidence shared by every arm; model-only bypasses candidate retrieval. */
export interface QualityObservation {
    label: boolean;
    retrieved: boolean;
    lexical: number;
    probability: number;
}
/** Frozen train operating point. Null disables positive proposals, including probability one. */
export interface QualityPolicy {
    model: number | null;
    lexical: number | null;
}
/** The three ablations use exactly the same labelled population. */
export type QualityArm = "lexical-only" | "model-only" | "combined";
/** Positive decisions require every enabled channel; all remaining rows explicitly abstain. */
export declare function qualityProposes(row: QualityObservation, arm: QualityArm, policy: QualityPolicy): boolean;
/** Unretrieved positives stay in recall; every withheld proposal is an unsure decision. */
export declare function qualityMetrics(rows: readonly QualityObservation[], arm: QualityArm, policy: QualityPolicy): {
    count: number;
    tp: number;
    fp: number;
    fn: number;
    precision: number | null;
    recall: number | null;
    abstention_rate: number | null;
    precision_ci95: [number, number] | null;
    recall_ci95: [number, number] | null;
};
/** Enumerate train-observed cutoffs and retain the precision/recall frontier plus a disable point. */
export declare function qualityFrontier(train: readonly QualityObservation[], arm: QualityArm): {
    policy: QualityPolicy;
    train: {
        count: number;
        tp: number;
        fp: number;
        fn: number;
        precision: number | null;
        recall: number | null;
        abstention_rate: number | null;
        precision_ci95: [number, number] | null;
        recall_ci95: [number, number] | null;
    };
}[];
/** Maximize train recall at precision >= 0.8 and >= 3 predictions; ties prefer precision then stricter cutoffs. */
export declare function fitQualityPolicy(train: readonly QualityObservation[], arm: QualityArm): QualityPolicy;
/** Two-sided Wilson interval; empty denominators remain explicitly undefined. */
export declare function wilson(successes: number, count: number, z?: number): [number, number] | null;
//# sourceMappingURL=duplicate-quality.d.ts.map