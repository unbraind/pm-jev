import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isPmCliExpectedError, readStringOption } from "@unbrained/pm-cli/sdk";
import type { FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import type { TokenUsage } from "./token-usage.ts";

/** Stable interruption categories; provider messages and input text are excluded. */
export type InterruptionReason = "sigint" | "timeout" | "provider_error" | "budget_exhausted" | "process_interrupted" | "aborted";
/** Durable content-free accounting; unknown usage and monetary cost remain explicit. */
export interface PartialReceipt {
  version: "pm-jev-partial/1";
  operation: "evaluation" | "replay";
  status: "running" | "complete" | "interrupted";
  reason: InterruptionReason | null;
  attempted_calls: number;
  completed_calls: number;
  model_calls: number;
  inference_calls: number;
  completed_cases: string[];
  tokens: { input: number | null; output: number | null; known_input: number; known_output: number; unknown_calls: number; unknown_input_calls: number; unknown_output_calls: number };
  cost: { amount: number | null; currency: "USD"; basis: "unreported" | "no_inference" };
  evidence: unknown;
  input_sha256: string | null;
  model: string | null;
}
/** Programmatic refusal envelope shared by durable evaluation and replay. */
export interface ReceiptFailure {
  ok: false;
  exit_code: 2;
  receipt?: PartialReceipt;
  refusal: { code: "invalid_receipt_options" | "receipt_exists" | "receipt_io" | "run_interrupted"; remedy: string };
}
/** Receipt selection and hard invocation limits shared by SDK and CLI callers. */
export interface ReceiptOptions {
  file: string;
  maxCalls?: number;
  deadlineMs?: number;
  signal?: AbortSignal;
}
/** Actionable refusal that never echoes a receipt path or provider failure. */
export class ReceiptRefusal extends Error {
  /** Stable recovery category. */
  readonly code: "invalid_receipt_options" | "receipt_exists" | "receipt_io";
  /** Concrete next step. */
  readonly remedy: string;
  /** Existing durable accounting when reporting a prior invocation. */
  readonly receipt?: PartialReceipt;
  /** Build a redacted refusal. */
  constructor(code: ReceiptRefusal["code"], remedy: string, receipt?: PartialReceipt) {
    super(`Partial receipt refused: ${code}.`);
    this.name = "ReceiptRefusal"; this.code = code; this.remedy = remedy; this.receipt = receipt;
  }
}
/** Explicit private checkpoint selection and run budgets. */
export const RECEIPT_FLAGS: FlagDefinition[] = [
  { long: "--receipt", value_name: "file", value_type: "string", description: "Private durable receipt; an existing file reports prior work without inference" },
  { long: "--max-calls", value_name: "N", value_type: "string", description: "Maximum inference attempts for this invocation (no retries)" },
  { long: "--run-deadline-ms", value_name: "N", value_type: "string", description: "Total inference-run deadline in milliseconds" },
];
/** Parse hard bounds before source access; defaults live outside tracker records. */
export function receiptOptions(options: Record<string, unknown>, cwd: string, operation: string): ReceiptOptions {
  const file = readStringOption(options, "receipt");
  const max = readStringOption(options, "maxCalls", ["max-calls", "max_calls"]);
  const deadline = readStringOption(options, "runDeadlineMs", ["run-deadline-ms", "run_deadline_ms"]);
  return { file: options.receipt === undefined ? join(cwd, ".jev-receipts", `${operation}-${randomUUID()}.json`) : file === undefined ? "" : resolve(cwd, file),
    ...(max === undefined ? {} : { maxCalls: Number(max) }), ...(deadline === undefined ? {} : { deadlineMs: Number(deadline) }) };
}
/** Report a prior private checkpoint without source reads, provider access or writes. */
export function reportPriorReceipt(file: string): ReceiptFailure | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const prior = JSON.parse(readFileSync(file, "utf8")) as PartialReceipt;
    if (prior.version !== "pm-jev-partial/1") throw new Error();
    if (prior.status === "running") { prior.status = "interrupted"; prior.reason = "process_interrupted"; }
    return { ok: false, exit_code: 2, receipt: prior, refusal: { code: "receipt_exists", remedy: "Inspect the returned receipt; use a new --receipt file for an explicit rerun. Completed work is never silently repeated." } };
  } catch { return { ok: false, exit_code: 2, refusal: { code: "receipt_io", remedy: "Choose a new writable private receipt file; preserve existing receipts for inspection." } }; }
}

