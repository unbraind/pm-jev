import assert from "node:assert/strict";
import test from "node:test";
import { encode, decode } from "@toon-format/toon";
import { threshold, compareThreshold, acceptsThreshold, thresholdRatio, numericBoundary, legacyThreshold, marginValue, belowComplement } from "../threshold.ts";
import type { Threshold } from "../threshold.ts";
import { fraction, precisionMeets } from "../exact.ts";
import { resolveTriageType, KEEP_CURRENT_TYPE } from "../index.ts";
import { deriveThreshold } from "../calibration.ts";
import { fitTypeMargin, typeMetrics } from "../type-calibration.ts";
import type { TypeObservation } from "../type-calibration.ts";
import { fitPairCutoff, fitPairThreshold, fitDuplicateThreshold, duplicateMetrics, pairMetrics } from "../dedupe-evaluation.ts";
import { fitQualityPolicy, qualityMetrics, qualityProposes } from "../duplicate-quality.ts";
import { selectAbstentionPolicy, abstainWithPolicy } from "../cost-policy.ts";
import type { CostObservation } from "../cost-policy.ts";
import { pairVerdict } from "../dedupe.ts";
import type { DuplicatePair } from "../dedupe.ts";
import type { ChoiceResponse } from "@typesafe-ai/sdk";

/** Preserve public JSON values with the actual TOON codec rather than a test-specific parser. */
function roundTrips<T>(value: T): T[] { return [value, JSON.parse(JSON.stringify(value)) as T, decode(encode(value)) as T]; }
/** Construct stored probabilities directly, including deliberate float-noise and exact ties. */
function observation(i: number, top: number, other: number, expected: string, current = "Task"): TypeObservation {
  const after: ChoiceResponse = { type: "choice", choice: "Feature", confidence: top, probabilities: { Feature: top, Task: other } };
  return { id: String(i), expected, current, split: "calibration", text: "Synthetic calibration observation", before: after, after };
}
/** Independent unreduced decimal parser for the stored-probability application oracle. */
function reference(value: number): [bigint, bigint] {
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [whole, fractional = ""] = mantissa.split(".");
  return [BigInt(whole + fractional), 10n ** BigInt(fractional.length - Number(exponent))];
}
/** Compare stored margins with a numeric boundary without using production threshold helpers. */
function referenceAccepts(row: TypeObservation, cutoff: number): boolean {
  const ordered = Object.values(row.after.probabilities).sort((a, b) => b - a);
  const [a, ad] = reference(ordered[0]), [b, bd] = reference(ordered[1]), [t, td] = reference(cutoff);
  return (a * bd - b * ad) * td >= t * ad * bd;
}

test("released unsupported-fit call forms preserve Infinity disabled metrics and typed disabled results", () => {
  const rows = [{ label: true, probability: 0.9, related_probability: 0, retrieved: true }];
  const cutoff = fitDuplicateThreshold(rows, false);
  assert.equal(cutoff, Infinity);
  const typed = fitPairCutoff(rows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, false);
  assert.deepEqual(typed, { state: "disabled" });
  for (const policy of [cutoff, null, ...roundTrips(typed)]) {
    const metrics = duplicateMetrics(rows, policy);
    assert.equal(metrics.count, 1); assert.equal(metrics.tp, 0); assert.equal(metrics.fp, 0); assert.equal(metrics.fn, 1);
    assert.equal(metrics.abstain_rate, 1); assert.equal(metrics.f1, 0);
    assert.deepEqual(metrics, duplicateMetrics(rows, Infinity));
    assert.doesNotThrow(() => JSON.stringify(metrics));
  }
  const tied = Array.from({ length: 4 }, (_, i) => observation(i, 0.5, 0.5, "Task"));
  const absent = fitTypeMargin(tied);
  assert.equal(absent.cutoff.state, "disabled");
  assert.equal(typeMetrics(tied, "after", absent.cutoff).accepted, 0);
  assert.equal(typeMetrics(tied, "after", null).accepted, 4, "released null prompt-baseline mode remains unfiltered");
  assert.equal(resolveTriageType(tied[0].after, "Task", {}, Infinity).abstained, true);
  const pair = { a: { id: "a" }, b: { id: "b" } } as DuplicatePair;
  assert.equal(pairVerdict(pair, 0.9, 0, Infinity, 0.8).decision, "abstain");
  assert.equal(pairVerdict(pair, 0.1, 0.1, 0.8, Infinity).decision, "abstain");
  assert.equal(pairVerdict(pair, 0.1, 0.9, Infinity, 0.8).decision, "related", "one disabled channel cannot disable a supported peer");
  assert.equal(pairVerdict(pair, 0.9, 0.1, -Infinity, -Infinity).decision, "duplicate");
  assert.equal(pairVerdict(pair, 0.1, 0.1, -Infinity, -Infinity).decision, "distinct");
  assert.equal(duplicateMetrics(rows, Infinity, true).abstain_rate, 0, "released lexical disabled policy reports distinct rather than model abstention");
});

