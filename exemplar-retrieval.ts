import { displayRatio } from "./exact.ts";
/**
 * Same-tracker exemplar retrieval for retrieval-augmented decisions.
 *
 * Exemplars are labelled examples from the SAME tracker as the target item,
 * never the target itself and never items created after it. Ranking is
 * deterministic in-process BM25 over title and body, with optional local
 * Ollama embedding similarity that falls back to lexical when unavailable.
 * Selected exemplars are composed into typed prompt context under a token
 * budget, and majority-class / kNN-vote baselines share the same retrieved
 * evidence so model arms are compared against context-equivalent baselines.
 */

import { estimatePmOutputTokens, normalizeSimilarityText, tokenizeSimilarityText } from "@unbrained/pm-cli/sdk";

/** Similarity source used to rank same-tracker exemplars. */
export type RetrievalMode = "lexical" | "embedding";

/** Calibrated exemplar context identity: the retrieval setting in force. */
export interface ExemplarSetting {
  /** Similarity source; lexical BM25 is the dependency-free default. */
  readonly retrieval: RetrievalMode;
  /** Retrieved exemplar count k, 1 to 8. */
  readonly count: number;
  /** Token budget for the composed exemplar context. */
  readonly token_budget: number;
  /** Exact local embedding model tag; present only for embedding retrieval. */
  readonly embedding_model?: string;
}

/** Fixed local embedding model used for optional embedding similarity. */
export const EMBEDDING_MODEL = "qwen3-embedding:0.6b";

/** The local System One endpoint refuses prompts above this many tokens; input is never truncated. */
export const PROMPT_TOKEN_LIMIT = 2050;

/** Extra headroom beyond the SDK byte estimate; not a provider tokenizer. */
const PROMPT_TOKEN_SAFETY = 1.25;

/** Truncation marker appended to budgeted body excerpts. */
const TRUNCATED_MARKER = "…[truncated]";

/** BM25 term-frequency saturation. */
const BM25_K1 = 1.2;
/** BM25 length-normalization weight. */
const BM25_B = 0.75;

/** One labelled same-tracker exemplar with its projected text and digest. */
export interface ExemplarUnit {
  /** Item ids composing the labelled unit (one for triage, two for a link pair). */
  readonly ids: readonly string[];
  /** Latest creation timestamp among the unit's items. */
  readonly created_at: string;
  /** Primary exemplar text (item title, or source → candidate for pairs). */
  readonly title: string;
  /** Supporting exemplar text: bounded description and body excerpts. */
  readonly body: string;
  /** Ground-truth labels keyed by the question channel they answer. */
  readonly labels: Record<string, string>;
  /** Content digest of the underlying labelled example. */
  readonly example_sha256: string;
}

/** An exemplar unit with its local embedding vector attached. */
export interface EmbeddedUnit extends ExemplarUnit {
  /** Embedding vector of the unit's retrieval text. */
  readonly vector: readonly number[];
}

/** One exemplar as typed prompt context: title/body excerpt plus its labels. */
export interface ExemplarEntry {
  /** Exemplar title excerpt. */
  readonly title: string;
  /** Exemplar body excerpt, truncated to the remaining budget. */
  readonly body: string;
  /** Ground-truth labels flattened into the entry. */
  readonly [label: string]: string;
}

/** Deterministic similarity order: descending score, then ascending item ids. */
function similarityOrder(left: { unit: ExemplarUnit; score: number }, right: { unit: ExemplarUnit; score: number }): number {
  return right.score - left.score || left.unit.ids.join("\u0000").localeCompare(right.unit.ids.join("\u0000"));
}

/**
 * Clamp the exemplar budget to the prompt headroom left by the base request.
 *
 * The local System One endpoint refuses prompts above {@link PROMPT_TOKEN_LIMIT}
 * tokens and never truncates input, so the effective exemplar budget is the
 * smaller of the requested budget and the remaining headroom (with a safety
 * divisor beyond the UTF-8 byte estimate).
 *
 * @param baseRequest - JSON-encoded request without the exemplar section.
 * @param requested - Requested exemplar token budget.
 * @param measuredBaseTokens - Observed plain-request input usage, when available.
 * @returns The effective exemplar budget, never negative.
 */
