import assert from "node:assert/strict";
import test from "node:test";
import { closureTarget, duplicateMetrics, fitDuplicateThreshold, labelledPairs, wilson } from "../dedupe-evaluation.ts";
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
        const original = (await fixture.pm.create({ type: "Task", title: `Validate session policy ${r} ${i}`, description: "Check session expiry and reject old sessions" })).item;
        const duplicate = (await fixture.pm.create({ type: "Task", title: original.title })).item;
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
      assert.equal(partition.filter(row => row.label).length, 3);
      assert.equal(partition.filter(row => !row.label).length, 6);
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
    const accepted = labelledPairs([enriched, corpora[1]], 30).filter(row => row.label);
    assert.ok(!accepted.some(row => [row.pair.a.id, row.pair.b.id].some(id => ["bad-self", "bad-missing", "bad-cycle", "bad-loop", "bad-active"].includes(id))));
    assert.throws(() => labelledPairs([]), /Insufficient/);
    assert.throws(() => labelledPairs([{ ...corpora[0], items: [item, { ...item, id: "other", status: "closed", close_reason: `Duplicate of ${item.id}` }] }]), /Insufficient/);
  });
});

test("duplicate metrics expose misses, abstention, null precision and Wilson uncertainty", () => {
  const rows = [
    { label: true, probability: 0.9, retrieved: true },
    { label: false, probability: 0.9, retrieved: true },
    { label: true, probability: 0.9, retrieved: false },
    { label: true, probability: 0.5, retrieved: true },
    { label: false, probability: 0.1, retrieved: true },
  ];
  const m = duplicateMetrics(rows, 0.8);
  assert.equal(m.tp, 1); assert.equal(m.fp, 1); assert.equal(m.fn, 2);
  assert.equal(m.precision, 0.5); assert.equal(m.recall, 1 / 3); assert.equal(m.f1, 0.4);
  assert.equal(m.abstain_rate, 0.2);
  assert.equal(duplicateMetrics(rows, 0.8, true).abstain_rate, 0);
  assert.equal(duplicateMetrics([], 0.8).precision, null);
  assert.equal(duplicateMetrics([], 0.8).recall, null);
  assert.equal(duplicateMetrics([], 0.8).abstain_rate, null);
  assert.equal(duplicateMetrics([{ label: true, probability: 0, retrieved: true }, { label: false, probability: 1, retrieved: true }], 0.8).f1, 0);
  assert.equal(wilson(0, 0), null);
  const interval = wilson(1, 1)!;
  assert.ok(interval[0] > 0.2 && interval[0] < 0.21);
  assert.equal(interval[1], 1);
  assert.equal(wilson(0, 1)![0], 0);
  assert.ok(m.f1_wilson_envelope95![0] < m.f1 && m.f1_wilson_envelope95![1] > m.f1);
});

test("threshold fitting uses dev evidence only and refuses unsupported model selection", () => {
  const positives = Array.from({ length: 4 }, () => ({ label: true, probability: 0.85, retrieved: true }));
  const negatives = Array.from({ length: 8 }, () => ({ label: false, probability: 0.7, retrieved: true }));
  assert.equal(fitDuplicateThreshold([...positives, ...negatives], false), 0.8);
  assert.equal(fitDuplicateThreshold([...positives, ...negatives], true), 0.85);
  assert.equal(fitDuplicateThreshold(negatives, false), Infinity);
  assert.equal(fitDuplicateThreshold([], true), 0);
  assert.equal(fitDuplicateThreshold([], false), Infinity);
});

type Row = { pair_id: string; repository: string; a: string; b: string; label: boolean; retrieved: boolean; lexical: number; split: string };
type Observation = { pair_id: string; label: boolean; probability: number; retrieved: boolean };
type Arm = { arm: string; threshold: number | null; model_digest?: string; model_calls?: number; unretained_postprocessing_calls?: number; observations?: Observation[]; excluded?: { repository: string; a: string; b: string; observation: Observation }[]; dev: ReturnType<typeof duplicateMetrics>; heldout: ReturnType<typeof duplicateMetrics> };

