import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
/** A file of typed proposals and declarative rules; no apply flag or inference settings. */
export declare const JOINT_FLAGS: FlagDefinition[];
/** Delegate parsing, host reads, compact rendering and semantic exit status to the shared SDK path. */
export declare function runJointCommand(ctx: CommandHandlerContext): Promise<import("./joint-decisions.ts").JointReport | {
    ok: boolean;
    exit_code: number;
    refusal: {
        code: import("./joint-schema.ts").JointRefusalCode;
        message: string;
        remedy: string;
    };
}>;
//# sourceMappingURL=joint-command.d.ts.map