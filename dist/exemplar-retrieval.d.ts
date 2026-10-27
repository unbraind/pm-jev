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
export declare const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
/** The local System One endpoint refuses prompts above this many tokens; input is never truncated. */
export declare const PROMPT_TOKEN_LIMIT = 2050;
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
export declare function exemplarBudget(baseRequest: string, requested: number, measuredBaseTokens?: number | null): number;
/**
 * Deterministic token estimate for budget arithmetic.
 *
 * Uses the host SDK's UTF-8 byte estimate. Provider-reported usage remains a
 * separate measurement; this estimate is not a provider tokenizer.
 *
 * @param text - Encoded text of any length.
 * @returns The estimated token count, at least one for nonempty text.
 */
export declare function estimateTokens(text: string): number;
/**
 * Unicode-aware SDK tokens, retaining repeated terms for BM25 weighting.
 *
 * @param text - Free text of any length.
 * @returns The token list, empty when the text has no alphanumeric runs.
 */
export declare function tokenize(text: string): string[];
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
export declare function bm25Rank(targetText: string, pool: readonly ExemplarUnit[]): ExemplarUnit[];
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
export declare function eligibleExemplars<T extends ExemplarUnit>(target: {
    ids: readonly string[];
    created_at: string;
}, pool: readonly T[], sampled: ReadonlySet<string>): T[];
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
export declare function exemplarContext(ranked: readonly ExemplarUnit[], budget: number): ExemplarEntry[];
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
export declare function majorityLabel(pool: readonly ExemplarUnit[], channel: string): string | null;
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
export declare function knnVote(retrieved: readonly ExemplarUnit[], channel: string): Record<string, number> | null;
/**
 * Report whether the fixed local embedding model is installed.
 *
 * @param baseUrl - Local Ollama base URL.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @returns True when the embedding model tag is served; false on any failure.
 */
export declare function embeddingAvailable(baseUrl: string, timeoutMs: number): Promise<boolean>;
/**
 * Embed retrieval texts through the local Ollama embedding endpoint.
 *
 * @param baseUrl - Local Ollama base URL.
 * @param texts - Retrieval texts in stable order.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @param signal - Optional shared interruption signal for the enclosing evaluation.
 * @returns One vector per text, or null on any transport or shape failure.
 */
export declare function embedTexts(baseUrl: string, texts: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<readonly (readonly number[])[] | null>;
/**
 * Cosine similarity of two vectors.
 *
 * @param left - First vector.
 * @param right - Second vector of the same length.
 * @returns Similarity in `[-1, 1]`; zero when either vector is zero or the lengths differ.
 */
export declare function cosineSimilarity(left: readonly number[], right: readonly number[]): number;
/**
 * Rank embedded exemplars by cosine similarity to the target vector.
 *
 * @param target - Embedding vector of the target's retrieval text.
 * @param pool - Eligible embedded exemplar units of the target's tracker.
 * @returns The pool in deterministic descending similarity order.
 */
export declare function embeddingRank(target: readonly number[], pool: readonly EmbeddedUnit[]): ExemplarUnit[];
//# sourceMappingURL=exemplar-retrieval.d.ts.map