import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
/** Explicit comparisons are opt-in; there is no mutation or apply flag. */
export declare const EXPLANATION_FLAGS: FlagDefinition[];
/** Reuse host routing, reads and rendering; return redacted typed refusals in either format. */
export declare function runExplanationCommand(ctx: CommandHandlerContext): Promise<{
    version: typeof import("./counterfactual.ts").COUNTERFACTUAL_VERSION;
    complete: boolean;
    model: string | null;
    questions_sha256: string;
    evidence_digest: string;
    baseline: Readonly<Record<string, import("./counterfactual.ts").ExplanationProposal>> | null;
    comparisons: readonly import("./counterfactual.ts").FieldComparison[];
    omitted: readonly {
        readonly field: string;
        readonly reason: "call_limit" | "deadline" | "provider_failure" | "model_changed";
    }[];
    calls: {
        readonly attempted: number;
        readonly succeeded: number;
        readonly limit: number;
        readonly retries: 0;
    };
    usage: {
        readonly input_tokens: number | null;
        readonly output_tokens: number | null;
        readonly unknown_calls: number;
    };
    uncertainty: readonly string[];
    ok: boolean;
    exit_code?: number | undefined;
    refusal?: undefined;
} | {
    ok: boolean;
    exit_code: number;
    refusal: {
        code: "endpoint_refused" | "invalid_request";
        message: string;
        remedy: string;
    };
}>;
//# sourceMappingURL=counterfactual-command.d.ts.map