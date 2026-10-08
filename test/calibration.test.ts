import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endpoint } from "./fixtures.ts";
import { DATASET_VERSION, FAMILIES, generateDataset, datasetBytes, readDataset, observe, deriveThreshold, gatePoint, familyMetrics, localConfig, calibrate } from "../calibration.ts";
import type { CalibrationQuestion, Observation } from "../calibration.ts";
import { main, parseArgs } from "../scripts/calibrate.ts";

const corpus = generateDataset();
const question = corpus.questions[0];
const digest = "a".repeat(64);

/** A real HTTP fixture for installed tags and official-SDK noul responses. */
async function localEndpoint() {
  const server = await endpoint();
  let calls = 0;
  server.setReply((request, response) => {
    if (request.url === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest, capabilities: ["decision"] }] }));
    } else {
      const q = corpus.questions[calls++ % corpus.questions.length];
      response.end(JSON.stringify({ model: "tev1:4b", answers: { decision: { type: "noul", noul: q.expected ? 0.9 : 0.1 } }, usage: { input_tokens: 3, output_tokens: 1 } }));
    }
  });
  return server;
}

/** Construct independently controlled labels, probabilities and splits. */
function row(value: number, expected: boolean, split: CalibrationQuestion["split"] = "calibration"): Observation {
  return observe({ ...question, expected, split }, value);
}

test("versioned corpus regenerates byte-for-byte, balances labels and covers all families", () => {
  assert.equal(datasetBytes(corpus), readFileSync("calibration/dataset-v1.json", "utf8"));
  assert.equal(corpus.version, DATASET_VERSION);
  assert.equal(corpus.questions.length, 64);
  assert.deepEqual(readDataset(datasetBytes(corpus)), corpus);
  assert.notEqual(datasetBytes(generateDataset(1)), datasetBytes(corpus));
  assert.equal(generateDataset(0xffffffff).seed, 0xffffffff);
  for (const family of FAMILIES) {
    for (const split of ["calibration", "evaluation"]) {
      const subset = corpus.questions.filter(q => q.family === family && q.split === split);
      assert.equal(subset.length, 8);
      assert.equal(subset.filter(q => q.expected).length, 4);
      assert.equal(new Set(subset.map(q => q.id)).size, 8);
    }
  }
  assert.ok(corpus.questions.filter(q => q.family === "long_context").every(q => q.state.length > 3000));
  for (const seed of [-1, 1.5, NaN, Infinity, 0x100000000]) assert.throws(() => generateDataset(seed));
  for (const raw of [null, [], {}, { seed: "1" }, { seed: 0 }, { ...corpus, version: "wrong" }]) assert.throws(() => readDataset(JSON.stringify(raw)));
  assert.throws(() => readDataset("bad-json"));
});

test("threshold derivation chooses lowest qualifying inclusive cutoff and preserves ties", () => {
  const evidence = [
    { confidence: 0.6, correct: false },
    { confidence: 0.7, correct: true },
    { confidence: 0.7, correct: false },
    { confidence: 0.8, correct: true },
    { confidence: 0.9, correct: true },
  ];
  const fit = deriveThreshold(evidence, 1, 2);
  assert.equal(fit.threshold, 0.8);
  assert.deepEqual(fit.curve.find(p => p.threshold === 0.7), { threshold: 0.7, accepted: 4, correct: 3, coverage: 0.8, precision: 0.75 });
  assert.equal(deriveThreshold(evidence, 0.75, 2).threshold, 0.7);
  assert.equal(deriveThreshold(evidence, 1, 3).threshold, null);
  assert.equal(deriveThreshold(evidence, 0, 1).threshold, 0);
  assert.equal(deriveThreshold([{ confidence: 1, correct: false }], 1, 1).threshold, null);
  assert.deepEqual(deriveThreshold([]).curve, [
    { threshold: 0, accepted: 0, correct: 0, coverage: 0, precision: null },
    { threshold: 1, accepted: 0, correct: 0, coverage: 0, precision: null },
  ]);
  assert.equal(deriveThreshold([{ confidence: 0, correct: true }], 1, 1).threshold, 0);
  for (const value of [NaN, Infinity, -0.1, 1.1]) {
    assert.throws(() => deriveThreshold(evidence, value));
    assert.throws(() => deriveThreshold([{ confidence: value, correct: true }]));
    assert.throws(() => observe(question, value));
    assert.throws(() => observe(question, 0.5, value));
    assert.throws(() => gatePoint([], value));
    assert.throws(() => gatePoint([{ ...row(0.5, true), probability: value }], 0.5));
  }
  for (const minimum of [0, -1, 1.5, Infinity]) assert.throws(() => deriveThreshold(evidence, 0.9, minimum));
});

