import type { Questions } from "@typesafe-ai/sdk";
/** Version of the read-only, text-only decision admission document. */
export declare const ADMISSION_VERSION = "pm-jev-admission/1";
/** Bounds apply before serialization, network requests or tokenizer construction. */
export declare const ADMISSION_LIMITS: Readonly<{
    bytes: 65536;
    questions: 64;
    options: 255;
    nodes: 16384;
    depth: 12;
    context: 1048576;
}>;
/** Content-free refusals distinguish invalid data, unsupported profiles and transport failures. */
export type AdmissionRefusalCode = "invalid_input" | "unsupported_model" | "ambiguous_model" | "metadata_unavailable" | "invalid_report" | "context_exceeded" | "option_limit_exceeded";
/** A stable refusal never repeats state, question text or provider response bodies. */
export declare class AdmissionRefusal extends Error {
    /** Stable machine classification of the refusal. */
    readonly code: AdmissionRefusalCode;
    /** Concrete next step without source data. */
    readonly remedy: string;
    /** Preserve a machine code and actionable remedy for SDK and CLI callers. */
    constructor(code: AdmissionRefusalCode, remedy: string);
}
/** One detached batch retains the exact state, question names, order and criteria. */
export interface AdmissionInput {
    readonly version: typeof ADMISSION_VERSION;
    readonly state: NonNullable<unknown>;
    readonly questions: Questions;
}
/** Validate the bounded input, then parse the SDK JSON representation before counting any questions or options. */
export declare function parseAdmissionInput(raw: unknown): AdmissionInput;
//# sourceMappingURL=admission-schema.d.ts.map