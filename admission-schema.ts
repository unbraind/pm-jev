import type { Questions } from "@typesafe-ai/sdk";
import { parseQuestionsDocument } from "./questions-document.ts";

/** Version of the read-only, text-only decision admission document. */
export const ADMISSION_VERSION = "pm-jev-admission/1";
/** Bounds apply before serialization, network requests or tokenizer construction. */
export const ADMISSION_LIMITS = Object.freeze({ bytes: 65536, questions: 64, options: 255, nodes: 16384, depth: 12, context: 1048576 });
/** Content-free refusals distinguish invalid data, unsupported profiles and transport failures. */
export type AdmissionRefusalCode = "invalid_input" | "unsupported_model" | "metadata_unavailable" | "invalid_report" | "context_exceeded" | "option_limit_exceeded";
/** A stable refusal never repeats state, question text or provider response bodies. */
export class AdmissionRefusal extends Error {
  /** Stable machine classification of the refusal. */
  readonly code: AdmissionRefusalCode;
  /** Concrete next step without source data. */
  readonly remedy: string;
  /** Preserve a machine code and actionable remedy for SDK and CLI callers. */
  constructor(code: AdmissionRefusalCode, remedy: string) {
    super(`Decision admission refused: ${code}. ${remedy}`);
    this.name = "AdmissionRefusal";
    this.code = code; this.remedy = remedy;
  }
}
/** One detached batch retains the exact state, question names, order and criteria. */
export interface AdmissionInput {
  readonly version: typeof ADMISSION_VERSION;
  readonly state: NonNullable<unknown>;
  readonly questions: Questions;
}
/** Reject unsupported input through the single schema shared by preflight and inference. */
function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new AdmissionRefusal("invalid_input", "Use pm-jev-admission/1 with non-null JSON state, 1..64 choice/score/noul questions, 1..255 choice options and 2..10 score levels, within 64 KiB. Use dense arrays, safe integer numbers, well-formed strings and documented fields only.");
}
/** Traverse before cloning: JSON must not silently erase holes, infinities, cycles or undefined entries. */
function json(value: unknown, depth = 0, budget = { nodes: ADMISSION_LIMITS.nodes, chars: ADMISSION_LIMITS.bytes }): void {
  requireInput(--budget.nodes >= 0 && depth <= ADMISSION_LIMITS.depth);
  if (typeof value === "string") { budget.chars -= value.length; requireInput(!/[\uD800-\uDFFF]/u.test(value) && budget.chars >= 0); return; }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { requireInput(Number.isSafeInteger(value)); return; }
  requireInput(typeof value === "object" && value !== null);
  if (Array.isArray(value)) {
    requireInput(value.length <= ADMISSION_LIMITS.nodes && Object.keys(value).length === value.length);
    for (let i = 0; i < value.length; i++) { requireInput(Object.hasOwn(value, i)); json(value[i], depth + 1, budget); }
  } else {
    requireInput(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
    for (const [key, entry] of Object.entries(value)) {
      budget.chars -= key.length; requireInput(!/[\uD800-\uDFFF]/u.test(key) && budget.chars >= 0);
      // Optional question fields may be absent in typed producer objects; JSON omits them on the wire.
      if (entry !== undefined) json(entry, depth + 1, budget);
    }
  }
}
/** Require own schema fields and reject misspelled options rather than dropping them. */
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  requireInput(typeof value === "object" && value !== null && !Array.isArray(value));
  requireInput(Object.keys(value).every(/** Only documented fields cross the boundary. */ key => fields.includes(key)));
  return value as Record<string, unknown>;
}
/** Validate the original JSON once, then use the existing producer question parser without normalization copies. */
export function parseAdmissionInput(raw: unknown): AdmissionInput {
  json(raw);
  requireInput(Buffer.byteLength(JSON.stringify(raw)) <= ADMISSION_LIMITS.bytes);
  const doc = record(raw, ["version", "state", "questions"]);
  requireInput(doc.version === ADMISSION_VERSION && doc.state !== null && doc.state !== undefined);
  requireInput(typeof doc.questions === "object" && doc.questions !== null && !Array.isArray(doc.questions));
  const entries = Object.entries(doc.questions);
  requireInput(entries.length >= 1 && entries.length <= ADMISSION_LIMITS.questions);
  for (const [name, value] of entries) {
    requireInput(name.length > 0 && name.length <= 128);
    const q = record(value, ["type", "criteria", "instructions"]);
    if (q.type === "choice") {
      requireInput(typeof q.criteria === "object" && q.criteria !== null && !Array.isArray(q.criteria));
      requireInput(Object.keys(q.criteria).length >= 1 && Object.keys(q.criteria).length <= ADMISSION_LIMITS.options);
    } else if (q.type === "score") requireInput(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10);
    else { requireInput(q.type === "noul"); if (q.criteria !== undefined && q.criteria !== null) record(q.criteria, ["false", "true"]); }
  }
  let questions: Questions;
  try { questions = parseQuestionsDocument(doc.questions); }
  catch { requireInput(false); }
  return { version: ADMISSION_VERSION, state: structuredClone(doc.state), questions: structuredClone(questions) };
}