test("noul classification uses inclusive gate and predicted-label probability", () => {
  assert.equal(observe(question, 0.5).predicted, true);
  assert.equal(observe(question, 0.3).confidence, 0.7);
  assert.equal(observe(question, 0.6, 0.7).predicted, false);
  const metrics = gatePoint([row(0.8, true), row(0.8, false), row(0.2, true), row(0.2, false)], 0.8);
  assert.deepEqual(metrics, { threshold: 0.8, positive: 2, truePositive: 1, falsePositive: 1, falseNegative: 1, precision: 0.5, recall: 0.5, accuracy: 0.5 });
  assert.equal(gatePoint([], 0.5).accuracy, null);
  assert.equal(gatePoint([row(0.2, false)], 0.5).recall, null);
  assert.equal(gatePoint([row(0.2, false)], 0.5).precision, null);
});

test("family derivation freezes calibration cutoffs before held-out scoring", () => {
  const training = [row(0.6, false), row(0.7, true), row(0.9, true)];
  const holdout = [row(0.8, false, "evaluation"), row(0.1, false, "evaluation")];
  const metrics = familyMetrics([...training, ...holdout], 1, 2);
  assert.equal(metrics.confidence.threshold, 0.7);
  assert.equal(metrics.gateThreshold, 0.7);
  assert.equal(metrics.evaluation.precision, 0.5);
  assert.equal(metrics.evaluation.gate?.precision, 0);
  assert.equal(metrics.evaluation.coverage, 1);
  assert.equal(familyMetrics(training, 1, 2).evaluation.coverage, 0);
  assert.equal(familyMetrics(training, 1, 4).confidence.threshold, null);
  assert.equal(familyMetrics(training, 1, 4).evaluation.gate, null);
  assert.equal(familyMetrics([], 0.95, 1).evaluation.precision, null);
  const difficult = familyMetrics([...training, row(0.55, true, "evaluation")], 1, 2);
  assert.equal(difficult.evaluation.coverage, 0);
  assert.equal(difficult.evaluation.precision, null);
  assert.equal(difficult.confidence.threshold, metrics.confidence.threshold);
});

test("local configuration rejects every external or credential-bearing destination", () => {
  assert.equal(localConfig().baseUrl, "http://127.0.0.1:11434");
  for (const url of ["http://localhost:1234", "http://[::1]:1234"]) assert.equal(localConfig(url).baseUrl, url);
  for (const url of ["https://127.0.0.1", "http://192.0.2.1", "http://example.invalid", "http://user@localhost", "http://localhost:pw@localhost", "http://localhost/path", "http://localhost/?x=1", "http://localhost/#x", "invalid"]) assert.throws(() => localConfig(url, "tev1:4b"));
  for (const model of ["jev-latest", "glm:cloud", "arbitrary"]) assert.throws(() => localConfig("http://127.0.0.1", model));
  for (const model of ["tev1:0.8b", "nimble:9b"]) assert.equal(localConfig("http://127.0.0.1", model).model, model);
});

test("calibration traverses real HTTP and official SDK, records provenance and metrics", async () => {
  const server = await localEndpoint();
  try {
    const report = await calibrate(corpus, server.url, "tev1:4b");
    assert.equal(report.observations.length, 64);
    assert.equal(report.observations.filter(q => q.correct).length, 64);
    assert.equal(report.modelDigest, digest);
    assert.deepEqual(report.usage, { inputTokens: 192, outputTokens: 64 });
    assert.equal(report.pooled.confidence.threshold, 0);
    assert.equal(report.pooled.evaluation.precision, 1);
    assert.equal(server.requests.filter(r => r.path === "/v1/systemone").length, 64);
    assert.equal(server.requests.filter(r => r.path === "/api/tags").length, 2);
    assert.equal(report.datasetSha256.length, 64);
    assert.deepEqual(report.resolvedModels, ["tev1:4b"]);
    assert.equal(report.families.negations.evaluation.count, 8);
  } finally { await server.close(); }
});

