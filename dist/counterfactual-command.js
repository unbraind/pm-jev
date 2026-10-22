import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { createExtensionCommandSdk, isErrnoError, isPmCliExpectedError, PmClient, readStringOption } from "@unbrained/pm-cli/sdk";
import { parseQuestionsDocument, projectItemState, resolveJevEndpoint } from "./index.js";
import { CounterfactualRefusal, explainDecision, explanationEndpointRefusal } from "./counterfactual.js";
/** Explicit comparisons are opt-in; there is no mutation or apply flag. */
export const EXPLANATION_FLAGS = [
    { long: "--questions", value_name: "file", value_type: "string", description: "Existing typed choice/score/noul question map (maximum 16 KiB)" },
    { long: "--fields", value_name: "names", value_type: "string", description: "Ordered comma-separated projected fields to remove: title,type,status,tags,description,body" },
    { long: "--max-calls", value_name: "N", value_type: "string", description: "Hard request limit including baseline and failures (default 5, maximum 17); no retries" },
];
/** Refuse malformed input with a remedy that never repeats file or item contents. */
function commandRefusal() {
    return new CounterfactualRefusal("invalid_request", "Explanation needs a readable typed question file, item and explicit projected fields.", "Use pm jev explain <id> --questions questions.json --fields title,description --max-calls 3; keep the file within 16 KiB.");
}
/** Bound file reads even if the regular file grows after opening. */
async function explanationQuestions(file) {
    try {
        const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            if (!(await handle.stat()).isFile())
                throw commandRefusal();
            const read = await handle.read({ buffer: Buffer.alloc(16385), position: 0 });
            if (read.bytesRead > 16384)
                throw commandRefusal();
            return parseQuestionsDocument(JSON.parse(read.buffer.subarray(0, read.bytesRead).toString("utf8")));
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (error instanceof SyntaxError || isPmCliExpectedError(error) || isErrnoError(error))
            throw commandRefusal();
        throw error;
    }
}
/** Reuse host routing, reads and rendering; return redacted typed refusals in either format. */
export async function runExplanationCommand(ctx) {
    try {
        const file = readStringOption(ctx.options, "questions");
        const fields = readStringOption(ctx.options, "fields");
        const id = ctx.args[0];
        if (!id?.trim() || !file || !fields)
            throw commandRefusal();
        const questions = await explanationQuestions(file);
        const endpoint = await resolveJevEndpoint(ctx.pm_root, process.env).catch(/** Map known configuration refusals while preserving unexpected failures. */ (error) => {
            if (!isPmCliExpectedError(error))
                throw error;
            throw explanationEndpointRefusal();
        });
        const sdk = ctx.sdk ?? createExtensionCommandSdk(ctx.pm_root, new PmClient({ pmRoot: ctx.pm_root, cwd: ctx.source_workspace_root, author: ctx.global.author }), ctx.global.author, ctx.command);
        const result = await sdk.client.get(id, { fields: "id,title,type,status,priority,tags,description,body" }).catch(/** Only a host-classified missing item is a malformed item selection. */ (error) => {
            if (!sdk.isItemNotFoundError(error))
                throw error;
            throw commandRefusal();
        });
        const rawLimit = readStringOption(ctx.options, "maxCalls", ["max_calls", "max-calls"]);
        const hasLimit = ["maxCalls", "max_calls", "max-calls"].some(/** Empty explicit limits must not silently become the default budget. */ /** Empty explicit limits must not silently become the default budget. */ key => ctx.options[key] !== undefined);
        if (hasLimit && rawLimit === undefined)
            throw commandRefusal();
        const receipt = await explainDecision({ endpoint, evidence: { ...projectItemState(result.item) }, fields: fields.split(",").map(/** Preserve requested order while accepting spaces around field names. */ /** Preserve requested order while accepting spaces around field names. */ field => field.trim()), questions,
            ...(rawLimit === undefined ? {} : { maxCalls: Number(rawLimit) }) });
        return { ok: receipt.baseline !== null, ...(receipt.baseline === null ? { exit_code: 2 } : {}), ...receipt };
    }
    catch (error) {
        if (!(error instanceof CounterfactualRefusal))
            throw error;
        return { ok: false, exit_code: 2, refusal: { code: error.code, message: error.message, remedy: error.remedy } };
    }
}
//# sourceMappingURL=counterfactual-command.js.map