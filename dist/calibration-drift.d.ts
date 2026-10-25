/** Versioned population diagnostic; no provider or tracker mutation is involved. */
export declare const DRIFT_VERSION = "pm-jev-drift/1";
/** Exact frozen model weights and question catalog (or ordered catalog bundle) identity. */
export interface DriftIdentity {
    model_digest: string;
    question_digest: string;
}
/** Minimized evidence: input_bucket is a predeclared category, never raw input text. */
export interface DriftObservation {
    id: string;
    task: string;
    type: string;
    input_bucket: string;
    predicted: string;
    label: string | null;
}
/** A cohort and its exact decision identity; null labels mean no explicit later judgement. */
export interface DriftCohort {
    identity: DriftIdentity;
    observations: readonly DriftObservation[];
}
/** Freeze these inclusive thresholds before inspecting the current cohort. */
export interface DriftThresholds {
    population_tv: number;
    error_increase: number;
    min_population: number;
    min_labels: number;
}
/** Portable fixed evidence; public provenance is a caller assertion, not a publication permission. */
export interface DriftInput {
    version: typeof DRIFT_VERSION;
    provenance: "synthetic" | "public" | "local-unverified";
    thresholds: DriftThresholds;
    calibration: DriftCohort;
    current: DriftCohort;
}
/** Machine-readable boundary refusals shared by SDK and command. */
export type DriftRefusalCode = "invalid_input" | "identity_mismatch" | "input_unreadable" | "invalid_output";
/** Content-free refusal with an actionable remedy, safe for compact agent output. */
export declare class DriftRefusal extends Error {
    /** Stable routing code, independent of source text. */
    readonly code: DriftRefusalCode;
    /** Safe recovery instructions that do not reflect input values. */
    readonly remedy: string;
    /** Retain only typed diagnostics, never the rejected input. */
    constructor(code: DriftRefusalCode, remedy: string);
}
/** Missing evidence is distinct from measured stability and an observed threshold crossing. */
export type DriftStatus = "stable" | "drift" | "insufficient_evidence";
/** Bounded diagnostic counts and rates; null means a required denominator was absent. */
export interface DriftReport {
    ok: true;
    version: typeof DRIFT_VERSION;
    provenance: DriftInput["provenance"];
    identity: DriftIdentity;
    evidence_sha256: string;
    calibration_sha256: string;
    thresholds: DriftThresholds;
    status: DriftStatus;
    population: {
        status: DriftStatus;
        calibration_count: number;
        current_count: number;
        task_tv: number | null;
        type_tv: number | null;
        input_tv: number | null;
    };
    labels: {
        status: DriftStatus;
        calibration_count: number;
        current_count: number;
        calibration_coverage: number;
        current_coverage: number;
        calibration_error: number | null;
        current_error: number | null;
        error_increase: number | null;
    };
    recommendation: "retain_policy_and_monitor" | "abstain_and_recalibrate" | "abstain_pending_evidence";
    inference_calls: 0;
    mutation_authority: "none";
}
/** One strict boundary schema for both SDK inputs and command JSON; return a detached validated snapshot. */
export declare function parseDriftInput(raw: unknown): DriftInput;
/** Assert all emitted numbers have documented finite domains before exposing an ok result. */
export declare function validateDriftReportNumbers(report: DriftReport): DriftReport;
/** Compare frozen operating populations and later labels with zero inference, I/O or mutation. */
export declare function checkCalibrationDrift(raw: unknown): DriftReport;
//# sourceMappingURL=calibration-drift.d.ts.map