export function exemplarBudget(baseRequest: string, requested: number, measuredBaseTokens: number | null = 0): number {
  if (measuredBaseTokens === null) return 0;
  // Reserve the JSON property wrapper as well as the budgeted array itself.
  return Math.max(0, Math.min(requested, Math.floor(PROMPT_TOKEN_LIMIT / PROMPT_TOKEN_SAFETY) - Math.max(estimateTokens(baseRequest), measuredBaseTokens) - 8));
}

/**
 * Deterministic token estimate for budget arithmetic.
 *
 * Uses the host SDK's UTF-8 byte estimate. Provider-reported usage remains a
 * separate measurement; this estimate is not a provider tokenizer.
 *
 * @param text - Encoded text of any length.
 * @returns The estimated token count, at least one for nonempty text.
 */
export function estimateTokens(text: string): number {
  return estimatePmOutputTokens(Buffer.byteLength(text, "utf8"));
}

/**
 * Unicode-aware SDK tokens, retaining repeated terms for BM25 weighting.
 *
 * @param text - Free text of any length.
 * @returns The token list, empty when the text has no alphanumeric runs.
 */
export function tokenize(text: string): string[] {
  // The SDK returns unique tokens per call; isolate runs so BM25 keeps term frequency.
  return normalizeSimilarityText(text).split(/[^\p{L}\p{N}]+/u).flatMap(tokenizeSimilarityText);
}

/**
 * Rank exemplars by BM25 similarity to the target text.
 *
 * The pool itself is the corpus, so IDF comes from the same tracker context.
 * Scores are computed over title and body; ranking is deterministic with ties
 * broken by ascending item-id order, and zero-score units remain ranked last
 * so retrieval coverage never silently empties on disjoint vocabulary.
 *
 * @param targetText - Retrieval text of the target (title and body).
 * @param pool - Eligible exemplar units of the target's tracker.
 * @returns The full pool in deterministic descending similarity order.
 */
export function bm25Rank(targetText: string, pool: readonly ExemplarUnit[]): ExemplarUnit[] {
  if (pool.length === 0) return [];
  const documents = pool.map(/** Tokenize each exemplar's retrieval text once. */ unit => tokenize(`${unit.title}\n${unit.body}`));
  const averageLength = documents.reduce(/** Mean document length for BM25 normalization. */ (sum, document) => sum + document.length, 0) / documents.length;
  const frequencies = new Map<string, number>();
  for (const document of documents) for (const term of new Set(document)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  const query = new Set(tokenize(targetText));
  return pool.map(/** Score every eligible unit against the target terms. */ (unit, index) => {
    const document = documents[index];
    const counts = new Map<string, number>();
    for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of query) {
      const count = counts.get(term);
      if (count === undefined) continue;
      // A term present in this document is always present in the corpus frequencies.
      const frequency = frequencies.get(term) as number;
      const idf = Math.log(1 + (pool.length - frequency + 0.5) / (frequency + 0.5));
      score += idf * (count * (BM25_K1 + 1)) / (count + BM25_K1 * (1 - BM25_B + BM25_B * document.length / averageLength));
    }
    return { unit, score };
  }).sort(/** Highest similarity first; ties keep ascending item-id order. */ similarityOrder)
    .map(/** Keep only the ranked units in the comparator's order. */ ranked => ranked.unit);
}

/**
 * Exclude the target itself, items created after it, and evaluation-sample
 * items from a same-tracker exemplar pool.
 *
 * Leakage rules: a unit is ineligible when it shares any item with the target,
 * when any of its items was created after the target's latest item, or when
 * any of its items belongs to the current invocation's evaluation sample.
 *
 * @param target - Target unit item ids and latest creation timestamp.
 * @param pool - All labelled units of the target's tracker.
 * @param sampled - Item ids that belong to the sampled evaluation set.
 * @returns The eligible exemplar units, in pool order.
 */
