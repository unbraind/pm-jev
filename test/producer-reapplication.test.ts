import assert from "node:assert/strict";
import test from "node:test";
import { encode, decode } from "@toon-format/toon";
import { acceptsThreshold, compareThreshold, marginValue, threshold } from "../threshold.ts";
import { duplicateSimilarity, duplicateSimilarityRatio, qualityObservation, qualityLexicalAccepts, qualityFrontier, fitQualityPolicy, qualityMetrics } from "../duplicate-quality.ts";
import type { QualityArm } from "../duplicate-quality.ts";
import { candidatePairs, orderedPair, pairVerdict, DUPLICATE_QUALITY_CALIBRATION } from "../dedupe.ts";
import type { DuplicatePair, PairItem, PairVerdict } from "../dedupe.ts";
import { fitPairCutoff, fitDuplicateThreshold, duplicateMetrics, pairMetrics } from "../dedupe-evaluation.ts";
import { fitTypeMargin } from "../type-calibration.ts";
import type { TypeObservation } from "../type-calibration.ts";
import { resolveTriageType, TYPE_MARGIN_THRESHOLD } from "../index.ts";
import { observe, gatePoint, familyMetrics } from "../calibration.ts";
import { calibrateObservations, calibratedAnswer, questionFingerprint, scaledRows, ranked, atThreshold } from "../decision-calibration.ts";
import type { Observation } from "../decision-calibration.ts";
import { COST_POLICY_VERSION, selectAbstentionPolicy, abstainWithPolicy } from "../cost-policy.ts";
import type { CostObservation } from "../cost-policy.ts";
import { checkCalibrationDrift } from "../calibration-drift.ts";
import type { DriftObservation } from "../calibration-drift.ts";
import { project, scenario, answers, withoutGit, trackerSnapshot } from "./fixtures.ts";
import type { ChoiceResponse, Questions } from "@typesafe-ai/sdk";

/** Reproducible unsigned generator; each inventory family has a separate recorded seed. */
function randomFrom(initial: number): () => number {
  let seed = initial;
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
}
/** Exercise actual wire codecs on every fitted policy, without custom normalization. */
function savedForms<T>(value: T): T[] { return [value, JSON.parse(JSON.stringify(value)) as T, decode(encode(value)) as T]; }
/** Raw categorical inputs include float noise, ties, endpoints and near-boundary observations. */
const distributions = [
  { Feature: 0.8, Task: 0.20000000000000004 }, { Feature: 0.8, Task: 0.19999999999999998 },
  { Feature: 0.5, Task: 0.5 }, { Feature: 1, Task: 0 }, { Feature: 0, Task: 1 },
  { Feature: 0.5000000000000001, Task: 0.49999999999999994 }, { Feature: Number.MIN_VALUE, Task: 1 },
];
/** Produce a real answer shape, not a precomputed margin or score. */
function answer(probabilities: Record<string, number>): ChoiceResponse {
  const [choice, confidence] = ranked(probabilities)[0];
  return { type: "choice", choice, confidence, probabilities };
}
/** Count actual production proposals independently of the fitting metric loop. */
function appliedQuality(pairs: readonly DuplicatePair[], labels: readonly boolean[], probabilities: readonly number[], retrieved: readonly boolean[], arm: QualityArm, policy: ReturnType<typeof fitQualityPolicy>) {
  const decisions = pairs.map((pair, i) => (arm === "model-only" || retrieved[i]) &&
    (arm === "lexical-only" || acceptsThreshold(probabilities[i], policy.model)) &&
    (arm === "model-only" || qualityLexicalAccepts(pair, policy.lexical)));
  return { tp: decisions.filter((yes, i) => yes && labels[i]).length, fp: decisions.filter((yes, i) => yes && !labels[i]).length, fn: decisions.filter((yes, i) => !yes && labels[i]).length };
}

