import { candidatePairs, orderedPair, pairKey, pairState, pairVerdict } from "./dedupe.ts";
import type { PairItem, DuplicatePair } from "./dedupe.ts";
import { duplicateTarget } from "./tracker-evaluation.ts";
import { evidenceHash } from "./decision-calibration.ts";

/** Public, complete tracker-copy evidence accepted by the label builder. */
export interface DuplicateCorpus { repository: string; commit: string; items: PairItem[] }
/** A real duplicate closure, dependency edge or lexical hard control, with no labels sent to inference. */
export interface LabelledPair { pair_id: string; repository: string; pair: DuplicatePair; label: boolean; retrieved: boolean; split: "dev" | "heldout" }
/** Benchmark observation retains scores and probabilities without copied tracker text. */
export interface PairObservation { label: boolean; probability: number; related_probability?: number | null; retrieved: boolean }
/** Operating points for both typed questions; the lexical arm ignores the related channel. */
export interface PairThresholds { threshold: number; relatedThreshold: number }

/** Recognize explicit duplicate consolidation receipts as well as standard duplicate closures. */
export function closureTarget(item: PairItem): string | undefined {
  const reason = item.close_reason ?? "";
  return duplicateTarget(item) ?? (/duplicate-consolidation/i.test(reason) ? /Superseded by canonical item ([a-z0-9]+(?:-[a-z0-9]+)+)/i.exec(reason)?.[1] : undefined);
}

