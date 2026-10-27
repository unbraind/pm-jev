import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
/** The native host formats the constant-size report as TOON or JSON. */
export declare const DRIFT_FLAGS: FlagDefinition[];
/** Pure diagnostic command: no settings, model discovery, Git, journal or tracker write path. */
export declare function runDriftCommand(ctx: CommandHandlerContext): import("./calibration-drift.ts").DriftReport | {
    ok: boolean;
    exit_code: number;
    refusal: {
        code: import("./calibration-drift.ts").DriftRefusalCode;
        message: string;
        remedy: string;
    };
};
//# sourceMappingURL=drift-command.d.ts.map