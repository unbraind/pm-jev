import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { getSettingsPath } from "@unbrained/pm-cli/sdk";
import { activeCalibration, atThreshold, calibrationKey, calibrateObservations, calibratedAnswer, EVALUATION_VERSION, evidenceHash, fitTemperature, modelDigest, precisionLower, questionFingerprint, ranked, readCalibration, reliability, repositorySplit, scaledRows, scaleProbabilities, validExemplarSetting } from "../decision-calibration.ts";
import type { Observation } from "../decision-calibration.ts";
import { scenario } from "./fixtures.ts";

/** Construct independent categorical observations with reproducible public provenance. */
export function observations(count = 40, repository = "public/alpha", correct = true): Observation[] {
  return Array.from({ length: count }, (_, index) => ({ repository, commit: "a".repeat(40), data_sha256: "b".repeat(64), example_sha256: evidenceHash([repository, index]), question_sha256: evidenceHash({ type: "choice" }), channel: "type", label: correct ? "Issue" : "Task", probabilities: { Issue: 0.65, Task: 0.35 }, latency_ms: 10, input_tokens: 20, output_tokens: 2 }));
}

test("reliability uses probability winners, all ten bins, absent classes, inclusive thresholds and finite zero-mass NLL", () => {
  const rows = observations(2);
  rows[1].label = "Task";
  rows[1].probabilities = { Issue: 1, Task: 0, Chore: 0 };
  const result = reliability(rows);
  assert.equal(result.accuracy, 0.5);
  assert.equal(result.bins.length, 10);
  assert.equal(result.bins[9].count, 1);
  assert.equal(result.bins[6].confidence, 0.65);
  assert.ok(Math.abs(result.ece! - 0.675) < 1e-12);
  assert.ok(Number.isFinite(result.nll));
  assert.deepEqual(result.classes.find(c => c.label === "Chore"), { label: "Chore", support: 0, precision: null, recall: null });
  assert.equal(atThreshold(rows, 0.65).count, 2);
  assert.equal(atThreshold(rows, 0.8).precision, 0);
  assert.equal(precisionLower(0, 0), 0);
  assert.ok(precisionLower(40, 40) > 0.9);
  assert.equal(reliability([]).accuracy, null);
  assert.equal(reliability([]).ece, null);
  assert.equal(reliability([]).nll, null);
  assert.equal(atThreshold([], 0.8).coverage, 0);
  assert.equal(atThreshold([], 0.8).precision, null);
  assert.deepEqual(ranked({ a: 0.5, b: 0.5 }).map(([label]) => label), ["a", "b"]);
});

test("temperature minimizes calibration loss without reading validation labels and never flips a winner", () => {
  const good = observations();
  const temperature = fitTemperature(good);
  assert.ok(temperature < 1);
  assert.ok(scaleProbabilities({ yes: 0.9, no: 0.1, absent: 0 }, temperature).yes > 0.9);
  assert.equal(scaleProbabilities({ yes: 0.9, no: 0.1, absent: 0 }, temperature).absent, 0);
  assert.ok(fitTemperature(observations(40, "public/alpha", false)) > 1);
  const names = ["public/alpha", "public/beta"];
  const split = repositorySplit(names, "frozen");
  assert.deepEqual(repositorySplit(names.reverse(), "frozen"), split);
  const calibration = observations(40, split.calibration[0]).map((row, index) => ({ ...row, probabilities: { Issue: index < 32 ? 0.95 : 0.55, Task: index < 32 ? 0.05 : 0.45 } }));
  const validation = observations(40, split.validation[0]);
  const receipt = calibrateObservations("triage", "local", "c".repeat(64), [...calibration, ...validation], "frozen", 0.9);
  assert.ok(receipt.channels.type.threshold !== null);
  assert.equal(receipt.channels.type.reason, "qualified_on_held_out_repositories");
  assert.equal(atThreshold(scaledRows(calibration, receipt.channels.type.temperature), receipt.channels.type.threshold!).count, 40);
  const badValidation = validation.map(row => ({ ...row, label: "Task" }));
  const refused = calibrateObservations("triage", "local", "c".repeat(64), [...calibration, ...badValidation], "frozen", 0.9);
  assert.equal(refused.channels.type.temperature, receipt.channels.type.temperature);
  assert.equal(refused.channels.type.threshold, null);
  assert.equal(refused.channels.type.reason, "held_out_precision_not_met");
  const sparse = calibrateObservations("triage", "local", "c".repeat(64), [...calibration.slice(0, 2), ...validation], "frozen", 0.9);
  assert.equal(sparse.channels.type.reason, "insufficient_calibration_precision_evidence");
  assert.equal(sparse.channels.type.threshold, null);
  assert.equal(scaledRows(calibration, temperature)[0].label, calibration[0].label);
  assert.deepEqual(receipt.calibration_repositories, split.calibration);
  assert.deepEqual(receipt.validation_repositories, split.validation);
  assert.equal(receipt.data.length, 2);
});

