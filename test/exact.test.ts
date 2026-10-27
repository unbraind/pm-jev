import assert from "node:assert/strict";
import test from "node:test";
import { compareExact, decimal, fraction, addExact, subtractExact, multiplyExact, displayExact, displayRatio, countRatio, populationDistance, precisionMeets, checkCalibrationDrift } from "../index.ts";
import type { DriftInput, DriftObservation } from "../index.ts";
import { deriveThreshold } from "../calibration.ts";
import { pairVerdict } from "../dedupe.ts";
import type { DuplicatePair } from "../dedupe.ts";

/** Unreduced oracle fractions deliberately share no parser, arithmetic or metric helpers with production. */
type Reference = readonly [bigint, bigint];
/** Independent decimal oracle uses character accumulation and explicit scale, not the production regexp/parser. */
function referenceDecimal(text: string): Reference {
  const [mantissa, exponent = "0"] = text.toLowerCase().split("e");
  const negative = mantissa.startsWith("-");
  let digits = 0n, places = 0, fractional = false;
  for (const character of negative ? mantissa.slice(1) : mantissa) {
    if (character === ".") fractional = true;
    else { digits = digits * 10n + BigInt(character); if (fractional) places++; }
  }
  const scale = places - Number(exponent);
  return [negative ? -digits : digits, 10n ** BigInt(scale)];
}
/** Compare the independent unreduced products, including exact-boundary equality. */
function referenceOrder(a: Reference, b: Reference): number {
  const product = a[0] * b[1] - b[0] * a[1];
  return product === 0n ? 0 : product < 0n ? -1 : 1;
}
/** Direct category-count oracle has no normalization, float division or shared implementation calls. */
function referenceTV(a: readonly number[], b: readonly number[]): Reference {
  const na = BigInt(a.reduce((sum, x) => sum + x, 0));
  const nb = BigInt(b.reduce((sum, x) => sum + x, 0));
  let numerator = 0n;
  for (let i = 0; i < a.length; i++) {
    const difference = BigInt(a[i]) * nb - BigInt(b[i]) * na;
    numerator += difference < 0n ? -difference : difference;
  }
  return [numerator, 2n * na * nb];
}
/** Minimized rows retain explicit error labels and exact integer category membership. */
function cohortRows(counts: readonly number[], errors: number): DriftObservation[] {
  const rows: DriftObservation[] = [];
  for (let category = 0; category < counts.length; category++) for (let i = 0; i < counts[category]; i++) {
    rows.push({ id: `r${rows.length}`, task: "triage", type: `type${category}`, input_bucket: `bucket${category}`, predicted: "yes", label: rows.length < errors ? "no" : "yes" });
  }
  return rows;
}
/** Shared versioned fixture; thresholds keep decimal lexemes intact at the public SDK boundary. */
function input(a: readonly number[], b: readonly number[], errorsA: number, errorsB: number, population: number | string, error: number | string): DriftInput {
  const identity = { model_digest: "a".repeat(64), question_digest: "b".repeat(64) };
  return { version: "pm-jev-drift/1", provenance: "synthetic", thresholds: { population_tv: population, error_increase: error, min_population: 2, min_labels: 2 },
    calibration: { identity, observations: cohortRows(a, errorsA) }, current: { identity, observations: cohortRows(b, errorsB) } };
}

test("review boundaries: 1/10 to 3/10 at 0.2, and binary TV 1/10 at 0.1 both trip inclusively", () => {
  const labels = checkCalibrationDrift(input([10], [10], 1, 3, 1, 0.2));
  assert.equal(labels.labels.error_increase, 0.2);
  assert.equal(labels.labels.status, "drift");
  assert.equal(labels.recommendation, "abstain_and_recalibrate");
  const population = checkCalibrationDrift(input([0, 10], [1, 9], 0, 0, 0.1, 1));
  assert.equal(population.population.input_tv, 0.1);
  assert.equal(population.population.status, "drift");
  assert.equal(population.recommendation, "abstain_and_recalibrate");
  assert.equal(checkCalibrationDrift(input([0, 10], [1, 9], 0, 0, "0.1000000000000000000000001", 1)).status, "stable");
  assert.equal(checkCalibrationDrift(input([0, 10], [1, 9], 0, 0, "0.0999999999999999999999999", 1)).status, "drift");
});

