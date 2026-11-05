import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
/** Preflight accepts the same batch as the SDK without inference or tracker writes. */
export declare const ADMISSION_FLAGS: FlagDefinition[];
/** Render one compact receipt through the host's TOON/JSON and exit-code contract. */
export declare function runAdmissionCommand(ctx: CommandHandlerContext): Promise<{
    version: typeof import("./admission-schema.ts").ADMISSION_VERSION;
    ok: boolean;
    model_digest: string;
    template_sha256: string;
    tokenizer_sha256: string;
    context_tokens: number;
    scoring_tokens: 1;
    questions: number;
    options: number;
    max_prompt_tokens: number;
    limiting_question_index: number;
    minimum_prompt_tokens_to_remove: number;
    inference_calls: 0;
    mutations: 0;
    refusal?: undefined;
    exit_code?: number | undefined;
    remedy?: string | undefined;
} | {
    ok: boolean;
    exit_code: number;
    inference_calls: number;
    mutations: number;
    refusal: {
        code: import("./admission-schema.ts").AdmissionRefusalCode;
        remedy: string;
    };
}>;
//# sourceMappingURL=admission-command.d.ts.map