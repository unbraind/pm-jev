/** Generate reproducible calibration input and publish complete reports without truncating existing readers' files. */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { calibrate, datasetBytes, generateDataset, readDataset } from "../calibration.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Parsed command values let defaults be tested without connecting to Ollama. */
export type CalibrationCommand =
  | { readonly mode: "generate"; readonly seed: number; readonly output: string }
  | { readonly mode: "run"; readonly model: string; readonly baseUrl: string; readonly output: string; readonly target: number };

/** Validate positional command arguments before reading or writing files. */
export function parseArgs(args: readonly string[]): CalibrationCommand {
  const [mode, first, second, third, fourth] = args;
  if (args.length > 5) throw new Error("Too many calibration arguments");
  if (mode === "generate") {
    if (third !== undefined) throw new Error("Usage: generate [seed] [output]");
    const seed = first === undefined ? 20261008 : Number(first);
    return { mode, seed, output: second === undefined ? "calibration/dataset-v1.json" : second };
  } else if (mode === "run") {
    const model = first === undefined ? "tev1:4b" : first;
    const baseUrl = second === undefined ? "http://127.0.0.1:11434" : second;
    const output = third === undefined ? "calibration/report-v1.json" : third;
    const target = fourth === undefined ? 0.95 : Number(fourth);
    return { mode, model, baseUrl, output, target };
  } else throw new Error("Usage: generate [seed] [output] | run [model] [loopback-origin] [output] [target-precision]");
}

/** Opt-in entry point; fixed synthetic input and explicit positional local settings. */
export async function main(args: readonly string[]): Promise<void> {
  /** Validated output destination and local-only calibration parameters. */
  const command = parseArgs(args);
  /** Fully computed bytes precede filesystem mutation, so failed calibration leaves the previous result intact. */
  const contents = command.mode === "generate"
    ? datasetBytes(generateDataset(command.seed))
    : `${JSON.stringify(await calibrate(readDataset(readFileSync("calibration/dataset-v1.json", "utf8")), command.baseUrl, command.model, command.target), null, 2)}\n`;
  /** Exclusive same-directory file permits one atomic rename of a flushed complete result. */
  const temporary = join(dirname(command.output), `.${basename(command.output)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, command.output);
  } finally {
    rmSync(temporary, { force: true });
  }
}

await [/** Leave imports inert while retaining a testable command entry. */ async (_args: readonly string[]): Promise<void> => {}, main][Number(isMainInvocation(process.argv, import.meta.url))](process.argv.slice(2));
