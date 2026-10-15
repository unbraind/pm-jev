import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChoiceResponse, Questions } from "@typesafe-ai/sdk";
import { calibrateTypes, fitTypeMargin, typeDataset, typeMetrics } from "../type-calibration.ts";
import type { TypeObservation } from "../type-calibration.ts";
import { KEEP_CURRENT_TYPE, TRIAGE_CATALOG_VERSION, TYPE_MARGIN_THRESHOLD } from "../index.ts";
import { main, parseArgs } from "../scripts/calibrate.ts";
import { answers, endpoint } from "./fixtures.ts";

const dataset = typeDataset();
const digest = "a".repeat(64);

/** One exact labelled distribution for policy and metric assertions. */
function observation(expected: string, selected: string, current = expected): TypeObservation {
  const answer: ChoiceResponse = { type: "choice", choice: selected, confidence: 1,
    probabilities: { [selected]: 1, other: 0 } };
  return { id: "synthetic", text: "Synthetic record", split: "calibration", current, expected, before: answer, after: answer };
}

/** Real transport chooses semantic labels from the fixed synthetic dataset. */
async function typeEndpoint(mode: "ok" | "drift" | "wrong" = "ok") {
  const server = await endpoint();
  let inventory = 0;
  server.setReply((request, response, body) => {
    if (request.url === "/api/tags") {
      response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: mode === "drift" && inventory++ > 0 ? "b".repeat(64) : digest, capabilities: ["decision"] }] }));
      return;
    }
    const input = body as { state: string; questions: Questions };
    const sample = dataset.samples.find(entry => JSON.stringify(input.state).includes(entry.text));
    assert.ok(sample);
    const result = answers(input.questions);
    const labels = Object.keys((input.questions.type as { criteria: object }).criteria);
    const after = labels.includes(KEEP_CURRENT_TYPE);
    const selected = mode === "wrong" && after ? sample.expected === "Feature" ? "Issue" : "Feature"
      : after && sample.current === sample.expected ? KEEP_CURRENT_TYPE : sample.expected;
    result.answers.type = { type: "choice", choice: selected, confidence: 1, probabilities: Object.fromEntries(labels.map(label => [label, label === selected ? 1 : 0])) };
    response.end(JSON.stringify(result));
  });
  return server;
}

test("type family balances eight labels, two registered custom types and near-miss cases", () => {
  assert.deepEqual(JSON.parse(readFileSync("calibration/type-dataset-v1.json", "utf8")), dataset);
  assert.equal(dataset.samples.length, 48);
  assert.equal(dataset.customTypes.length, 2);
  for (const type of new Set(dataset.samples.map(row => row.expected))) {
    const rows = dataset.samples.filter(row => row.expected === type);
    assert.equal(rows.length, 6);
    assert.equal(rows.filter(row => row.split === "calibration").length, 3);
    assert.equal(rows.filter(row => row.current !== row.expected).length, 2);
  }
  assert.equal(new Set(dataset.samples.map(row => row.id)).size, 48);
  assert.ok(dataset.samples.some(row => row.expected === "Issue" && row.text.startsWith("Decide")));
});

test("per-type precision counts predicted labels and abstention counts labelled examples", () => {
  const rows = [observation("Issue", "Issue"), observation("Feature", "Issue"), observation("Run", KEEP_CURRENT_TYPE)];
  assert.equal(typeMetrics(rows, "before", null).precision, 1 / 3);
  assert.equal(typeMetrics(rows, "after", 0).precision, 2 / 3);
  assert.equal(typeMetrics(rows, "after", null).precision, 2 / 3);
  assert.equal(typeMetrics([], "after", null).precision, null);
  assert.equal(typeMetrics(rows, "after", 0).perType.Issue.precision, 0.5);
  assert.equal(typeMetrics(rows, "after", 0).perType.Feature.precision, null);
  assert.equal(typeMetrics([], "after", 0).precision, null);
  assert.equal(typeMetrics([], "before", null).abstentionRate, 0);
  const tied = { ...observation("Issue", "Issue"), after: { type: "choice", choice: "Issue", confidence: 1, probabilities: { Issue: 0.5, Feature: 0.5 } } as ChoiceResponse };
  assert.equal(typeMetrics([tied], "after", 0.1).abstentionRate, 1);
  assert.equal(typeMetrics([tied], "after", 0.1).perType.Issue.abstentionRate, 1);
  assert.equal(fitTypeMargin([tied]).threshold, null);
});

