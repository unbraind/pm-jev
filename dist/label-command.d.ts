import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
/** A single portable policy and evidence document; the host renders compact TOON or JSON. */
export declare const LABEL_QUEUE_FLAGS: FlagDefinition[];
/** Use the sole SDK selection path; no SDK client is acquired when there is no tracker I/O. */
export declare function runLabelQueueCommand(ctx: CommandHandlerContext): Promise<import("./label-queue.ts").LabelQueueReport | {
    ok: boolean;
    exit_code: number;
    refusal: {
        code: import("./label-schema.ts").LabelQueueRefusalCode;
        message: string;
        remedy: string;
    };
}>;
//# sourceMappingURL=label-command.d.ts.map