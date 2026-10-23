import { createHash } from "node:crypto";
import type { Questions, SystemOneResult, ChoiceResponse, ScoreResponse, NoulResponse } from "@typesafe-ai/sdk";
import { createJevClient, parseQuestionsDocument, runDecision, validateAnswers } from "./index.ts";
import type { JevConfig } from "./index.ts";

/** Version of the frozen-input compatibility contract. */
export const REPLAY_VERSION = "pm-jev-replay/1";

/** Redacted, actionable replay failure; input and transport text are never echoed. */
export class ReplayRefusal extends Error {
  /** Stable category suitable for programmatic recovery. */
  readonly code: "invalid_recording" | "invalid_policy" | "local_only" | "model_unavailable";
  /** Recovery guidance without source evidence or transport details. */
  readonly remedy: string;
  /** Construct a stable refusal with a recovery instruction. */
  constructor(code: ReplayRefusal["code"], remedy: string) {
    super(`Decision replay refused: ${code}.`);
    this.name = "ReplayRefusal";
    this.code = code;
    this.remedy = remedy;
  }
}

/** Versioned probability filter, inclusive at the threshold. */
export interface ReplayPolicy {
  readonly version: string;
  readonly min_probability: number;
}

/** Frozen minimized state, exact questions, raw validated answer and original policy. */
export interface ReplayRecord {
  readonly id: string;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly questions?: Questions;
  readonly result?: SystemOneResult<Questions>;
  readonly policy?: ReplayPolicy;
}

/** Portable recordings; omitted inputs remain explicit gaps instead of being reconstructed. */
export interface ReplayRecording {
  readonly version: typeof REPLAY_VERSION;
  readonly records: readonly ReplayRecord[];
}

/** Trusted in-process adapter; only the built-in Ollama adapter makes local HTTP calls. */
export interface ReplayAdapter {
  readonly version: string;
  decide(record: Required<ReplayRecord>): Promise<SystemOneResult<Questions>>;
}

/** Compact totals over all questions, independently of the bounded detail rows. */
export interface ReplayReport {
  readonly version: typeof REPLAY_VERSION;
  readonly recording_sha256: string;
  readonly policy: ReplayPolicy;
  readonly adapter: string;
  readonly complete: boolean;
  readonly records: number;
  readonly attempted: number;
  readonly replayed: number;
  readonly gaps: number;
  readonly compared: number;
  readonly agreement: number;
  readonly disagreement: number;
  readonly old_abstentions: number;
  readonly new_abstentions: number;
  readonly latency_ms: { readonly total: number; readonly mean: number | null };
  readonly details: readonly { readonly index: number; readonly gap?: string; readonly changed?: readonly string[] }[];
  readonly omitted_details: number;
}

/** Validate labels without allowing unbounded or path-shaped metadata in receipts. */
function label(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_.:@+-]{1,128}$/.test(value);
}

/** Check versioned policies at both the recording and candidate boundaries. */
function checkPolicy(policy: ReplayPolicy): void {
  if (!policy || !label(policy.version) || !Number.isFinite(policy.min_probability) || policy.min_probability < 0 || policy.min_probability > 1) {
    throw new ReplayRefusal("invalid_policy", "Supply a policy version and min_probability between 0 and 1.");
  }
}

/** Parse and snapshot bounded JSON data; missing fields are allowed, malformed fields refuse. */
export function parseReplayRecording(raw: unknown): ReplayRecording {
  try {
    const text = JSON.stringify(raw);
    if (Buffer.byteLength(text) > 4194304) throw new Error();
    const doc = JSON.parse(text) as ReplayRecording;
    if (!doc || doc.version !== REPLAY_VERSION || !Array.isArray(doc.records) || doc.records.length > 1000) throw new Error();
    const ids = new Set<string>();
    for (const row of doc.records) {
      if (!row || !label(row.id) || ids.has(row.id)) throw new Error();
      ids.add(row.id);
      if (row.state !== undefined && (!row.state || typeof row.state !== "object" || Array.isArray(row.state) || Buffer.byteLength(JSON.stringify(row.state)) > 32768)) throw new Error();
      if (row.questions !== undefined) {
        const questions = parseQuestionsDocument(row.questions);
        if (Object.keys(questions).length > 8 || Object.keys(questions).some(/** Keep question detail labels bounded. */ name => !label(name))) throw new Error();
        for (const question of Object.values(questions)) {
          if (question.type === "choice" && (Object.keys(question.criteria).length > 32 || Object.keys(question.criteria).some(/** Bound option labels carried by typed proposals. */ option => !label(option)))) throw new Error();
          if (question.type === "score" && question.criteria.length > 32) throw new Error();
        }
        if (row.result !== undefined) validateAnswers(questions, row.result);
      }
      if (row.policy !== undefined) checkPolicy(row.policy);
    }
    return doc;
  } catch {
    throw new ReplayRefusal("invalid_recording", "Supply pm-jev-replay/1 JSON up to 4 MiB with at most 1000 distinct records, 32 KiB states and 1..8 typed questions (32 options maximum). Omit unavailable inputs to report gaps.");
  }
}

