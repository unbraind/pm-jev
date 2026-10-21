import assert from "node:assert/strict";
import test from "node:test";
import { closureTarget, pairMetrics, fitPairThreshold, labelledPairs, labelledRelatedPairs, wilson, duplicateMetrics, fitDuplicateThreshold } from "../dedupe-evaluation.ts";
import type { DuplicateCorpus } from "../dedupe-evaluation.ts";
import type { PairItem } from "../dedupe.ts";
import { scenario } from "./fixtures.ts";
import { evidenceHash } from "../decision-calibration.ts";
import { PAIR_CALIBRATION, PAIR_QUESTIONS } from "../dedupe.ts";
import { readFileSync } from "node:fs";

test("duplicate benchmark reads real SDK items and separates whole duplicate groups", async () => {
  await scenario(async fixture => {
    const corpora: DuplicateCorpus[] = [];
    for (let r = 0; r < 2; r++) {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const original = (await fixture.pm.create({ id: `seed-${evidenceHash(["benchmark-original", r, i]).slice(0, 12)}`, type: "Task", title: `Validate session policy ${r} ${i}`, description: "Check session expiry and reject old sessions" })).item;
        const duplicate = (await fixture.pm.create({ id: `seed-${evidenceHash(["benchmark-duplicate", r, i]).slice(0, 12)}`, type: "Task", title: original.title })).item;
        await fixture.pm.update(duplicate.id, { status: "closed", closeReason: i % 2 === 0 ? `Duplicate of ${original.id}` : `Superseded by canonical item ${original.id} during governance duplicate-consolidation; retained evidence.` });
        ids.push(original.id, duplicate.id);
      }
      corpora.push({ repository: `public-${r}`, commit: "synthetic", items: (await fixture.pm.listAllComplete({ includeBody: true })).items.filter(item => ids.includes(item.id)) });
    }
    const rows = labelledPairs(corpora, 3);
    assert.equal(rows.length, 18);
    assert.equal(new Set(rows.map(row => row.pair_id)).size, rows.length);
    for (const row of rows) {
      assert.equal(row.pair_id, `${row.repository}:${row.pair.a.id}:${row.pair.b.id}`);
    }
    for (const split of ["dev", "heldout"]) {
      const partition = rows.filter(row => row.split === split);
      assert.deepEqual([partition.filter(row => row.label).length, partition.filter(row => !row.label).length], [3, 6]);
    }
    const dev = new Set(rows.filter(row => row.split === "dev").flatMap(row => [row.pair.a.id, row.pair.b.id]));
    assert.ok(rows.filter(row => row.split === "heldout").every(row => !dev.has(row.pair.a.id) && !dev.has(row.pair.b.id)));
    assert.deepEqual(labelledPairs([...corpora].reverse(), 3), rows);
    const item = corpora[0].items[0];
    assert.equal(closureTarget({ ...item, close_reason: "duplicate text with no resolvable target" }), undefined);
    assert.equal(closureTarget({ ...item, close_reason: "duplicate-consolidation but no named target" }), undefined);
    const bad = [
      { ...item, id: "bad-self", status: "closed", close_reason: "Duplicate of bad-self" },
      { ...item, id: "bad-missing", status: "closed", close_reason: "Duplicate of bad-target" },
      { ...item, id: "bad-cycle", status: "closed", close_reason: "Duplicate of bad-loop" },
      { ...item, id: "bad-loop", status: "closed", close_reason: "Duplicate of bad-cycle" },
      { ...item, id: "bad-active", status: "open", duplicate_of: item.id, title: "" },
      { ...item, id: "bad-empty", status: "canceled", close_reason: `Duplicate of ${item.id}`, title: "", description: "", body: "" },
    ] as PairItem[];
    const twins = Array.from({ length: 20 }, (_, i) => `identical-control-${i}`).filter(id => evidenceHash(["dedupe-20261019", corpora[0].repository, id])[0] < "8").slice(0, 2).map(id => ({ ...item, id, title: "Identical uncontrolled work", body: "exact semantic evidence" }));
    const enriched = { ...corpora[0], items: [...corpora[0].items, corpora[0].items.find(row => row.status === "closed")!, ...bad, ...twins] };
    const enrichedRows = labelledPairs([enriched, corpora[1]], 30);
    const accepted = enrichedRows.filter(row => row.label);
    assert.ok(!accepted.some(row => [row.pair.a.id, row.pair.b.id].some(id => ["bad-self", "bad-missing", "bad-cycle", "bad-loop", "bad-active"].includes(id))));
    assert.equal(twins.length, 2);
    assert.ok(enrichedRows.some(row => row.label && row.repository === enriched.repository && row.split === "dev"));
    const twinIds = new Set(twins.map(twin => twin.id));
    assert.ok(!enrichedRows.some(row => !row.label && twinIds.has(row.pair.a.id) && twinIds.has(row.pair.b.id)));
    assert.throws(() => labelledPairs([]), /Insufficient/);
    assert.throws(() => labelledPairs([{ ...corpora[0], items: [item, { ...item, id: "other", status: "closed", close_reason: `Duplicate of ${item.id}` }] }]), /Insufficient/);
  });
});

