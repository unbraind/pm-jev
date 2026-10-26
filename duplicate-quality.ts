import { acceptsThreshold } from "./threshold.ts";
import { addExact, compareExact, countRatio, displayExact, displayRatio, multiplyExact } from "./exact.ts";
import { evidenceHash } from "./decision-calibration.ts";
import type { Rational } from "./exact.ts";
import type { DuplicatePair, PairItem } from "./dedupe.ts";

/** Repository-only assignment frozen before labels, scores or model outcomes. */
export function duplicateSplit(repository: string): "train" | "heldout" {
  return evidenceHash(["duplicate-quality-20261021", repository])[0] < "8" ? "train" : "heldout";
}
/** Normalize tokens without ids, closure reasons, annotations or receipts. */
function tokens(text: string): Set<string> {
  return new Set(text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu));
}
/** Symmetric overlap; missing evidence cannot count as agreement. */
function overlap(a: Set<string>, b: Set<string>): Rational {
  return countRatio(2 * [...a].filter(/** Count actual shared evidence. */ token => b.has(token)).length, a.size + b.size);
}
/** Title-focused semantic evidence; generic shared tags alone cannot score as duplicates. */
export function duplicateSimilarityRatio(pair: DuplicatePair): Rational {
  /** Combine distinct description and body without doubling a repeated summary. */
  const text = (item: PairItem): Set<string> => tokens([...new Set([item.description, item.body ?? ""])].join("\n"));
  /** Keep tag and path namespaces distinct. */
  const structure = (item: PairItem): Set<string> => new Set([...item.tags.map(/** Normalize tags. */ tag => `#${tag.toLowerCase()}`), ...(item.files ?? []).map(/** Normalize linked file paths. */ file => `@${file.path.toLowerCase()}`)]);
  return addExact(addExact(multiplyExact("0.65", overlap(tokens(pair.a.title), tokens(pair.b.title))), multiplyExact("0.3", overlap(text(pair.a), text(pair.b)))), multiplyExact("0.05", overlap(structure(pair.a), structure(pair.b))));
}
/** Numeric compatibility view of the exact lexical count score, for report display only. */
export function duplicateSimilarity(pair: DuplicatePair): number { return displayExact(duplicateSimilarityRatio(pair)); }
/** Raw benchmark evidence shared by every arm; model-only bypasses candidate retrieval. */
export interface QualityObservation { label: boolean; retrieved: boolean; lexical: number; probability: number }
/** Frozen train operating point. Null disables positive proposals, including probability one. */
export interface QualityPolicy { model: number | null; lexical: number | null }
/** The three ablations use exactly the same labelled population. */
export type QualityArm = "lexical-only" | "model-only" | "combined";
/** Positive decisions require every enabled channel; all remaining rows explicitly abstain. */
export function qualityProposes(row: QualityObservation, arm: QualityArm, policy: QualityPolicy): boolean {
  return (arm === "model-only" || row.retrieved) &&
    (arm === "lexical-only" || policy.model !== null && acceptsThreshold(row.probability, policy.model)) &&
    (arm === "model-only" || policy.lexical !== null && acceptsThreshold(row.lexical, policy.lexical));
}
/** Unretrieved positives stay in recall; every withheld proposal is an unsure decision. */
export function qualityMetrics(rows: readonly QualityObservation[], arm: QualityArm, policy: QualityPolicy) {
  let tp = 0, fp = 0, fn = 0, abstained = 0;
  for (const row of rows) {
    if (qualityProposes(row, arm, policy)) { if (row.label) tp++; else fp++; }
    else { abstained++; if (row.label) fn++; }
  }
  return { count: rows.length, tp, fp, fn, precision: tp + fp === 0 ? null : displayRatio(tp, tp + fp), recall: tp + fn === 0 ? null : displayRatio(tp, tp + fn),
    abstention_rate: rows.length === 0 ? null : displayRatio(abstained, rows.length), precision_ci95: wilson(tp, tp + fp), recall_ci95: wilson(tp, tp + fn) };
}
/** Canonical reduced ratios deduplicate frontier points without rounded numeric keys. */
function ratioKey(numerator: number, denominator: number): string {
  const value = countRatio(numerator, denominator);
  return `${value.numerator}/${value.denominator}`;
}
/** Enumerate train-observed cutoffs and retain the precision/recall frontier plus a disable point. */
export function qualityFrontier(train: readonly QualityObservation[], arm: QualityArm) {
  const models = arm === "lexical-only" ? [null] : [...new Set(train.map(/** Raw model scores are not calibrated precision; search the full train range. */ row => row.probability))].sort(/** Stable cutoff order. */ (a, b) => compareExact(a, b));
  const lexical = arm === "model-only" ? [null] : [...new Set(train.map(/** Lexical evidence is a score, not a probability. */ row => row.lexical))].sort(/** Stable cutoff order. */ (a, b) => compareExact(a, b));
  const points = [{ policy: { model: null, lexical: null } as QualityPolicy, train: qualityMetrics(train, arm, { model: null, lexical: null }) }];
  for (const model of models) for (const score of lexical) {
    const policy = { model, lexical: score };
    points.push({ policy, train: qualityMetrics(train, arm, policy) });
  }
  const unique = new Map<string, typeof points[number]>();
  for (const point of points.slice(1)) {
    if (point.train.precision === null) continue;
    const key = `${ratioKey(point.train.tp, point.train.tp + point.train.fp)}:${ratioKey(point.train.tp, point.train.tp + point.train.fn)}`;
    // The grid visits model then lexical cutoffs in ascending order; its last train-equivalent policy is strictest.
    unique.set(key, point);
  }
  const ranked = [...unique.values()].sort(/** Higher recall first; the best precision at each recall dominates its peers. */ (a, b) => compareExact(countRatio(b.train.tp, b.train.tp + b.train.fn), countRatio(a.train.tp, a.train.tp + a.train.fn)) || compareExact(countRatio(b.train.tp, b.train.tp + b.train.fp), countRatio(a.train.tp, a.train.tp + a.train.fp)));
  let precision = countRatio(-1, 1);
  return [points[0], ...ranked.filter(/** Retain only train-nondominated points, without inspecting held-out observations. */ point => {
    const candidate = countRatio(point.train.tp, point.train.tp + point.train.fp);
    const keep = compareExact(candidate, precision) > 0;
    if (keep) precision = candidate;
    return keep;
  })];
}
/** Maximize train recall at precision >= 0.8 and >= 3 predictions; ties prefer precision then stricter cutoffs. */
export function fitQualityPolicy(train: readonly QualityObservation[], arm: QualityArm): QualityPolicy {
  const qualified = qualityFrontier(train, arm).filter(/** Avoid a one-example precision claim or an empty-set qualification. */ point => point.train.precision !== null && compareExact(countRatio(point.train.tp, point.train.tp + point.train.fp), 0.8) >= 0 && compareExact(point.train.tp + point.train.fp, 3) >= 0);
  return qualified[0]?.policy ?? { model: null, lexical: null };
}

/** Two-sided Wilson interval; empty denominators remain explicitly undefined. */
export function wilson(successes: number, count: number, z = 1.959963984540054): [number, number] | null {
  if (count === 0) return null;
  const p = successes / count;
  const d = 1 + z * z / count;
  const center = (p + z * z / (2 * count)) / d;
  const delta = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / d;
  return [Math.max(0, center - delta), Math.min(1, center + delta)];
}