test("absent ground-truth labels have finite clamped loss and do not disable temperature fitting", () => {
  const good = observations(1);
  const missing = { ...good[0], label: "Unrepresented" };
  const zero = { ...missing, probabilities: { ...missing.probabilities, Unrepresented: 0 } };
  assert.equal(reliability([missing]).nll, -Math.log(1e-15));
  assert.equal(reliability([missing]).nll, reliability([zero]).nll);
  const temperature = fitTemperature([...good, missing]);
  assert.ok(temperature < 1);
  assert.equal(temperature, fitTemperature([...good, zero]));
  assert.ok(Number.isFinite(reliability(scaledRows([...good, missing], temperature)).nll));
});

test("channel application requires compatible semantics and refuses unqualified thresholds", () => {
  const q = { type: "choice" };
  const record = calibrateObservations("link", "local", "c".repeat(64), [...observations(40, "public/a"), ...observations(40, "public/b")], "0", 0.9);
  const fit = record.channels.type;
  fit.question_sha256 = [questionFingerprint("type", q)];
  const active = { record, receipt_sha256: evidenceHash(record) };
  assert.equal(calibratedAnswer(undefined, "type", q, { Issue: 0.65, Task: 0.35 }, 0.8).calibration, null);
  assert.equal(calibratedAnswer(active, "missing", q, { Issue: 0.65, Task: 0.35 }, 0.8).threshold, 0.8);
  assert.equal(calibratedAnswer(active, "type", {}, { Issue: 0.65, Task: 0.35 }, 0.8).calibration, null);
  assert.ok(calibratedAnswer(active, "type", q, { Issue: 0.65, Task: 0.35 }, 0.8).probabilities.Issue > 0.65);
  assert.equal(calibratedAnswer(active, "type", q, { Issue: 0.65, Task: 0.35 }, 0.8, 1).threshold, 1);
  fit.threshold = null;
  assert.equal(calibratedAnswer(active, "type", q, { Issue: 0.65, Task: 0.35 }, 0.8).threshold, Infinity);
  assert.equal(calibratedAnswer(active, "type", q, { Issue: 0.65, Task: 0.35 }, 0.8).calibration?.qualified, false);
  record.channels.candidate_0 = fit;
  fit.question_sha256 = [questionFingerprint("candidate_7", { instructions: "candidate_7" })];
  assert.ok(calibratedAnswer(active, "candidate_1", { instructions: "candidate_1" }, { yes: 0.65, no: 0.35 }, 0.8).calibration);
  assert.equal(questionFingerprint("duplicate_of", { type: "choice", instructions: "same", criteria: { id1: "A", none: "None" } }), questionFingerprint("duplicate_of", { type: "choice", instructions: "same", criteria: { id2: "B", none: "None" } }));
});

test("persisted exemplar settings validate every identity component before activation", () => {
  const setting = { retrieval: "lexical", count: 4, token_budget: 1200 } as const;
  assert.equal(validExemplarSetting(setting), true);
  assert.equal(validExemplarSetting({ retrieval: "embedding", count: 4, token_budget: 1200, embedding_model: "qwen3-embedding:0.6b" }), true);
  for (const invalid of [null, 7, "setting", { retrieval: "vector", count: 4, token_budget: 1200 },
    { retrieval: "embedding", count: 4, token_budget: 1200 }, { retrieval: "embedding", count: 4, token_budget: 1200, embedding_model: "" },
    { retrieval: "embedding", count: 4, token_budget: 1200, embedding_model: 7 },
    { retrieval: "lexical", count: 1.5, token_budget: 1200 }, { retrieval: "lexical", count: 0, token_budget: 1200 }, { retrieval: "lexical", count: 9, token_budget: 1200 },
    { retrieval: "lexical", count: 4, token_budget: 1.5 }, { retrieval: "lexical", count: 4, token_budget: 0 }, { retrieval: "lexical", count: 4, token_budget: 65537 },
    { retrieval: "lexical", count: 4, token_budget: 1200, embedding_model: "unexpected" }]) assert.equal(validExemplarSetting(invalid), false);
  assert.equal(calibrationKey("link", "local"), evidenceHash(["link", "local"]));
  assert.notEqual(calibrationKey("link", "local", setting), evidenceHash(["link", "local"]));
  assert.notEqual(calibrationKey("link", "local", setting), calibrationKey("link", "local", { ...setting, count: 2 }));
  assert.notEqual(calibrationKey("link", "local", setting), calibrationKey("link", "local", { ...setting, retrieval: "embedding", embedding_model: "qwen3-embedding:0.6b" }));
});

