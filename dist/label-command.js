import { readStringOption } from "@unbrained/pm-cli/sdk";
import { readBoundedJson } from "./bounded-json.js";
import { LABEL_QUEUE_LIMITS, LabelQueueRefusal } from "./label-schema.js";
import { selectLabelQueue } from "./label-queue.js";
/** A single portable policy and evidence document; the host renders compact TOON or JSON. */
export const LABEL_QUEUE_FLAGS = [
    { long: "--input", value_name: "file", value_type: "string", description: "pm-jev-label-queue/1 JSON up to 4 MiB; explicit seed, cohort, uncertainty, diversity and labeling budget" },
];
/** Read a bounded document with typed remedies, without acquiring a tracker or provider. */
async function labelDocument(file) {
    try {
        return await readBoundedJson(file, LABEL_QUEUE_LIMITS.bytes);
    }
    catch {
        throw new LabelQueueRefusal("input_unreadable", "Pass --input with a readable regular JSON file up to 4 MiB, using examples/label-queue.json. Directories, pipes and malformed JSON are refused.");
    }
}
/** Use the sole SDK selection path; no SDK client is acquired when there is no tracker I/O. */
export async function runLabelQueueCommand(ctx) {
    try {
        return selectLabelQueue(await labelDocument(readStringOption(ctx.options, "input")));
    }
    catch (error) {
        if (!(error instanceof LabelQueueRefusal))
            throw error;
        return { ok: false, exit_code: 2, refusal: { code: error.code, message: error.message, remedy: error.remedy } };
    }
}
//# sourceMappingURL=label-command.js.map