test("raw alpha pairs fit exact 13/30 and reapply through the registered no-git command", async () => {
  await scenario(async (fixture, server) => {
    const a = (await fixture.pm.create({ type: "Task", title: "alpha", description: "" })).item as PairItem;
    const b = (await fixture.pm.create({ type: "Task", title: "alpha beta", description: "" })).item as PairItem;
    const pair = orderedPair(a, b, 0);
    assert.equal(duplicateSimilarity(pair), 0.43333333333333335, "display value remains compatible");
    assert.equal(compareThreshold(duplicateSimilarityRatio(pair), threshold(13 / 30)), -1);
    const train = Array.from({ length: 3 }, () => qualityObservation(pair, 0.9, true, true));
    const policy = fitQualityPolicy(train, "combined");
    assert.equal(qualityMetrics(train, "combined", policy).tp, 3);
    for (const saved of savedForms(policy)) assert.equal(qualityLexicalAccepts(pair, saved.lexical), true, "fit counted 3 TP; runtime lexical guard must accept those same raw pairs");
    assert.deepEqual(policy.lexical, { state: "enabled", numerator: "13", denominator: "30" });
    const retrievalPositive = candidatePairs([a, b], 1)[0];
    const retrievalNegative = candidatePairs([a, { ...b, title: "alpha beta gamma delta" }], 1)[0];
    const retrievalRows = [retrievalPositive, retrievalPositive, retrievalPositive, retrievalNegative].map((candidate, i) => ({ probability: candidate.score, lexical_score: candidate.score_cutoff, label: i < 3, retrieved: true }));
    const retrievalFit = fitPairCutoff(retrievalRows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, true);
    assert.equal(compareThreshold(retrievalFit, retrievalPositive.score_cutoff!), 0);
    for (const saved of savedForms(retrievalFit)) assert.equal(pairMetrics(retrievalRows, "duplicate", { threshold: saved, relatedThreshold: 0.8 }, true).tp, 3);
    const key = "tev1:4b", previous = Object.getOwnPropertyDescriptor(DUPLICATE_QUALITY_CALIBRATION, key);
    Object.defineProperty(DUPLICATE_QUALITY_CALIBRATION, key, { configurable: true, value: { policy, digest: "a".repeat(64) } });
    server.setReply((request, response, body) => {
      if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: key, digest: "a".repeat(64) }] })); return; }
      const result = answers((body as { questions: Questions }).questions);
      result.answers.same_work = { type: "noul", noul: 0.9 };
      response.end(JSON.stringify(result));
    });
    try {
      const before = trackerSnapshot(fixture.pmRoot);
      const output = await withoutGit(fixture.cwd, () => fixture.harness.runCommand({ command: "jev dedupe", pmRoot: fixture.pmRoot, global: { json: true } }));
      assert.deepEqual((output.result as PairVerdict[]).map(row => row.decision), ["duplicate"]);
      assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
      const applied = await withoutGit(fixture.cwd, () => fixture.harness.runCommand({ command: "jev dedupe", pmRoot: fixture.pmRoot, options: { apply: true }, global: { json: true } }));
      const row = (applied.result as PairVerdict[])[0];
      const readBack = (await fixture.pm.get(row.a, { full: true })).item;
      assert.ok(readBack.dependencies?.some(dep => dep.id === row.b && dep.kind === "related"));
      assert.ok(readBack.comments?.some(comment => comment.text.includes('lexical_threshold={"state":"enabled","numerator":"13","denominator":"30"}')));
    } finally { Object.defineProperty(DUPLICATE_QUALITY_CALIBRATION, key, previous!); }
  });
});

