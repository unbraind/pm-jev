import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkCalibrationDrift, parseDriftInput, DRIFT_VERSION, DriftRefusal, validateDriftReportNumbers } from "../index.ts";
import type { DriftInput, DriftReport } from "../index.ts";
import { cliFailure, installBuiltExtension, runBuiltCommand } from "./replay-fixtures.ts";
import { runDriftCommand } from "../drift-command.ts";
import { project, trackerSnapshot, withoutGit } from "./fixtures.ts";

/** Balanced explicit outcomes on a frozen identity; nothing is inferred from tracker status. */
function fixture(): DriftInput {
  const cohort = { identity: { model_digest: "a".repeat(64), question_digest: "b".repeat(64) }, observations: Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`, task: i % 2 ? "triage" : "link", type: i % 2 ? "Issue" : "Task", input_bucket: i % 2 ? "short" : "long", predicted: "yes", label: "yes" })) };
  return { version: DRIFT_VERSION, provenance: "synthetic", thresholds: { population_tv: 0.25, error_increase: 0.2, min_population: 10, min_labels: 10 }, calibration: cohort, current: structuredClone(cohort) };
}
/** Assert the typed refusal remains content-free and actionable. */
function refuses(run: () => unknown, code = "invalid_input"): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DriftRefusal);
    assert.equal(error.code, code);
    assert.equal(error.name, "DriftRefusal");
    assert.ok(error.remedy.length > 30);
    return true;
  });
}

test("predeclared sentries distinguish identical, shifted and sparse cohorts with exact identity and no inference", () => {
  assert.equal(checkCalibrationDrift(JSON.parse(readFileSync(new URL("../examples/calibration-drift.json", import.meta.url), "utf8"))).status, "stable");
  const data = fixture();
  const before = JSON.stringify(data);
  const stable = checkCalibrationDrift(data);
  assert.equal(stable.status, "stable");
  assert.equal(stable.recommendation, "retain_policy_and_monitor");
  assert.equal(stable.population.task_tv, 0);
  assert.equal(stable.population.type_tv, 0);
  assert.equal(stable.population.input_tv, 0);
  assert.equal(stable.labels.error_increase, 0);
  assert.equal(stable.inference_calls, 0);
  assert.equal(stable.mutation_authority, "none");
  assert.deepEqual(stable.identity, data.calibration.identity);
  for (const key of ["task", "type", "input_bucket"] as const) {
    const changed = structuredClone(data);
    changed.current.observations = changed.current.observations.map(row => ({ ...row, [key]: "new" }));
    const report = checkCalibrationDrift(changed);
    assert.equal(report.status, "drift");
    assert.equal(report.population[key === "input_bucket" ? "input_tv" : key === "type" ? "type_tv" : "task_tv"], 1);
    assert.equal(report.recommendation, "abstain_and_recalibrate");
    assert.notEqual(report.evidence_sha256, stable.evidence_sha256);
    assert.equal(report.calibration_sha256, stable.calibration_sha256);
  }
  const atCutoff = structuredClone(data);
  atCutoff.current.observations = atCutoff.current.observations.map((row, i) => ({ ...row, input_bucket: i < 5 ? "new" : row.input_bucket }));
  assert.equal(checkCalibrationDrift(atCutoff).population.input_tv, 0.25);
  assert.equal(checkCalibrationDrift(atCutoff).population.status, "drift", "inclusive population cutoff");
  const labelled = structuredClone(data);
  labelled.current.observations = labelled.current.observations.map((row, i) => ({ ...row, label: i < 4 ? "no" : "yes" }));
  assert.equal(checkCalibrationDrift(labelled).labels.error_increase, 0.2);
  assert.equal(checkCalibrationDrift(labelled).status, "drift", "inclusive error cutoff");
  const sparse = structuredClone(data);
  sparse.current.observations = sparse.current.observations.map((row, i) => ({ ...row, label: i < 9 ? "yes" : null }));
  const insufficient = checkCalibrationDrift(sparse);
  assert.equal(insufficient.status, "insufficient_evidence");
  assert.equal(insufficient.population.status, "stable");
  assert.equal(insufficient.labels.current_coverage, 0.45);
  assert.equal(insufficient.recommendation, "abstain_pending_evidence");
  sparse.current.observations = sparse.current.observations.map(row => ({ ...row, task: "changed" }));
  assert.equal(checkCalibrationDrift(sparse).status, "drift", "known population shift survives sparse labels");
  const empty = structuredClone(data);
  empty.calibration.observations = [];
  empty.current.observations = [];
  const missing = checkCalibrationDrift(empty);
  assert.equal(missing.status, "insufficient_evidence");
  assert.equal(missing.population.input_tv, null);
  assert.equal(missing.labels.current_coverage, 0);
  assert.equal(missing.labels.error_increase, null);
  const onlyCurrentEmpty = structuredClone(data);
  onlyCurrentEmpty.current.observations = [];
  assert.equal(checkCalibrationDrift(onlyCurrentEmpty).population.status, "insufficient_evidence");
  assert.equal(checkCalibrationDrift(onlyCurrentEmpty).labels.error_increase, null);
  const moreLabels = structuredClone(data);
  moreLabels.calibration.observations = moreLabels.calibration.observations.map(row => ({ ...row, label: "no" }));
  assert.equal(checkCalibrationDrift(moreLabels).labels.error_increase, -1);
  for (const key of ["model_digest", "question_digest"] as const) {
    const changed = structuredClone(data);
    changed.current.identity[key] = "c".repeat(64);
    refuses(() => checkCalibrationDrift(changed), "identity_mismatch");
  }
  assert.equal(JSON.stringify(data), before);
  const detached = parseDriftInput(data);
  detached.current.identity.model_digest = "f".repeat(64);
  assert.equal(data.current.identity.model_digest, "a".repeat(64));
  assert.deepEqual(checkCalibrationDrift({ ...data, provenance: "public" }).provenance, "public");
  assert.equal(checkCalibrationDrift({ ...data, provenance: "local-unverified" }).provenance, "local-unverified");
});

test("ONE strict boundary rejects sparse arrays, extra fields, bad domains and extreme values", () => {
  const data = fixture();
  for (const raw of [null, undefined, 3, {}, [], { ...data, extra: true }, { ...data, version: "old" }, { ...data, provenance: "secret" }, { ...data, thresholds: null }, { ...data, calibration: null }]) refuses(() => checkCalibrationDrift(raw));
  for (const key of Object.keys(data.thresholds)) for (const value of [null, undefined, NaN, Infinity, -Infinity, -1, 0, 1e-300, 1e300, "1"]) {
    if (key === "population_tv" || key === "error_increase") { if (value === 1e-300) continue; }
    refuses(() => checkCalibrationDrift({ ...data, thresholds: { ...data.thresholds, [key]: value } }));
  }
  for (const key of ["population_tv", "error_increase"]) refuses(() => checkCalibrationDrift({ ...data, thresholds: { ...data.thresholds, [key]: 1.01 } }));
  for (const key of ["min_population", "min_labels"]) for (const value of [1, 2.5, 5001]) refuses(() => checkCalibrationDrift({ ...data, thresholds: { ...data.thresholds, [key]: value } }));
  for (const identity of [null, {}, { ...data.current.identity, extra: 1 }, { ...data.current.identity, model_digest: "tag" }, { ...data.current.identity, question_digest: 42 }]) refuses(() => checkCalibrationDrift({ ...data, current: { ...data.current, identity } }));
  for (const observations of [null, {}, Array(2), Array(5001).fill(data.current.observations[0]), [data.current.observations[0], data.current.observations[0]]]) refuses(() => checkCalibrationDrift({ ...data, current: { ...data.current, observations } }));
  const row = data.current.observations[0];
  for (const value of [null, {}, { ...row, extra: "no" }, ...["id", "task", "type", "input_bucket", "predicted", "label"].flatMap(key => [undefined, 1, "", "x".repeat(97), " padded "].map(value => ({ ...row, [key]: value })))]) refuses(() => checkCalibrationDrift({ ...data, current: { ...data.current, observations: [value] } }));
  const sparseWithExtra = Array(1);
  Object.assign(sparseWithExtra, { extra: row });
  refuses(() => checkCalibrationDrift({ ...data, current: { ...data.current, observations: sparseWithExtra } }));
  const inherited = Array(1);
  Object.assign(inherited, { extra: row });
  Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype) as object, { 0: row }));
  refuses(() => checkCalibrationDrift({ ...data, current: { ...data.current, observations: inherited } }));
  const extremes = { ...data, thresholds: { population_tv: Number.MIN_VALUE, error_increase: 1, min_population: 2, min_labels: 5000 } };
  assert.equal(checkCalibrationDrift(extremes).status, "insufficient_evidence");
  const large = structuredClone(data);
  large.current.observations = Array.from({ length: 5000 }, (_, i) => ({ ...row, id: `x${i}`, type: `type${i}` }));
  assert.ok(checkCalibrationDrift(large).population.type_tv! <= 1);
});

test("output numeric guard and fuzz reject invalid counts and rates before ok", () => {
  const report = checkCalibrationDrift(fixture());
  for (const [section, keys] of [["population", ["calibration_count", "current_count", "task_tv", "type_tv", "input_tv"]], ["labels", ["calibration_count", "current_count", "calibration_coverage", "current_coverage", "calibration_error", "current_error", "error_increase"]]] as const) {
    for (const key of keys) for (const value of [NaN, Infinity, -Infinity, -2, 5001]) {
      const mutated = structuredClone(report);
      Object.assign(mutated[section], { [key]: value });
      refuses(() => validateDriftReportNumbers(mutated), "invalid_output");
    }
  }
  assert.equal(validateDriftReportNumbers(report), report);
});

/** A separate frequency reference uses integer filtering rather than the implementation's map. */
function referenceDistance(data: DriftInput, key: "task" | "type" | "input_bucket"): number {
  const a = data.calibration.observations, b = data.current.observations;
  return [...new Set([...a, ...b].map(row => row[key]))].reduce((sum, category) => sum + Math.abs(a.filter(row => row[key] === category).length / a.length - b.filter(row => row[key] === category).length / b.length), 0) / 2;
}

test("500 seeded model-based operation sequences include old replays, later labels, CRLF and field ordering", () => {
  let seed = 20261025;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let sequence = 0; sequence < 500; sequence++) {
    let state = fixture();
    const saved = [structuredClone(state)];
    for (let step = 0; step < 8; step++) {
      const operation = random() % 4;
      if (operation === 0) state = structuredClone(saved[random() % saved.length]);
      else if (operation === 1) state.current.observations = state.current.observations.map((row, i) => ({ ...row, type: i < random() % 20 ? "custom-active" : row.type }));
      else if (operation === 2) state.current.observations = state.current.observations.map(row => ({ ...row, label: [null, "yes", "no"][random() % 3] }));
      else state.current.observations = [...state.current.observations].reverse();
      saved.push(structuredClone(state));
      const serialized = JSON.stringify(state, null, "  ").replaceAll("\n", "\r\n");
      const result = checkCalibrationDrift(JSON.parse(` \r\n${serialized}\r\n `));
      for (const [key, output] of [["task", "task_tv"], ["type", "type_tv"], ["input_bucket", "input_tv"]] as const) assert.ok(Math.abs(result.population[output]! - referenceDistance(state, key)) < 1e-12);
      const baseline = state.calibration.observations.filter(row => row.label !== null);
      const current = state.current.observations.filter(row => row.label !== null);
      assert.equal(result.labels.current_count, current.length);
      assert.equal(result.labels.calibration_count, baseline.length);
      const error = current.length ? current.filter(row => row.predicted !== row.label).length / current.length : null;
      assert.equal(result.labels.current_error, error);
      const shifted = Math.max(referenceDistance(state, "task"), referenceDistance(state, "type"), referenceDistance(state, "input_bucket")) >= state.thresholds.population_tv || current.length >= 10 && error! >= 0.2;
      assert.equal(result.status, shifted ? "drift" : current.length < 10 ? "insufficient_evidence" : "stable");
      const reordered = JSON.parse(JSON.stringify(state, (_key, value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).reverse()) : value)) as unknown;
      assert.deepEqual(checkCalibrationDrift(reordered), result);
    }
  }
});

test("registered command runs on a real non-git tracker with no inference, no writes, compact TOON/JSON and typed refusals", async () => {
  const p = await project();
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("inference forbidden"); };
  const restoreFetch = () => { globalThis.fetch = fetch; };
  try {
    const item = await p.pm.create({ title: "Synthetic sentry source", type: "Task" });
    const before = await p.pm.get(item.item.id);
    const snapshot = trackerSnapshot(p.pmRoot);
    const file = join(p.cwd, "cohorts.json");
    writeFileSync(file, JSON.stringify(fixture()));
    await withoutGit(p.cwd, async () => {
      const result = await p.harness.runCommand({ command: "jev drift", options: { cohorts: file }, pmRoot: p.pmRoot });
      assert.equal((result.result as DriftReport).status, "stable");
      assert.equal((result.result as DriftReport).inference_calls, 0);
    });
    assert.deepEqual(await p.pm.get(item.item.id), before, "authoritative state read back through SDK");
    assert.deepEqual(trackerSnapshot(p.pmRoot), snapshot);
    installBuiltExtension(p.pmRoot);
    const installed = trackerSnapshot(p.pmRoot);
    for (const json of [true, false]) {
      const result = await runBuiltCommand(p, ["jev", "drift", "--cohorts", file, ...(json ? ["--json"] : [])]);
      assert.ok(result.stdout.length < 3000);
      assert.match(result.stdout, /stable/);
    }
    assert.deepEqual(trackerSnapshot(p.pmRoot), installed);
    const unexpected = Object.defineProperty({}, "cohorts", { get() { throw new Error("unexpected boundary failure"); } });
    assert.throws(() => runDriftCommand({ command: "jev drift", pm_root: p.pmRoot, args: [], global: {}, options: unexpected }), /unexpected boundary failure/);
    for (const bad of [undefined, "", " ", join(p.cwd, "absent"), p.cwd]) {
      const result = await p.harness.runCommand({ command: "jev drift", options: { cohorts: bad }, pmRoot: p.pmRoot });
      assert.equal((result.result as { refusal: { code: string } }).refusal.code, "input_unreadable");
    }
    for (const contents of ["{", " ".repeat(8 * 1024 * 1024 + 1), JSON.stringify({}), JSON.stringify({ ...fixture(), current: { ...fixture().current, identity: { model_digest: "c".repeat(64), question_digest: "b".repeat(64) } } })]) {
      writeFileSync(file, contents);
      const result = await p.harness.runCommand({ command: "jev drift", options: { cohorts: file }, pmRoot: p.pmRoot });
      assert.equal((result.result as { ok: boolean }).ok, false);
    }
    writeFileSync(file, "{}");
    await assert.rejects(runBuiltCommand(p, ["jev", "drift", "--cohorts", file, "--json"]), cliFailure({ ok: false, exit_code: 2 }));
  } finally { restoreFetch(); p.dispose(); }
});
