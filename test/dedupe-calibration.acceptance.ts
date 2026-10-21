/**
 * Opt-in, one-shot real-model benchmark: node test/dedupe-calibration.acceptance.ts <fleet> <scratch> <report>.
 * Failed runs require a new empty scratch directory; checkpoints are evidence only, not resumable state.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import type { NoulResponse } from "@typesafe-ai/sdk";
import { labelledPairs, labelledRelatedPairs, fitPairThreshold, pairMetrics } from "../dedupe-evaluation.ts";
import type { DuplicateCorpus, PairObservation, LabelledPair } from "../dedupe-evaluation.ts";
import { PAIR_QUESTIONS, pairState } from "../dedupe.ts";
import { createJevClient, resolveJevEndpoint, runDecision } from "../index.ts";
import { evidenceHash, modelDigest } from "../decision-calibration.ts";

type Corpus = DuplicateCorpus & { archive_sha256: string };
type Observation = PairObservation & { pair_id: string; latency_ms: number };
const [fleet, scratch, output] = process.argv.slice(2);
if (!fleet || !scratch || !output) throw new Error("Usage: node test/dedupe-calibration.acceptance.ts <fleet> <scratch> <report>");
await mkdir(scratch, { recursive: true });
if ((await readdir(scratch)).length > 0) throw new Error("Benchmark is one-shot; failed runs require a new empty scratch directory. Non-empty scratch directory refused.");
/** Inspect only a named public clone; no tracker mutation or shell interpretation. */
function inspect(command: string, args: string[], cwd: string, input?: Buffer): Buffer {
  return execFileSync(command, args, { cwd, input, timeout: 60_000, maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}
/** Reject archives that could materialize links rather than tracker documents. */
function requireRegularTree(tree: string): void {
  const entries = tree.trim().split("\n");
  if (tree.length === 0 || entries.some(entry => /^(120000|160000) /.test(entry))) throw new Error("Tracker must contain regular committed files");
}
const corpora: Corpus[] = [];
const skipped: string[] = [];
const started = performance.now();
for (const name of (await readdir(fleet)).filter(name => /^pm-[a-z0-9-]+$/.test(name) && name !== "pm-cli-companion").sort()) {
  const repo = join(fleet, name), repository = `unbraind/${name}`;
  const origin = inspect("git", ["remote", "get-url", "origin"], repo).toString().trim();
  if (![`${repository}.git`, repository].some(suffix => origin === `https://github.com/${suffix}`) && origin !== `git@github.com:${repository}.git`) throw new Error("Unexpected source origin");
  const visibility = JSON.parse(inspect("gh", ["repo", "view", repository, "--json", "visibility"], repo).toString()) as { visibility: string };
  if (visibility.visibility !== "PUBLIC") { skipped.push("nonpublic source omitted"); continue; }
  const commit = inspect("git", ["rev-parse", "HEAD"], repo).toString().trim();
  const publicCommit = inspect("gh", ["api", `repos/${repository}/commits/${commit}`, "--jq", ".sha"], repo).toString().trim();
  if (publicCommit !== commit) throw new Error("Source commit is not publicly resolvable");
  const archive = inspect("git", ["archive", "--format=tar", commit, ".agents/pm"], repo);
  const tree = inspect("git", ["ls-tree", "-r", commit, "--", ".agents/pm"], repo).toString();
  requireRegularTree(tree);
  const dest = join(scratch, name);
  await mkdir(dest);
  inspect("tar", ["-xf", "-", "-C", dest], repo, archive);
  const result = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: join(dest, ".agents/pm"), cwd: dest, noExtensions: true }));
  corpora.push({ repository, commit, items: result.items, archive_sha256: evidenceHash(archive.toString("base64")) });
  console.log("snapshot", repository, result.items.length);
}
// Text stays in scratch; the public receipt contains only hashes, ids and probabilities.
await writeFile(join(scratch, "corpora.json"), JSON.stringify(corpora));
const duplicates = labelledPairs(corpora, 30), related = labelledRelatedPairs(corpora, 15);
if (duplicates.length + related.length > 200) throw new Error("Benchmark exceeds 200 calls; reduce label sample limits before inference");
/** Serialize stable identity at inference time; never backfill it by array position. */
function sample(row: LabelledPair, set: string) {
  return { set, pair_id: row.pair_id, repository: row.repository, a: row.pair.a.id, b: row.pair.b.id, label: row.label, retrieved: row.retrieved, split: row.split, lexical: row.pair.score, example_sha256: evidenceHash(pairState(row.pair)) };
}
/** Keep the preassigned dev or held-out population. */
function partition(rows: Observation[], labels: LabelledPair[], split: string): Observation[] { return rows.filter((_, i) => labels[i].split === split); }
const lexical = duplicates.map(row => ({ pair_id: row.pair_id, label: row.label, probability: row.pair.score, related_probability: 0, retrieved: row.retrieved, latency_ms: 0 }));
const lexicalThreshold = fitPairThreshold(partition(lexical, duplicates, "dev"), "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, true);
const report = {
  version: "pm-jev-duplicate-labels/2", wall_scope: "snapshot collection, label generation and inference in this invocation", recorded_at: new Date().toISOString(),
  source_method: "PUBLIC visibility, origin and public commit reachability verified; committed git archives extracted to scratch; certified complete SDK reads without extensions",
  ci_method: "Two-sided Wilson precision/recall intervals; approximate F1 envelope from Bonferroni 97.5% Wilson bounds. Shared-item correlations prevent independent-population guarantees.",
  seeds: { duplicate: "dedupe-20261019", related: "dedupe-related" },
  question_sha256: evidenceHash(PAIR_QUESTIONS), request_timeout_ms: 360_000, total_deadline_ms_per_pair: 600_000, automatic_retries: 0,
  data: corpora.map(corpus => ({ repository: corpus.repository, commit: corpus.commit, items: corpus.items.length, archive_sha256: corpus.archive_sha256, data_sha256: evidenceHash(corpus.items) })),
  skipped, samples: [...duplicates.map(row => sample(row, "duplicate")), ...related.map(row => sample(row, "related"))],
  arms: [{ arm: "lexical", threshold: lexicalThreshold, dev: pairMetrics(partition(lexical, duplicates, "dev"), "duplicate", { threshold: lexicalThreshold, relatedThreshold: 0.8 }, true), heldout: pairMetrics(partition(lexical, duplicates, "heldout"), "duplicate", { threshold: lexicalThreshold, relatedThreshold: 0.8 }, true) }] as object[], wall_ms: 0,
};
console.log("labels", duplicates.length, related.length);
for (const model of ["tev1:4b"]) {
  const endpoint = await resolveJevEndpoint(join(scratch, "unused-settings"), { PM_JEV_MODEL: model });
  const resolved = { ...endpoint, config: { ...endpoint.config, timeoutMs: 360_000, totalDeadlineMs: 600_000, keepAlive: "30m" } };
  console.log("inference-start", model);
  const digest = await modelDigest(resolved.config.baseUrl, model, 90_000);
  const client = createJevClient(resolved, {}, 0);
  const observations: Observation[] = [], relatedObservations: Observation[] = [];
  const armStarted = performance.now();
  for (const [labels, rows] of [[duplicates, observations], [related, relatedObservations]] as const) {
    for (const row of labels) {
      const callStarted = performance.now();
      const result = await runDecision(client, resolved.config, pairState(row.pair), PAIR_QUESTIONS);
      rows.push({ pair_id: row.pair_id, label: row.label, retrieved: row.retrieved, probability: (result.answers.same_work as NoulResponse).noul, related_probability: (result.answers.related_work as NoulResponse).noul, latency_ms: performance.now() - callStarted });
      await writeFile(join(scratch, `${model.replace(":", "-")}-observations.json`), JSON.stringify({ observations, related_observations: relatedObservations }));
      console.log(model, observations.length + relatedObservations.length, "/", duplicates.length + related.length);
    }
  }
  if (await modelDigest(resolved.config.baseUrl, model, 90_000) !== digest) throw new Error("Model digest drift");
  const threshold = fitPairThreshold(partition(observations, duplicates, "dev"), "duplicate", { threshold: 0.8, relatedThreshold: 0.8 }, false);
  const relatedThreshold = fitPairThreshold(partition(relatedObservations, related, "dev"), "related", { threshold, relatedThreshold: 0.8 }, false);
  const thresholds = { threshold, relatedThreshold };
  report.arms.push({ arm: model, model_digest: digest, threshold, related_threshold: relatedThreshold, model_calls: observations.length + relatedObservations.length,
    dev: pairMetrics(partition(observations, duplicates, "dev"), "duplicate", thresholds), heldout: pairMetrics(partition(observations, duplicates, "heldout"), "duplicate", thresholds),
    related_dev: pairMetrics(partition(relatedObservations, related, "dev"), "related", thresholds), related_heldout: pairMetrics(partition(relatedObservations, related, "heldout"), "related", thresholds),
    observations, related_observations: relatedObservations, wall_ms: performance.now() - armStarted,
    latency_ms_per_pair: [...observations, ...relatedObservations].reduce((sum, row) => sum + row.latency_ms, 0) / (observations.length + relatedObservations.length),
  });
  await writeFile(join(scratch, "report-progress.json"), JSON.stringify(report, null, 2));
}
report.wall_ms = performance.now() - started;
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log("COMPLETE", report.wall_ms);