test("500 raw lexical populations reproduce every quality frontier and retrieval fit after JSON/TOON", async () => {
  const fixture = await project();
  try {
    const base = (await fixture.pm.create({ type: "Task", title: "Raw evidence", description: "" })).item as PairItem;
    const random = randomFrom(0x27e2e1);
    const texts = ["", "alpha", "alpha beta", "beta gamma", "alpha beta gamma delta", "ALPHA!", "café alpha", "修復 alpha"];
    for (let run = 0; run < 500; run++) {
      const items = Array.from({ length: 4 + random() % 5 }, (_, i) => ({ ...base, id: `raw-${i}`, title: texts[random() % texts.length], description: texts[random() % texts.length], body: texts[random() % texts.length], tags: random() % 2 ? [] : [texts[random() % texts.length]], files: random() % 2 ? [] : [{ path: "src/alpha.ts", scope: "project" as const }] }));
      const pairs = items.slice(1).map((item, i) => orderedPair(items[i], item, 0));
      const labels = pairs.map(() => run % 4 === 0 || random() % 3 !== 0);
      const probabilities = pairs.map(() => distributions[random() % distributions.length].Feature);
      const retrieved = pairs.map(() => run % 4 === 0 || random() % 4 !== 0);
      const train = pairs.map((pair, i) => qualityObservation(pair, probabilities[i], labels[i], retrieved[i]));
      for (const arm of ["lexical-only", "model-only", "combined"] as const) {
        const frontier = qualityFrontier(train, arm);
        const fitted = fitQualityPolicy(train, arm);
        for (const point of [...frontier, { policy: fitted, train: qualityMetrics(train, arm, fitted) }]) for (const policy of savedForms(point.policy)) {
          assert.deepEqual(appliedQuality(pairs, labels, probabilities, retrieved, arm, policy), { tp: point.train.tp, fp: point.train.fp, fn: point.train.fn }, `quality ${arm} case ${run}`);
        }
      }
      // Retrieval fitting and application retain exact corpus-dependent channel ratios beside numeric display scores.
      const candidates = candidatePairs(items, 100);
      const lexicalRows = candidates.map((pair, i) => ({ label: i % 3 !== 0, retrieved: true, probability: pair.score, lexical_score: pair.score_cutoff }));
      const cutoff = fitPairCutoff(lexicalRows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, true);
      const counted = pairMetrics(lexicalRows, "duplicate", { threshold: cutoff, relatedThreshold: 0.8 }, true);
      for (const saved of savedForms(cutoff)) {
        const applied = candidatePairs(items, 100).map(pair => acceptsThreshold(pair.score_cutoff!, saved));
        assert.equal(applied.filter((yes, i) => yes && lexicalRows[i].label).length, counted.tp);
        assert.equal(applied.filter((yes, i) => yes && !lexicalRows[i].label).length, counted.fp);
      }
    }
  } finally { fixture.dispose(); }
});

