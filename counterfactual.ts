import { createHmac, randomBytes, createHash } from "node:crypto";
import type { Questions, SystemOneResult, ChoiceResponse, ScoreResponse, NoulResponse } from "@typesafe-ai/sdk";
import { createJevClient, isPmCliExpectedError, parseQuestionsDocument, runDecision } from "./index.ts";
import type { ResolvedJevEndpoint } from "./index.ts";
import { TokenUsageTotals } from "./token-usage.ts";

/** Versioned sensitivity receipt; no narrative rationale or mutation authority. */
export const COUNTERFACTUAL_VERSION = "pm-jev-counterfactual/1";

/** Caller-correctable refusals happen before any decision request. */
export class CounterfactualRefusal extends Error {
  /** Stable refusal category for agent recovery. */
  readonly code: "invalid_request" | "endpoint_refused";
  /** Concrete recovery instruction without input or provider error text. */
  readonly remedy: string;
  /** Construct a redacted, typed refusal. */
  constructor(code: CounterfactualRefusal["code"], message: string, remedy: string) {
    super(message);
    this.name = "CounterfactualRefusal";
    this.code = code;
    this.remedy = remedy;
  }
}

/** One compact typed outcome; score values are rubric levels and noul uses 0.5. */
export interface ExplanationProposal {
  readonly kind: "choice" | "score" | "noul";
  readonly value: string | number | boolean;
  /** Probability of the selected value, including the false noul outcome. */
  readonly probability: number;
}

/** An observed field removal, preserving changed outcomes and distribution movement. */
export interface FieldComparison {
  readonly field: string;
  readonly evidence_digest: string;
  readonly changed: readonly string[];
  readonly proposals: Readonly<Record<string, ExplanationProposal>>;
  readonly max_probability_delta: number;
}

/** Bounded receipt with explicit unknowns, attempts and omitted comparisons. */
export interface CounterfactualReceipt {
  readonly version: typeof COUNTERFACTUAL_VERSION;
  readonly complete: boolean;
  readonly model: string | null;
  readonly questions_sha256: string;
  /** Per-run HMAC; the random key is discarded, preventing cross-run correlation. */
  readonly evidence_digest: string;
  readonly baseline: Readonly<Record<string, ExplanationProposal>> | null;
  readonly comparisons: readonly FieldComparison[];
  readonly omitted: readonly { readonly field: string; readonly reason: "call_limit" | "deadline" | "provider_failure" | "model_changed" }[];
  readonly calls: { readonly attempted: number; readonly succeeded: number; readonly limit: number; readonly retries: 0 };
  readonly usage: { readonly input_tokens: number | null; readonly output_tokens: number | null; readonly unknown_calls: number };
  readonly uncertainty: readonly string[];
}

/** Explicit evidence fields and the existing typed question/model interface. */
export interface CounterfactualOptions {
  readonly endpoint: ResolvedJevEndpoint;
  /** JSON object, at most 32 KiB; removals affect top-level fields only. */
  readonly evidence: Readonly<Record<string, unknown>>;
  /** Ordered, distinct, own field names: 1..16; no nested or inferred removals. */
  readonly fields: readonly string[];
  /** Up to eight existing choice/score/noul questions, 32 options each. */
  readonly questions: Questions;
  /** Includes baseline and failed attempts; defaults to 5, maximum 17. */
  readonly maxCalls?: number;
}

/** Enforce one documented request bound without copying caller content into errors. */
function requireBound(ok: boolean): void {
  if (!ok) throw invalidRequest();
}

/** Share one redacted recovery contract for parse failures and bound violations. */
function invalidRequest(): CounterfactualRefusal {
  return new CounterfactualRefusal("invalid_request", "Explanation input exceeds its bounds or has an invalid shape.", "Use a JSON object up to 32 KiB, 1..16 distinct own fields (names up to 64 characters), 1..8 typed questions with up to 32 options, and --max-calls 1..17.");
}

/** Keep endpoint recovery consistent between SDK construction and CLI resolution. */
export function explanationEndpointRefusal(): CounterfactualRefusal {
  return new CounterfactualRefusal("endpoint_refused", "Decision endpoint configuration refused the explanation.", "Run pm jev doctor; set a valid HTTP(S) PM_JEV_BASE_URL and supported jev.provider, or use the local provider. Hosted endpoints require explicit opt-in and runtime credentials.");
}

/** Freeze caller-owned inputs into JSON snapshots before the first asynchronous call. */
function snapshot(options: CounterfactualOptions) {
  try {
    const evidenceText = JSON.stringify(options.evidence);
    const questionText = JSON.stringify(options.questions);
    requireBound(typeof evidenceText === "string" && Buffer.byteLength(evidenceText) <= 32768 && typeof questionText === "string" && Buffer.byteLength(questionText) <= 16384);
    const evidence = JSON.parse(evidenceText) as Record<string, unknown>;
    requireBound(evidence !== null && typeof evidence === "object" && !Array.isArray(evidence));
    const fields = [...options.fields];
    requireBound(fields.length > 0 && fields.length <= 16 && new Set(fields).size === fields.length);
    for (const field of fields) requireBound(typeof field === "string" && field.length > 0 && field.length <= 64 && Object.hasOwn(evidence, field));
    const questions = parseQuestionsDocument(JSON.parse(questionText) as unknown);
    requireBound(Object.keys(questions).length <= 8);
    for (const [name, question] of Object.entries(questions)) {
      requireBound(name.length <= 64);
      if (question.type === "choice" || question.type === "score") {
        const labels = Object.keys(question.criteria);
        requireBound(labels.length <= 32 && labels.every(/** Keep compact receipts bounded even with caller-defined labels. */ label => label.length <= 64));
      }
    }
    const limit = options.maxCalls ?? 5;
    requireBound(Number.isSafeInteger(limit) && limit >= 1 && limit <= 17);
    return { evidence, fields, questions, limit };
  } catch (error) {
    if (!(error instanceof CounterfactualRefusal || error instanceof TypeError || isPmCliExpectedError(error))) throw error;
    throw invalidRequest();
  }
}

