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
/** Fixed local embedding model used for optional embedding similarity. */
export const EMBEDDING_MODEL = "qwen3-embedding:0.6b";
/** The local System One endpoint refuses prompts above this many tokens; input is never truncated. */
export const PROMPT_TOKEN_LIMIT = 2050;
/** Conservative divisor covering tokenizer inflation beyond four characters per token. */
const PROMPT_TOKEN_SAFETY = 1.25;
/** Truncation marker appended to budgeted body excerpts. */
const TRUNCATED_MARKER = "…[truncated]";
/** BM25 term-frequency saturation. */
const BM25_K1 = 1.2;
/** BM25 length-normalization weight. */
const BM25_B = 0.75;
/** Deterministic similarity order: descending score, then ascending item ids. */
function similarityOrder(left, right) {
    return right.score - left.score || left.unit.ids.join("\u0000").localeCompare(right.unit.ids.join("\u0000"));
}
/**
 * Clamp the exemplar budget to the prompt headroom left by the base request.
 *
 * The local System One endpoint refuses prompts above {@link PROMPT_TOKEN_LIMIT}
 * tokens and never truncates input, so the effective exemplar budget is the
 * smaller of the requested budget and the remaining headroom (with a safety
 * divisor for tokenizer inflation beyond the character estimate).
 *
 * @param baseRequest - JSON-encoded request without the exemplar section.
 * @param requested - Requested exemplar token budget.
 * @param measuredBaseTokens - Observed plain-request input usage, when available.
 * @returns The effective exemplar budget, never negative.
 */
export function exemplarBudget(baseRequest, requested, measuredBaseTokens = 0) {
    if (measuredBaseTokens === null)
        return 0;
    // Reserve the JSON property wrapper as well as the budgeted array itself.
    return Math.max(0, Math.min(requested, Math.floor(PROMPT_TOKEN_LIMIT / PROMPT_TOKEN_SAFETY) - Math.max(estimateTokens(baseRequest), measuredBaseTokens) - 8));
}
/**
 * Deterministic token estimate for budget arithmetic.
 *
 * Uses the conservative four-characters-per-token heuristic; exact tokenizer
 * output is unnecessary because the budget only bounds the composed context.
 *
 * @param text - Encoded text of any length.
 * @returns The estimated token count, at least one for nonempty text.
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/**
 * Lowercase alphanumeric tokens for lexical similarity.
 *
 * @param text - Free text of any length.
 * @returns The token list, empty when the text has no alphanumeric runs.
 */
