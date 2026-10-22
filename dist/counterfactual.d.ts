import type { Questions } from "@typesafe-ai/sdk";
import type { ResolvedJevEndpoint } from "./index.ts";
/** Versioned sensitivity receipt; no narrative rationale or mutation authority. */
export declare const COUNTERFACTUAL_VERSION = "pm-jev-counterfactual/1";
/** Caller-correctable refusals happen before any decision request. */
export declare class CounterfactualRefusal extends Error {
    /** Stable refusal category for agent recovery. */
    readonly code: "invalid_request" | "endpoint_refused";
    /** Concrete recovery instruction without input or provider error text. */
    readonly remedy: string;
    /** Construct a redacted, typed refusal. */
    constructor(code: CounterfactualRefusal["code"], message: string, remedy: string);
}
/** One compact typed outcome; score values are rubric levels and noul uses 0.5. */
export interface ExplanationProposal {
    readonly kind: "choice" | "score" | "noul";
    readonly value: string | number | boolean;
    readonly probability: number;
}
/** An observed field removal, preserving changed outcomes and distribution movement. */
export interface FieldComparison {
    readonly field: string;
    readonly evidence_digest: string;
    readonly changed: readonly string[];
    readonly proposals: Readonly<Record<string, ExplanationProposal>>;
    readonly max_probability_delta: number;
}
/** Bounded receipt with explicit unknowns, attempts and omitted comparisons. */
export interface CounterfactualReceipt {
    readonly version: typeof COUNTERFACTUAL_VERSION;
    readonly complete: boolean;
    readonly model: string | null;
    readonly questions_sha256: string;
    /** Per-run HMAC; the random key is discarded, preventing cross-run correlation. */
    readonly evidence_digest: string;
    readonly baseline: Readonly<Record<string, ExplanationProposal>> | null;
    readonly comparisons: readonly FieldComparison[];
    readonly omitted: readonly {
        readonly field: string;
        readonly reason: "call_limit" | "deadline" | "provider_failure" | "model_changed";
    }[];
    readonly calls: {
        readonly attempted: number;
        readonly succeeded: number;
        readonly limit: number;
        readonly retries: 0;
    };
    readonly usage: {
        readonly input_tokens: number | null;
        readonly output_tokens: number | null;
        readonly unknown_calls: number;
    };
    readonly uncertainty: readonly string[];
}
/** Explicit evidence fields and the existing typed question/model interface. */
export interface CounterfactualOptions {
    readonly endpoint: ResolvedJevEndpoint;
    /** JSON object, at most 32 KiB; removals affect top-level fields only. */
    readonly evidence: Readonly<Record<string, unknown>>;
    /** Ordered, distinct, own field names: 1..16; no nested or inferred removals. */
    readonly fields: readonly string[];
    /** Up to eight existing choice/score/noul questions, 32 options each. */
    readonly questions: Questions;
    /** Includes baseline and failed attempts; defaults to 5, maximum 17. */
    readonly maxCalls?: number;
}
/** Measure local sensitivity with sequential calls, no retries and one shared deadline. */
export declare function explainDecision(options: CounterfactualOptions, env?: Record<string, string | undefined>): Promise<CounterfactualReceipt>;
//# sourceMappingURL=counterfactual.d.ts.map