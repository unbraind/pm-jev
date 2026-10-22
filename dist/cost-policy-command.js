import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { readBooleanOption, readStringOption } from "@unbrained/pm-cli/sdk";
import { CostPolicyRefusal, parseCostDataset, selectAbstentionPolicy } from "./cost-policy.js";
/** Fixed-score policy selection never invokes a provider, git or a mutation SDK. */
export const COST_POLICY_FLAGS = [
    { long: "--observations", value_name: "file", value_type: "string", description: "Versioned fixed-score labelled JSON dataset (maximum 2 MiB, 5000 rows)" },
    { long: "--false-duplicate-cost", value_name: "cost", value_type: "string", description: "Relative penalty for a false duplicate proposal" },
    { long: "--wrong-type-cost", value_name: "cost", value_type: "string", description: "Relative penalty for an incorrect type proposal" },
    { long: "--missed-candidate-cost", value_name: "cost", value_type: "string", description: "Relative penalty for withholding a true duplicate or a type proposal" },
    { long: "--full", value_type: "boolean", description: "Include counts for both splits at every threshold" },
];
/** Read at most the documented bound; errors never reflect paths, labels or raw JSON. */
async function readDataset(file) {
    if (!file)
        throw new CostPolicyRefusal("input_unreadable", "A labelled observations file is required.", "Pass --observations with a fixed-score JSON dataset.");
    try {
        const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            if (!(await handle.stat()).isFile())
                throw new Error("regular file required");
            const buffer = Buffer.alloc(2 * 1024 * 1024 + 1);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            if (bytesRead === buffer.length)
                throw new Error("size limit");
            return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        }
        finally {
            await handle.close();
        }
    }
    catch {
        throw new CostPolicyRefusal("input_unreadable", "Cannot read a JSON dataset within the 2 MiB bound.", "Provide a readable regular JSON file using the documented schema and size limit.");
    }
}
/** Treat missing or empty flags as invalid costs rather than silently assigning zero. */
function costOption(options, name, aliases) {
    const raw = readStringOption(options, name, aliases);
    return raw?.trim() ? Number(raw) : NaN;
}
/** Return bounded TOON/JSON receipts and typed refusals; no tracker state or settings are written. */
export async function runCostPolicyCommand(ctx) {
    try {
        const data = parseCostDataset(await readDataset(readStringOption(ctx.options, "observations")));
        const report = selectAbstentionPolicy(data, {
            false_duplicate: costOption(ctx.options, "falseDuplicateCost", ["false_duplicate_cost", "false-duplicate-cost"]),
            wrong_type: costOption(ctx.options, "wrongTypeCost", ["wrong_type_cost", "wrong-type-cost"]),
            missed_candidate: costOption(ctx.options, "missedCandidateCost", ["missed_candidate_cost", "missed-candidate-cost"]),
        });
        if (readBooleanOption(ctx.options, "full") === true)
            return report;
        return { ...report, curve: report.curve.map(/** Compact rows retain full numeric precision and expose both cost and coverage. */ /** Compact rows retain full numeric precision and expose both cost and coverage. */ point => ({ threshold: point.threshold, selection_cost: point.selection.cost, selection_coverage: point.selection.coverage, heldout_cost: point.heldout.cost, heldout_coverage: point.heldout.coverage })) };
    }
    catch (error) {
        if (!(error instanceof CostPolicyRefusal))
            throw error;
        return { ok: false, exit_code: 2, refusal: { code: error.code, message: error.message, remedy: error.remedy } };
    }
}
//# sourceMappingURL=cost-policy-command.js.map