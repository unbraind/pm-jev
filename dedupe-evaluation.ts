import { candidatePairs, orderedPair, pairKey, pairState, pairVerdict } from "./dedupe.ts";
import type { PairItem, DuplicatePair } from "./dedupe.ts";
import { duplicateTarget } from "./tracker-evaluation.ts";
import { evidenceHash } from "./decision-calibration.ts";

/** Public, complete tracker-copy evidence accepted by the label builder. */
export interface DuplicateCorpus { repository: string; commit: string; items: PairItem[] }
/** A real duplicate closure or a lexical hard control, with no labels sent to inference. */
export interface LabelledPair { pair_id: string; repository: string; pair: DuplicatePair; label: boolean; retrieved: boolean; split: "dev" | "heldout" }
/** Benchmark observation retains scores and probabilities without copied tracker text. */
export interface PairObservation { label: boolean; probability: number; retrieved: boolean }

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
/** Build duplicate-group-separated real closures and top lexical controls at a strict 2:1 ratio. */
export function labelledPairs(corpora: readonly DuplicateCorpus[], positivesPerSplit = 30): LabelledPair[] {
  const repositories = [...corpora].filter(/** Only labelled repositories enter stratified partitioning. */ corpus => corpus.items.some(/** Require a terminal duplicate closure with a target. */ item => (item.status === "closed" || item.status === "canceled") && closureTarget(item) !== undefined))
    .sort(/** Seeded repository ordering prevents model outcomes from influencing the split. */ (a, b) => evidenceHash(["dedupe-20261019", a.repository]).localeCompare(evidenceHash(["dedupe-20261019", b.repository])));
  const positives: LabelledPair[] = [];
  const controls: LabelledPair[] = [];
  for (const corpus of repositories) {
    const byId = new Map(corpus.items.map(/** Index complete items locally. */ item => [item.id, item]));
    const ids = new Set(byId.keys());
    const targets = new Map<string, string>();
    for (const item of corpus.items) {
      const target = closureTarget(item);
      if (target !== undefined) targets.set(item.id, target);
    }
    const ranked = candidatePairs(corpus.items, corpus.items.length * 8);
    const scores = new Map(ranked.map(/** Preserve the same corpus-frequency scoring used in production. */ pair => [pairKey(pair.a.id, pair.b.id), pair.score]));
    const retrieved = new Set(ranked.map(/** Record retrieval misses instead of dropping hard positives. */ pair => pairKey(pair.a.id, pair.b.id)));
    const known = new Set<string>();
    /** Keep every member of an explicit duplicate group in one preassigned split. */
    const splitOf = (id: string): "dev" | "heldout" => evidenceHash(["dedupe-20261019", corpus.repository, canonical(id, targets, ids)])[0] < "8" ? "dev" : "heldout";
    for (const item of corpus.items) {
      if (item.status !== "closed" && item.status !== "canceled") continue;
      const target = targets.get(item.id);
      if (target === undefined || target === item.id || !byId.has(target) || canonical(item.id, targets, ids) === null) continue;
      const key = pairKey(item.id, target);
      if (known.has(key)) continue;
      known.add(key);
      const other = byId.get(target) as PairItem;
      const score = scores.get(key) ?? 0;
      const pair = orderedPair(item, other, score);
      positives.push({ pair_id: `${corpus.repository}:${pair.a.id}:${pair.b.id}`, repository: corpus.repository, pair, label: true, retrieved: retrieved.has(key), split: splitOf(item.id) });
    }
    for (const pair of ranked) {
      const a = canonical(pair.a.id, targets, ids);
      const b = canonical(pair.b.id, targets, ids);
      if (a === null || b === null || a === b || splitOf(a) !== splitOf(b)) continue;
      const state = pairState(pair);
      if (evidenceHash(state.A) === evidenceHash(state.B)) continue;
      controls.push({ pair_id: `${corpus.repository}:${pair.a.id}:${pair.b.id}`, repository: corpus.repository, pair, label: false, retrieved: true, split: splitOf(a) });
    }
  }
  const selected: LabelledPair[] = [];
  for (const split of ["dev", "heldout"] as const) {
    const pos = positives.filter(/** Keep disjoint repository populations. */ row => row.split === split).sort(/** Deterministic positive sampling independent of lexical similarity. */ (a, b) => evidenceHash([a.repository, pairKey(a.pair.a.id, a.pair.b.id)]).localeCompare(evidenceHash([b.repository, pairKey(b.pair.a.id, b.pair.b.id)]))).slice(0, positivesPerSplit);
    const neg = controls.filter(/** Controls come from the selected positive repositories only. */ row => row.split === split && pos.some(/** Match the current repository population. */ positive => positive.repository === row.repository)).sort(/** Use the generator's hardest controls with stable ties. */ (a, b) => b.pair.score - a.pair.score || `${a.repository}${pairKey(a.pair.a.id, a.pair.b.id)}`.localeCompare(`${b.repository}${pairKey(b.pair.a.id, b.pair.b.id)}`)).slice(0, 2 * pos.length);
    if (pos.length === 0 || neg.length !== 2 * pos.length) throw new Error("Insufficient real duplicate closures or lexical controls for both splits");
    selected.push(...pos, ...neg);
  }
  return selected;
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
/** Positive-class metrics count abstained and unretrieved positives as missed work. */
export function duplicateMetrics(rows: readonly PairObservation[], threshold: number, lexical = false) {
  let tp = 0, fp = 0, fn = 0, abstained = 0;
  for (const row of rows) {
    const decision = !row.retrieved ? "distinct" : lexical ? (row.probability >= threshold ? "duplicate" : "distinct") : pairVerdict({ a: { id: "a" }, b: { id: "b" } } as DuplicatePair, row.probability, threshold).decision;
    if (decision === "abstain") abstained++;
    if (decision === "duplicate") { if (row.label) tp++; else fp++; }
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
export function fitDuplicateThreshold(rows: readonly PairObservation[], lexical: boolean): number {
  const cutoffs = [...new Set([lexical ? 0 : 0.8, 1, ...rows.map(/** Fit only observed cutoffs, retaining ties. */ row => row.probability)])].filter(/** Preserve the existing 0.8 safety floor for model decisions. */ p => lexical || p >= 0.8).sort(/** Prefer the lower cutoff on equal F1. */ (a, b) => a - b);
  let best = Infinity, f1 = -1;
  for (const threshold of cutoffs) {
    const metrics = duplicateMetrics(rows, threshold, lexical);
    if (!lexical && (metrics.tp === 0 || metrics.tp + metrics.fp < 3)) continue;
    if (metrics.f1 > f1) { best = threshold; f1 = metrics.f1; }
  }
  return best;
}