/** Convert validated responses to typed outcomes plus internal full distributions. */
function outcomes(result: SystemOneResult<Questions>, questions: Questions) {
  const proposals: Record<string, ExplanationProposal> = Object.create(null) as Record<string, ExplanationProposal>;
  const distributions: Record<string, Record<string, number>> = Object.create(null) as Record<string, Record<string, number>>;
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      const p = (result.answers[name] as NoulResponse).noul;
      proposals[name] = { kind: "noul", value: p >= 0.5, probability: p >= 0.5 ? p : 1 - p };
      distributions[name] = { true: p, false: 1 - p };
    } else {
      const answer = result.answers[name] as ChoiceResponse | ScoreResponse;
      const probabilities = answer.probabilities as Record<string, number>;
      const winner = Object.keys(probabilities).reduce(/** Stable registry-order tie break for score levels. */ (best, label) => probabilities[label] > probabilities[best] ? label : best);
      const value = answer.type === "choice" ? answer.choice : Number(winner);
      proposals[name] = { kind: answer.type, value, probability: probabilities[String(value)] };
      distributions[name] = probabilities;
    }
  }
  return { proposals, distributions };
}

/** Measure local sensitivity with sequential calls, no retries and one shared deadline. */
export async function explainDecision(options: CounterfactualOptions, env: Record<string, string | undefined> = process.env): Promise<CounterfactualReceipt> {
  const { evidence, fields, questions, limit } = snapshot(options);
  let client;
  try { client = createJevClient(options.endpoint, env, 0); }
  catch (error) {
    if (!isPmCliExpectedError(error)) throw error;
    throw explanationEndpointRefusal();
  }
  const signal = AbortSignal.timeout(options.endpoint.config.totalDeadlineMs);
  const key = randomBytes(32);
  /** Keyed digests identify exact evidence within this receipt without exposing it. */
  const digest = (state: unknown): string => createHmac("sha256", key).update(JSON.stringify(state)).digest("hex");
  const usage = new TokenUsageTotals();
  let attempted = 0, succeeded = 0;
  let baseline: ReturnType<typeof outcomes> | null = null;
  let model: string | null = null;
  let stopped: CounterfactualReceipt["omitted"][number]["reason"] | null = null;
  const comparisons: FieldComparison[] = [];
  const omitted: CounterfactualReceipt["omitted"][number][] = [];
  for (const field of [null, ...fields]) {
    if (signal.aborted) stopped = "deadline";
    if (attempted >= limit && stopped === null) stopped = "call_limit";
    if (stopped !== null) { if (field !== null) omitted.push({ field, reason: stopped }); continue; }
    const state = { ...evidence };
    if (field !== null) delete state[field];
    attempted++;
    try {
      const result = await runDecision(client, options.endpoint.config, state, questions, signal);
      succeeded++;
      usage.add(result.usage);
      if (model !== null && model !== result.model) stopped = "model_changed";
      else {
        model = result.model;
        const current = outcomes(result, questions);
        if (field === null) baseline = current;
        else {
          const original = baseline as NonNullable<typeof baseline>;
          const changed = Object.keys(questions).filter(/** Only typed outcome changes count; probability drift is reported separately. */ name => original.proposals[name].value !== current.proposals[name].value);
          const deltas = Object.keys(questions).flatMap(/** Inspect every label, including losers, rather than only the winning probability. */ name => Object.keys(original.distributions[name]).map(/** Compare identical question labels across the two validated responses. */ label => Math.abs(original.distributions[name][label] - current.distributions[name][label])));
          comparisons.push({ field, evidence_digest: digest(state), changed, proposals: current.proposals, max_probability_delta: Math.max(...deltas) });
        }
      }
    } catch (error) {
      if (!isPmCliExpectedError(error)) throw error;
      stopped = signal.aborted ? "deadline" : "provider_failure";
    }
    if (stopped !== null && field !== null) omitted.push({ field, reason: stopped });
  }
  return { version: COUNTERFACTUAL_VERSION, complete: baseline !== null && omitted.length === 0, model,
    questions_sha256: createHash("sha256").update(JSON.stringify(questions)).digest("hex"), evidence_digest: digest(evidence),
    baseline: baseline === null ? null : baseline.proposals, comparisons, omitted,
    calls: { attempted, succeeded, limit, retries: 0 },
    usage: { input_tokens: attempted === succeeded ? usage.inputTokens : null, output_tokens: attempted === succeeded ? usage.outputTokens : null, unknown_calls: usage.unknownCalls + attempted - succeeded },
    uncertainty: ["single_sample_per_state", "model_stochasticity_unmeasured", "field_interactions_unmeasured", "sensitivity_is_not_causation", "only_supplied_evidence_tested"] };
}
