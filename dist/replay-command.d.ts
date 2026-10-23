import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
/** Explicit file and version selection; native host formatting handles TOON and JSON. */
export declare const REPLAY_FLAGS: FlagDefinition[];
/** Run compatibility inspection without tracker writes, provider settings, or Git subprocesses. */
export declare function runReplayCommand(ctx: CommandHandlerContext): Promise<{
    version: typeof import("./policy-replay.ts").REPLAY_VERSION;
    recording_sha256: string;
    policy: import("./policy-replay.ts").ReplayPolicy;
    adapter: string;
    complete: boolean;
    records: number;
    attempted: number;
    replayed: number;
    gaps: number;
    compared: number;
    agreement: number;
    disagreement: number;
    old_abstentions: number;
    new_abstentions: number;
    latency_ms: {
        readonly total: number;
        readonly mean: number | null;
    };
    details: readonly {
        readonly index: number;
        readonly gap?: string;
        readonly changed?: readonly string[];
    }[];
    omitted_details: number;
    ok: boolean;
    exit_code?: number | undefined;
    refusal?: undefined;
} | {
    ok: boolean;
    exit_code: number;
    refusal: {
        code: "invalid_policy" | "invalid_recording" | "local_only" | "model_unavailable";
        message: string;
        remedy: string;
    };
}>;
//# sourceMappingURL=replay-command.d.ts.map