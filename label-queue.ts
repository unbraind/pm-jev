import { createHash } from "node:crypto";
import { compareExact, fraction, displayRatio } from "./exact.ts";
import { LABEL_QUEUE_VERSION, LABEL_QUEUE_LIMITS, LabelQueueRefusal, parseLabelQueueInput, labelCaseKey, labelOrdinal } from "./label-schema.ts";
import type { LabelCase, LabelPolicy, LabelRatio, LabelCaseRejection } from "./label-schema.ts";

/** Mutually exclusive omission reasons in precedence order. */
export type LabelOmission = "invalid" | "held_out" | "other_cohort" | "human_labeled" | "not_pending" | "below_uncertainty" | "diversity" | "budget" | "limit";
/** A selected reference retains inferred provenance without granting ground-truth status. */
export interface LabelQueueEntry extends LabelCase { readonly rank: number; readonly uncertainty_display: number; readonly ground_truth: false }
/** Bounded advisory receipt; integer budget is a per-call cap, never a shared reservation. */
export interface LabelQueueReport {
  readonly ok: true; readonly version: typeof LABEL_QUEUE_VERSION; readonly input_sha256: string;
  readonly policy: LabelPolicy; readonly counts: { readonly candidates: number; readonly eligible: number; readonly selected: number; readonly omitted: number };
  readonly omissions: Readonly<Record<LabelOmission, number>>;
  readonly rejected: readonly LabelCaseRejection[]; readonly rejected_omitted: number;
  readonly spent: number; readonly remaining: number; readonly queue: readonly LabelQueueEntry[];
  readonly inference_calls: 0; readonly mutations: 0; readonly mutation_authority: "none";
}
/** Exact count comparison, including arbitrarily close ratios inside the documented integer domain. */
function compareRatio(a: LabelRatio, b: LabelRatio): number { return compareExact(fraction(a.numerator, a.denominator), fraction(b.numerator, b.denominator)); }
/** Seeded hash breaks uncertainty/diversity ties without mutable RNG or input-order bias. */
function tie(seed: string, row: LabelCase): string { return createHash("sha256").update(JSON.stringify([seed, labelCaseKey(row)])).digest("hex"); }
/** Check every emitted numeric field and conservation law before returning an ok receipt. */
export function validateLabelQueueReportNumbers(report: LabelQueueReport): LabelQueueReport {
  const { policy: p, counts: c } = report;
  /** Output counts and costs must remain finite integers in their documented domain. */
  const count = (value: number, maximum: number) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
  /** Exact displayed ratios are bounded probabilities; they never feed a selection decision. */
  const ratio = (value: LabelRatio) => count(value.numerator, LABEL_QUEUE_LIMITS.ratio) && count(value.denominator, LABEL_QUEUE_LIMITS.ratio) && value.denominator > 0 && value.numerator <= value.denominator;
  const valid = [c.candidates, c.eligible, c.selected, c.omitted, ...Object.values(report.omissions)].every(/** No count can exceed the input bound. */ value => count(value, LABEL_QUEUE_LIMITS.cases))
    && count(p.budget, LABEL_QUEUE_LIMITS.units) && count(p.limit, LABEL_QUEUE_LIMITS.queue) && count(p.max_per_bucket, LABEL_QUEUE_LIMITS.queue) && p.max_per_bucket > 0 && ratio(p.min_uncertainty)
    && count(report.spent, p.budget) && count(report.remaining, p.budget) && report.spent + report.remaining === p.budget
    && c.selected === report.queue.length && c.selected <= p.limit && c.eligible <= c.candidates && c.selected <= c.eligible && c.selected + c.omitted === c.candidates
    && Object.values(report.omissions).reduce(/** Each omitted candidate has one reason. */ (a, b) => a + b, 0) === c.omitted
    && report.queue.every(/** Every reference number obeys the producer's original domains. */ (row, index) => row.rank === index + 1 && count(row.cost, LABEL_QUEUE_LIMITS.units) && row.cost > 0 && ratio(row.uncertainty) && Number.isFinite(row.uncertainty_display) && row.uncertainty_display >= 0 && row.uncertainty_display <= 1)
    && report.queue.reduce(/** Selected costs must account for the entire spent budget. */ (sum, row) => sum + row.cost, 0) === report.spent && report.inference_calls === 0 && report.mutations === 0
    && count(report.rejected_omitted, c.candidates) && report.rejected.length <= 10 && report.rejected.length + report.rejected_omitted === report.omissions.invalid
    && report.rejected.every(/** Diagnostics reference only actual input positions. */ row => count(row.index, c.candidates - 1));
  if (!valid) throw new LabelQueueRefusal("invalid_report", "Do not use this queue; retain the input and report a numeric invariant failure.");
  return report;
}
/** Rank explicit labeling candidates without fetching sources, inferring labels or changing any state. */
export function selectLabelQueue(raw: unknown): LabelQueueReport {
  const parsed = parseLabelQueueInput(raw), { input } = parsed, p = input.policy;
  const omissions: Record<LabelOmission, number> = { invalid: parsed.rejected.length, held_out: 0, other_cohort: 0, human_labeled: 0, not_pending: 0, below_uncertainty: 0, diversity: 0, budget: 0, limit: 0 };
  const heldOut = new Set(input.cohorts.filter(/** Held-out boundaries precede all eligibility rules. */ row => row.role === "held_out").map(/** Membership is by exact source identity. */ row => row.id));
  const eligible: LabelCase[] = [];
  for (const row of input.cases) {
    const reason = heldOut.has(row.cohort) ? "held_out" : row.cohort !== p.cohort ? "other_cohort" : row.label.kind === "human" ? "human_labeled" : row.state === "decided" ? "not_pending" : compareRatio(row.uncertainty, p.min_uncertainty) < 0 ? "below_uncertainty" : null;
    if (reason === null) eligible.push(row); else omissions[reason]++;
  }
  const pending = new Map(eligible.map(/** Cache stable tie hashes once per candidate. */ row => [labelCaseKey(row), { row, tie: tie(p.seed, row) }]));
  const buckets = new Map<string, number>(); const queue: LabelQueueEntry[] = []; let spent = 0;
  while (queue.length < p.limit) {
    let best: { row: LabelCase; tie: string } | undefined;
    for (const candidate of pending.values()) {
      const n = buckets.get(candidate.row.bucket) ?? 0;
      if (n >= p.max_per_bucket || candidate.row.cost > p.budget - spent) continue;
      const diversity = best === undefined || p.diversity === "cap" ? 0 : n - (buckets.get(best.row.bucket) ?? 0);
      if (best === undefined || diversity < 0 || diversity === 0 && (compareRatio(candidate.row.uncertainty, best.row.uncertainty) > 0 || compareRatio(candidate.row.uncertainty, best.row.uncertainty) === 0 && labelOrdinal(candidate.tie, best.tie) < 0)) best = candidate;
    }
    if (best === undefined) break;
    const row = best.row;
    pending.delete(labelCaseKey(row)); spent += row.cost; buckets.set(row.bucket, (buckets.get(row.bucket) ?? 0) + 1);
    queue.push({ ...row, rank: queue.length + 1, uncertainty_display: displayRatio(row.uncertainty.numerator, row.uncertainty.denominator), ground_truth: false });
  }
  for (const { row } of pending.values()) {
    const reason = (buckets.get(row.bucket) ?? 0) >= p.max_per_bucket ? "diversity" : row.cost > p.budget - spent ? "budget" : "limit";
    omissions[reason]++;
  }
  return validateLabelQueueReportNumbers({ ok: true, version: LABEL_QUEUE_VERSION, input_sha256: createHash("sha256").update(JSON.stringify(parsed)).digest("hex"), policy: p,
    counts: { candidates: parsed.candidates, eligible: eligible.length, selected: queue.length, omitted: parsed.candidates - queue.length }, omissions,
    rejected: parsed.rejected.slice(0, 10), rejected_omitted: Math.max(0, parsed.rejected.length - 10),
    spent, remaining: p.budget - spent, queue, inference_calls: 0, mutations: 0, mutation_authority: "none" });
}