test("saved model identity is exact and digest discovery refuses missing, malformed or changed models", async () => {
  await scenario(async (fixture, server) => {
    assert.equal(await readCalibration(fixture.pmRoot, "triage", "local"), undefined);
    assert.equal(await readCalibration(join(fixture.cwd, "missing-settings"), "triage", "local"), undefined);
    const record = calibrateObservations("triage", "local", "c".repeat(64), observations(), "0", 0.9);
    const key = evidenceHash(["triage", "local"]);
    const save = () => writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify({ jev: { calibrations: { [key]: record } } }));
    save();
    const config = { provider: "ollama", model: "local", baseUrl: server.url, timeoutMs: 30_000 };
    let digest = "c".repeat(64);
    server.setReply((_, response) => response.end(JSON.stringify({ models: [{ name: "local", digest }] })));
    assert.equal((await activeCalibration(fixture.pmRoot, "triage", config))?.record.version, EVALUATION_VERSION);
    assert.equal(await activeCalibration(fixture.pmRoot, "triage", { ...config, provider: "typesafe" }), undefined);
    digest = "d".repeat(64);
    assert.equal(await activeCalibration(fixture.pmRoot, "triage", config), undefined);
    digest = "invalid";
    await assert.rejects(modelDigest(server.url, "local", 30_000), /digest missing/);
    await assert.rejects(modelDigest(server.url, "absent", 30_000), /digest missing/);
    server.setReply((_, response) => { response.statusCode = 503; response.end("{}"); });
    await assert.rejects(modelDigest(server.url, "local", 30_000), /Cannot verify/);
    for (const raw of ["broken JSON", "null", "7", '{"jev":null}', '{"jev":7}']) {
      writeFileSync(getSettingsPath(fixture.pmRoot), raw);
      assert.equal(await readCalibration(fixture.pmRoot, "triage", "local"), undefined);
    }
    save();
    const original = record.channels;
    Object.assign(record, { channels: null }); save();
    await assert.rejects(readCalibration(fixture.pmRoot, "triage", "local"), /Saved calibration/);
    Object.assign(record, { channels: original });
    const fit = record.channels.type;
    Object.assign(record.channels, { type: null }); save();
    await assert.rejects(readCalibration(fixture.pmRoot, "triage", "local"), /Saved calibration/);
    Object.assign(record.channels, { type: fit });
    for (const invalid of [{ temperature: null }, { temperature: 0 }, { temperature: 21 }, { threshold: -1 }, { threshold: 2 }, { question_sha256: null }, { question_sha256: ["bad"] }]) {
      const previous = { ...fit };
      Object.assign(fit, invalid); save();
      await assert.rejects(readCalibration(fixture.pmRoot, "triage", "local"), /Saved calibration/);
      Object.assign(fit, previous);
    }
    Object.assign(record, { model_digest: "invalid" }); save();
    await assert.rejects(readCalibration(fixture.pmRoot, "triage", "local"), /Saved calibration/);
    Object.assign(record, { model_digest: "c".repeat(64) });
    Object.assign(record, { version: "obsolete" }); save();
    assert.equal(await readCalibration(fixture.pmRoot, "triage", "local"), undefined);
    Object.assign(record, { version: EVALUATION_VERSION, task: "link" }); save();
    assert.equal(await readCalibration(fixture.pmRoot, "triage", "local"), undefined);
    Object.assign(record, { task: "triage", model: "different" }); save();
    assert.equal(await readCalibration(fixture.pmRoot, "triage", "local"), undefined);
  });
});
