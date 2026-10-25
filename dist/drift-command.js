import { closeSync, fstatSync, openSync, readSync, constants } from "node:fs";
import { readStringOption } from "@unbrained/pm-cli/sdk";
import { checkCalibrationDrift, DriftRefusal } from "./calibration-drift.js";
/** The native host formats the constant-size report as TOON or JSON. */
export const DRIFT_FLAGS = [
    { long: "--cohorts", value_name: "file", value_type: "string", description: "Frozen pm-jev-drift/1 JSON, at most 8 MiB; no inference or writes" },
];
/** Read a bounded regular file even if it grows concurrently; never follow a blocking FIFO. */
function cohortDocument(file) {
    if (!file?.trim())
        throw new DriftRefusal("input_unreadable", "Pass --cohorts cohorts.json using the documented drift example.");
    try {
        const descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
            if (!fstatSync(descriptor).isFile())
                throw new Error();
            const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
            const length = readSync(descriptor, buffer, 0, buffer.length, 0);
            if (length === buffer.length)
                throw new Error();
            return JSON.parse(buffer.toString("utf8", 0, length));
        }
        finally {
            closeSync(descriptor);
        }
    }
    catch {
        throw new DriftRefusal("input_unreadable", "Provide a readable regular JSON file up to 8 MiB; no directory, pipe or malformed JSON.");
    }
}
/** Pure diagnostic command: no settings, model discovery, Git, journal or tracker write path. */
export function runDriftCommand(ctx) {
    try {
        return checkCalibrationDrift(cohortDocument(readStringOption(ctx.options, "cohorts")));
    }
    catch (error) {
        if (!(error instanceof DriftRefusal))
            throw error;
        return { ok: false, exit_code: 2, refusal: { code: error.code, message: error.message, remedy: error.remedy } };
    }
}
//# sourceMappingURL=drift-command.js.map