test("noisy stored probabilities fit a boundary accepted identically by numeric and tagged application", () => {
  const rows = Array.from({ length: 4 }, (_, i) => observation(i, 0.8, 0.20000000000000004, "Feature"));
  const fit = fitTypeMargin(rows, 1);
  assert.equal(fit.threshold, 0.5999999999999999);
  assert.deepEqual(fit.cutoff, threshold(fit.threshold));
  assert.equal(fit.curve.find(point => point.threshold === fit.threshold)!.accepted, 4);
  for (const serialized of roundTrips(fit)) for (const cutoff of [serialized.threshold, serialized.cutoff, String(serialized.threshold), thresholdRatio(serialized.cutoff)]) {
    for (const row of rows) {
      const applied = resolveTriageType(row.after, row.current, {}, cutoff);
      assert.equal(applied.abstained, false);
      assert.equal(applied.value, "Feature");
      assert.doesNotThrow(() => JSON.stringify(applied));
    }
  }
});

test("2000 seeded calibration sets satisfy reapplication and JSON/TOON persistence laws", () => {
  let seed = 0x26f17a;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const scores: readonly [number, number][] = [[0, 1], [1, 0], [0.5, 0.5], [0.8, 0.20000000000000004], [0.8, 0.19999999999999998], [0.9, 0.1], [0.6, 0.4], [0.5000000000000001, 0.49999999999999994], [Number.MIN_VALUE, 1], [1, Number.MIN_VALUE]];
  let enabled = 0, disabled = 0;
  for (let run = 0; run < 2000; run++) {
    const rows = Array.from({ length: 4 + random() % 9 }, (_, i) => {
      const [a, b] = scores[random() % scores.length];
      const row = observation(i, a, b, random() % 4 ? "Feature" : "Task", random() % 2 ? "Task" : "Feature");
      return random() % 7 ? row : { ...row, after: { ...row.after, choice: KEEP_CURRENT_TYPE, probabilities: { [KEEP_CURRENT_TYPE]: a, [row.current]: b } } };
    });
    const fit = fitTypeMargin(rows, [0.5, 0.75, 1][random() % 3]);
    if (fit.cutoff.state === "disabled") disabled++; else enabled++;
    const counted = fit.threshold === null ? { accepted: 0, correct: 0 } : fit.curve.find(point => point.threshold === fit.threshold)!;
    const expected = rows.map(row => fit.threshold !== null && referenceAccepts(row, fit.threshold) ? resolveTriageType(row.after, row.current, {}, 0).value : null);
    for (const saved of roundTrips(fit)) for (const cutoff of [saved.threshold, saved.cutoff]) {
      const decisions = rows.map(row => resolveTriageType(row.after, row.current, {}, cutoff));
      assert.deepEqual(decisions.map(row => row.value), expected, `reapplication case ${run}`);
      assert.equal(decisions.filter(row => !row.abstained).length, counted.accepted);
      assert.equal(decisions.filter((row, i) => !row.abstained && row.value === rows[i].expected).length, counted.correct);
    }
    const empirical = deriveThreshold(rows.map(row => ({ confidence: marginValue(row.after.probabilities), correct: row.expected === resolveTriageType(row.after, row.current, {}, 0).value })), 0.75, 4);
    for (const saved of roundTrips(empirical)) {
      const accepted = rows.filter(row => acceptsThreshold(marginValue(row.after.probabilities), saved.cutoff));
      const point = saved.threshold === null ? { accepted: 0 } : saved.curve.find(p => p.threshold === saved.threshold)!;
      assert.equal(accepted.length, point.accepted);
    }
  }
  assert.ok(enabled > 0 && disabled > 0);
});

test("1000 seeded unsupported policies never throw and retain released metric semantics through serialization", () => {
  let seed = 0x26d15a;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let run = 0; run < 1000; run++) {
    const rows = Array.from({ length: random() % 3 }, () => ({ label: random() % 2 === 0, probability: [0, 0.5, 0.8, 1][random() % 4], related_probability: random() % 2, retrieved: random() % 2 === 0 }));
    const legacy = fitPairThreshold(rows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, false);
    const fitted = fitPairCutoff(rows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, false);
    assert.equal(legacy, Infinity);
    assert.equal(fitted.state, "disabled");
    for (const saved of roundTrips(fitted)) {
      const actual = duplicateMetrics(rows, saved);
      const previousForm = duplicateMetrics(rows, legacy);
      assert.deepEqual(actual, previousForm);
      assert.equal(actual.tp, 0); assert.equal(actual.fp, 0); assert.equal(actual.fn, rows.filter(row => row.label).length);
      assert.equal(pairMetrics(rows, "related", { threshold: saved, relatedThreshold: saved }).tp, 0);
    }
  }
});

