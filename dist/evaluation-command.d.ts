import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import { readPublicCorpus } from "./tracker-evaluation.ts";
import type { Questions } from "@typesafe-ai/sdk";
/** Shared evaluator flags; source paths stay outside every emitted receipt. */
export declare const EVALUATION_FLAGS: FlagDefinition[];
/** Label space of one question channel, matching the model's answer schema. */
export declare function channelLabels(question: Questions[string]): string[];
/** Run public or explicitly opted-in local evaluation; only public calibration enters project settings. */
export declare function runEvaluationCommand(ctx: CommandHandlerContext, calibrate: boolean, readCorpus?: typeof readPublicCorpus): Promise<unknown>;
//# sourceMappingURL=evaluation-command.d.ts.map