import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { evidenceHash } from "../decision-calibration.ts";
import { duplicateSimilarity, duplicateSplit, qualityMetrics, qualityProposes, qualityFrontier, fitQualityPolicy } from "../duplicate-quality.ts";
import { historicalDuplicate, repositoryDuplicatePairs } from "../dedupe-evaluation.ts";
import { DUPLICATE_QUESTIONS, DUPLICATE_QUALITY_CALIBRATION, orderedPair } from "../dedupe.ts";
import type { PairItem } from "../dedupe.ts";
import type { QualityArm, QualityObservation, QualityPolicy } from "../duplicate-quality.ts";
import { scenario } from "./fixtures.ts";

test("precision-first calibration abstains at disabled points and fits only supplied train rows", () => {
  const train = [
    { label: true, probability: 0.95, lexical: 0.9, retrieved: true },
    { label: true, probability: 0.95, lexical: 0.9, retrieved: true },
    { label: true, probability: 0.95, lexical: 0.9, retrieved: true },
    { label: false, probability: 0.99, lexical: 0.3, retrieved: true },
    { label: false, probability: 0.7, lexical: 0.9, retrieved: true },
    { label: true, probability: 0.99, lexical: 0.99, retrieved: false },
  ];
  const combined = fitQualityPolicy(train, "combined");
  assert.deepEqual(combined, { model: 0.95, lexical: 0.9 });
  const metrics = qualityMetrics(train, "combined", combined);
  assert.deepEqual([metrics.tp, metrics.fp, metrics.fn, metrics.precision, metrics.recall, metrics.abstention_rate], [3, 0, 1, 1, 0.75, 0.5]);
  assert.equal(qualityMetrics(train, "model-only", { model: 0.95, lexical: null }).tp, 4, "model-only bypasses retrieval on the identical labelled set");
  assert.equal(qualityMetrics(train, "lexical-only", { model: null, lexical: 0.9 }).fp, 1);
  assert.equal(qualityMetrics([{ ...train[0], probability: 0.94 }], "combined", combined).tp, 0);
  assert.equal(qualityMetrics([{ ...train[0], lexical: 0.89 }], "combined", combined).tp, 0);
  assert.equal(qualityProposes({ ...train[0], probability: 1 }, "combined", { model: null, lexical: 0 }), false);
  for (const arm of ["lexical-only", "model-only", "combined"] as QualityArm[]) {
    assert.deepEqual(fitQualityPolicy([], arm), { model: null, lexical: null });
    assert.deepEqual(fitQualityPolicy([train[0]], arm), { model: null, lexical: null });
    const empty = qualityMetrics([], arm, { model: null, lexical: null });
    assert.equal(empty.precision, null); assert.equal(empty.recall, null); assert.equal(empty.abstention_rate, null);
    assert.equal(qualityMetrics(train, arm, { model: null, lexical: null }).abstention_rate, 1);
    assert.deepEqual(fitQualityPolicy([...train].reverse(), arm), fitQualityPolicy(train, arm));
    assert.ok(qualityFrontier(train, arm).length > 1);
  }
  const heldout = [{ label: false, probability: 1, lexical: 1, retrieved: true }];
  assert.equal(qualityMetrics(heldout, "combined", combined).precision, 0);
  assert.deepEqual(fitQualityPolicy(train, "combined"), combined, "held-out outcomes cannot change the fitted policy");
  assert.deepEqual(fitQualityPolicy(Array.from({ length: 3 }, () => ({ ...train[0], probability: 0.79 })), "combined"), { model: 0.79, lexical: 0.9 });
  const ties: QualityObservation[] = [0.8, 0.9].flatMap(probability => Array.from({ length: 3 }, () => ({ label: true, probability, lexical: 0.9, retrieved: true })));
  assert.equal(fitQualityPolicy(ties, "model-only").model, 0.8, "best train recall precedes stricter cutoffs");
  assert.equal(qualityMetrics([{ label: false, probability: 0, lexical: 0, retrieved: true }], "combined", combined).recall, null);
});

test("semantic duplicate score resists generic tags and title dilution", async () => {
  await scenario(async fixture => {
    const created = (await fixture.pm.create({ type: "Task", title: "Reject expired sessions", description: "Deny stale sessions", tags: "auth" })).item as PairItem;
    created.files = [{ path: "src/auth.ts", scope: "project" }];
    const pair = orderedPair(created, { ...created, id: "other-id" }, 1);
    assert.equal(duplicateSimilarity(pair), 1);
    const unrelated = { ...created, title: "Rotate signing keys", description: "Issue fresh tokens", body: "", id: "different-id" };
    assert.equal(duplicateSimilarity({ ...pair, b: unrelated }), 0.05, "tags and files cannot independently qualify duplicates");
    const sparse = { ...created, title: "", description: "", body: undefined, tags: [], files: undefined };
    assert.equal(duplicateSimilarity({ a: sparse, b: sparse, score: 0 }), 0);
    assert.equal(duplicateSimilarity({ ...pair, b: { ...created, title: "REJECT expired sessions!", body: created.description } }), 1);
  });
});

