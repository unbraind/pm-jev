/** Versioned contract shared by evaluation, persisted calibration and live decisions. */
export declare const EVALUATION_VERSION = "pm-jev-eval/1";
/** Supported ground-truth decision tasks. */
export type EvaluationTask = "triage" | "link" | "dedupe";
/** One labelled model answer, with content-free reproducibility evidence. */
export interface Observation {
    repository: string;
    commit: string;
    data_sha256: string;
    example_sha256: string;
    question_sha256: string;
    channel: string;
    label: string;
    probabilities: Record<string, number>;
    latency_ms: number;
    input_tokens: number;
    output_tokens: number;
}
/** Accuracy and reliability over the exact reported population. */
export interface Reliability {
    count: number;
    accuracy: number | null;
    ece: number | null;
    nll: number | null;
    classes: {
        label: string;
        support: number;
        precision: number | null;
        recall: number | null;
    }[];
    bins: {
        lower: number;
        upper: number;
        count: number;
        confidence: number | null;
        accuracy: number | null;
    }[];
    thresholds: {
        threshold: number;
        count: number;
        coverage: number;
        precision: number | null;
        precision_lower_95: number;
    }[];
}
/** Fitted scalar and precision qualification for one question channel. */
export interface ChannelCalibration {
    temperature: number;
    threshold: number | null;
    reason: string;
    question_sha256: string[];
    calibration: {
        raw: Reliability;
        calibrated: Reliability;
    };
    validation: {
        raw: Reliability;
        calibrated: Reliability;
    };
    validation_at_threshold: ReturnType<typeof atThreshold> | null;
}
/** Auditable, content-free project settings record for one task/model digest. */
export interface CalibrationReceipt {
    version: string;
    method: "temperature_scaling_nll_grid";
    task: EvaluationTask;
    model: string;
    model_digest: string;
    target_precision: number;
    seed: string;
    calibration_repositories: string[];
    validation_repositories: string[];
    data: {
        repository: string;
        commit: string;
        data_sha256: string;
    }[];
    observations_sha256: string;
    channels: Record<string, ChannelCalibration>;
}
/** Canonical SHA-256 for ordered JSON evidence, never an absolute path. */
export declare function evidenceHash(value: unknown): string;
/** Fingerprint fixed decision semantics while treating duplicate candidate identities as exchangeable evidence. */
export declare function questionFingerprint(channel: string, question: unknown): string;
/** Stable descending probability ranking, preserving schema order on ties. */
export declare function ranked(probabilities: Record<string, number>): [string, number][];
/** Temperature scaling on log probabilities; zero mass remains zero. */
export declare function scaleProbabilities(probabilities: Record<string, number>, temperature: number): Record<string, number>;
/** One-sided 95% Wilson lower bound; empty evidence cannot qualify. */
export declare function precisionLower(correct: number, count: number): number;
/** Threshold coverage and precision, including a conservative uncertainty bound. */
export declare function atThreshold(rows: readonly Observation[], threshold: number): {
    threshold: number;
    count: number;
    coverage: number;
    precision: number | null;
    precision_lower_95: number;
};
/** Compute categorical accuracy, per-class metrics, ten-bin ECE, NLL and threshold curves. */
export declare function reliability(rows: readonly Observation[]): Reliability;
/** Fit one parameter on calibration labels only using a fixed log-spaced NLL grid. */
export declare function fitTemperature(rows: readonly Observation[]): number;
/** Apply a fitted temperature without changing labels or provenance. */
export declare function scaledRows(rows: readonly Observation[], temperature: number): Observation[];
/** Deterministic repository partition independent of item labels and model outcomes. */
export declare function repositorySplit(repositories: readonly string[], seed: string): {
    calibration: string[];
    validation: string[];
};
/** Fit channels and freeze candidate thresholds before inspecting validation outcomes. */
export declare function calibrateObservations(task: EvaluationTask, model: string, digest: string, rows: readonly Observation[], seed: string, target: number): CalibrationReceipt;
/** Read package-private settings through the SDK; normalized host settings intentionally omit them. */
export declare function readOpaqueJevSettings(pmRoot: string): Promise<Record<string, unknown>>;
/** Read and validate the task/model calibration without exposing other project settings. */
export declare function readCalibration(pmRoot: string, task: EvaluationTask, model: string): Promise<CalibrationReceipt | undefined>;
/** Read the immutable local model identity with no prompts or hosted credentials. */
export declare function modelDigest(baseUrl: string, model: string, timeoutMs: number): Promise<string>;
/** Calibrated channel with enough identity metadata for user-facing decisions and receipts. */
export interface ActiveCalibration {
    record: CalibrationReceipt;
    receipt_sha256: string;
}
/** Activate a saved record only for the exact local digest; aliases and replacements do not silently reuse it. */
export declare function activeCalibration(pmRoot: string, task: EvaluationTask, config: {
    provider: string;
    baseUrl: string;
    model: string;
    timeoutMs: number;
}): Promise<ActiveCalibration | undefined>;
/** Apply a compatible channel and keep an unqualified threshold closed. */
export declare function calibratedAnswer(active: ActiveCalibration | undefined, channel: string, questions: unknown, probabilities: Record<string, number>, fallback: number, minimum?: number): {
    probabilities: Record<string, number>;
    threshold: number;
    calibration: null;
} | {
    probabilities: Record<string, number>;
    threshold: number;
    calibration: {
        receipt_sha256: string;
        temperature: number;
        threshold: number | null;
        fitted_threshold: number | null;
        qualified: boolean;
        reason: string;
    };
};
/** Exact metadata exposed when a compatible channel calibration is applied. */
export type CalibrationUse = NonNullable<ReturnType<typeof calibratedAnswer>["calibration"]>;
//# sourceMappingURL=decision-calibration.d.ts.map