export function eligibleExemplars<T extends ExemplarUnit>(target: { ids: readonly string[]; created_at: string }, pool: readonly T[], sampled: ReadonlySet<string>): T[] {
  return pool.filter(/** Refuse self-reference, future items and sampled items. */ unit =>
    !unit.ids.some(/** A unit touching the target, a sample item or a future item never serves as context. */ id => target.ids.includes(id) || sampled.has(id)) && unit.created_at <= target.created_at);
}

/**
 * Compose retrieved exemplars into typed context under a token budget.
 *
 * Units are consumed in ranked order. A unit whose body does not fit is
 * body-truncated with a marker; when not even its title fits, no further
 * exemplars are included. The budget bounds the JSON-encoded exemplar section
 * using the SDK's UTF-8 byte estimate.
 *
 * @param ranked - Retrieved exemplar units in descending similarity order.
 * @param budget - Token budget for the composed exemplar context.
 * @returns The budgeted exemplar entries, possibly fewer than the input.
 */
export function exemplarContext(ranked: readonly ExemplarUnit[], budget: number): ExemplarEntry[] {
  const entries: ExemplarEntry[] = [];
  let used = 2; // The enclosing JSON array brackets count against the budget.
  for (const unit of ranked) {
    const separator = entries.length === 0 ? 0 : 1;
    const body = budgetedBody(unit, (budget * 4 - used - separator) / 4);
    if (body === null) break;
    const entry: ExemplarEntry = { title: unit.title, body, ...unit.labels };
    used += Buffer.byteLength(JSON.stringify(entry), "utf8") + separator;
    entries.push(entry);
  }
  return entries;
}

/**
 * Fit one exemplar body into a remaining token budget.
 *
 * @param unit - The exemplar whose body is fitted.
 * @param remaining - Tokens still available for the whole entry.
 * @returns The whole body when it fits, a truncated excerpt otherwise, an
 * empty string when only the skeleton fits, or null when the title alone
 * exceeds the budget.
 */
function budgetedBody(unit: ExemplarUnit, remaining: number): string | null {
  const skeleton = Buffer.byteLength(JSON.stringify({ title: unit.title, body: "", ...unit.labels }), "utf8");
  if (skeleton > remaining * 4) return null;
  if (Buffer.byteLength(JSON.stringify({ title: unit.title, body: unit.body, ...unit.labels }), "utf8") <= remaining * 4) return unit.body;
  const room = remaining * 4 - skeleton - Buffer.byteLength(TRUNCATED_MARKER, "utf8");
  let slice = Math.max(0, room);
  let text = `${unit.body.slice(0, slice)}${TRUNCATED_MARKER}`;
  // Escape inflation can push a candidate over the budget; halve deterministically.
  while (slice > 0 && Buffer.byteLength(JSON.stringify({ title: unit.title, body: text, ...unit.labels }), "utf8") > remaining * 4) {
    slice = Math.floor(slice / 2);
    text = `${unit.body.slice(0, slice)}${TRUNCATED_MARKER}`;
  }
  return slice === 0 && Buffer.byteLength(JSON.stringify({ title: unit.title, body: text, ...unit.labels }), "utf8") > remaining * 4 ? "" : text;
}

/**
 * Deterministic majority label of one channel over a pool.
 *
 * Ties resolve to the lexicographically smallest label so the baseline is
 * reproducible regardless of pool iteration order.
 *
 * @param pool - Eligible exemplar units of one tracker.
 * @param channel - Question channel whose labels are counted.
 * @returns The most frequent label, or null when no unit carries the channel.
 */