/** Follow resolvable duplicate chains, refusing cycles and missing targets. */
function canonical(id: string, targets: Map<string, string>, ids: Set<string>): string | null {
  const seen = new Set<string>();
  while (targets.has(id)) {
    if (seen.has(id)) return null;
    seen.add(id);
    id = targets.get(id) as string;
  }
  return ids.has(id) ? id : null;
}
/** Resolve duplicate groups and production candidates once for either label set. */
function corpusIndex(corpus: DuplicateCorpus) {
  const byId = new Map(corpus.items.map(/** Index complete tracker items. */ item => [item.id, item]));
  const ids = new Set(byId.keys()), targets = new Map<string, string>();
  for (const item of corpus.items) {
    const target = closureTarget(item);
    if (target !== undefined) targets.set(item.id, target);
  }
  const ranked = candidatePairs(corpus.items, corpus.items.length * 8);
  const scores = new Map(ranked.map(/** Preserve production channel scores. */ pair => [pairKey(pair.a.id, pair.b.id), pair.score]));
  return { byId, ids, targets, ranked, scores };
}
/** Store ordered pair identity immediately, including retrieval misses. */
function labelPair(repository: string, pair: DuplicatePair, label: boolean, retrieved: boolean, split: "dev" | "heldout"): LabelledPair {
  return { pair_id: `${repository}:${pair.a.id}:${pair.b.id}`, repository, pair, label, retrieved, split };
}
/** Identical semantic projections cannot establish reliable negative controls. */
function sameEvidence(pair: DuplicatePair): boolean {
  const state = pairState(pair);
  return evidenceHash(state.A) === evidenceHash(state.B);
}
/** Sample positives independently of scores, then select hard controls from their repositories. */
function selectPairs(positives: LabelledPair[], controls: LabelledPair[], count: number, related: boolean): LabelledPair[] {
  /** Preserve the published seeds and stable tie policies for both benchmark versions. */
  const samplingKey = (row: LabelledPair): string => related ? row.pair_id : pairKey(row.pair.a.id, row.pair.b.id);
  /** Duplicate and edge benchmarks retain their original tie identities. */
  const tieKey = (row: LabelledPair): string => related ? row.pair_id : `${row.repository}${samplingKey(row)}`;
  const selected: LabelledPair[] = [];
  for (const split of ["dev", "heldout"] as const) {
    const pos = positives.filter(/** Respect the preassigned population. */ row => row.split === split)
      .sort(/** Label sampling never depends on model outcomes. */ (a, b) => evidenceHash([a.repository, samplingKey(a)]).localeCompare(evidenceHash([b.repository, samplingKey(b)]))).slice(0, count);
    const repositories = new Set(pos.map(/** Restrict controls to the positive repositories. */ row => row.repository));
    const neg = controls.filter(/** Controls share their positive population. */ row => row.split === split && repositories.has(row.repository))
      .sort(/** Hardest retrieval scores first, with stable ties. */ (a, b) => b.pair.score - a.pair.score || tieKey(a).localeCompare(tieKey(b))).slice(0, 2 * pos.length);
    if (pos.length === 0 || neg.length !== 2 * pos.length) throw new Error("Insufficient real labels or lexical controls for both splits");
    selected.push(...pos, ...neg);
  }
  return selected;
}
/** Build duplicate-group-separated real closures and hard controls at a strict 2:1 ratio. */
export function labelledPairs(corpora: readonly DuplicateCorpus[], positivesPerSplit = 30): LabelledPair[] {
  const repositories = [...corpora].filter(/** Only repositories with terminal duplicate labels enter. */ corpus => corpus.items.some(/** Require an explicit closure target. */ item => (item.status === "closed" || item.status === "canceled") && closureTarget(item) !== undefined))
    .sort(/** Seeded ordering cannot depend on inference. */ (a, b) => evidenceHash(["dedupe-20261019", a.repository]).localeCompare(evidenceHash(["dedupe-20261019", b.repository])));
  const positives: LabelledPair[] = [], controls: LabelledPair[] = [];
  for (const corpus of repositories) {
    const { byId, ids, targets, ranked, scores } = corpusIndex(corpus);
    const known = new Set<string>();
    /** Entire resolved duplicate groups share a preassigned split. */
    const splitOf = (id: string): "dev" | "heldout" => evidenceHash(["dedupe-20261019", corpus.repository, canonical(id, targets, ids)])[0] < "8" ? "dev" : "heldout";
    for (const item of corpus.items) {
      if (item.status !== "closed" && item.status !== "canceled") continue;
      const target = targets.get(item.id);
      if (target === undefined || target === item.id || !byId.has(target) || canonical(item.id, targets, ids) === null) continue;
      const key = pairKey(item.id, target);
      if (known.has(key)) continue;
      known.add(key);
      const pair = orderedPair(item, byId.get(target) as PairItem, scores.get(key) ?? 0);
      positives.push(labelPair(corpus.repository, pair, true, scores.has(key), splitOf(item.id)));
    }
    for (const pair of ranked) {
      const a = canonical(pair.a.id, targets, ids), b = canonical(pair.b.id, targets, ids);
      if (a === null || b === null || a === b || splitOf(a) !== splitOf(b) || sameEvidence(pair)) continue;
      controls.push(labelPair(corpus.repository, pair, false, true, splitOf(a)));
    }
  }
  return selectPairs(positives, controls, positivesPerSplit, false);
}
/** Build repository-separated real dependency edges and lexical controls at a strict 2:1 ratio. */
export function labelledRelatedPairs(corpora: readonly DuplicateCorpus[], positivesPerSplit = 15): LabelledPair[] {
  const positives: LabelledPair[] = [], controls: LabelledPair[] = [];
  for (const corpus of corpora) {
    const { byId, ids, targets, ranked, scores } = corpusIndex(corpus);
    /** Exclude entire duplicate groups, cycles and unresolved targets. */
    const separateWork = (a: string, b: string): boolean => {
      const left = canonical(a, targets, ids), right = canonical(b, targets, ids);
      return left !== null && right !== null && left !== right;
    };
    const edges = new Set<string>(), seen = new Set<string>();
    const split = evidenceHash(["dedupe-related", corpus.repository])[0] < "8" ? "dev" : "heldout";
    for (const item of corpus.items) {
      for (const dep of item.dependencies ?? []) {
        if (dep.id === item.id || !byId.has(dep.id)) continue;
        const key = pairKey(item.id, dep.id);
        edges.add(key);
        if (!separateWork(item.id, dep.id) || seen.has(key)) continue;
        seen.add(key);
        const pair = orderedPair(item, byId.get(dep.id) as PairItem, scores.get(key) ?? 0);
        positives.push(labelPair(corpus.repository, pair, true, scores.has(key), split));
      }
    }
    for (const pair of ranked) {
      if (edges.has(pairKey(pair.a.id, pair.b.id)) || !separateWork(pair.a.id, pair.b.id) || sameEvidence(pair)) continue;
      controls.push(labelPair(corpus.repository, pair, false, true, split));
    }
  }
  return selectPairs(positives, controls, positivesPerSplit, true);
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
/** Harmonic mean with explicit zero support. */
function harmonic(a: number, b: number): number { return a + b === 0 ? 0 : 2 * a * b / (a + b); }
/** The verdict stub used to score stored observations; ids never enter metrics. */
const scoredPair = { a: { id: "a" }, b: { id: "b" } } as DuplicatePair;
/** Positive-class metrics count abstained and unretrieved positives as missed work. */
export function pairMetrics(rows: readonly PairObservation[], target: "duplicate" | "related", thresholds: PairThresholds, lexical = false) {
  let tp = 0, fp = 0, fn = 0, abstained = 0;
  for (const row of rows) {
    const decision = !row.retrieved ? "distinct" as const : lexical ? (row.probability >= thresholds.threshold ? target : "distinct" as const) : pairVerdict(scoredPair, row.probability, row.related_probability ?? 0, thresholds.threshold, thresholds.relatedThreshold).decision;
    if (decision === "abstain") abstained++;
    if (decision === target) { if (row.label) tp++; else fp++; }
    else if (row.label) fn++;
  }
  const precision = tp + fp === 0 ? null : tp / (tp + fp);
  const recall = tp + fn === 0 ? null : tp / (tp + fn);
  const pBounds = wilson(tp, tp + fp, 2.241402727604947);
  const rBounds = wilson(tp, tp + fn, 2.241402727604947);
  return { count: rows.length, tp, fp, fn, precision, recall, f1: precision === null || recall === null ? 0 : harmonic(precision, recall),
    precision_ci95: wilson(tp, tp + fp), recall_ci95: wilson(tp, tp + fn),
    f1_wilson_envelope95: pBounds === null || rBounds === null ? null : [harmonic(pBounds[0], rBounds[0]), harmonic(pBounds[1], rBounds[1])],
    abstain_rate: rows.length === 0 ? null : abstained / rows.length, abstain_ci95: wilson(abstained, rows.length) };
}
/** Tune F1 on dev observations only, retaining the existing 0.8 model safety floor. */
export function fitPairThreshold(rows: readonly PairObservation[], target: "duplicate" | "related", base: PairThresholds, lexical: boolean): number {
  const observed = rows.map(/** Fit the channel of the requested target class. */ row => target === "related" && !lexical ? row.related_probability ?? 0 : row.probability);
  const cutoffs = [...new Set([lexical ? 0 : 0.8, 1, ...observed])].filter(/** Preserve the existing 0.8 safety floor for model decisions. */ p => lexical || p >= 0.8).sort(/** Prefer the lower cutoff on equal F1. */ (a, b) => a - b);
  let best = Infinity, f1 = -1;
  for (const cutoff of cutoffs) {
    const thresholds = target === "related" && !lexical ? { ...base, relatedThreshold: cutoff } : { ...base, threshold: cutoff };
    const metrics = pairMetrics(rows, target, thresholds, lexical);
    if (!lexical && (metrics.tp === 0 || metrics.tp + metrics.fp < 3)) continue;
    if (metrics.f1 > f1) { best = cutoff; f1 = metrics.f1; }
  }
  return best;
}

/** Replay historical single-question receipts through the preserved public helper. */
export function duplicateMetrics(rows: readonly PairObservation[], threshold: number, lexical = false) {
  return pairMetrics(rows, "duplicate", { threshold, relatedThreshold: 0.8 }, lexical);
}
/** Preserve the documented dev-only fitting entry point for single-question callers. */
export function fitDuplicateThreshold(rows: readonly PairObservation[], lexical: boolean): number {
  return fitPairThreshold(rows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, lexical);
}