test("related benchmark reads real dependency edges and separates whole repositories", async () => {
  await scenario(async fixture => {
    const corpora: DuplicateCorpus[] = [];
    for (const repository of ["public-1", "rel-x"]) {
      const ids: string[] = [];
      for (let i = 0; i < 9; i++) {
        const created = (await fixture.pm.create({ id: `edge-${repository}-${i}`, type: "Task", title: `Session policy ${repository} ${i}`, description: "Check session expiry and reject old sessions" })).item;
        ids.push(created.id);
      }
      // Even items connect to the anchor; item 7 is a duplicate closure of item 8 and must not become a related label.
      for (const i of [1, 2, 3, 4]) await fixture.pm.update(ids[i], { dep: [`id=${ids[0]},kind=related`] });
      await fixture.pm.update(ids[7], { dep: [`id=${ids[8]},kind=related`], status: "closed", closeReason: `Duplicate of ${ids[8]}` });
      // A transitive duplicate edge and an unresolved chain cannot be related ground truth.
      await fixture.pm.update(ids[5], { dep: [`id=${ids[8]},kind=related`], status: "closed", closeReason: `Duplicate of ${ids[7]}` });
      await fixture.pm.update(ids[6], { dep: [`id=${ids[0]},kind=related`], status: "closed", closeReason: "Duplicate of missing-target" });
      await fixture.pm.update(ids[0], { dep: [`id=${ids[1]},kind=related`] });
      const sparseA = (await fixture.pm.create({ id: `sparse-a-${repository}`, type: "Task", title: "AAAAAAAAAA", description: "" })).item;
      const sparseB = (await fixture.pm.create({ id: `sparse-b-${repository}`, type: "Task", title: "ZZZZZZZZZZ", description: "" })).item;
      await fixture.pm.update(sparseA.id, { dep: [`id=${sparseB.id},kind=related`] });
      ids.push(sparseA.id, sparseB.id);
      corpora.push({ repository, commit: "synthetic", items: (await fixture.pm.listAllComplete({ includeBody: true })).items.filter(item => ids.includes(item.id)) });
    }
    const rows = labelledRelatedPairs(corpora, 3);
    const edges = new Map(corpora.map(corpus => [corpus.repository, new Set(corpus.items.flatMap(item => (item.dependencies ?? []).map(dep => [item.id, dep.id].sort().join("\u0000"))))]));
    const closures = new Map(corpora.map(corpus => [corpus.repository, new Set(corpus.items.flatMap(item => { const target = closureTarget(item); return target === undefined ? [] : [[item.id, target].sort().join("\u0000")]; }))]));
    const splits = new Map(rows.map(row => [row.repository, row.split]));
    for (const row of rows) {
      assert.equal(row.pair_id, `${row.repository}:${row.pair.a.id}:${row.pair.b.id}`);
      const key = [row.pair.a.id, row.pair.b.id].sort().join("\u0000");
      // Positives are recorded edges; controls are never edges; duplicate closures are excluded from both.
      assert.ok(!closures.get(row.repository)!.has(key));
      assert.equal(row.label, edges.get(row.repository)!.has(key));
    }
    // Whole repositories sit in one seeded split; both splits carry a strict 2:1 control ratio.
    assert.equal(splits.get("public-1"), "dev");
    assert.equal(splits.get("rel-x"), "heldout");
    for (const split of ["dev", "heldout"]) {
      const partition = rows.filter(row => row.split === split);
      assert.equal(partition.filter(row => row.label).length, 3);
      assert.equal(partition.filter(row => !row.label).length, 6);
    }
    assert.equal(rows.filter(row => row.label && ([row.pair.a.id, row.pair.b.id].some(id => /-[567]$/.test(id)))).length, 0);
    assert.deepEqual(labelledRelatedPairs([...corpora].reverse(), 3), rows);
    assert.ok(labelledRelatedPairs(corpora, 20).some(row => row.label && !row.retrieved), "unretrieved real edges stay in the denominator");
    assert.throws(() => labelledRelatedPairs([]), /Insufficient/);
    assert.throws(() => labelledRelatedPairs([{ ...corpora[0], items: corpora[0].items.slice(0, 1) }]), /Insufficient/);
  });
});

