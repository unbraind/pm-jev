import { readBoundedJson } from "./bounded-json.js";
import { PmClient, readStringOption } from "@unbrained/pm-cli/sdk";
import { validateJointDecisions } from "./joint-decisions.js";
import { JOINT_LIMITS, JointRefusal } from "./joint-schema.js";
/** A file of typed proposals and declarative rules; no apply flag or inference settings. */
export const JOINT_FLAGS = [
    { long: "--batch", value_name: "file", value_type: "string", description: "pm-jev-joint/1 JSON (256 KiB maximum): questions, raw result and joint constraints" },
];
/** Read a bounded regular JSON file, including short reads, without blocking on pipes. */
async function jointFile(file) {
    try {
        return await readBoundedJson(file, JOINT_LIMITS.bytes);
    }
    catch {
        throw new JointRefusal("input_unreadable", "Pass --batch with a readable regular pm-jev-joint/1 JSON file up to 256 KiB; use examples/joint-decisions.json. Directories, pipes and malformed JSON are refused.");
    }
}
/** Delegate parsing, host reads, compact rendering and semantic exit status to the shared SDK path. */
export async function runJointCommand(ctx) {
    try {
        const raw = await jointFile(readStringOption(ctx.options, "batch"));
        return await validateJointDecisions(raw, {
            /** Acquire the host client only after parsing and only for selected relationships. */
            get client() { return ctx.sdk?.client ?? new PmClient({ pmRoot: ctx.pm_root, cwd: ctx.source_workspace_root, author: ctx.global.author, noExtensions: true }); },
        });
    }
    catch (error) {
        if (!(error instanceof JointRefusal))
            throw error;
        return { ok: false, exit_code: 2, refusal: { code: error.code, message: error.message, remedy: error.remedy } };
    }
}
//# sourceMappingURL=joint-command.js.map