test("inventory errors and cloud-backed tags fail before inference", async () => {
  const server = await endpoint();
  const tag = { name: "tev1:4b", digest, capabilities: ["decision"] };
  try {
    const invalid = [null, [], {}, { models: null }, { models: [] },
      { models: [null, 1, {}, { name: "other" }] },
      ...[{ remote_host: "https://example.invalid" }, { remote_model: "cloud" }, { digest: 1 }, { digest: "bad" }, { capabilities: "decision" }, { capabilities: [] }].map(patch => ({ models: [{ ...tag, ...patch }] })),
      ...["digest", "capabilities"].map(key => ({ models: [Object.fromEntries(Object.entries(tag).filter(([k]) => k !== key))] })),
    ];
    for (const inventory of invalid) {
      server.setReply((_request, response) => response.end(JSON.stringify(inventory)));
      await assert.rejects(calibrate(corpus, server.url, "tev1:4b"));
    }
    server.setReply((_request, response) => { response.statusCode = 400; response.end("private synthetic error"); });
    await assert.rejects(calibrate(corpus, server.url, "tev1:4b"), /inventory failed/);
    assert.ok(server.requests.every(r => r.path === "/api/tags"));
  } finally { await server.close(); }
});

test("a changed model digest or malformed decision prevents a report", async () => {
  const server = await endpoint();
  let tags = 0;
  try {
    server.setReply((request, response) => {
      if (request.url === "/api/tags") response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: tags++ ? "b".repeat(64) : digest, capabilities: ["decision"] }] }));
      else response.end(JSON.stringify({ model: "tev1:4b", answers: { decision: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    await assert.rejects(calibrate(corpus, server.url, "tev1:4b"), /changed during calibration/);
    server.setReply((request, response) => {
      if (request.url === "/api/tags") response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest, capabilities: ["decision"] }] }));
      else response.end(JSON.stringify({ model: "tev1:4b", answers: { decision: { type: "noul", noul: 2 } }, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
    await assert.rejects(calibrate(corpus, server.url, "tev1:4b"), /malformed/);
  } finally { await server.close(); }
});

test("opt-in script parses defaults and executes generator and harness over real HTTP", async () => {
  assert.deepEqual(parseArgs(["generate"]), { mode: "generate", seed: 20261008, output: "calibration/dataset-v1.json" });
  assert.deepEqual(parseArgs(["generate", "42", "output.json"]), { mode: "generate", seed: 42, output: "output.json" });
  assert.deepEqual(parseArgs(["run"]), { mode: "run", model: "tev1:4b", baseUrl: "http://127.0.0.1:11434", output: "calibration/report-v1.json", target: 0.95 });
  assert.deepEqual(parseArgs(["run", "nimble:9b", "http://localhost:1234", "out.json", "0.9"]), { mode: "run", model: "nimble:9b", baseUrl: "http://localhost:1234", output: "out.json", target: 0.9 });
  for (const args of [[], ["wrong"], ["generate", "1", "out", "extra"], ["run", "1", "2", "3", "4", "5"]]) assert.throws(() => parseArgs(args));
  const cwd = process.cwd();
  const scratch = mkdtempSync(join(tmpdir(), "jev-calibration-"));
  const server = await localEndpoint();
  try {
    process.chdir(scratch);
    mkdirSync("calibration");
    await main(["generate"]);
    assert.equal(readFileSync("calibration/dataset-v1.json", "utf8"), datasetBytes(corpus));
    await main(["run", "tev1:4b", server.url, "calibration/report.json", "0.95"]);
    const report = JSON.parse(readFileSync("calibration/report.json", "utf8"));
    assert.equal(report.observations.length, 64);
    writeFileSync("calibration/dataset-v1.json", "{}");
    await assert.rejects(main(["run", "tev1:4b", server.url, "unwritten.json"]));
  } finally { process.chdir(cwd); await server.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("committed local receipt replays against the generated corpus and frozen curves", () => {
  const report = JSON.parse(readFileSync("calibration/report-v1.json", "utf8")) as Awaited<ReturnType<typeof calibrate>>;
  assert.equal(report.datasetVersion, DATASET_VERSION);
  assert.equal(report.seed, corpus.seed);
  assert.equal(report.datasetSha256, createHash("sha256").update(datasetBytes(corpus)).digest("hex"));
  assert.equal(report.model, "tev1:4b");
  assert.match(report.modelDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.observations.length, corpus.questions.length);
  const replay = corpus.questions.map((q, i) => observe(q, report.observations[i].probability));
  assert.deepEqual(report.observations, replay);
  assert.deepEqual(report.pooled, familyMetrics(replay, report.targetPrecision, report.minAccepted));
  for (const family of FAMILIES) assert.deepEqual(report.families[family], familyMetrics(replay.filter(q => q.family === family), report.targetPrecision, report.minAccepted));
});