test("pair metrics expose misses, abstention, null precision and Wilson uncertainty", () => {
  const rows = [
    { label: true, probability: 0.9, related_probability: 0.2, retrieved: true },
    { label: false, probability: 0.9, related_probability: 0.2, retrieved: true },
    { label: true, probability: 0.9, related_probability: 0.2, retrieved: false },
    { label: true, probability: 0.5, related_probability: 0.2, retrieved: true },
    { label: false, probability: 0.1, related_probability: 0.1, retrieved: true },
  ];
  const m = pairMetrics(rows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 });
  assert.equal(m.tp, 1); assert.equal(m.fp, 1); assert.equal(m.fn, 2);
  assert.equal(m.precision, 0.5); assert.equal(m.recall, 1 / 3); assert.equal(m.f1, 0.4);
  assert.equal(m.abstain_rate, 0.2);
  assert.equal(pairMetrics(rows, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, true).abstain_rate, 0);
  assert.equal(pairMetrics([], "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }).precision, null);
  assert.equal(pairMetrics([], "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }).recall, null);
  assert.equal(pairMetrics([], "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }).abstain_rate, null);
  assert.equal(pairMetrics([{ label: true, probability: 0, related_probability: 0, retrieved: true }, { label: false, probability: 1, related_probability: 0, retrieved: true }], "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }).f1, 0);
  assert.equal(wilson(0, 0), null);
  const interval = wilson(1, 1)!;
  assert.ok(interval[0] > 0.2 && interval[0] < 0.21);
  assert.equal(interval[1], 1);
  assert.equal(wilson(0, 1)![0], 0);
  assert.ok(m.f1_wilson_envelope95![0] < m.f1 && m.f1_wilson_envelope95![1] > m.f1);
  // The related class scores a second typed question over the same rows.
  const related = pairMetrics([
    { label: true, probability: 0.1, related_probability: 0.9, retrieved: true },
    { label: false, probability: 0.1, related_probability: 0.1, retrieved: true },
    { label: true, probability: 0.1, related_probability: 0.5, retrieved: true },
  ], "related", { threshold: 0.8, relatedThreshold: 0.8 });
  assert.equal(related.tp, 1); assert.equal(related.fp, 0); assert.equal(related.fn, 1);
  assert.equal(related.abstain_rate, 1 / 3);
  assert.equal(pairMetrics([{ label: false, probability: 0, related_probability: null, retrieved: true }], "related", { threshold: 0.8, relatedThreshold: 0.8 }).fp, 0);
});

test("threshold fitting uses dev evidence only and refuses unsupported model selection", () => {
  const positives = Array.from({ length: 4 }, () => ({ label: true, probability: 0.85, related_probability: 0.1, retrieved: true }));
  const negatives = Array.from({ length: 8 }, () => ({ label: false, probability: 0.7, related_probability: 0.1, retrieved: true }));
  const relatedPositives = Array.from({ length: 4 }, () => ({ label: true, probability: 0.1, related_probability: 0.85, retrieved: true }));
  const relatedNegatives = Array.from({ length: 8 }, () => ({ label: false, probability: 0.1, related_probability: 0.7, retrieved: true }));
  assert.equal(fitPairThreshold([...positives, ...negatives], "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, false), 0.8);
  assert.equal(fitPairThreshold([...positives, ...negatives], "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, true), 0.85);
  assert.equal(fitPairThreshold([...relatedPositives, ...relatedNegatives], "related", { threshold: 0.8, relatedThreshold: 0.8 }, false), 0.8);
  const overlappingRelatedControls = relatedNegatives.map(row => ({ ...row, related_probability: 0.83 }));
  assert.equal(fitPairThreshold([...relatedPositives, ...overlappingRelatedControls], "related", { threshold: 0.8, relatedThreshold: 0.8 }, false), 0.85);
  assert.equal(fitPairThreshold(negatives, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, false), Infinity);
  assert.equal(fitPairThreshold([], "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, true), 0);
  assert.equal(fitPairThreshold([], "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, false), Infinity);
  assert.equal(fitPairThreshold([...positives, ...negatives], "related", { threshold: 0.8, relatedThreshold: 0.8 }, true), 0.85);
  assert.equal(fitPairThreshold([{ label: true, probability: 0, related_probability: null, retrieved: true }], "related", { threshold: 0.8, relatedThreshold: 0.8 }, false), Infinity);
});

type Row = { set: "duplicate" | "related"; pair_id: string; repository: string; a: string; b: string; label: boolean; retrieved: boolean; lexical: number; split: string };
type Observation = { pair_id: string; label: boolean; retrieved: boolean; probability: number; related_probability: number };
type Metrics = ReturnType<typeof pairMetrics>;
type Arm = { arm: string; threshold: number | null; related_threshold?: number | null; model_digest?: string; model_calls?: number; observations?: Observation[]; related_observations?: Observation[]; dev: Metrics; heldout: Metrics; related_dev?: Metrics; related_heldout?: Metrics };

/** Load the persisted inference receipt without making model requests. */
function readReport(): { data: unknown[]; samples: Row[]; arms: Arm[]; question_sha256: string } {
  return JSON.parse(readFileSync(new URL("../calibration/dedupe-report-v2.json", import.meta.url), "utf8"));
}

/** Verify pair identity and metadata before assigning observations to splits by index. */
function assertObservationOrder(samples: Row[], observations: Observation[]): void {
  assert.equal(observations.length, samples.length);
  for (const [i, sample] of samples.entries()) {
    assert.equal(sample.pair_id, `${sample.repository}:${sample.a}:${sample.b}`);
    assert.equal(observations[i].pair_id, sample.pair_id, `pair identity at index ${i}`);
    assert.equal(observations[i].label, sample.label);
    assert.equal(observations[i].retrieved, sample.retrieved);
  }
}

/** Refit both recorded cutoffs independently and compare every recorded metric. */
function assertOperatingPoint(samples: Row[], observations: Observation[], relatedSamples: Row[], relatedObservations: Observation[], arm: Arm, lexical: boolean): void {
  const split = (row: Row) => row.split === "dev";
  const dev = observations.filter((_, i) => split(samples[i]));
  const heldout = observations.filter((_, i) => !split(samples[i]));
  const threshold = fitPairThreshold(dev, "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, lexical);
  assert.equal(Number.isFinite(threshold) ? threshold : null, arm.threshold);
  const thresholds = { threshold: threshold === Infinity ? 1 : threshold, relatedThreshold: 0.8 };
  if (lexical) {
    assert.deepEqual(pairMetrics(dev, "duplicate", thresholds, true), arm.dev);
    assert.deepEqual(pairMetrics(heldout, "duplicate", thresholds, true), arm.heldout);
    return;
  }
  const relatedDev = relatedObservations.filter((_, i) => split(relatedSamples[i]));
  const relatedHeldout = relatedObservations.filter((_, i) => !split(relatedSamples[i]));
  const relatedThreshold = fitPairThreshold(relatedDev, "related", { threshold: thresholds.threshold, relatedThreshold: 0.8 }, false);
  assert.equal(relatedThreshold, arm.related_threshold);
  const frozen = { threshold: thresholds.threshold, relatedThreshold };
  assert.deepEqual(pairMetrics(dev, "duplicate", frozen), arm.dev);
  assert.deepEqual(pairMetrics(heldout, "duplicate", frozen), arm.heldout);
  assert.deepEqual(pairMetrics(relatedDev, "related", frozen, false), arm.related_dev);
  assert.deepEqual(pairMetrics(relatedHeldout, "related", frozen, false), arm.related_heldout);
}

test("real label receipt replays every operating point and held-out metric", () => {
  const report = readReport();
  assert.equal(report.question_sha256, evidenceHash(PAIR_QUESTIONS));
  const samples = report.samples.filter(row => row.set === "duplicate");
  const relatedSamples = report.samples.filter(row => row.set === "related");
  assert.equal(samples.length, 105);
  assert.equal(samples.filter(row => row.label).length, 35);
  assert.equal(relatedSamples.length, 90);
  assert.equal(relatedSamples.filter(row => row.label).length, 30);
  const devIds = new Set(samples.filter(row => row.split === "dev").flatMap(row => [`${row.repository}:${row.a}`, `${row.repository}:${row.b}`]));
  for (const row of samples.filter(row => row.split === "heldout")) {
    assert.ok(!devIds.has(`${row.repository}:${row.a}`)); assert.ok(!devIds.has(`${row.repository}:${row.b}`));
  }
  const relatedRepositories = new Map(relatedSamples.map(row => [row.repository, row.split]));
  for (const [repository, split] of relatedRepositories) assert.ok(relatedSamples.filter(row => row.repository === repository).every(row => row.split === split));
  for (const partition of [samples, relatedSamples]) {
    for (const split of ["dev", "heldout"]) {
      const rows = partition.filter(row => row.split === split);
      assert.equal(rows.filter(row => !row.label).length, 2 * rows.filter(row => row.label).length);
    }
  }
  for (const arm of report.arms) {
    const lexical = arm.arm === "lexical";
    const observations = lexical ? samples.map(row => ({ pair_id: row.pair_id, label: row.label, retrieved: row.retrieved, probability: row.lexical, related_probability: 0 })) : arm.observations!;
    assertObservationOrder(samples, observations);
    if (lexical) {
      assertOperatingPoint(samples, observations, relatedSamples, [], arm, true);
      continue;
    }
    assertObservationOrder(relatedSamples, arm.related_observations!);
    assertOperatingPoint(samples, observations, relatedSamples, arm.related_observations!, arm, false);
    assert.equal(arm.model_digest, PAIR_CALIBRATION[arm.arm].digest);
    assert.equal(arm.threshold, PAIR_CALIBRATION[arm.arm].threshold);
    assert.equal(arm.related_threshold, PAIR_CALIBRATION[arm.arm].related_threshold);
    assert.equal(arm.model_calls, observations.length + arm.related_observations!.length);
    assert.ok(arm.model_calls! <= 200);
  }
});

test("receipt rejects metric-preserving observation swaps across dev and held-out splits", () => {
  const report = readReport();
  for (const [name, set] of [["tev1:4b", "duplicate"], ["tev1:4b", "related"]] as const) {
    const arm = report.arms.find(row => row.arm === name)!;
    const samples = report.samples.filter(row => row.set === set);
    const observations = set === "duplicate" ? arm.observations! : arm.related_observations!;
    /** Find a metric-preserving cross-split swap: same label and retrieval, different probability. */
    const devIndex = samples.findIndex((row, i) => row.split === "dev" && samples.some((other, j) => other.split === "heldout" && observations[j].label === observations[i].label && observations[j].retrieved === observations[i].retrieved && observations[j].probability !== observations[i].probability));
    const heldoutIndex = samples.findIndex((row, j) => row.split === "heldout" && observations[devIndex].label === observations[j].label && observations[devIndex].retrieved === observations[j].retrieved && observations[devIndex].probability !== observations[j].probability);
    assert.ok(devIndex >= 0 && heldoutIndex >= 0, "a metric-preserving swap pair must exist");
    const swapped = [...observations];
    [swapped[devIndex], swapped[heldoutIndex]] = [swapped[heldoutIndex], swapped[devIndex]];
    assert.throws(() => assertObservationOrder(samples, swapped), /pair identity at index/);
  }
});

test("documented single-question helpers replay the unchanged historical receipt", () => {
  const legacy = JSON.parse(readFileSync(new URL("../calibration/dedupe-report-v1.json", import.meta.url), "utf8")) as {
    samples: Omit<Row, "set">[];
    arms: { arm: string; threshold: number; dev: Metrics; heldout: Metrics; observations?: { label: boolean; retrieved: boolean; probability: number }[] }[];
  };
  for (const arm of legacy.arms) {
    const lexical = arm.arm === "lexical";
    const rows = lexical ? legacy.samples.map(row => ({ label: row.label, retrieved: row.retrieved, probability: row.lexical })) : arm.observations!;
    const dev = rows.filter((_, i) => legacy.samples[i].split === "dev");
    const heldout = rows.filter((_, i) => legacy.samples[i].split === "heldout");
    assert.equal(fitDuplicateThreshold(dev, lexical), arm.threshold);
    assert.deepEqual(duplicateMetrics(dev, arm.threshold, lexical), arm.dev);
    const heldoutMetrics = lexical ? duplicateMetrics(heldout, arm.threshold, true) : duplicateMetrics(heldout, arm.threshold);
    assert.deepEqual(heldoutMetrics, arm.heldout);
  }
});
