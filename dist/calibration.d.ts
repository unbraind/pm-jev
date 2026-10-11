import type { JevConfig } from "./index.ts";
/** Stable corpus identity; template or label changes require a new version. */
export declare const DATASET_VERSION = "pm-jev-calibration/1";
/** Independent failure families requested by the calibration item. */
export declare const FAMILIES: readonly ["negations", "boundary", "adversarial", "long_context"];
/** Family names retained in every observation and curve. */
export type Family = typeof FAMILIES[number];
/** One synthetic proposition, with a mechanically determined boolean label. */
export interface CalibrationQuestion {
    readonly id: string;
    readonly family: Family;
    readonly split: "calibration" | "evaluation";
    readonly state: string;
    readonly instructions: string;
    readonly expected: boolean;
}
/** Complete reproducible corpus; no caller-supplied traces are accepted. */
export interface CalibrationDataset {
    readonly version: string;
    readonly seed: number;
    readonly questions: readonly CalibrationQuestion[];
}
/** Generate balanced labels and disjoint template variants from an unsigned seed. */
export declare function generateDataset(seed?: number): CalibrationDataset;
/** Stable serialized bytes used by the generator and the report digest. */
export declare function datasetBytes(dataset: CalibrationDataset): string;
/** Refuse edited or imported corpora so the opt-in command stays synthetic-only. */
export declare function readDataset(text: string): CalibrationDataset;
/** Noul has no SDK confidence field; chosen-label probability is derived explicitly. */
export interface Observation extends CalibrationQuestion {
    readonly probability: number;
    readonly predicted: boolean;
    readonly confidence: number;
    readonly correct: boolean;
}
/** One inclusive confidence cutoff and its selective prediction trade-off. */
export interface ReliabilityPoint {
    readonly threshold: number;
    readonly accepted: number;
    readonly correct: number;
    readonly coverage: number;
    readonly precision: number | null;
}
/** Declared empirical objective, with an explicit insufficient-evidence outcome. */
export interface ThresholdDerivation {
    readonly targetPrecision: number;
    readonly minAccepted: number;
    readonly threshold: number | null;
    readonly curve: readonly ReliabilityPoint[];
}
/** Predict noul inclusively; confidence measures the probability of that label. */
export declare function observe(question: CalibrationQuestion, value: number, gateThreshold?: number): Observation;
/** Compute all attainable confidence cutoffs, retaining tied observations together. */
export declare function deriveThreshold(rows: readonly Pick<Observation, "confidence" | "correct">[], targetPrecision?: number, minAccepted?: number): ThresholdDerivation;
/** Positive-class gate metrics differ from selective prediction correctness. */
export interface GatePoint {
    readonly threshold: number;
    readonly positive: number;
    readonly truePositive: number;
    readonly falsePositive: number;
    readonly falseNegative: number;
    readonly precision: number | null;
    readonly recall: number | null;
    readonly accuracy: number | null;
}
/** Measure inclusive noul gates, without confusing confidence and probability. */
export declare function gatePoint(rows: readonly Observation[], threshold: number): GatePoint;
/** Freeze a family's confidence and positive-class thresholds before evaluation. */
export declare function familyMetrics(rows: readonly Observation[], targetPrecision: number, minAccepted: number): {
    confidence: ThresholdDerivation;
    gateThreshold: number | null;
    gateCurve: GatePoint[];
    evaluation: {
        count: number;
        accepted: number;
        coverage: number;
        precision: number | null;
        gate: GatePoint | null;
        baselineGate: GatePoint;
    };
};
/** Constrain calibration to HTTP loopback and installed decision models. */
export declare function localConfig(baseUrl?: string, model?: string): JevConfig;
/** Run the committed synthetic corpus through the production decision boundary. */
export declare function calibrate(dataset: CalibrationDataset, baseUrl: string, model: string, targetPrecision?: number, minAccepted?: number): Promise<{
    schemaVersion: string;
    datasetVersion: string;
    seed: number;
    datasetSha256: string;
    model: string;
    modelDigest: string;
    resolvedModels: string[];
    recordedAt: string;
    durationMs: number;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
    targetPrecision: number;
    minAccepted: number;
    confidenceDefinition: string;
    families: {
        [k: string]: {
            confidence: ThresholdDerivation;
            gateThreshold: number | null;
            gateCurve: GatePoint[];
            evaluation: {
                count: number;
                accepted: number;
                coverage: number;
                precision: number | null;
                gate: GatePoint | null;
                baselineGate: GatePoint;
            };
        };
    };
    pooled: {
        confidence: ThresholdDerivation;
        gateThreshold: number | null;
        gateCurve: GatePoint[];
        evaluation: {
            count: number;
            accepted: number;
            coverage: number;
            precision: number | null;
            gate: GatePoint | null;
            baselineGate: GatePoint;
        };
    };
    defaultDecision: string;
    observations: Observation[];
}>;
//# sourceMappingURL=calibration.d.ts.map