export function majorityLabel(pool: readonly ExemplarUnit[], channel: string): string | null {
  const counts = new Map<string, number>();
  for (const unit of pool) {
    const label = unit.labels[channel];
    if (label === undefined) continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [label, count] of counts) if (count > bestCount || (count === bestCount && best !== null && label.localeCompare(best) < 0)) { best = label; bestCount = count; }
  return best;
}

/**
 * kNN vote over retrieved exemplars for one channel.
 *
 * Probabilities are uniform vote shares. The evaluation baseline rebuilds the
 * distribution in question-schema order, which breaks equal-share ties.
 * Integer-like keys, including priority levels, enumerate numerically ascending.
 *
 * @param retrieved - The top-k retrieved exemplar units.
 * @param channel - Question channel whose labels are voted.
 * @returns Vote shares keyed by label, or null when nothing was retrieved.
 */
export function knnVote(retrieved: readonly ExemplarUnit[], channel: string): Record<string, number> | null {
  if (retrieved.length === 0) return null;
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const unit of retrieved) {
    const label = unit.labels[channel];
    if (label === undefined) continue;
    if (!counts.has(label)) order.push(label);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return Object.fromEntries(order.map(/** Share of the vote for each retrieved label. */ label => [label, displayRatio(counts.get(label) as number, retrieved.length)]));
}

/**
 * Report whether the fixed local embedding model is installed.
 *
 * @param baseUrl - Local Ollama base URL.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @returns True when the embedding model tag is served; false on any failure.
 */
export async function embeddingAvailable(baseUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return false;
    const payload = await response.json() as { models?: { name?: unknown }[] };
    return Array.isArray(payload.models) && payload.models.some(/** Match the exact embedding model tag. */ model => model?.name === EMBEDDING_MODEL);
  } catch { return false; }
}

/**
 * Embed retrieval texts through the local Ollama embedding endpoint.
 *
 * @param baseUrl - Local Ollama base URL.
 * @param texts - Retrieval texts in stable order.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @param signal - Optional shared interruption signal for the enclosing evaluation.
 * @returns One vector per text, or null on any transport or shape failure.
 */
export async function embedTexts(baseUrl: string, texts: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<readonly (readonly number[])[] | null> {
  try {
    const response = await fetch(`${baseUrl}/api/embed`, { method: "POST", redirect: "error", signal: signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }) });
    if (!response.ok) return null;
    const payload = await response.json() as { embeddings?: unknown };
    if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length) return null;
    const vectors = payload.embeddings.map(/** Require a nonempty finite-number vector per text. */ vector =>
      Array.isArray(vector) && vector.length > 0 && vector.every(/** Reject non-finite components before ranking. */ value => typeof value === "number" && Number.isFinite(value)) ? vector as readonly number[] : null);
    return vectors.some(/** One malformed vector invalidates the whole batch. */ vector => vector === null) ? null : vectors as readonly (readonly number[])[];
  } catch { return null; }
}

/**
 * Cosine similarity of two vectors.
 *
 * @param left - First vector.
 * @param right - Second vector of the same length.
 * @returns Similarity in `[-1, 1]`; zero when either vector is zero or the lengths differ.
 */
export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    normLeft += left[index] * left[index];
    normRight += right[index] * right[index];
  }
  return normLeft === 0 || normRight === 0 ? 0 : dot / Math.sqrt(normLeft * normRight);
}

/**
 * Rank embedded exemplars by cosine similarity to the target vector.
 *
 * @param target - Embedding vector of the target's retrieval text.
 * @param pool - Eligible embedded exemplar units of the target's tracker.
 * @returns The pool in deterministic descending similarity order.
 */
export function embeddingRank(target: readonly number[], pool: readonly EmbeddedUnit[]): ExemplarUnit[] {
  return pool.map(/** Score every eligible embedded unit. */ unit => ({ unit, score: cosineSimilarity(target, unit.vector) }))
    .sort(/** Highest similarity first; ties keep ascending item-id order. */ similarityOrder)
    .map(/** Keep only the ranked units in the comparator's order. */ ranked => ranked.unit);
}