/** One validated inference response with provider usage metadata. */
type UsageResult = { usage: TokenUsage };

/** Classify typed transport timeouts without matching provider prose or recovery advice. */
function failureReason(error: unknown): "timeout" | "provider_error" {
  const code = isPmCliExpectedError(error) ? error.context.code : undefined;
  return code === "jev_timeout" || code === "jev_deadline_exceeded" || (error instanceof Error && error.name === "TimeoutError") ? "timeout" : "provider_error";
}

/** Checkpoint every attempted call and validated completion before advancing the run. */
export class ReceiptRun {
  /** Aborts active local transports when the run is interrupted. */
  readonly controller = new AbortController();
  /** Current durable counters and minimized evidence. */
  readonly receipt: PartialReceipt;
  private readonly file: string;
  private readonly maxCalls: number;
  private readonly deadline: number;
  /** Validate and exclusively reserve a new receipt before doing inference. */
  constructor(operation: PartialReceipt["operation"], options: ReceiptOptions) {
    if (typeof options.file !== "string" || !options.file.trim() || [options.maxCalls, options.deadlineMs].some(/** Bounds must be positive safe integers when present. */ value => value !== undefined && (!Number.isSafeInteger(value) || value < 1))) throw new ReceiptRefusal("invalid_receipt_options", "Supply a nonempty --receipt and positive integer --max-calls and --run-deadline-ms values.");
    this.file = options.file; this.maxCalls = options.maxCalls ?? Number.MAX_SAFE_INTEGER; this.deadline = Date.now() + (options.deadlineMs ?? 2147483647);
    this.receipt = { version: "pm-jev-partial/1", operation, status: "running", reason: null, attempted_calls: 0, completed_calls: 0, model_calls: 0, inference_calls: 0,
      completed_cases: [], tokens: { input: 0, output: 0, known_input: 0, known_output: 0, unknown_calls: 0, unknown_input_calls: 0, unknown_output_calls: 0 }, cost: { amount: 0, currency: "USD", basis: "no_inference" }, evidence: null, input_sha256: null, model: null };
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      const previous = reportPriorReceipt(this.file);
      if (previous !== undefined) throw new ReceiptRefusal(previous.receipt === undefined ? "receipt_io" : "receipt_exists", previous.refusal.remedy, previous.receipt);
      const fd = openSync(this.file, "wx", 0o600); closeSync(fd);
      this.save();
    } catch (error) { if (error instanceof ReceiptRefusal) throw error; throw new ReceiptRefusal("receipt_io", "Choose a new writable private receipt file; preserve existing receipts for inspection."); }
  }
  /** Atomically replace only this invocation's reserved file with private JSON. */
  save(): void {
    try { const temp = `${this.file}.next`; writeFileSync(temp, JSON.stringify(this.receipt), { mode: 0o600, flag: "wx" }); renameSync(temp, this.file); }
    catch { throw new ReceiptRefusal("receipt_io", "Restore writable private receipt storage before rerunning; preserve the last checkpoint."); }
  }
  /** Bind content hashes and model identity without storing raw input. */
  identify(inputHash: string, model: string): void { this.receipt.input_sha256 = inputHash; this.receipt.model = model; this.save(); }
  /** Set minimized evidence without changing the completed-case count. */
  evidence(value: unknown): void { this.receipt.evidence = value; this.save(); }
  /** Mark a finished invocation only if cancellation has not occurred. */
  complete(): void { this.controller.signal.throwIfAborted(); this.receipt.status = "complete"; this.save(); }
  /** Preserve complete cases and content-free observation evidence. */
  checkpoint(id: string, evidence: unknown): void {
    this.receipt.completed_cases.push(id); this.receipt.evidence = evidence; this.save();
  }
  /** Invoke exactly once, recording the attempt before crossing the provider boundary. */
  async call<T extends UsageResult>(/** Exactly one transport invocation; caller validates the returned usage. */ invoke: (signal: AbortSignal) => Promise<T>, model = true): Promise<T> {
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    if (Date.now() >= this.deadline) { this.interrupt("timeout"); throw new Error("timeout"); }
    if (this.receipt.inference_calls >= this.maxCalls) { this.interrupt("budget_exhausted"); throw new Error("budget_exhausted"); }
    this.receipt.attempted_calls++; this.receipt.inference_calls++; if (model) this.receipt.model_calls++;
    const tokens = this.receipt.tokens;
    tokens.unknown_calls++; tokens.unknown_input_calls++; tokens.unknown_output_calls++;
    tokens.input = null; tokens.output = null;
    this.receipt.cost = { amount: null, currency: "USD", basis: "unreported" }; this.save();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(Math.max(1, Math.min(2147483647, this.deadline - Date.now())))]);
    try {
      let cancel: (() => void) | undefined;
      const aborted = new Promise<never>(/** Stop even a trusted adapter that ignores cancellation. */ (_, reject) => {
        cancel = /** Reject the active attempt on cancellation without provider details. */ () => reject(new Error("deadline or interruption"));
        signal.addEventListener("abort", cancel, { once: true });
      });
      let result: T;
      try { result = await Promise.race([invoke(signal), aborted]); }
      finally { signal.removeEventListener("abort", cancel!); }
      signal.throwIfAborted();
      this.receipt.completed_calls++;
      tokens.known_input += result.usage.input_tokens ?? 0; tokens.known_output += result.usage.output_tokens ?? 0;
      if (result.usage.input_tokens !== null && result.usage.output_tokens !== null) tokens.unknown_calls--;
      if (result.usage.input_tokens !== null) tokens.unknown_input_calls--;
      if (result.usage.output_tokens !== null) tokens.unknown_output_calls--;
      tokens.input = tokens.unknown_input_calls === 0 ? tokens.known_input : null;
      tokens.output = tokens.unknown_output_calls === 0 ? tokens.known_output : null;
      this.save(); return result;
    } catch (error) {
      if (this.receipt.reason === null) this.interrupt(signal.aborted ? "timeout" : failureReason(error));
      this.save(); throw error;
    }
  }
  /** Persist interruption before aborting the active request. */
  interrupt(reason: InterruptionReason): void {
    this.receipt.status = "interrupted"; this.receipt.reason = reason;
    try { this.save(); } finally { this.controller.abort(reason); }
  }
}
/** Execute with scoped SIGINT handling and return a typed, redacted partial envelope. */
export async function withReceipt<T>(operation: PartialReceipt["operation"], options: ReceiptOptions, execute: (run: ReceiptRun) => Promise<T>): Promise<T | ReceiptFailure> {
  let run: ReceiptRun | undefined;
  let result: T | ReceiptFailure;
  /** Checkpoint before allowing the request transport to unwind. */
  const interrupt = (reason: InterruptionReason) => {
    try { run!.interrupt(reason); } catch { /* The request unwinds into the typed storage refusal. */ }
  };
  /** Preserve the operating-system signal separately from SDK cancellation. */
  const onInterrupt = () => interrupt("sigint");
  /** A caller's timeout signal retains its typed cause without echoing arbitrary reasons. */
  const onAbort = () => interrupt(failureReason(options.signal!.reason) === "timeout" ? "timeout" : "aborted");
  try {
    run = new ReceiptRun(operation, options);
    if (options.signal?.aborted) onAbort();
    process.once("SIGINT", onInterrupt);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    result = await execute(run);
    run.complete();
  } catch (error) {
    if (error instanceof ReceiptRefusal) {
      const receipt = error.receipt ?? run?.receipt;
      result = { ok: false, exit_code: 2, ...(receipt === undefined ? {} : { receipt }), refusal: { code: error.code, remedy: error.remedy } };
    } else {
      if (run === undefined) throw error;
      try {
        if (run.receipt.reason === null) run.interrupt(failureReason(error)); else run.save();
        result = { ok: false, exit_code: 2, receipt: run.receipt, refusal: { code: "run_interrupted", remedy: "Inspect the private receipt and completed evidence; use a new --receipt file for an explicit rerun. Incomplete evaluations never fit or save calibration." } };
      } catch {
        result = { ok: false, exit_code: 2, receipt: run.receipt, refusal: { code: "receipt_io", remedy: "Restore writable private receipt storage; inspect the returned accounting and preserve the last durable checkpoint." } };
      }
    }
  } finally { process.removeListener("SIGINT", onInterrupt); options.signal?.removeEventListener("abort", onAbort); }
  return result;
}