test("500 seeded scalar pair, quality and cost fits retain decisions across JSON/TOON round trips", () => {
  let seed = 0x26c07f;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const values = [0, 0.2, 0.20000000000000004, 0.5, 0.8, 1];
  for (let run = 0; run < 500; run++) {
    const rows = Array.from({ length: 4 + random() % 5 }, () => ({ label: random() % 2 === 0, probability: values[random() % values.length], related_probability: values[random() % values.length], retrieved: random() % 4 !== 0, lexical: values[random() % values.length] }));
    const pair = fitPairCutoff(rows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, false);
    const baseline = pairMetrics(rows, "duplicate", { threshold: pair, relatedThreshold: 0.8 });
    for (const saved of roundTrips(pair)) assert.deepEqual(pairMetrics(rows, "duplicate", { threshold: saved, relatedThreshold: 0.8 }), baseline);
    const quality = fitQualityPolicy(rows, "combined");
    const qualityDecisions = rows.map(row => qualityProposes(row, "combined", quality));
    const qualityBaseline = qualityMetrics(rows, "combined", quality);
    for (const saved of roundTrips(quality)) {
      assert.deepEqual(rows.map(row => qualityProposes(row, "combined", saved)), qualityDecisions);
      assert.deepEqual(qualityMetrics(rows, "combined", saved), qualityBaseline);
    }
    const observations: CostObservation[] = rows.flatMap((row, i) => (["selection", "heldout"] as const).map(split => ({ id: `${split}-${i}`, group: split, split, task: "duplicate", confidence: row.probability, eligible: row.retrieved, label: row.label })));
    const cost = selectAbstentionPolicy({ version: "pm-jev-cost/1", provenance: "synthetic", observations }, { false_duplicate: 20, wrong_type: 10, missed_candidate: 1 });
    const decisions = rows.map(row => abstainWithPolicy(cost.policy, row.probability, row.retrieved, true).propose);
    assert.equal(decisions.filter(Boolean).length, cost.selected.selection.proposed);
    for (const saved of roundTrips(cost.policy)) assert.deepEqual(rows.map(row => abstainWithPolicy(saved, row.probability, row.retrieved, true).propose), decisions);
  }
});

test("threshold schema, numeric projection and explicit sentinel ordering are bounded and deterministic", () => {
  for (const a of [-Infinity, -1, 0, 0.1, 1, Infinity]) for (const b of [-Infinity, -1, 0, 0.1, 1, Infinity]) {
    assert.equal(compareThreshold(a, b), a === b ? 0 : a < b ? -1 : 1);
  }
  for (const input of [Infinity, null, -Infinity, 0.1, fraction(1, 3)]) for (const saved of roundTrips(threshold(input))) assert.equal(compareThreshold(saved, threshold(input)), 0);
  assert.equal(acceptsThreshold(NaN, Infinity), false);
  assert.equal(precisionMeets(1, 1, Infinity), false);
  assert.equal(precisionMeets(1, 1, threshold(null)), false);
  assert.equal(precisionMeets(0, 1, -Infinity), true);
  assert.equal(acceptsThreshold(0.5, 0.5, true), false);
  assert.equal(acceptsThreshold(0.6, 0.5, true), true);
  assert.equal(acceptsThreshold(0.5, 0.5), true);
  assert.deepEqual(thresholdRatio(threshold(0.1)), fraction(1, 10));
  assert.equal(legacyThreshold(Infinity), Infinity);
  assert.equal(legacyThreshold(-Infinity), -Infinity);
  assert.equal(legacyThreshold(0.1), 0.1);
  assert.throws(() => legacyThreshold(fraction(1, 3)));
  assert.throws(() => legacyThreshold("1e1000"));
  assert.equal(belowComplement(0.9, Infinity), false);
  assert.equal(belowComplement(0.9, -Infinity), true);
  assert.equal(numericBoundary(fraction(-1n, 10n ** 400n)), -Number.MIN_VALUE);
  assert.ok(compareThreshold(numericBoundary(fraction(-100000000000000001n, 1000000000000000000n)), fraction(-100000000000000001n, 1000000000000000000n)) <= 0);
  assert.throws(() => numericBoundary("1e1000"));
  assert.throws(() => numericBoundary("-1.7976931348623157000000000000000001e308"));
  assert.throws(() => marginValue({ only: 1 }));
  assert.throws(() => thresholdRatio(Infinity));
  assert.throws(() => thresholdRatio(-Infinity));
  for (const bad of [{ state: "wrong" }, { state: "disabled", extra: 1 }, { state: "enabled", numerator: "1" }, { state: "enabled", numerator: 1, denominator: "2" }, { state: "enabled", numerator: "x", denominator: "2" }, { state: "enabled", numerator: "1", denominator: "x" }, { state: "enabled", numerator: "1", denominator: "0" }]) assert.throws(() => threshold(bad as Threshold));
  assert.throws(() => threshold(fraction(10n ** 2050n, 1)));
  assert.throws(() => threshold(fraction(1, 10n ** 2050n)));
  assert.equal(KEEP_CURRENT_TYPE, "__keep_current__");
});