test("6000 seeded count-vector, sample-size and decimal-threshold cases match an independent exact oracle", () => {
  let seed = 0x26ca1b;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  let boundaries = 0;
  for (let i = 0; i < 6000; i++) {
    const categories = 2 + random() % 6;
    let a = Array<number>(categories).fill(0), b = Array<number>(categories).fill(0);
    let na = 2 + random() % 60, nb = 2 + random() % 60;
    for (let j = 0; j < na; j++) a[random() % categories]++;
    for (let j = 0; j < nb; j++) b[random() % categories]++;
    let threshold = `0.${String(1 + random() % 999).padStart(3, "0")}`;
    if (i % 4 === 0) {
      na = [10, 20, 25, 50, 100][random() % 5]; nb = na;
      const change = 1 + random() % na;
      a = [0, na]; b = [change, na - change];
      const units = change * (10000 / na);
      threshold = units === 10000 ? "1" : `0.${String(units).padStart(4, "0")}`;
      boundaries++;
    }
    const ea = random() % (na + 1), eb = random() % (nb + 1);
    const tv = referenceTV(a, b), cutoff = referenceDecimal(threshold);
    const difference: Reference = [BigInt(eb) * BigInt(na) - BigInt(ea) * BigInt(nb), BigInt(na) * BigInt(nb)];
    const expectedPopulation = referenceOrder(tv, cutoff), expectedLabels = referenceOrder(difference, cutoff);
    const wideA = a.map(() => 1 + random() % 1000000000), wideB = b.map(() => 1 + random() % 1000000000);
    const wideReference = referenceTV(wideA, wideB);
    assert.equal(compareExact(populationDistance(wideA, wideB), threshold), referenceOrder(wideReference, cutoff), "cross-products beyond Number.MAX_SAFE_INTEGER");
    const tvExact = populationDistance(a, b), errorExact = subtractExact(fraction(eb, nb), fraction(ea, na));
    for (const [value, expected] of [[tvExact, expectedPopulation], [errorExact, expectedLabels]] as const) {
      assert.equal(compareExact(value, threshold), expected);
      assert.equal(compareExact(value, threshold) >= 0, expected >= 0, "inclusive cutoff");
      assert.equal(compareExact(value, threshold) > 0, expected > 0, "exclusive cutoff");
      assert.equal(compareExact(value, threshold) <= 0, expected <= 0);
      assert.equal(compareExact(value, threshold) < 0, expected < 0);
    }
    const result = checkCalibrationDrift(input(a, b, ea, eb, threshold, i % 2 ? Number(threshold) : threshold));
    assert.equal(result.population.status, expectedPopulation >= 0 ? "drift" : "stable", `population case ${i}`);
    assert.equal(result.labels.status, expectedLabels >= 0 ? "drift" : "stable", `labels case ${i}`);
    assert.equal(result.status, expectedPopulation >= 0 || expectedLabels >= 0 ? "drift" : "stable");
    const fitted = deriveThreshold(Array.from({ length: na }, (_, index) => ({ confidence: 0.5, correct: index < ea })), Number(threshold), 1);
    assert.equal(fitted.threshold, referenceOrder([BigInt(ea), BigInt(na)], cutoff) >= 0 ? 0 : null, "empirical precision selects from counts");
    const ratio = fraction(ea, na);
    assert.equal(compareExact(ratio, threshold), referenceOrder([BigInt(ea), BigInt(na)], cutoff));
    assert.equal(precisionMeets(ea, na, threshold, 0), referenceOrder([BigInt(ea), BigInt(na)], cutoff) >= 0);
    const oracleWilson = referenceOrder([BigInt(ea), BigInt(na)], cutoff) >= 0 &&
      (cutoff[0] !== cutoff[1]) &&
      (BigInt(ea) * cutoff[1] - cutoff[0] * BigInt(na)) ** 2n * 100000000000000000000000000000000n >=
      16448536269514722n ** 2n * cutoff[0] * (cutoff[1] - cutoff[0]) * BigInt(na);
    assert.equal(precisionMeets(ea, na, threshold), oracleWilson);
  }
  assert.equal(boundaries, 1500, "all 1500 exact-TV boundaries exercise both inclusive and exclusive cutoffs");
});

