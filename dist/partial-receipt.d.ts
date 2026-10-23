import type { FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import type { TokenUsage } from "./token-usage.ts";
/** Stable interruption categories; provider messages and input text are excluded. */
export type InterruptionReason = "sigint" | "timeout" | "provider_error" | "budget_exhausted" | "process_interrupted" | "aborted";
/** Durable content-free accounting; unknown usage and monetary cost remain explicit. */
export interface PartialReceipt {
    version: "pm-jev-partial/1";
    operation: "evaluation" | "replay";
    status: "running" | "complete" | "interrupted";
    reason: InterruptionReason | null;
    attempted_calls: number;
    completed_calls: number;
    model_calls: number;
    inference_calls: number;
    completed_cases: string[];
    tokens: {
        input: number | null;
        output: number | null;
        known_input: number;
        known_output: number;
        unknown_calls: number;
        unknown_input_calls: number;
        unknown_output_calls: number;
    };
    cost: {
        amount: number | null;
        currency: "USD";
        basis: "unreported" | "no_inference";
    };
    evidence: unknown;
    input_sha256: string | null;
    model: string | null;
}
/** Programmatic refusal envelope shared by durable evaluation and replay. */
export interface ReceiptFailure {
    ok: false;
    exit_code: 2;
    receipt?: PartialReceipt;
    refusal: {
        code: "invalid_receipt_options" | "receipt_exists" | "receipt_io" | "run_interrupted";
        remedy: string;
    };
}
/** Receipt selection and hard invocation limits shared by SDK and CLI callers. */
export interface ReceiptOptions {
    file: string;
    maxCalls?: number;
    deadlineMs?: number;
    signal?: AbortSignal;
}
/** Actionable refusal that never echoes a receipt path or provider failure. */
export declare class ReceiptRefusal extends Error {
    /** Stable recovery category. */
    readonly code: "invalid_receipt_options" | "receipt_exists" | "receipt_io";
    /** Concrete next step. */
    readonly remedy: string;
    /** Existing durable accounting when reporting a prior invocation. */
    readonly receipt?: PartialReceipt;
    /** Build a redacted refusal. */
    constructor(code: ReceiptRefusal["code"], remedy: string, receipt?: PartialReceipt);
}
/** Explicit private checkpoint selection and run budgets. */
export declare const RECEIPT_FLAGS: FlagDefinition[];
/** Parse hard bounds before source access; defaults live outside tracker records. */
export declare function receiptOptions(options: Record<string, unknown>, cwd: string, operation: string): ReceiptOptions;
/** Report a prior private checkpoint without source reads, provider access or writes. */
export declare function reportPriorReceipt(file: string): ReceiptFailure | undefined;
/** One validated inference response with provider usage metadata. */
type UsageResult = {
    usage: TokenUsage;
};
/** Checkpoint every attempted call and validated completion before advancing the run. */
export declare class ReceiptRun {
    /** Aborts active local transports when the run is interrupted. */
    readonly controller: AbortController;
    /** Current durable counters and minimized evidence. */
    readonly receipt: PartialReceipt;
    private readonly file;
    private readonly maxCalls;
    private readonly deadline;
    /** Validate and exclusively reserve a new receipt before doing inference. */
    constructor(operation: PartialReceipt["operation"], options: ReceiptOptions);
    /** Atomically replace only this invocation's reserved file with private JSON. */
    save(): void;
    /** Bind content hashes and model identity without storing raw input. */
    identify(inputHash: string, model: string): void;
    /** Set minimized evidence without changing the completed-case count. */
    evidence(value: unknown): void;
    /** Mark a finished invocation only if cancellation has not occurred. */
    complete(): void;
    /** Preserve complete cases and content-free observation evidence. */
    checkpoint(id: string, evidence: unknown): void;
    /** Invoke exactly once, recording the attempt before crossing the provider boundary. */
    call<T extends UsageResult>(/** Exactly one transport invocation; caller validates the returned usage. */ invoke: (signal: AbortSignal) => Promise<T>, model?: boolean): Promise<T>;
    /** Persist interruption before aborting the active request. */
    interrupt(reason: InterruptionReason): void;
}
/** Execute with scoped SIGINT handling and return a typed, redacted partial envelope. */
export declare function withReceipt<T>(operation: PartialReceipt["operation"], options: ReceiptOptions, execute: (run: ReceiptRun) => Promise<T>): Promise<T | ReceiptFailure>;
export {};
//# sourceMappingURL=partial-receipt.d.ts.map