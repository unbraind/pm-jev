import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import { readPublicCorpus } from "./tracker-evaluation.ts";
/** Shared evaluator flags; source paths stay outside every emitted receipt. */
export declare const EVALUATION_FLAGS: FlagDefinition[];
/** Run deterministic public-only evaluation and optionally persist a held-out calibration through the SDK. */
export declare function runEvaluationCommand(ctx: CommandHandlerContext, calibrate: boolean, readCorpus?: typeof readPublicCorpus): Promise<unknown>;
//# sourceMappingURL=evaluation-command.d.ts.map