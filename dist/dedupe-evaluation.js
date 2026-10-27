import { acceptsThreshold, threshold as asThreshold, legacyThreshold } from "./threshold.js";
import { compareExact, countRatio, displayExact, displayRatio } from "./exact.js";
import { candidatePairs, orderedPair, pairKey, pairState, pairVerdict } from "./dedupe.js";
import { duplicateSplit, wilson } from "./duplicate-quality.js";
import { duplicateTarget } from "./tracker-evaluation.js";
import { evidenceHash } from "./decision-calibration.js";
/** Recognize explicit duplicate consolidation receipts as well as standard duplicate closures. */
export function closureTarget(item) {
    const reason = item.close_reason ?? "";
    return duplicateTarget(item) ?? (/duplicate-consolidation/i.test(reason) ? /Superseded by canonical item ([a-z0-9]+(?:-[a-z0-9]+)+)/i.exec(reason)?.[1] : undefined);
}
/** Follow resolvable duplicate chains, refusing cycles and missing targets. */
function canonical(id, targets, ids) {
    const seen = new Set();
    while (targets.has(id)) {
        if (seen.has(id))
            return null;
        seen.add(id);
        id = targets.get(id);
    }
    return ids.has(id) ? id : null;
}
/** Resolve duplicate groups and production candidates once for either label set. */
function corpusIndex(corpus) {
    const byId = new Map(corpus.items.map(/** Index complete tracker items. */ /** Index complete tracker items. */ item => [item.id, item]));
    const ids = new Set(byId.keys()), targets = new Map();
    for (const item of corpus.items) {
        const target = closureTarget(item);
        if (target !== undefined)
            targets.set(item.id, target);
    }
    const ranked = candidatePairs(corpus.items, corpus.items.length * 8);
    const cutoffs = new Map(ranked.map(/** Keep exact retrieval ratios beside compatibility display scores. */ /** Keep exact retrieval ratios beside compatibility display scores. */ pair => [pairKey(pair.a.id, pair.b.id), pair.score_cutoff]));
    const scores = new Map(ranked.map(/** Preserve production channel scores. */ /** Preserve production channel scores. */ pair => [pairKey(pair.a.id, pair.b.id), pair.score]));
    return { byId, ids, targets, ranked, scores, cutoffs };
}
/** Preserve the exact retrieval coordinate when orienting labelled positives, including unretrieved zero scores. */
function indexedPair(a, b, scores, cutoffs) {
    const key = pairKey(a.id, b.id);
    return { ...orderedPair(a, b, scores.get(key) ?? 0), score_cutoff: cutoffs.get(key) ?? asThreshold(0) };
}
/** Store ordered pair identity immediately, including retrieval misses. */
function labelPair(repository, pair, label, retrieved, split) {
    return { pair_id: `${repository}:${pair.a.id}:${pair.b.id}`, repository, pair, label, retrieved, split };
}
/** Identical semantic projections cannot establish reliable negative controls. */
function sameEvidence(pair) {
    const state = pairState(pair);
    return evidenceHash(state.A) === evidenceHash(state.B);
}
/** Sample positives independently of scores, then select hard controls from their repositories. */
function selectPairs(positives, controls, count, related) {
    /** Preserve the published seeds and stable tie policies for both benchmark versions. */
    const samplingKey = (row) => related ? row.pair_id : pairKey(row.pair.a.id, row.pair.b.id);
    /** Duplicate and edge benchmarks retain their original tie identities. */
    const tieKey = (row) => related ? row.pair_id : `${row.repository}${samplingKey(row)}`;
    const selected = [];
    for (const split of ["dev", "heldout"]) {
        const pos = positives.filter(/** Respect the preassigned population. */ /** Respect the preassigned population. */ row => row.split === split)
            .sort(/** Label sampling never depends on model outcomes. */ (a, b) => evidenceHash([a.repository, samplingKey(a)]).localeCompare(evidenceHash([b.repository, samplingKey(b)]))).slice(0, count);
        const repositories = new Set(pos.map(/** Restrict controls to the positive repositories. */ /** Restrict controls to the positive repositories. */ row => row.repository));
        const neg = controls.filter(/** Controls share their positive population. */ /** Controls share their positive population. */ row => row.split === split && repositories.has(row.repository))
            .sort(/** Hardest retrieval scores first, with stable ties. */ (a, b) => b.pair.score - a.pair.score || tieKey(a).localeCompare(tieKey(b))).slice(0, 2 * pos.length);
        if (pos.length === 0 || neg.length !== 2 * pos.length)
            throw new Error("Insufficient real labels or lexical controls for both splits");
        selected.push(...pos, ...neg);
    }
    return selected;
}
/** Build duplicate-group-separated real closures and hard controls at a strict 2:1 ratio. */
export function labelledPairs(corpora, positivesPerSplit = 30) {
    const repositories = [...corpora].filter(/** Only repositories with terminal duplicate labels enter. */ /** Only repositories with terminal duplicate labels enter. */ corpus => corpus.items.some(/** Require an explicit closure target. */ /** Require an explicit closure target. */ item => (item.status === "closed" || item.status === "canceled") && closureTarget(item) !== undefined))
        .sort(/** Seeded ordering cannot depend on inference. */ (a, b) => evidenceHash(["dedupe-20261019", a.repository]).localeCompare(evidenceHash(["dedupe-20261019", b.repository])));
    const positives = [], controls = [];
    for (const corpus of repositories) {
        const { byId, ids, targets, ranked, scores, cutoffs } = corpusIndex(corpus);
        const known = new Set();
        /** Entire resolved duplicate groups share a preassigned split. */
        const splitOf = (id) => evidenceHash(["dedupe-20261019", corpus.repository, canonical(id, targets, ids)])[0] < "8" ? "dev" : "heldout";
        for (const item of corpus.items) {
            if (item.status !== "closed" && item.status !== "canceled")
                continue;
            const target = targets.get(item.id);
            if (target === undefined || target === item.id || !byId.has(target) || canonical(item.id, targets, ids) === null)
                continue;
            const key = pairKey(item.id, target);
            if (known.has(key))
                continue;
            known.add(key);
            const pair = indexedPair(item, byId.get(target), scores, cutoffs);
            positives.push(labelPair(corpus.repository, pair, true, scores.has(key), splitOf(item.id)));
        }
        for (const pair of ranked) {
            const a = canonical(pair.a.id, targets, ids), b = canonical(pair.b.id, targets, ids);
            if (a === null || b === null || a === b || splitOf(a) !== splitOf(b) || sameEvidence(pair))
                continue;
            controls.push(labelPair(corpus.repository, pair, false, true, splitOf(a)));
        }
    }
    return selectPairs(positives, controls, positivesPerSplit, false);
}
/** Build repository-separated real dependency edges and lexical controls at a strict 2:1 ratio. */
export function labelledRelatedPairs(corpora, positivesPerSplit = 15) {
    const positives = [], controls = [];
    for (const corpus of corpora) {
        const { byId, ids, targets, ranked, scores, cutoffs } = corpusIndex(corpus);
        /** Exclude entire duplicate groups, cycles and unresolved targets. */
        const separateWork = (a, b) => {
            const left = canonical(a, targets, ids), right = canonical(b, targets, ids);
            return left !== null && right !== null && left !== right;
        };
        const edges = new Set(), seen = new Set();
        const split = evidenceHash(["dedupe-related", corpus.repository])[0] < "8" ? "dev" : "heldout";
        for (const item of corpus.items) {
            for (const dep of item.dependencies ?? []) {
                if (dep.id === item.id || !byId.has(dep.id))
                    continue;
                const key = pairKey(item.id, dep.id);
                edges.add(key);
                if (!separateWork(item.id, dep.id) || seen.has(key))
                    continue;
                seen.add(key);
                const pair = indexedPair(item, byId.get(dep.id), scores, cutoffs);
                positives.push(labelPair(corpus.repository, pair, true, scores.has(key), split));
            }
        }
        for (const pair of ranked) {
            if (edges.has(pairKey(pair.a.id, pair.b.id)) || !separateWork(pair.a.id, pair.b.id) || sameEvidence(pair))
                continue;
            controls.push(labelPair(corpus.repository, pair, false, true, split));
        }
    }
    return selectPairs(positives, controls, positivesPerSplit, true);
}
/** Preserve the historical interval helper for receipt replay callers. */
export { wilson } from "./duplicate-quality.js";
/** Harmonic mean with explicit zero support. */
function harmonic(a, b) { return a + b === 0 ? 0 : 2 * a * b / (a + b); }
/** The verdict stub used to score stored observations; ids never enter metrics. */
const scoredPair = { a: { id: "a" }, b: { id: "b" } };
/** Positive-class metrics count abstained and unretrieved positives as missed work. */
export function pairMetrics(rows, target, thresholds, lexical = false) {
    let tp = 0, fp = 0, fn = 0, abstained = 0;
    for (const row of rows) {
        const decision = !row.retrieved ? "distinct" : lexical ? (acceptsThreshold(row.lexical_score ?? row.probability, thresholds.threshold) ? target : "distinct") : pairVerdict(scoredPair, row.probability, row.related_probability ?? 0, thresholds.threshold, thresholds.relatedThreshold).decision;
        if (decision === "abstain")
            abstained++;
        if (decision === target) {
            if (row.label)
                tp++;
            else
                fp++;
        }
        else if (row.label)
            fn++;
    }
    const precision = tp + fp === 0 ? null : displayRatio(tp, tp + fp);
    const recall = tp + fn === 0 ? null : displayRatio(tp, tp + fn);
    const pBounds = wilson(tp, tp + fp, 2.241402727604947);
    const rBounds = wilson(tp, tp + fn, 2.241402727604947);
    return { count: rows.length, tp, fp, fn, precision, recall, f1: displayExact(countRatio(2 * tp, 2 * tp + fp + fn)),
        precision_ci95: wilson(tp, tp + fp), recall_ci95: wilson(tp, tp + fn),
        f1_wilson_envelope95: pBounds === null || rBounds === null ? null : [harmonic(pBounds[0], rBounds[0]), harmonic(pBounds[1], rBounds[1])],
        abstain_rate: rows.length === 0 ? null : displayRatio(abstained, rows.length), abstain_ci95: wilson(abstained, rows.length) };
}
/** Tune F1 on dev observations only, retaining the existing 0.8 model safety floor. */
export function fitPairCutoff(rows, target, base, lexical) {
    const observed = rows.map(/** Fit the channel of the requested target class. */ /** Fit the channel of the requested target class. */ row => lexical ? row.lexical_score ?? row.probability : target === "related" ? row.related_probability ?? 0 : row.probability);
    const cutoffs = [...new Set([lexical ? 0 : 0.8, 1, ...observed])].filter(/** Preserve the existing 0.8 safety floor for model decisions. */ /** Preserve the existing 0.8 safety floor for model decisions. */ p => lexical || compareExact(p, 0.8) >= 0).sort(/** Prefer the lower cutoff on equal F1. */ (a, b) => compareExact(a, b));
    let best = asThreshold(null);
    let f1 = countRatio(-1, 1);
    for (const cutoff of cutoffs) {
        const thresholds = target === "related" && !lexical ? { ...base, relatedThreshold: cutoff } : { ...base, threshold: cutoff };
        const metrics = pairMetrics(rows, target, thresholds, lexical);
        if (!lexical && (metrics.tp === 0 || compareExact(metrics.tp + metrics.fp, 3) < 0))
            continue;
        const exactF1 = countRatio(2 * metrics.tp, 2 * metrics.tp + metrics.fp + metrics.fn);
        if (compareExact(exactF1, f1) > 0) {
            best = asThreshold(cutoff);
            f1 = exactF1;
        }
    }
    return best;
}
/** Last-release numeric fitting API delegates to the typed exact cutoff, preserving Infinity when unsupported. */
export function fitPairThreshold(rows, target, base, lexical) {
    return legacyThreshold(fitPairCutoff(rows, target, base, lexical));
}
/** Replay historical single-question receipts through the preserved public helper. */
export function duplicateMetrics(rows, threshold, lexical = false) {
    return pairMetrics(rows, "duplicate", { threshold, relatedThreshold: 0.8 }, lexical);
}
/** Preserve the documented dev-only fitting entry point for single-question callers. */
export function fitDuplicateThreshold(rows, lexical) {
    return fitPairThreshold(rows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, lexical);
}
/** Reconstruct an explicitly deleted duplicate from public append-only history; reject incomplete projections. */
export function historicalDuplicate(events) {
    const metadata = {};
    let body = "";
    for (const event of events) {
        if (event.op === "delete") {
            const target = /duplicate of ([a-z0-9]+(?:-[a-z0-9]+)+)|duplicate[^;]*; retained ([a-z0-9]+(?:-[a-z0-9]+)+)/i.exec(event.message ?? "");
            if (target === null || typeof metadata.id !== "string" || typeof metadata.title !== "string" || typeof metadata.type !== "string" || typeof metadata.created_at !== "string" || typeof metadata.updated_at !== "string" || !Array.isArray(metadata.tags))
                return undefined;
            return { ...metadata, description: typeof metadata.description === "string" ? metadata.description : "", body, status: "closed", close_reason: `Duplicate of ${target[1] ?? target[2]}` };
        }
        for (const patch of event.patch) {
            const key = /^\/metadata\/([^/]+)$/.exec(patch.path)?.[1];
            if (key !== undefined) {
                if (patch.op === "remove")
                    delete metadata[key];
                else
                    metadata[key] = patch.value;
            }
            else if (patch.path === "/body" && typeof patch.value === "string")
                body = patch.value;
            else
                return undefined;
        }
    }
    return undefined;
}
/** Repository-separated duplicate closure components, including siblings implied by recorded equivalence. */
export function repositoryDuplicatePairs(corpora, positivesPerSplit = 50) {
    const positives = [], controls = [];
    for (const corpus of corpora) {
        if (!corpus.items.some(/** No positive closure means no controls from this repository are sampled. */ /** No positive closure means no controls from this repository are sampled. */ item => (item.status === "closed" || item.status === "canceled") && closureTarget(item) !== undefined))
            continue;
        const { byId, targets, ranked, scores, cutoffs } = corpusIndex(corpus);
        const split = duplicateSplit(corpus.repository) === "train" ? "dev" : "heldout";
        const groups = new Map(corpus.items.map(/** Start each item as a singleton equivalence group. */ /** Start each item as a singleton equivalence group. */ item => [item.id, new Set([item.id])]));
        for (const item of corpus.items) {
            const target = targets.get(item.id);
            if ((item.status !== "closed" && item.status !== "canceled") || target === undefined || target === item.id || !byId.has(target))
                continue;
            const union = new Set([...groups.get(item.id), ...groups.get(target)]);
            for (const id of union)
                groups.set(id, union);
        }
        for (const group of new Set(groups.values())) {
            const members = [...group].sort();
            for (let i = 0; i < members.length; i++)
                for (let j = i + 1; j < members.length; j++) {
                    const key = pairKey(members[i], members[j]);
                    positives.push(labelPair(corpus.repository, indexedPair(byId.get(members[i]), byId.get(members[j]), scores, cutoffs), true, scores.has(key), split));
                }
        }
        for (const pair of ranked) {
            if (groups.get(pair.a.id) === groups.get(pair.b.id) || sameEvidence(pair))
                continue;
            controls.push(labelPair(corpus.repository, pair, false, true, split));
        }
    }
    return selectPairs(positives, controls, positivesPerSplit, false);
}
//# sourceMappingURL=dedupe-evaluation.js.map