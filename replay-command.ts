import { dirname } from "node:path";
import { RECEIPT_FLAGS, receiptOptions, reportPriorReceipt } from "./partial-receipt.ts";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { readStringOption } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import { createOllamaReplayAdapter, parseReplayRecording, replayDecisions, ReplayRefusal } from "./policy-replay.ts";

/** Explicit file and version selection; native host formatting handles TOON and JSON. */
export const REPLAY_FLAGS: FlagDefinition[] = [
  ...RECEIPT_FLAGS,
  { long: "--recording", value_name: "file", value_type: "string", description: "Frozen minimized replay JSON (maximum 4 MiB); never read current items" },
  { long: "--policy-version", value_name: "version", value_type: "string", description: "Candidate local policy version" },
  { long: "--min-probability", value_name: "p", value_type: "string", description: "Inclusive candidate proposal probability threshold in [0,1]" },
  { long: "--model", value_name: "model", value_type: "string", description: "Installed local Ollama decision model, e.g. tev1:4b; default reuses recorded scores with zero network" },
  { long: "--deadline-ms", value_name: "N", value_type: "string", description: "Per-input local-model deadline 1..300000 ms (default 120000); no retries" },
  { long: "--limit", value_name: "N", value_type: "string", description: "Detail rows 0..100 (default 20); totals always cover every recording" },
];

/** Reject explicitly empty options while preserving the host's alias and type handling. */
function replayOption(ctx: CommandHandlerContext, key: string, aliases: string[] = []): string | undefined {
  const value = readStringOption(ctx.options, key, aliases);
  if ([key, ...aliases].some(/** An explicitly present blank value must not silently select a default. */ name => ctx.options[name] !== undefined) && !value?.trim()) throw new ReplayRefusal("invalid_policy", "Supply nonempty replay option values; omit optional flags to select defaults.");
  return value;
}

/** Bound regular-file reads, including growth after opening, without following a FIFO. */
async function readRecording(file: string) {
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!(await handle.stat()).isFile()) throw new Error();
      const data = await handle.read({ buffer: Buffer.alloc(4194305), position: 0 });
      if (data.bytesRead > 4194304) throw new Error();
      return parseReplayRecording(JSON.parse(data.buffer.subarray(0, data.bytesRead).toString("utf8")) as unknown);
    } finally { await handle.close(); }
  } catch { throw new ReplayRefusal("invalid_recording", "Pass --recording with readable pm-jev-replay/1 JSON in a regular file up to 4 MiB."); }
}

/** Run compatibility inspection without tracker writes, provider settings, or Git subprocesses. */
export async function runReplayCommand(ctx: CommandHandlerContext) {
  try {
    const storage = receiptOptions(ctx.options, ctx.source_workspace_root ?? dirname(ctx.pm_root), "replay");
    const previous = reportPriorReceipt(storage.file);
    if (previous !== undefined) return previous;
    const file = replayOption(ctx, "recording");
    const version = replayOption(ctx, "policyVersion", ["policy-version", "policy_version"]);
    const threshold = replayOption(ctx, "minProbability", ["min-probability", "min_probability"]);
    if (!file || !version || !threshold?.trim()) throw new ReplayRefusal("invalid_policy", "Use pm jev replay --recording recording.json --policy-version candidate-v2 --min-probability 0.8 [--model tev1:4b].");
    const recording = await readRecording(file);
    const policy = { version, min_probability: Number(threshold) };
    const limit = replayOption(ctx, "limit");
    const detailLimit = limit === undefined ? 20 : Number(limit);
    // Validate everything before optional model discovery or inference.
    await replayDecisions(recording, policy, undefined, detailLimit);
    const model = replayOption(ctx, "model");
    const deadline = replayOption(ctx, "deadlineMs", ["deadline-ms", "deadline_ms"]);
    const adapter = model === undefined ? undefined : await createOllamaReplayAdapter(model, undefined, deadline === undefined ? undefined : Number(deadline));
    const report = await replayDecisions(recording, policy, adapter, detailLimit, storage);
    if ("ok" in report) return report;
    return { ok: report.complete, ...(report.complete ? {} : { exit_code: 2 }), ...report };
  } catch (error) {
    if (!(error instanceof ReplayRefusal)) throw error;
    return { ok: false, exit_code: 2, refusal: { code: error.code, message: error.message, remedy: error.remedy } };
  }
}