test("1000 raw probability populations reapply pair, margin, noul confidence, gate and cost fits", () => {
  const random = randomFrom(0x27e2e2);
  let supported = 0, unsupported = 0;
  for (let run = 0; run < 1000; run++) {
    const raw = Array.from({ length: 4 + random() % 6 }, (_, i) => ({ id: String(i), after: answer(distributions[random() % distributions.length]), label: random() % 3 !== 0, related: { type: "noul" as const, noul: distributions[random() % distributions.length].Feature }, retrieved: random() % 4 !== 0 }));
    const pairs = raw.map(row => ({ label: row.label, probability: row.after.probabilities.Feature, related_probability: row.related.noul, retrieved: row.retrieved }));
    const stub = { a: { id: "a" }, b: { id: "b" } } as DuplicatePair;
    for (const target of ["duplicate", "related"] as const) {
      const cutoff = fitPairCutoff(pairs, target, { threshold: 0.8, relatedThreshold: 0.8 }, false);
      if (cutoff.state === "disabled") unsupported++; else supported++;
      for (const saved of savedForms(cutoff)) {
        const thresholds = target === "duplicate" ? { threshold: saved, relatedThreshold: 0.8 } : { threshold: 0.8, relatedThreshold: saved };
        const counted = pairMetrics(pairs, target, thresholds);
        const applied = raw.map(row => row.retrieved && pairVerdict(stub, row.after.probabilities.Feature, row.related.noul, thresholds.threshold, thresholds.relatedThreshold).decision === target);
        assert.equal(applied.filter((yes, i) => yes && raw[i].label).length, counted.tp);
        assert.equal(applied.filter((yes, i) => yes && !raw[i].label).length, counted.fp);
      }
    }
    const typeRows: TypeObservation[] = raw.map(row => ({ id: row.id, text: "Raw inputs", current: "Task", expected: row.label ? row.after.choice : "Other", split: "calibration", before: row.after, after: row.after }));
    const fit = fitTypeMargin(typeRows, 0.75);
    const counted = fit.threshold === null ? { accepted: 0, correct: 0 } : fit.curve.find(p => p.threshold === fit.threshold)!;
    for (const saved of savedForms(fit)) {
      const applied = raw.map(row => resolveTriageType(row.after, "Task", {}, saved.cutoff));
      assert.equal(applied.filter(row => !row.abstained).length, counted.accepted);
      assert.equal(applied.filter((row, i) => row.value !== null && row.value === typeRows[i].expected).length, counted.correct);
    }
    // The link margin gate is fixed, rather than fitted, and uses the same raw distribution margin.
    for (const row of raw) assert.equal(resolveTriageType(row.after, "Task", {}, TYPE_MARGIN_THRESHOLD).abstained, !acceptsThreshold(marginValue(row.after.probabilities), TYPE_MARGIN_THRESHOLD));
    const observed = raw.map(row => observe({ id: row.id, family: "boundary", split: "calibration", state: "Raw proposition", instructions: "True?", expected: row.label }, row.after.probabilities.Feature));
    const family = familyMetrics(observed, 0.75, 4);
    const confidenceFit = family.confidence;
    for (const saved of savedForms(confidenceFit)) {
      const reapplied = raw.map((row, i) => observe(observed[i], row.after.probabilities.Feature)).filter(row => acceptsThreshold(row.confidence, saved.cutoff));
      const point = saved.threshold === null ? { accepted: 0, correct: 0 } : saved.curve.find(p => p.threshold === saved.threshold)!;
      assert.equal(reapplied.length, point.accepted);
      assert.equal(reapplied.filter(row => row.correct).length, point.correct);
    }
    if (family.gateThreshold !== null) {
      const point = family.gateCurve.find(p => p.threshold === family.gateThreshold)!;
      const applied = gatePoint(observed, family.gateThreshold);
      assert.equal(applied.positive, point.positive); assert.equal(applied.truePositive, point.truePositive);
      const rawApplied = raw.map(row => row.after.probabilities.Feature).filter(p => acceptsThreshold(p, family.gateThreshold));
      assert.equal(rawApplied.length, point.positive);
    }
    const costRows: CostObservation[] = raw.flatMap(row => (["selection", "heldout"] as const).flatMap(split => [
      { id: `${split}-${row.id}-dup`, group: split, split, task: "duplicate" as const, label: row.label, confidence: row.after.probabilities.Feature, eligible: row.retrieved },
      { id: `${split}-${row.id}-type`, group: split, split, task: "type" as const, label: row.label ? row.after.choice : "Other", predicted: resolveTriageType(row.after, "Task", {}, 0).value!, confidence: ranked(row.after.probabilities)[0][1], eligible: true },
    ]));
    const costFit = selectAbstentionPolicy({ version: COST_POLICY_VERSION, provenance: "synthetic", observations: costRows }, { false_duplicate: 20, wrong_type: 10, missed_candidate: 1 });
    for (const saved of savedForms(costFit.policy)) {
      const applied = raw.flatMap(row => [abstainWithPolicy(saved, row.after.probabilities.Feature, row.retrieved, true).propose, abstainWithPolicy(saved, ranked(row.after.probabilities)[0][1], true, true).propose]);
      assert.equal(applied.filter(Boolean).length, costFit.selected.selection.proposed);
      assert.equal(applied.filter((yes, i) => yes && costRows.filter(row => row.split === "selection")[i].task === "duplicate" && !costRows.filter(row => row.split === "selection")[i].label).length, costFit.selected.selection.false_duplicates);
    }
  }
  assert.ok(supported > 0 && unsupported > 0);
});

