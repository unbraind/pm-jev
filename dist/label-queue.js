import { createHash } from "node:crypto";
import { compareExact, fraction, displayRatio } from "./exact.js";
import { LABEL_QUEUE_VERSION, LABEL_QUEUE_LIMITS, LabelQueueRefusal, parseLabelQueueInput, labelCaseKey, labelOrdinal } from "./label-schema.js";
/** Exact count comparison, including arbitrarily close ratios inside the documented integer domain. */
function compareRatio(a, b) { return compareExact(fraction(a.numerator, a.denominator), fraction(b.numerator, b.denominator)); }
/** Seeded hash breaks uncertainty/diversity ties without mutable RNG or input-order bias. */
function tie(seed, row) { return createHash("sha256").update(JSON.stringify([seed, labelCaseKey(row)])).digest("hex"); }
/** Check every emitted numeric field and conservation law before returning an ok receipt. */
export function validateLabelQueueReportNumbers(report) {
    const { policy: p, counts: c } = report;
    /** Output counts and costs must remain finite integers in their documented domain. */
    const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
    /** Exact displayed ratios are bounded probabilities; they never feed a selection decision. */
    const ratio = (value) => count(value.numerator, LABEL_QUEUE_LIMITS.ratio) && count(value.denominator, LABEL_QUEUE_LIMITS.ratio) && value.denominator > 0 && value.numerator <= value.denominator;
    const valid = [c.candidates, c.eligible, c.selected, c.omitted, ...Object.values(report.omissions)].every(/** No count can exceed the input bound. */ /** No count can exceed the input bound. */ value => count(value, LABEL_QUEUE_LIMITS.cases))
        && count(p.budget, LABEL_QUEUE_LIMITS.units) && count(p.limit, LABEL_QUEUE_LIMITS.queue) && count(p.max_per_bucket, LABEL_QUEUE_LIMITS.queue) && p.max_per_bucket > 0 && ratio(p.min_uncertainty)
        && count(report.spent, p.budget) && count(report.remaining, p.budget) && report.spent + report.remaining === p.budget
        && c.selected === report.queue.length && c.selected <= p.limit && c.eligible <= c.candidates && c.selected <= c.eligible && c.selected + c.omitted === c.candidates
        && Object.values(report.omissions).reduce(/** Each omitted candidate has one reason. */ (a, b) => a + b, 0) === c.omitted
        && report.queue.every(/** Every reference number obeys the producer's original domains. */ (row, index) => row.rank === index + 1 && count(row.cost, LABEL_QUEUE_LIMITS.units) && row.cost > 0 && ratio(row.uncertainty) && Number.isFinite(row.uncertainty_display) && row.uncertainty_display >= 0 && row.uncertainty_display <= 1)
        && report.queue.reduce(/** Selected costs must account for the entire spent budget. */ (sum, row) => sum + row.cost, 0) === report.spent && report.inference_calls === 0 && report.mutations === 0
        && count(report.rejected_omitted, c.candidates) && report.rejected.length <= 10 && report.rejected.length + report.rejected_omitted === report.omissions.invalid
        && report.rejected.every(/** Diagnostics reference only actual input positions. */ /** Diagnostics reference only actual input positions. */ row => count(row.index, c.candidates - 1));
    if (!valid)
        throw new LabelQueueRefusal("invalid_report", "Do not use this queue; retain the input and report a numeric invariant failure.");
    return report;
}
/** Rank explicit labeling candidates without fetching sources, inferring labels or changing any state. */
export function selectLabelQueue(raw) {
    const parsed = parseLabelQueueInput(raw), { input } = parsed, p = input.policy;
    const omissions = { invalid: parsed.rejected.length, held_out: 0, other_cohort: 0, human_labeled: 0, not_pending: 0, below_uncertainty: 0, diversity: 0, budget: 0, limit: 0 };
    const heldOut = new Set(input.cohorts.filter(/** Held-out boundaries precede all eligibility rules. */ /** Held-out boundaries precede all eligibility rules. */ row => row.role === "held_out").map(/** Membership is by exact source identity. */ /** Membership is by exact source identity. */ row => row.id));
    const eligible = [];
    for (const row of input.cases) {
        const reason = heldOut.has(row.cohort) ? "held_out" : row.cohort !== p.cohort ? "other_cohort" : row.label.kind === "human" ? "human_labeled" : row.state === "decided" ? "not_pending" : compareRatio(row.uncertainty, p.min_uncertainty) < 0 ? "below_uncertainty" : null;
        if (reason === null)
            eligible.push(row);
        else
            omissions[reason]++;
    }
    const pending = new Map(eligible.map(/** Cache stable tie hashes once per candidate. */ /** Cache stable tie hashes once per candidate. */ row => [labelCaseKey(row), { row, tie: tie(p.seed, row) }]));
    const buckets = new Map();
    const queue = [];
    let spent = 0;
    while (queue.length < p.limit) {
        let best;
        for (const candidate of pending.values()) {
            const n = buckets.get(candidate.row.bucket) ?? 0;
            if (n >= p.max_per_bucket || candidate.row.cost > p.budget - spent)
                continue;
            const diversity = best === undefined || p.diversity === "cap" ? 0 : n - (buckets.get(best.row.bucket) ?? 0);
            if (best === undefined || diversity < 0 || diversity === 0 && (compareRatio(candidate.row.uncertainty, best.row.uncertainty) > 0 || compareRatio(candidate.row.uncertainty, best.row.uncertainty) === 0 && labelOrdinal(candidate.tie, best.tie) < 0))
                best = candidate;
        }
        if (best === undefined)
            break;
        const row = best.row;
        pending.delete(labelCaseKey(row));
        spent += row.cost;
        buckets.set(row.bucket, (buckets.get(row.bucket) ?? 0) + 1);
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
//# sourceMappingURL=label-queue.js.map