test("public history restoration accepts explicit deleted duplicates and refuses incomplete evidence", () => {
  const metadata = { id: "old-id", title: "Repair query state filter", description: "Server-side state filtering", type: "Issue", created_at: "2026-01-01", updated_at: "2026-01-01", tags: [] };
  const create = { op: "create", patch: Object.entries(metadata).map(([key, value]) => ({ op: "add", path: `/metadata/${key}`, value })) };
  const deletion = { op: "delete", message: "Remove duplicate of canonical-id", patch: [] };
  assert.equal(historicalDuplicate([create, deletion])?.close_reason, "Duplicate of canonical-id");
  assert.equal(historicalDuplicate([create, { ...deletion, message: "Remove duplicate audit; retained canonical-id" }])?.close_reason, "Duplicate of canonical-id");
  assert.equal(historicalDuplicate([create, { op: "update", patch: [{ op: "add", path: "/body", value: "Details" }, { op: "remove", path: "/metadata/description" }] }, deletion])?.body, "Details");
  assert.equal(historicalDuplicate([create, { op: "update", patch: [{ op: "remove", path: "/metadata/description" }] }, deletion])?.description, "");
  for (const key of ["id", "title", "type", "created_at", "updated_at", "tags"]) assert.equal(historicalDuplicate([{ ...create, patch: create.patch.filter(patch => patch.path !== `/metadata/${key}`) }, deletion]), undefined);
  assert.equal(historicalDuplicate([create, { ...deletion, message: undefined }]), undefined);
  assert.equal(historicalDuplicate([create, { op: "update", patch: [{ op: "add", path: "/metadata/tags/0", value: "auth" }] }, deletion]), undefined);
  assert.equal(historicalDuplicate([create]), undefined);
});

test("closure-component labels grow positives and isolate whole repositories on real non-git trackers", async () => {
  await scenario(async fixture => {
    const corpora = [];
    for (const repository of ["unbraind/pm-cli", "unbraind/pm-beads"]) {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) ids.push((await fixture.pm.create({ type: "Task", title: `Validate login policy ${i}`, description: "Reject expired sessions" })).item.id);
      await fixture.pm.update(ids[1], { status: "closed", closeReason: `Duplicate of ${ids[0]}` });
      await fixture.pm.update(ids[2], { status: "canceled", closeReason: `Duplicate of ${ids[0]}` });
      await fixture.pm.update(ids[3], { status: "closed", closeReason: `Duplicate of ${ids[4]}` });
      await fixture.pm.update(ids[4], { status: "closed", closeReason: `Duplicate of ${ids[3]}` });
      await fixture.pm.update(ids[5], { status: "closed", closeReason: "Duplicate of missing-target" });
      await fixture.pm.update(ids[6], { status: "closed", closeReason: `Duplicate of ${ids[6]}` });
      const sparseA = (await fixture.pm.create({ type: "Task", title: "AAAAAAAA", description: "" })).item.id;
      const sparseB = (await fixture.pm.create({ type: "Task", title: "ZZZZZZZZ", description: "" })).item.id;
      await fixture.pm.update(sparseA, { status: "closed", closeReason: `Duplicate of ${sparseB}` });
      ids.push(sparseA, sparseB);
      for (let i = 0; i < 2; i++) ids.push((await fixture.pm.create({ type: "Task", title: "Identical uncontrolled evidence", description: "same text" })).item.id);
      corpora.push({ repository, commit: "synthetic", items: (await fixture.pm.listAllComplete({ includeBody: true })).items.filter(item => ids.includes(item.id)) as PairItem[] });
    }
    const rows = repositoryDuplicatePairs(corpora);
    assert.equal(rows.filter(row => row.label).length, 10, "two siblings add the third pair; reciprocal closures count once");
    assert.equal(rows.filter(row => !row.label).length, 20);
    assert.ok(rows.some(row => row.label && !row.retrieved));
    assert.ok(rows.every(row => row.label || row.pair.a.title !== "Identical uncontrolled evidence" || row.pair.b.title !== "Identical uncontrolled evidence"));
    const repositories = new Map<string, string>();
    for (const row of rows) {
      const expected = duplicateSplit(row.repository) === "train" ? "dev" : "heldout";
      assert.equal(row.split, expected);
      assert.equal(repositories.get(row.repository) ?? row.split, row.split);
      repositories.set(row.repository, row.split);
    }
    assert.equal(new Set(repositories.values()).size, 2);
    assert.deepEqual(repositoryDuplicatePairs([...corpora].reverse()), rows);
    assert.deepEqual(repositoryDuplicatePairs([...corpora, { repository: "no-closures", commit: "synthetic", items: [] }]), rows);
    assert.throws(() => repositoryDuplicatePairs([]), /Insufficient/);
  });
});