test("100 raw temperature-scaled channel fits reapply through calibratedAnswer with stable JSON/TOON counts", () => {
  const random = randomFrom(0x27e2e3), question = { type: "choice", criteria: { Feature: null, Task: null } };
  let supported = 0, unsupported = 0;
  for (let run = 0; run < 100; run++) {
    const rows: Observation[] = ["public/a", "public/b"].flatMap(repository => Array.from({ length: 12 }, (_, i) => {
      const probabilities = distributions[random() % distributions.length];
      return { repository, commit: "a".repeat(40), data_sha256: "b".repeat(64), example_sha256: "c".repeat(64), question_sha256: questionFingerprint("type", question), channel: "type", label: run % 3 !== 1 && i < 10 ? ranked(probabilities)[0][0] : "Other", probabilities, latency_ms: 0, input_tokens: 0, output_tokens: 0 };
    }));
    const fit = calibrateObservations("triage", "synthetic", "d".repeat(64), rows, "raw-fit", 0.5, undefined, true);
    const channel = fit.channels.type;
    if (channel.threshold === null) unsupported++; else supported++;
    for (const saved of savedForms(fit)) {
      for (const repositories of [fit.calibration_repositories, fit.validation_repositories]) {
        const raw = rows.filter(row => repositories.includes(row.repository));
        const applied = raw.map(row => {
          const answer = calibratedAnswer({ record: saved, receipt_sha256: "e".repeat(64) }, "type", question, row.probabilities, 0.8);
          return acceptsThreshold(ranked(answer.probabilities)[0][1], answer.threshold);
        });
        const counted = channel.threshold === null ? { count: 0, precision: null } : atThreshold(scaledRows(raw, channel.temperature), channel.threshold);
        assert.equal(applied.filter(Boolean).length, counted.count);
        const correct = applied.filter((yes, i) => yes && ranked(raw[i].probabilities)[0][0] === raw[i].label).length;
        if (counted.count) assert.equal(correct / counted.count, counted.precision);
      }
    }
  }
  assert.ok(supported > 0 && unsupported > 0);
});

test("raw fixed cases preserve noisy margin, disabled metrics and inclusive drift recommendations", () => {
  const raw = answer({ Feature: 0.8, Task: 0.20000000000000004 });
  const rows: TypeObservation[] = Array.from({ length: 4 }, (_, i) => ({ id: String(i), text: "Raw", current: "Task", expected: "Feature", split: "calibration", before: raw, after: raw }));
  const fit = fitTypeMargin(rows, 1);
  assert.equal(fit.threshold, 0.5999999999999999);
  for (const saved of savedForms(fit)) assert.equal(rows.filter(row => !resolveTriageType(row.after, row.current, {}, saved.cutoff).abstained).length, 4);
  const unsupported = [{ label: true, probability: raw.probabilities.Feature, retrieved: true }];
  assert.equal(fitDuplicateThreshold(unsupported, false), Infinity);
  assert.equal(duplicateMetrics(unsupported, Infinity).fn, 1);
  const identity = { model_digest: "a".repeat(64), question_digest: "b".repeat(64) };
  const cohort = (errors: number, changed: number): DriftObservation[] => Array.from({ length: 10 }, (_, i) => ({ id: String(i), task: "triage", type: "Task", input_bucket: i < changed ? "other" : "same", predicted: "yes", label: i < errors ? "no" : "yes" }));
  const data = { version: "pm-jev-drift/1", provenance: "synthetic", calibration: { identity, observations: cohort(1, 0) }, current: { identity, observations: cohort(3, 1) }, thresholds: { population_tv: "0.1", error_increase: "0.2", min_population: 2, min_labels: 2 } };
  for (const saved of savedForms(data)) {
    const report = checkCalibrationDrift(saved);
    assert.equal(report.population.status, "drift"); assert.equal(report.labels.status, "drift"); assert.equal(report.inference_calls, 0);
  }
});
