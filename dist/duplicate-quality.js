import { evidenceHash } from "./decision-calibration.js";
/** Repository-only assignment frozen before labels, scores or model outcomes. */
export function duplicateSplit(repository) {
    return evidenceHash(["duplicate-quality-20261021", repository])[0] < "8" ? "train" : "heldout";
}
/** Normalize tokens without ids, closure reasons, annotations or receipts. */
function tokens(text) {
    return new Set(text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu));
}
/** Symmetric overlap; missing evidence cannot count as agreement. */
function overlap(a, b) {
    return a.size + b.size === 0 ? 0 : 2 * [...a].filter(/** Count actual shared evidence. */ /** Count actual shared evidence. */ token => b.has(token)).length / (a.size + b.size);
}
/** Title-focused semantic evidence; generic shared tags alone cannot score as duplicates. */
export function duplicateSimilarity(pair) {
    /** Combine distinct description and body without doubling a repeated summary. */
    const text = (item) => tokens([...new Set([item.description, item.body ?? ""])].join("\n"));
    /** Keep tag and path namespaces distinct. */
    const structure = (item) => new Set([...item.tags.map(/** Normalize tags. */ /** Normalize tags. */ tag => `#${tag.toLowerCase()}`), ...(item.files ?? []).map(/** Normalize linked file paths. */ /** Normalize linked file paths. */ file => `@${file.path.toLowerCase()}`)]);
    return 0.65 * overlap(tokens(pair.a.title), tokens(pair.b.title)) + 0.3 * overlap(text(pair.a), text(pair.b)) + 0.05 * overlap(structure(pair.a), structure(pair.b));
}
/** Positive decisions require every enabled channel; all remaining rows explicitly abstain. */
export function qualityProposes(row, arm, policy) {
    return (arm === "model-only" || row.retrieved) &&
        (arm === "lexical-only" || policy.model !== null && row.probability >= policy.model) &&
        (arm === "model-only" || policy.lexical !== null && row.lexical >= policy.lexical);
}
/** Unretrieved positives stay in recall; every withheld proposal is an unsure decision. */
export function qualityMetrics(rows, arm, policy) {
    let tp = 0, fp = 0, fn = 0, abstained = 0;
    for (const row of rows) {
        if (qualityProposes(row, arm, policy)) {
            if (row.label)
                tp++;
            else
                fp++;
        }
        else {
            abstained++;
            if (row.label)
                fn++;
        }
    }
    return { count: rows.length, tp, fp, fn, precision: tp + fp === 0 ? null : tp / (tp + fp), recall: tp + fn === 0 ? null : tp / (tp + fn),
        abstention_rate: rows.length === 0 ? null : abstained / rows.length, precision_ci95: wilson(tp, tp + fp), recall_ci95: wilson(tp, tp + fn) };
}
/** Enumerate train-observed cutoffs and retain the precision/recall frontier plus a disable point. */
export function qualityFrontier(train, arm) {
    const models = arm === "lexical-only" ? [null] : [...new Set(train.map(/** Raw model scores are not calibrated precision; search the full train range. */ /** Raw model scores are not calibrated precision; search the full train range. */ row => row.probability))].sort(/** Stable cutoff order. */ (a, b) => a - b);
    const lexical = arm === "model-only" ? [null] : [...new Set(train.map(/** Lexical evidence is a score, not a probability. */ /** Lexical evidence is a score, not a probability. */ row => row.lexical))].sort(/** Stable cutoff order. */ (a, b) => a - b);
    const points = [{ policy: { model: null, lexical: null }, train: qualityMetrics(train, arm, { model: null, lexical: null }) }];
    for (const model of models)
        for (const score of lexical) {
            const policy = { model, lexical: score };
            points.push({ policy, train: qualityMetrics(train, arm, policy) });
        }
    const unique = new Map();
    for (const point of points.slice(1)) {
        if (point.train.precision === null)
            continue;
        const key = JSON.stringify([point.train.precision, point.train.recall]);
        // The grid visits model then lexical cutoffs in ascending order; its last train-equivalent policy is strictest.
        unique.set(key, point);
    }
    const ranked = [...unique.values()].sort(/** Higher recall first; the best precision at each recall dominates its peers. */ (a, b) => Number(b.train.recall) - Number(a.train.recall) || Number(b.train.precision) - Number(a.train.precision));
    let precision = -1;
    return [points[0], ...ranked.filter(/** Retain only train-nondominated points, without inspecting held-out observations. */ /** Retain only train-nondominated points, without inspecting held-out observations. */ point => {
            const keep = Number(point.train.precision) > precision;
            precision = Math.max(precision, Number(point.train.precision));
            return keep;
        })];
}
/** Maximize train recall at precision >= 0.8 and >= 3 predictions; ties prefer precision then stricter cutoffs. */
export function fitQualityPolicy(train, arm) {
    const qualified = qualityFrontier(train, arm).filter(/** Avoid a one-example precision claim or an empty-set qualification. */ /** Avoid a one-example precision claim or an empty-set qualification. */ point => point.train.precision !== null && point.train.precision >= 0.8 && point.train.tp + point.train.fp >= 3);
    return qualified[0]?.policy ?? { model: null, lexical: null };
}
/** Two-sided Wilson interval; empty denominators remain explicitly undefined. */
export function wilson(successes, count, z = 1.959963984540054) {
    if (count === 0)
        return null;
    const p = successes / count;
    const d = 1 + z * z / count;
    const center = (p + z * z / (2 * count)) / d;
    const delta = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / d;
    return [Math.max(0, center - delta), Math.min(1, center + delta)];
}
//# sourceMappingURL=duplicate-quality.js.map