test("calibration chooses precision over a higher-F1 low-precision operating point", () => {
  const high = Array.from({ length: 3 }, () => ({ label: true, retrieved: true, lexical: 0.95, probability: 0.95 }));
  const low = [...Array.from({ length: 7 }, () => ({ label: true, retrieved: true, lexical: 0.7, probability: 0.9 })), ...Array.from({ length: 7 }, () => ({ label: false, retrieved: true, lexical: 0.7, probability: 0.9 }))];
  const train = [...high, ...low];
  assert.deepEqual(fitQualityPolicy(train, "combined"), { model: 0.95, lexical: 0.95 });
  assert.deepEqual(fitQualityPolicy(train, "lexical-only"), { model: null, lexical: 0.95 });
  assert.deepEqual(fitQualityPolicy(train, "model-only"), { model: 0.95, lexical: null });
});

/** Public receipt rows bind observations by pair identity, never by probability or outcome. */
interface ReceiptSample { pair_id: string; repository: string; a: string; b: string; split: "train" | "heldout"; label: boolean; retrieved: boolean; lexical: number }
/** Replayable report shape without source tracker text. */
interface QualityReceipt {
  question_sha256: string; model: string; model_digest: string; samples: ReceiptSample[];
  observations: (QualityObservation & { pair_id: string })[];
  arms: { arm: QualityArm; policy: QualityPolicy; train: ReturnType<typeof qualityMetrics>; heldout: ReturnType<typeof qualityMetrics>; frontier: { policy: QualityPolicy; train: ReturnType<typeof qualityMetrics>; heldout: ReturnType<typeof qualityMetrics> }[] }[];
}


test("public quality receipt replays repository separation, train fitting and every held-out frontier point", () => {
  const report = JSON.parse(readFileSync(new URL("../calibration/duplicate-quality-report-v3.json", import.meta.url), "utf8")) as QualityReceipt;
  assert.equal(report.question_sha256, evidenceHash(DUPLICATE_QUESTIONS));
  assert.ok(report.samples.filter(row => row.label).length > 35);
  assert.equal(new Set(report.samples.map(row => row.pair_id)).size, report.samples.length);
  assert.equal(report.observations.length, report.samples.length);
  for (const [i, row] of report.samples.entries()) {
    assert.equal(row.split, duplicateSplit(row.repository));
    assert.equal(row.pair_id, `${row.repository}:${row.a}:${row.b}`);
    const observation = report.observations[i];
    assert.equal(observation.pair_id, row.pair_id);
    assert.equal(observation.label, row.label);
    assert.equal(observation.retrieved, row.retrieved);
    assert.equal(observation.lexical, row.lexical);
    assert.ok(observation.probability >= 0 && observation.probability <= 1);
  }
  const train = report.observations.filter((_, i) => report.samples[i].split === "train");
  const heldout = report.observations.filter((_, i) => report.samples[i].split === "heldout");
  assert.deepEqual(report.arms.map(row => row.arm), ["lexical-only", "model-only", "combined"]);
  for (const arm of report.arms) {
    assert.deepEqual(arm.policy, fitQualityPolicy(train, arm.arm));
    assert.deepEqual(arm.train, qualityMetrics(train, arm.arm, arm.policy));
    assert.deepEqual(arm.heldout, qualityMetrics(heldout, arm.arm, arm.policy));
    assert.deepEqual(arm.frontier, qualityFrontier(train, arm.arm).map(point => ({ ...point, heldout: qualityMetrics(heldout, arm.arm, point.policy) })));
  }
  assert.equal(DUPLICATE_QUALITY_CALIBRATION[report.model].digest, report.model_digest);
  assert.deepEqual(DUPLICATE_QUALITY_CALIBRATION[report.model].policy, report.arms.find(row => row.arm === "combined")!.policy);
});

test("train-equivalent thresholds use deterministic stricter channel cutoffs", () => {
  const train = [...Array.from({ length: 3 }, () => ({ label: true, retrieved: true, probability: 0.95, lexical: 0.95 })), { label: false, retrieved: false, probability: 0.9, lexical: 0.85 }];
  assert.deepEqual(fitQualityPolicy(train, "combined"), { model: 0.95, lexical: 0.95 });
  assert.deepEqual(fitQualityPolicy(train, "lexical-only"), { model: null, lexical: 0.95 });
});

test("frontier ignores empty proposals and retains the best precision at each train recall", () => {
  const negative = [{ label: false, retrieved: true, probability: 0.2, lexical: 0.1 }];
  assert.equal(qualityFrontier(negative, "combined").length, 2);
  assert.deepEqual(fitQualityPolicy(negative, "combined"), { model: null, lexical: null });
  const rows = [...Array.from({ length: 4 }, () => ({ label: true, retrieved: true, probability: 0.4, lexical: 0.9 })), { label: false, retrieved: true, probability: 0.2, lexical: 0.5 }];
  const frontier = qualityFrontier(rows, "combined");
  assert.equal(frontier.length, 2);
  assert.deepEqual(frontier[1].policy, { model: 0.4, lexical: 0.9 });
  assert.equal(frontier[1].train.precision, 1);
  assert.equal(frontier[1].train.recall, 1);
});
