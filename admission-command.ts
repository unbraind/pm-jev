import { readStringOption } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import { readBoundedJson } from "./bounded-json.ts";
import { ADMISSION_LIMITS, AdmissionRefusal } from "./admission-schema.ts";
import { admitDecisionBatch } from "./decision-admission.ts";
import { resolveJevEndpoint, requireCallableEndpoint } from "./index.ts";

/** Preflight accepts the same batch as the SDK without inference or tracker writes. */
export const ADMISSION_FLAGS: FlagDefinition[] = [{ long: "--batch", value_name: "file", value_type: "string", description: "pm-jev-admission/1 JSON state and typed questions (64 KiB maximum)" }];
/** Render one compact receipt through the host's TOON/JSON and exit-code contract. */
export async function runAdmissionCommand(ctx: CommandHandlerContext) {
  try {
    let raw: unknown;
    try { raw = await readBoundedJson(readStringOption(ctx.options, "batch"), ADMISSION_LIMITS.bytes); }
    catch { throw new AdmissionRefusal("invalid_input", "Pass --batch with a readable regular pm-jev-admission/1 JSON file up to 64 KiB; see node_modules/pm-jev/examples/decision-admission.json in the project where pm-jev is installed."); }
    const resolved = await resolveJevEndpoint(ctx.pm_root, process.env);
    requireCallableEndpoint(resolved);
    const { receipt } = await admitDecisionBatch(resolved.config, raw);
    return { ...receipt, ...(receipt.ok ? {} : { exit_code: 1, remedy: `Remove at least ${receipt.minimum_prompt_tokens_to_remove} prompt tokens from the limiting prompt, or explicitly select a supported model with a larger digest-bound num_ctx; recheck every question. Questions and options were preserved.` }) };
  } catch (error) {
    if (!(error instanceof AdmissionRefusal)) throw error;
    return { ok: false, exit_code: 2, inference_calls: 0, mutations: 0, refusal: { code: error.code, remedy: error.remedy } };
  }
}
