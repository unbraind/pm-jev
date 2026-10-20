import type { PairItem, DuplicatePair } from "./dedupe.ts";
/** Public, complete tracker-copy evidence accepted by the label builder. */
export interface DuplicateCorpus {
    repository: string;
    commit: string;
    items: PairItem[];
}
/** A real duplicate closure or a lexical hard control, with no labels sent to inference. */
export interface LabelledPair {
    pair_id: string;
    repository: string;
    pair: DuplicatePair;
    label: boolean;
    retrieved: boolean;
    split: "dev" | "heldout";
}
/** Benchmark observation retains scores and probabilities without copied tracker text. */
export interface PairObservation {
    label: boolean;
    probability: number;
    retrieved: boolean;
}
/** Recognize explicit duplicate consolidation receipts as well as standard duplicate closures. */
export declare function closureTarget(item: PairItem): string | undefined;
/** Build duplicate-group-separated real closures and top lexical controls at a strict 2:1 ratio. */
export declare function labelledPairs(corpora: readonly DuplicateCorpus[], positivesPerSplit?: number): LabelledPair[];
/** Two-sided Wilson interval; empty denominators remain explicitly undefined. */
export declare function wilson(successes: number, count: number, z?: number): [number, number] | null;
/** Positive-class metrics count abstained and unretrieved positives as missed work. */
export declare function duplicateMetrics(rows: readonly PairObservation[], threshold: number, lexical?: boolean): {
    count: number;
    tp: number;
    fp: number;
    fn: number;
    precision: number | null;
    recall: number | null;
    f1: number;
    precision_ci95: [number, number] | null;
    recall_ci95: [number, number] | null;
    f1_wilson_envelope95: number[] | null;
    abstain_rate: number | null;
    abstain_ci95: [number, number] | null;
};
/** Tune F1 on dev observations only, retaining the existing 0.8 model safety floor. */
export declare function fitDuplicateThreshold(rows: readonly PairObservation[], lexical: boolean): number;
//# sourceMappingURL=dedupe-evaluation.d.ts.map