/** Reduce the existing validated typed answers to proposals using an explicit policy. */
function proposals(record: Required<ReplayRecord>, result: SystemOneResult<Questions>, policy: ReplayPolicy): (string | number | boolean | null)[] {
  return Object.entries(record.questions).map(/** Compare the selected value; score uses the stable winning rubric level. */ ([name, question]) => {
    if (question.type === "noul") {
      const p = (result.answers[name] as NoulResponse).noul;
      return Math.max(p, 1 - p) >= policy.min_probability ? p >= 0.5 : null;
    }
    const answer = result.answers[name] as ChoiceResponse | ScoreResponse;
    const distribution = answer.probabilities as Record<string, number>;
    const winner = Object.keys(distribution).reduce(/** Stable label-order ties match the existing explanation adapter. */ (best, key) => distribution[key] > distribution[best] ? key : best);
    const value = answer.type === "choice" ? answer.choice : Number(winner);
    return distribution[String(value)] >= policy.min_probability ? value : null;
  });
}

/** Replay saved scores locally or call a trusted local adapter, never read current tracker state. */
export async function replayDecisions(recording: ReplayRecording, policy: ReplayPolicy, adapter?: ReplayAdapter, detailLimit = 20): Promise<ReplayReport> {
  const doc = parseReplayRecording(recording);
  const selected = { ...policy };
  checkPolicy(selected);
  if (!Number.isSafeInteger(detailLimit) || detailLimit < 0 || detailLimit > 100 || (adapter !== undefined && !label(adapter.version))) throw new ReplayRefusal("invalid_policy", "Use a detail limit from 0 to 100 and a bounded adapter version.");
  let attempted = 0, replayed = 0, gaps = 0, compared = 0, agreement = 0, disagreement = 0, oldAbstentions = 0, newAbstentions = 0, elapsed = 0;
  const details: ReplayReport["details"][number][] = [];
  for (const [index, row] of doc.records.entries()) {
    let gap = ["state", "questions", "result", "policy"].filter(/** Never fetch or infer missing historical inputs. */ field => !Object.hasOwn(row, field)).join(",");
    const changed: string[] = [];
    if (!gap) {
      const ready = row as Required<ReplayRecord>;
      attempted++;
      const started = performance.now();
      let next;
      try {
        next = adapter === undefined ? ready.result : await adapter.decide(structuredClone(ready));
        validateAnswers(ready.questions, next);
      } catch { gap = "decision_failed"; }
      elapsed += performance.now() - started;
      if (!gap) {
        const oldValues = proposals(ready, ready.result, ready.policy);
        const newValues = proposals(ready, next as SystemOneResult<Questions>, selected);
        for (const [i, name] of Object.keys(ready.questions).entries()) {
          compared++;
          if (oldValues[i] === null) oldAbstentions++;
          if (newValues[i] === null) newAbstentions++;
          if (oldValues[i] === newValues[i]) agreement++;
          else { disagreement++; changed.push(name); }
        }
        replayed++;
      }
    }
    if (gap) gaps++;
    if (details.length < detailLimit) details.push(gap ? { index, gap } : { index, changed });
  }
  return { version: REPLAY_VERSION, recording_sha256: createHash("sha256").update(JSON.stringify(doc)).digest("hex"), policy: selected, adapter: adapter === undefined ? "recorded" : adapter.version, complete: gaps === 0,
    records: doc.records.length, attempted, replayed, gaps, compared, agreement, disagreement, old_abstentions: oldAbstentions, new_abstentions: newAbstentions,
    latency_ms: { total: elapsed, mean: attempted === 0 ? null : elapsed / attempted }, details, omitted_details: doc.records.length - details.length };
}

/** Bind only a loopback, non-cloud, installed Ollama decision model; ignore hosted settings/env. */
export async function createOllamaReplayAdapter(model: string, baseUrl = "http://127.0.0.1:11434", deadlineMs = 120000): Promise<ReplayAdapter> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300000) throw new ReplayRefusal("invalid_policy", "Use --deadline-ms from 1 to 300000 (default 120000) for each local input.");
  let origin: string;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !label(model) || model.includes("cloud")) throw new Error();
    origin = url.origin;
  } catch { throw new ReplayRefusal("local_only", "Use an installed local decision model and an HTTP numeric loopback origin; hosted providers, cloud models, redirects and configured provider overrides are disabled for replay."); }
  const config: JevConfig = { provider: "ollama", baseUrl: origin, model, timeoutMs: deadlineMs, totalDeadlineMs: deadlineMs, minConfidence: 0.5, gateThreshold: 0.5 };
  try {
    const response = await fetch(`${origin}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const inventory = await response.json() as { models: { name: string; digest: string; capabilities: string[]; remote_host?: unknown; remote_model?: unknown }[] };
    const card = inventory.models.find(/** Resolve the exact installed tag before sending any recorded state. */ entry => entry.name === model);
    if (!card || card.remote_host || card.remote_model || !card.capabilities.includes("decision") || !/^[a-f0-9]{64}$/.test(card.digest)) throw new Error();
    const client = createJevClient({ config, hostedBlocked: null }, {}, 0);
    return { version: `ollama:${card.digest}`,
      /** Reuse the existing typed transport with zero retries and a per-input deadline. */
      async decide(record) {
        const result = await runDecision(client, config, record.state, record.questions);
        if (result.model !== model) throw new Error("Replay model changed");
        return result;
      } };
  } catch { throw new ReplayRefusal("model_unavailable", `Start local Ollama, run ollama pull ${model}, and verify that /api/tags advertises a local decision capability and digest; then retry.`); }
}