test("type calibration compares old/new over real trackers, freezes fitting, checks digest and uses the opt-in script", async () => {
  const server = await typeEndpoint();
  const scratch = mkdtempSync(join(tmpdir(), "jev-type-report-test-"));
  try {
    const report = await calibrateTypes(server.url, "tev1:4b");
    assert.equal(report.observations.length, 48);
    assert.equal(report.registeredTypes.length, 13);
    assert.equal(report.before.precision, 1);
    assert.equal(report.after.precision, 1);
    assert.equal(report.fit.threshold, 1);
    assert.equal(report.modelDigest, digest);
    assert.deepEqual(report.resolvedModels, ["tev1:4b"]);
    assert.deepEqual(report.usage, { inputTokens: 4800, outputTokens: 384 });
    assert.equal(server.requests.filter(row => row.path === "/v1/systemone").length, 96);
    assert.equal(parseArgs(["types"]).mode, "types");
    assert.equal(parseArgs(["types"]).output, "calibration/type-report-v1.json");
    await main(["types", "tev1:4b", server.url, join(scratch, "report.json")]);
    assert.equal(JSON.parse(readFileSync(join(scratch, "report.json"), "utf8")).family, "type_classification");
    assert.equal(report.fit.threshold, fitTypeMargin(report.observations.map(row => row.split === "evaluation" ? { ...row, expected: "wrong" } : row)).threshold);
  } finally { await server.close(); rmSync(scratch, { recursive: true, force: true }); }
});

test("type calibration rejects a changed model or insufficient empirical precision without a report", async () => {
  for (const mode of ["drift", "wrong"] as const) {
    const server = await typeEndpoint(mode);
    try { await assert.rejects(calibrateTypes(server.url, "tev1:4b"), mode === "drift" ? /changed/ : /No type margin/); }
    finally { await server.close(); }
  }
});


test("an invalid target precision is refused before any model call", async () => {
  // Port 9 (discard) is never served here: reaching the model would fail with a connection error instead.
  for (const target of [1.5, -0.1, Number.NaN]) {
    await assert.rejects(calibrateTypes("http://127.0.0.1:9", "tev1:4b", target), /Probability must be in \[0,1\]/);
  }
});

test("committed real type report replays its frozen threshold and per-type metrics", () => {
  const report = JSON.parse(readFileSync("calibration/type-report-v1.json", "utf8")) as Awaited<ReturnType<typeof calibrateTypes>>;
  assert.deepEqual(report.dataset, dataset);
  assert.equal(report.datasetSha256, createHash("sha256").update(JSON.stringify(dataset)).digest("hex"));
  assert.equal(report.model, "tev1:4b");
  assert.match(report.modelDigest, /^[a-f0-9]{64}$/);
  assert.equal(report.catalogVersion, TRIAGE_CATALOG_VERSION);
  assert.deepEqual(report.fit, fitTypeMargin(report.observations));
  assert.equal(report.fit.threshold, TYPE_MARGIN_THRESHOLD);
  assert.ok(TYPE_MARGIN_THRESHOLD > 0);
  const heldout = report.observations.filter(row => row.split === "evaluation");
  assert.deepEqual(report.before, typeMetrics(heldout, "before", null));
  assert.deepEqual(report.newPrompt, typeMetrics(heldout, "after", null));
  assert.deepEqual(report.after, typeMetrics(heldout, "after", report.fit.threshold));
});
