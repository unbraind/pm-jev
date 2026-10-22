import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { PmClient, readStringOption } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import { parseQuestionsDocument, projectItemState, resolveJevEndpoint } from "./index.ts";
import type { ProjectableItem } from "./index.ts";
import { CounterfactualRefusal, explainDecision } from "./counterfactual.ts";

/** Explicit comparisons are opt-in; there is no mutation or apply flag. */
export const EXPLANATION_FLAGS: FlagDefinition[] = [
  { long: "--questions", value_name: "file", value_type: "string", description: "Existing typed choice/score/noul question map (maximum 16 KiB)" },
  { long: "--fields", value_name: "names", value_type: "string", description: "Ordered comma-separated projected fields to remove: title,type,status,tags,description,body" },
  { long: "--max-calls", value_name: "N", value_type: "string", description: "Hard request limit including baseline and failures (default 5, maximum 17); no retries" },
];

/** Refuse malformed input with a remedy that never repeats file or item contents. */
function commandRefusal(): CounterfactualRefusal {
  return new CounterfactualRefusal("invalid_request", "Explanation needs a readable typed question file, item and explicit projected fields.", "Use pm jev explain <id> --questions questions.json --fields title,description --max-calls 3; keep the file within 16 KiB.");
}

/** Bound file reads even if the regular file grows after opening. */
async function explanationQuestions(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw commandRefusal();
    const read = await handle.read({ buffer: Buffer.alloc(16385), position: 0 });
    if (read.bytesRead > 16384) throw commandRefusal();
    return parseQuestionsDocument(JSON.parse(read.buffer.subarray(0, read.bytesRead).toString("utf8")) as unknown);
  } finally { await handle.close(); }
}

/** Reuse host routing, reads and rendering; return redacted typed refusals in either format. */
export async function runExplanationCommand(ctx: CommandHandlerContext) {
  try {
    const file = readStringOption(ctx.options, "questions");
    const fields = readStringOption(ctx.options, "fields");
    const id = ctx.args[0];
    if (!id?.trim() || !file || !fields) throw commandRefusal();
    const questions = await explanationQuestions(file);
    const endpoint = await resolveJevEndpoint(ctx.pm_root, process.env);
    const pm = ctx.sdk?.client ?? new PmClient({ pmRoot: ctx.pm_root, cwd: ctx.source_workspace_root, author: ctx.global.author });
    const result = await pm.get(id, { fields: "id,title,type,status,priority,tags,description,body" }) as { item: ProjectableItem };
    const rawLimit = readStringOption(ctx.options, "maxCalls", ["max_calls", "max-calls"]);
    const hasLimit = ["maxCalls", "max_calls", "max-calls"].some(/** Empty explicit limits must not silently become the default budget. */ key => ctx.options[key] !== undefined);
    if (hasLimit && rawLimit === undefined) throw commandRefusal();
    const receipt = await explainDecision({ endpoint, evidence: { ...projectItemState(result.item) }, fields: fields.split(",").map(/** Preserve requested order while accepting spaces around field names. */ field => field.trim()), questions,
      ...(rawLimit === undefined ? {} : { maxCalls: Number(rawLimit) }) });
    return { ok: receipt.baseline !== null, ...(receipt.baseline === null ? { exit_code: 2 } : {}), ...receipt };
  } catch (error) {
    const refusal = error instanceof CounterfactualRefusal ? error : commandRefusal();
    return { ok: false, exit_code: 2, refusal: { code: refusal.code, message: refusal.message, remedy: refusal.remedy } };
  }
}
