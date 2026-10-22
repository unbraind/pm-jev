import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { COST_POLICY_VERSION, selectAbstentionPolicy } from "../index.ts";
import type { CostDataset, CostObservation } from "../index.ts";
import { evidenceHash } from "../decision-calibration.ts";
import { historicalDuplicate, repositoryDuplicatePairs } from "../dedupe-evaluation.ts";
import type { DuplicateCorpus } from "../dedupe-evaluation.ts";
import type { PairItem } from "../dedupe.ts";
import { trackerSnapshot } from "./fixtures.ts";

/** Public receipt identity used to bind frozen observations to verified source snapshots. */
interface FrozenReceipt {
  model: string; model_digest: string; question_sha256: string;
  data: { repository: string; commit: string; archive_sha256: string; data_sha256: string }[];
  samples: { repository: string; pair_id: string; split: "train" | "heldout"; label: boolean; retrieved: boolean }[];
  observations: { pair_id: string; label: boolean; retrieved: boolean; probability: number }[];
}
const [fleet, scratch, output] = process.argv.slice(2);
if (!fleet || !scratch || !output) throw new Error("Usage: cost-policy.acceptance.ts <fleet> <empty-scratch> <report>");
await mkdir(scratch, { recursive: true });
assert.equal((await readdir(scratch)).length, 0);
const frozen = JSON.parse(await readFile(new URL("../calibration/duplicate-quality-report-v3.json", import.meta.url), "utf8")) as FrozenReceipt;
const sourceChecks = [];
const corpora: DuplicateCorpus[] = [];
const snapshots = new Map<string, Record<string, string>>();
for (const repository of ["unbraind/pm-beads", "unbraind/pm-linear", "unbraind/pm-changelog"]) {
  const name = repository.split("/")[1], source = join(fleet, name);
  const identity = frozen.data.find(row => row.repository === repository)!;
  const visibility = JSON.parse(execFileSync("gh", ["repo", "view", repository, "--json", "visibility"], { encoding: "utf8" })) as { visibility: string };
  assert.equal(visibility.visibility, "PUBLIC");
  assert.equal(execFileSync("gh", ["api", `repos/${repository}/commits/${identity.commit}`, "--jq", ".sha"], { encoding: "utf8" }).trim(), identity.commit);
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: source, encoding: "utf8" }).trim();
  assert.ok([`https://github.com/${repository}.git`, `https://github.com/${repository}`, `git@github.com:${repository}.git`].includes(origin));
  const tree = execFileSync("git", ["ls-tree", "-r", identity.commit, "--", ".agents/pm"], { cwd: source, encoding: "utf8" });
  assert.ok(tree.length > 0 && !/^(120000|160000) /m.test(tree));
  const archive = execFileSync("git", ["archive", "--format=tar", identity.commit, ".agents/pm"], { cwd: source, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(evidenceHash(archive.toString("base64")), identity.archive_sha256);
  const copy = join(scratch, name), root = join(copy, ".agents/pm");
  await mkdir(copy);
  execFileSync("tar", ["-xf", "-", "-C", copy], { input: archive });
  const before = trackerSnapshot(root);
  snapshots.set(root, before);
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  process.env.GIT_CEILING_DIRECTORIES = scratch;
  let items: PairItem[];
  try {
    const result = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: copy, noExtensions: true }));
    items = result.items;
  } finally { process.env.PATH = previousPath; }
  assert.deepEqual(trackerSnapshot(root), before);
  for (const file of (await readdir(join(root, "history"))).filter(file => file.endsWith(".jsonl")).sort()) {
    const events = (await readFile(join(root, "history", file), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Parameters<typeof historicalDuplicate>[0][number]);
    const old = historicalDuplicate(events);
    if (old && !items.some(item => item.id === old.id)) items.push(old);
  }
  assert.equal(evidenceHash(items), identity.data_sha256);
  corpora.push({ repository, commit: identity.commit, items });
  sourceChecks.push({ repository, commit: identity.commit, items: items.length, archive_sha256: identity.archive_sha256, tracker_unchanged: true });
}
const rebuilt = repositoryDuplicatePairs(corpora);
const matching = frozen.samples.filter(row => corpora.some(corpus => corpus.repository === row.repository));
// The original fleet-wide sample cap excludes some labels present in these copies.
assert.ok(rebuilt.length >= matching.length);
for (const sample of matching) {
  const actual = rebuilt.find(row => row.pair_id === sample.pair_id)!;
  assert.equal(actual.label, sample.label); assert.equal(actual.retrieved, sample.retrieved);
}
const data: CostDataset = { version: COST_POLICY_VERSION, provenance: "public", observations: frozen.samples.map((sample, index): CostObservation => {
  const scored = frozen.observations[index];
  assert.equal(scored.pair_id, sample.pair_id); assert.equal(scored.label, sample.label); assert.equal(scored.retrieved, sample.retrieved);
  return { id: sample.pair_id, group: sample.repository, split: sample.split === "train" ? "selection" : "heldout", task: "duplicate", label: sample.label, confidence: scored.probability, eligible: scored.retrieved };
}) };
const inputFile = join(scratch, "scores.json");
await writeFile(inputFile, JSON.stringify(data));
const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "hooks"] });
const results = [];
for (const falseDuplicate of [1, 20, 100]) {
  const report = selectAbstentionPolicy(data, { false_duplicate: falseDuplicate, wrong_type: 10, missed_candidate: 1 });
  assert.deepEqual(selectAbstentionPolicy({ ...data, observations: [...data.observations].reverse() }, report.costs), report);
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const full = await harness.runCommand({ command: "jev policy", pmRoot: join(scratch, "pm-beads/.agents/pm"), options: { observations: inputFile, falseDuplicateCost: String(falseDuplicate), wrongTypeCost: "10", missedCandidateCost: "1", full: true }, global: { json: true } });
    assert.deepEqual(full.result, report);
  } finally { process.env.PATH = previousPath; }
  results.push(report);
}
for (const [root, before] of snapshots) assert.deepEqual(trackerSnapshot(root), before);
const evidence = { version: COST_POLICY_VERSION, source_receipt: "calibration/duplicate-quality-report-v3.json", model: frozen.model, model_digest: frozen.model_digest, question_sha256: frozen.question_sha256, source_checks: sourceChecks,
  copied_pair_labels_verified: matching.length, observations: data.observations.length, model_calls: 0,
  limitations: "Replay of frozen public scores from PR #37; 150 selection and 6 held-out pairs. Only three public source snapshots are re-read here. Controls are unrecorded relationships, not adjudicated negatives; correlated pairs and two held-out positives cannot establish production precision. Type costs have synthetic coverage only. Existing mutation gates remain mandatory.", results };
await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ source_checks: sourceChecks, verified_pairs: matching.length, results: results.map(report => ({ costs: report.costs, threshold: report.policy.threshold, selection: report.selected.selection, heldout: report.selected.heldout })) }, null, 2));