export function tokenize(text) {
    return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
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
export function bm25Rank(targetText, pool) {
    if (pool.length === 0)
        return [];
    const documents = pool.map(/** Tokenize each exemplar's retrieval text once. */ /** Tokenize each exemplar's retrieval text once. */ unit => tokenize(`${unit.title}\n${unit.body}`));
    const averageLength = documents.reduce(/** Mean document length for BM25 normalization. */ (sum, document) => sum + document.length, 0) / documents.length;
    const frequencies = new Map();
    for (const document of documents)
        for (const term of new Set(document))
            frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    const query = new Set(tokenize(targetText));
    return pool.map(/** Score every eligible unit against the target terms. */ (unit, index) => {
        const document = documents[index];
        const counts = new Map();
        for (const term of document)
            counts.set(term, (counts.get(term) ?? 0) + 1);
        let score = 0;
        for (const term of query) {
            const count = counts.get(term);
            if (count === undefined)
                continue;
            // A term present in this document is always present in the corpus frequencies.
            const frequency = frequencies.get(term);
            const idf = Math.log(1 + (pool.length - frequency + 0.5) / (frequency + 0.5));
            score += idf * (count * (BM25_K1 + 1)) / (count + BM25_K1 * (1 - BM25_B + BM25_B * document.length / averageLength));
        }
        return { unit, score };
    }).sort(/** Highest similarity first; ties keep ascending item-id order. */ similarityOrder)
        .map(/** Keep only the ranked units in the comparator's order. */ /** Keep only the ranked units in the comparator's order. */ ranked => ranked.unit);
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
export function eligibleExemplars(target, pool, sampled) {
    return pool.filter(/** Refuse self-reference, future items and sampled items. */ /** Refuse self-reference, future items and sampled items. */ unit => !unit.ids.some(/** A unit touching the target, a sample item or a future item never serves as context. */ /** A unit touching the target, a sample item or a future item never serves as context. */ id => target.ids.includes(id) || sampled.has(id)) && unit.created_at <= target.created_at);
}
/**
 * Compose retrieved exemplars into typed context under a token budget.
 *
 * Units are consumed in ranked order. A unit whose body does not fit is
 * body-truncated with a marker; when not even its title fits, no further
 * exemplars are included. The budget bounds the JSON-encoded exemplar section
 * using the four-characters-per-token estimate.
 *
 * @param ranked - Retrieved exemplar units in descending similarity order.
 * @param budget - Token budget for the composed exemplar context.
 * @returns The budgeted exemplar entries, possibly fewer than the input.
 */
export function exemplarContext(ranked, budget) {
    const entries = [];
    let used = 2; // The enclosing JSON array brackets count against the budget.
    for (const unit of ranked) {
        const separator = entries.length === 0 ? 0 : 1;
        const body = budgetedBody(unit, (budget * 4 - used - separator) / 4);
        if (body === null)
            break;
        const entry = { title: unit.title, body, ...unit.labels };
        used += JSON.stringify(entry).length + separator;
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
function budgetedBody(unit, remaining) {
    const skeleton = JSON.stringify({ title: unit.title, body: "", ...unit.labels }).length;
    if (skeleton > remaining * 4)
        return null;
    if (JSON.stringify({ title: unit.title, body: unit.body, ...unit.labels }).length <= remaining * 4)
        return unit.body;
    const room = remaining * 4 - skeleton - TRUNCATED_MARKER.length;
    let slice = Math.max(0, room);
    let text = `${unit.body.slice(0, slice)}${TRUNCATED_MARKER}`;
    // Escape inflation can push a candidate over the budget; halve deterministically.
    while (slice > 0 && JSON.stringify({ title: unit.title, body: text, ...unit.labels }).length > remaining * 4) {
        slice = Math.floor(slice / 2);
        text = `${unit.body.slice(0, slice)}${TRUNCATED_MARKER}`;
    }
    return slice === 0 && JSON.stringify({ title: unit.title, body: text, ...unit.labels }).length > remaining * 4 ? "" : text;
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
export function majorityLabel(pool, channel) {
    const counts = new Map();
    for (const unit of pool) {
        const label = unit.labels[channel];
        if (label === undefined)
            continue;
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    let best = null;
    let bestCount = 0;
    for (const [label, count] of counts)
        if (count > bestCount || (count === bestCount && best !== null && label.localeCompare(best) < 0)) {
            best = label;
            bestCount = count;
        }
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
export function knnVote(retrieved, channel) {
    if (retrieved.length === 0)
        return null;
    const order = [];
    const counts = new Map();
    for (const unit of retrieved) {
        const label = unit.labels[channel];
        if (label === undefined)
            continue;
        if (!counts.has(label))
            order.push(label);
        counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    return Object.fromEntries(order.map(/** Share of the vote for each retrieved label. */ /** Share of the vote for each retrieved label. */ label => [label, counts.get(label) / retrieved.length]));
}
/**
 * Report whether the fixed local embedding model is installed.
 *
 * @param baseUrl - Local Ollama base URL.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @returns True when the embedding model tag is served; false on any failure.
 */
export async function embeddingAvailable(baseUrl, timeoutMs) {
    try {
        const response = await fetch(`${baseUrl}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok)
            return false;
        const payload = await response.json();
        return Array.isArray(payload.models) && payload.models.some(/** Match the exact embedding model tag. */ /** Match the exact embedding model tag. */ model => model?.name === EMBEDDING_MODEL);
    }
    catch {
        return false;
    }
}
/**
 * Embed retrieval texts through the local Ollama embedding endpoint.
 *
 * @param baseUrl - Local Ollama base URL.
 * @param texts - Retrieval texts in stable order.
 * @param timeoutMs - Per-attempt timeout in milliseconds.
 * @returns One vector per text, or null on any transport or shape failure.
 */
export async function embedTexts(baseUrl, texts, timeoutMs) {
    try {
        const response = await fetch(`${baseUrl}/api/embed`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
            headers: { "content-type": "application/json" }, body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }) });
        if (!response.ok)
            return null;
        const payload = await response.json();
        if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== texts.length)
            return null;
        const vectors = payload.embeddings.map(/** Require a nonempty finite-number vector per text. */ /** Require a nonempty finite-number vector per text. */ vector => Array.isArray(vector) && vector.length > 0 && vector.every(/** Reject non-finite components before ranking. */ /** Reject non-finite components before ranking. */ value => typeof value === "number" && Number.isFinite(value)) ? vector : null);
        return vectors.some(/** One malformed vector invalidates the whole batch. */ /** One malformed vector invalidates the whole batch. */ vector => vector === null) ? null : vectors;
    }
    catch {
        return null;
    }
}
/**
 * Cosine similarity of two vectors.
 *
 * @param left - First vector.
 * @param right - Second vector of the same length.
 * @returns Similarity in `[-1, 1]`; zero when either vector is zero or the lengths differ.
 */
export function cosineSimilarity(left, right) {
    if (left.length !== right.length || left.length === 0)
        return 0;
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
export function embeddingRank(target, pool) {
    return pool.map(/** Score every eligible embedded unit. */ /** Score every eligible embedded unit. */ unit => ({ unit, score: cosineSimilarity(target, unit.vector) }))
        .sort(/** Highest similarity first; ties keep ascending item-id order. */ similarityOrder)
        .map(/** Keep only the ranked units in the comparator's order. */ /** Keep only the ranked units in the comparator's order. */ ranked => ranked.unit);
}
//# sourceMappingURL=exemplar-retrieval.js.map