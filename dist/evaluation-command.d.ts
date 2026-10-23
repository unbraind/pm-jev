import type { ReceiptOptions } from "./partial-receipt.ts";
import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import { readPublicCorpus } from "./tracker-evaluation.ts";
import type { EvaluationTask, Observation } from "./decision-calibration.ts";
import type { Questions } from "@typesafe-ai/sdk";
/** Shared evaluator flags; source paths stay outside every emitted receipt. */
export declare const EVALUATION_FLAGS: FlagDefinition[];
/** Label space of one question channel, matching the model's answer schema. */
export declare function channelLabels(question: Questions[string]): string[];
/** Run public or explicitly opted-in local evaluation; only public calibration enters project settings. */
export declare function runEvaluationCommand(ctx: CommandHandlerContext, calibrate: boolean, readCorpus?: typeof readPublicCorpus): Promise<Awaited<ReturnType<typeof evaluate>>>;
/** Validate new evaluation inputs and preserve the full calibration result union. */
declare function evaluate(ctx: CommandHandlerContext, calibrate: boolean, readCorpus: typeof readPublicCorpus, storage: ReceiptOptions): Promise<import("./partial-receipt.ts").ReceiptFailure | {
    provenance?: "local-unverified" | undefined;
    version: string;
    task: EvaluationTask;
    model: string;
    model_digest: string;
    seed: string;
    model_calls: number;
    sampled_examples: number;
    eligible_examples: number;
    retrieval_misses: number;
    skipped: string[];
    mean_latency_ms: number;
    tokens: {
        input: number | null;
        output: number | null;
        mean_input: number | null;
        mean_output: number | null;
        unknown_calls: number;
        unknown_input_calls: number;
        unknown_output_calls: number;
    };
    metrics: {
        [k: string]: import("./decision-calibration.ts").Reliability;
    };
    observations: Observation[];
    retrieval?: {
        mode: import("./exemplar-retrieval.ts").RetrievalMode;
        count: number;
        token_budget: number;
        embedding_model: string | null;
        embedding_available: boolean | null;
        embedding_fallbacks: number;
        empty_retrievals: number;
        reused_baseline_calls: number;
        budget_clamped_examples: number;
        mean_exemplars: number;
    } | undefined;
    exemplar_metrics?: {
        [k: string]: import("./decision-calibration.ts").Reliability;
    } | undefined;
    baselines?: {
        [k: string]: {
            majority: {
                abstained: number;
                reliability: import("./decision-calibration.ts").Reliability;
            };
            knn: {
                abstained: number;
                reliability: import("./decision-calibration.ts").Reliability;
            };
        };
    } | undefined;
    exemplar_observations?: Observation[] | undefined;
} | {
    provenance?: "local-unverified" | undefined;
    version: string;
    task: EvaluationTask;
    model: string;
    model_digest: string;
    seed: string;
    model_calls: number;
    sampled_examples: number;
    eligible_examples: number;
    retrieval_misses: number;
    skipped: string[];
    mean_latency_ms: number;
    tokens: {
        input: number | null;
        output: number | null;
        mean_input: number | null;
        mean_output: number | null;
        unknown_calls: number;
        unknown_input_calls: number;
        unknown_output_calls: number;
    };
    metrics: {
        [k: string]: import("./decision-calibration.ts").Reliability;
    };
    observations: Observation[];
    retrieval?: {
        mode: import("./exemplar-retrieval.ts").RetrievalMode;
        count: number;
        token_budget: number;
        embedding_model: string | null;
        embedding_available: boolean | null;
        embedding_fallbacks: number;
        empty_retrievals: number;
        reused_baseline_calls: number;
        budget_clamped_examples: number;
        mean_exemplars: number;
    } | undefined;
    exemplar_metrics?: {
        [k: string]: import("./decision-calibration.ts").Reliability;
    } | undefined;
    baselines?: {
        [k: string]: {
            majority: {
                abstained: number;
                reliability: import("./decision-calibration.ts").Reliability;
            };
            knn: {
                abstained: number;
                reliability: import("./decision-calibration.ts").Reliability;
            };
        };
    } | undefined;
    exemplar_observations?: Observation[] | undefined;
    calibration: import("./decision-calibration.ts").CalibrationReceipt;
    settings_write: {
        changed: boolean;
        reason: string;
    };
} | {
    provenance?: "local-unverified" | undefined;
    version: string;
    task: EvaluationTask;
    model: string;
    model_digest: string;
    seed: string;
    model_calls: number;
    sampled_examples: number;
    eligible_examples: number;
    retrieval_misses: number;
    skipped: string[];
    mean_latency_ms: number;
    tokens: {
        input: number | null;
        output: number | null;
        mean_input: number | null;
        mean_output: number | null;
        unknown_calls: number;
        unknown_input_calls: number;
        unknown_output_calls: number;
    };
    metrics: {
        [k: string]: import("./decision-calibration.ts").Reliability;
    };
    observations: Observation[];
    retrieval?: {
        mode: import("./exemplar-retrieval.ts").RetrievalMode;
        count: number;
        token_budget: number;
        embedding_model: string | null;
        embedding_available: boolean | null;
        embedding_fallbacks: number;
        empty_retrievals: number;
        reused_baseline_calls: number;
        budget_clamped_examples: number;
        mean_exemplars: number;
    } | undefined;
    exemplar_metrics?: {
        [k: string]: import("./decision-calibration.ts").Reliability;
    } | undefined;
    baselines?: {
        [k: string]: {
            majority: {
                abstained: number;
                reliability: import("./decision-calibration.ts").Reliability;
            };
            knn: {
                abstained: number;
                reliability: import("./decision-calibration.ts").Reliability;
            };
        };
    } | undefined;
    exemplar_observations?: Observation[] | undefined;
    calibration: import("./decision-calibration.ts").CalibrationReceipt;
    settings_write: {
        changed: boolean;
        dry_run: boolean;
        replayed: boolean;
        preview?: import("@unbrained/pm-cli/sdk").PmSettings;
    };
}>;
/** Typed completed evaluation or private interruption envelope returned by the host SDK. */
export type EvaluationResult = Awaited<ReturnType<typeof runEvaluationCommand>>;
export {};
//# sourceMappingURL=evaluation-command.d.ts.map