import type { Questions } from "@typesafe-ai/sdk";
import type { JevConfig } from "./index.ts";
import { ADMISSION_VERSION } from "./admission-schema.ts";
/** Exact published Tev1 pplx-decider template; unknown templates require explicit new support. */
export declare const TEV1_TEMPLATE_SHA256 = "f2a33c8e30f70f59657efe8353810d61a86500d6f9e2c07d038c960d8a269135";
/** Counts refer to complete independently scored prompts, never a sum of unrelated questions. */
export interface AdmissionReceipt {
    readonly version: typeof ADMISSION_VERSION;
    readonly ok: boolean;
    readonly model_digest: string;
    readonly template_sha256: string;
    readonly tokenizer_sha256: string;
    readonly context_tokens: number;
    readonly scoring_tokens: 1;
    readonly questions: number;
    readonly options: number;
    readonly max_prompt_tokens: number;
    readonly limiting_question_index: number;
    readonly minimum_prompt_tokens_to_remove: number;
    readonly inference_calls: 0;
    readonly mutations: 0;
}
/** An admitted detached request pins inference to a digest rather than the discovery alias. */
export interface AdmittedDecision {
    readonly receipt: AdmissionReceipt;
    readonly state: NonNullable<unknown>;
    readonly questions: Questions;
    readonly model: string;
}
/** Validate emitted domains before returning an affirmative or overflow receipt. */
export declare function validateAdmissionReceipt(receipt: AdmissionReceipt): void;
/** Admit complete typed prompts before inference using metadata addressed by immutable model digest. */
export declare function admitDecision(config: JevConfig, state: unknown, questions: unknown, signal?: AbortSignal): Promise<AdmittedDecision>;
/** Parse a portable document once at the shared CLI/SDK boundary before metadata requests. */
export declare function admitDecisionBatch(config: JevConfig, raw: unknown, signal?: AbortSignal): Promise<AdmittedDecision>;
//# sourceMappingURL=decision-admission.d.ts.map