/** Load the persisted inference receipt without making model requests. */
function readReport(): { samples: Row[]; arms: Arm[]; question_sha256: string } {
  return JSON.parse(readFileSync(new URL("../calibration/dedupe-report-v1.json", import.meta.url), "utf8"));
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

/** Refit and compare all recorded metrics independently of pair-order validation. */
function assertOperatingPoint(samples: Row[], observations: Observation[], arm: Arm, lexical: boolean): void {
  const dev = observations.filter((_, i) => samples[i].split === "dev");
  const heldout = observations.filter((_, i) => samples[i].split === "heldout");
  const threshold = fitDuplicateThreshold(dev, lexical);
  assert.equal(Number.isFinite(threshold) ? threshold : null, arm.threshold);
  assert.deepEqual(duplicateMetrics(dev, threshold, lexical), arm.dev);
  assert.deepEqual(duplicateMetrics(heldout, threshold, lexical), arm.heldout);
}

test("real duplicate-label receipt replays every operating point and held-out metric", () => {
  const report = readReport();
  assert.equal(report.question_sha256, evidenceHash(PAIR_QUESTIONS));
  assert.equal(report.samples.length, 105);
  assert.equal(report.samples.filter(row => row.label).length, 35);
  const devIds = new Set(report.samples.filter(row => row.split === "dev").flatMap(row => [`${row.repository}:${row.a}`, `${row.repository}:${row.b}`]));
  for (const row of report.samples.filter(row => row.split === "heldout")) {
    assert.ok(!devIds.has(`${row.repository}:${row.a}`)); assert.ok(!devIds.has(`${row.repository}:${row.b}`));
  }
  for (const split of ["dev", "heldout"]) {
    const rows = report.samples.filter(row => row.split === split);
    assert.equal(rows.filter(row => !row.label).length, 2 * rows.filter(row => row.label).length);
  }
  for (const arm of report.arms) {
    const lexical = arm.arm === "lexical";
    const observations = lexical ? report.samples.map(row => ({ pair_id: row.pair_id, label: row.label, probability: row.lexical, retrieved: row.retrieved })) : arm.observations!;
    assertObservationOrder(report.samples, observations);
    assertOperatingPoint(report.samples, observations, arm, lexical);
    if (!lexical) {
      assert.equal(arm.model_digest, PAIR_CALIBRATION[arm.arm].digest);
      assert.equal(arm.threshold, PAIR_CALIBRATION[arm.arm].threshold);
      assert.equal(arm.model_calls, observations.length + arm.excluded!.length + arm.unretained_postprocessing_calls!);
      assert.ok(arm.model_calls! <= 200);
      for (const excluded of arm.excluded!) {
        assert.equal(excluded.observation.pair_id, `${excluded.repository}:${excluded.a}:${excluded.b}`);
      }
    }
  }
});

test("receipt rejects metric-preserving observation swaps across dev and held-out splits", () => {
  const report = readReport();
  for (const [name, devIndex, heldoutIndex] of [["tev1:0.8b", 2, 81], ["tev1:4b", 0, 83]] as const) {
    const arm = report.arms.find(row => row.arm === name)!;
    const observations = [...arm.observations!];
    assert.equal(report.samples[devIndex].split, "dev");
    assert.equal(report.samples[heldoutIndex].split, "heldout");
    assert.equal(observations[devIndex].label, observations[heldoutIndex].label);
    assert.equal(observations[devIndex].retrieved, observations[heldoutIndex].retrieved);
    assert.notEqual(observations[devIndex].probability, observations[heldoutIndex].probability);
    [observations[devIndex], observations[heldoutIndex]] = [observations[heldoutIndex], observations[devIndex]];
    assertOperatingPoint(report.samples, observations, arm, false);
    assert.throws(() => assertObservationOrder(report.samples, observations), /pair identity at index/);
  }
});