test("exact arithmetic refuses malformed decimals and unsafe counts, supports subnormals and internal disabled sentinels", () => {
  assert.deepEqual(decimal("-1.25e-2"), fraction(-1, 80));
  assert.equal(compareExact(decimal("0.1000000000000000001"), "0.1"), 1);
  assert.equal(displayExact(addExact("0.1", "0.2")), 0.3);
  assert.equal(displayExact(subtractExact("0.3", "0.1")), 0.2);
  assert.equal(displayExact(multiplyExact("0.3", 10)), 3);
  assert.equal(displayRatio(1, 10), 0.1);
  assert.equal(displayExact(Number.MIN_VALUE), Number.MIN_VALUE);
  assert.equal(displayExact("1e100"), 1e100);
  assert.equal(displayExact("-1e100"), -1e100);
  assert.equal(compareExact(fraction(2n ** 100n, 2n ** 103n), "0.125"), 0);
  assert.equal(compareExact(fraction(9007199254740993n, 9007199254740992n), 1), 1);
  for (const bad of ["junk", "1e1025", "1e-1025"]) assert.throws(() => checkCalibrationDrift(input([10], [10], 0, 0, bad, 1)));
  for (const a of [Infinity, -Infinity, 1]) for (const b of [Infinity, -Infinity, 1]) assert.equal(compareExact(a, b), a === b ? 0 : a < b ? -1 : 1);
  assert.deepEqual(countRatio(0, 0), fraction(0));
  assert.deepEqual(countRatio(1, 10), fraction(1, 10));
  for (const bad of [NaN, Infinity, "", " 0.1 ", "0x10", ".1", "1e1025", "1e-1025", "1e99999999999999999", "1".repeat(257)]) assert.throws(() => decimal(bad));
  assert.throws(() => compareExact(NaN, 1));
  assert.throws(() => compareExact(1, NaN));
  assert.throws(() => fraction(1.1));
  assert.throws(() => fraction(Number.MAX_SAFE_INTEGER + 1));
  assert.throws(() => fraction(1, 0));
  assert.throws(() => fraction(1, -1));
  for (const [a, b] of [[[1], [1, 0]], [[0], [1]], [[1], [0]], [[2, -1], [1, 0]]]) assert.throws(() => populationDistance(a, b));
  assert.equal(precisionMeets(0, 0, 0), false);
  assert.equal(precisionMeets(10, 10, 1), false);
  assert.equal(precisionMeets(10, 10, 1, 0), true);
  assert.equal(precisionMeets(0, 10, 0), true);
});

test("empirical calibration and strict model cutoffs retain exact inclusive and exclusive semantics", () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ confidence: 0.3, correct: i < 3 }));
  assert.equal(deriveThreshold(rows, 0.3, 10).threshold, 0);
  assert.equal(deriveThreshold(rows, 0.30000000000000004, 10).threshold, null);
  const pair = { a: { id: "a" }, b: { id: "b" } } as DuplicatePair;
  assert.equal(pairVerdict(pair, 0.5, 0, 0.5, 1).decision, "abstain", "strict half-probability guard");
  assert.equal(pairVerdict(pair, 0.7, 0, 0.7, 1).decision, "duplicate", "inclusive positive guard");
  assert.equal(pairVerdict(pair, 0.3, 0.3, 0.7, 0.7).decision, "distinct", "exact decimal complements");
});
