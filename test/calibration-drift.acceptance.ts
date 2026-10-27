import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { checkCalibrationDrift, DRIFT_VERSION } from "../index.ts";
import type { DriftInput, DriftObservation } from "../index.ts";
import { publicAcceptanceInput, hideGit } from "./replay-fixtures.ts";
import { trackerSnapshot } from "./fixtures.ts";

const { root, before, scratch, output, provenance } = publicAcceptanceInput("Usage: calibration-drift.acceptance.ts <public-clone> <empty-scratch> <report>");
const frozen = JSON.parse(readFileSync(new URL("../calibration/duplicate-quality-report-v3.json", import.meta.url), "utf8")) as { model_digest: string; question_sha256: string };
const restore = hideGit(scratch);
const previousFetch = globalThis.fetch;
let calls = 0;
globalThis.fetch = () => { calls++; throw new Error("Network forbidden during sentry validation"); };
/** Restore the exact provider boundary after read-only acceptance. */
const restoreFetch = () => { globalThis.fetch = previousFetch; };
try {
  const source = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: scratch, noExtensions: true }));
  // Predeclared before source inspection: body length <=512 UTF-16 units vs >512.
  // No predictions or explicit later labels are manufactured from native item fields.
  const rows: DriftObservation[] = source.items.map(item => ({ id: createHash("sha256").update(item.id).digest("hex"), task: "duplicate", type: item.type!, input_bucket: (item.description?.length ?? 0) <= 512 ? "short" : "long", predicted: "unrecorded", label: null }));
  const data: DriftInput = { version: DRIFT_VERSION, provenance: "public", thresholds: { population_tv: 0.25, error_increase: 0.2, min_population: 10, min_labels: 10 },
    calibration: { identity: { model_digest: frozen.model_digest, question_digest: frozen.question_sha256 }, observations: rows },
    current: { identity: { model_digest: frozen.model_digest, question_digest: frozen.question_sha256 }, observations: rows } };
  const unchanged = checkCalibrationDrift(data);
  assert.equal(unchanged.population.status, "stable");
  assert.equal(unchanged.labels.status, "insufficient_evidence");
  const shifted = checkCalibrationDrift({ ...data, current: { ...data.current, observations: rows.map(row => ({ ...row, input_bucket: "controlled-new-bucket" })) } });
  assert.equal(shifted.population.status, "drift");
  assert.equal(shifted.population.input_tv, 1);
  const after = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: scratch, noExtensions: true }));
  assert.deepEqual(after.items, source.items, "state read back through the SDK");
  assert.deepEqual(trackerSnapshot(root), before);
  assert.equal(calls, 0);
  const report = { version: "pm-jev-drift-public/1", ...provenance, tracker_items: rows.length, authoritative_files_verified: Object.keys(before).length, tracker_unchanged: true, git_available_during_check: false,
    input_buckets: { short: rows.filter(row => row.input_bucket === "short").length, long: rows.filter(row => row.input_bucket === "long").length },
    explicit_labels: 0, inference_calls: calls, unchanged, controlled_shift: shifted,
    limitations: "Operating-population mechanics on one public tracker, read through the SDK twice. Identity references a frozen public decision receipt; these items were not inferred and are not a newly calibrated production cohort. The shift is an injected input-bucket control, not observed live drift. No explicit later labels are available; label status remains insufficient evidence. Synthetic tests separately cover explicit-label degradation. No raw item text, ids or private configuration are published." };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ tracker_items: rows.length, files: Object.keys(before).length, buckets: report.input_buckets, unchanged: unchanged.population, shifted: shifted.population, labels: unchanged.labels, inference_calls: calls }));
} finally { restoreFetch(); restore(); }
