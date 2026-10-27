/** Public-only snapshot and one-shot local inference benchmark; text remains in the disposable snapshot. */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { NoulResponse } from "@typesafe-ai/sdk";
import { repositoryDuplicatePairs, historicalDuplicate } from "../dedupe-evaluation.ts";
import { snapshotPublicFleet } from "./public-duplicate-fixtures.ts";
import type { PublicDuplicateCorpus } from "./public-duplicate-fixtures.ts";
import { qualityObservation, duplicateSplit, fitQualityPolicy, qualityMetrics, qualityFrontier } from "../duplicate-quality.ts";
import type { QualityObservation, QualityArm } from "../duplicate-quality.ts";
import { DUPLICATE_QUESTIONS, pairState } from "../dedupe.ts";
import { createJevClient, resolveJevEndpoint, runDecision } from "../index.ts";
import { evidenceHash, modelDigest } from "../decision-calibration.ts";

const [mode, fleet, scratch, output] = process.argv.slice(2);
if (!["collect", "infer"].includes(mode) || !fleet || !scratch || !output) throw new Error("Usage: duplicate-quality.acceptance.ts <collect|infer> <fleet> <scratch> <report>");
if (mode === "collect") {
  await mkdir(scratch, { recursive: true });
  if ((await readdir(scratch)).length > 0) throw new Error("Collection requires an empty scratch directory.");
  const { corpora } = await snapshotPublicFleet(fleet, scratch, "origin/main");
  await writeFile(join(scratch, "corpora.json"), JSON.stringify(corpora));
} else {
  // Inference may consume a completed collection once; it never resumes a partial model run.
  await mkdir(join(scratch, "inference"));
  const corpora = JSON.parse(await readFile(join(scratch, "corpora.json"), "utf8")) as PublicDuplicateCorpus[];
  for (const corpus of corpora) {
    corpus.historical_items = 0;
    const history = join(scratch, corpus.repository.split("/")[1], ".agents/pm/history");
    for (const file of (await readdir(history)).filter(name => name.endsWith(".jsonl")).sort()) {
      const events = (await readFile(join(history, file), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Parameters<typeof historicalDuplicate>[0][number]);
      const item = historicalDuplicate(events);
      if (item !== undefined && !corpus.items.some(current => current.id === item.id)) { corpus.items.push(item); corpus.historical_items++; }
    }
  }
  const labels = repositoryDuplicatePairs(corpora);
  const samples = labels.map(row => ({ pair_id: row.pair_id, repository: row.repository, a: row.pair.a.id, b: row.pair.b.id, label: row.label, retrieved: row.retrieved,
    split: duplicateSplit(row.repository), lexical: qualityObservation(row.pair, 0, row.label, row.retrieved).lexical, example_sha256: evidenceHash(pairState(row.pair)) }));
  await writeFile(join(scratch, "inference/samples.json"), JSON.stringify(samples, null, 2));
  const endpoint = await resolveJevEndpoint(join(scratch, "unused-settings"), { PM_JEV_MODEL: "tev1:4b" });
  const resolved = { ...endpoint, config: { ...endpoint.config, timeoutMs: 360_000, totalDeadlineMs: 600_000, keepAlive: "30m" } };
  const digest = await modelDigest(resolved.config.baseUrl, resolved.config.model, 90_000);
  const client = createJevClient(resolved, {}, 0);
  const observations: (QualityObservation & { pair_id: string; latency_ms: number })[] = [];
  await writeFile(join(scratch, "inference/start.json"), JSON.stringify({ digest, samples: samples.length, question_sha256: evidenceHash(DUPLICATE_QUESTIONS) }));
  for (const [i, row] of labels.entries()) {
    const started = performance.now();
    const result = await runDecision(client, resolved.config, pairState(row.pair), DUPLICATE_QUESTIONS);
    observations.push({ pair_id: row.pair_id, label: row.label, retrieved: row.retrieved, lexical: samples[i].lexical,
      probability: (result.answers.same_work as NoulResponse).noul, latency_ms: performance.now() - started });
    await writeFile(join(scratch, "inference/observations.json"), JSON.stringify(observations));
    console.log("pair", i + 1, "/", labels.length, Math.round(performance.now() - started));
  }
  if (await modelDigest(resolved.config.baseUrl, resolved.config.model, 90_000) !== digest) throw new Error("Model digest drift");
  const train = observations.filter((_, i) => samples[i].split === "train"), heldout = observations.filter((_, i) => samples[i].split === "heldout");
  const arms = (["lexical-only", "model-only", "combined"] as QualityArm[]).map(arm => {
    const policy = fitQualityPolicy(train, arm);
    return { arm, policy, train: qualityMetrics(train, arm, policy), heldout: qualityMetrics(heldout, arm, policy),
      frontier: qualityFrontier(train, arm).map(point => ({ ...point, heldout: qualityMetrics(heldout, arm, point.policy) })) };
  });
  const report = { version: "pm-jev-duplicate-quality/3", model_calls: observations.length, automatic_retries: 0, request_timeout_ms: 360_000, pair_deadline_ms: 600_000, recorded_at: new Date().toISOString(), model: resolved.config.model, model_digest: digest, question_sha256: evidenceHash(DUPLICATE_QUESTIONS),
    retrieval_scope: "Complete top-8 candidate graph; a production --limit-pairs budget may truncate it further",
    split_seed: "duplicate-quality-20261021", fitting: "Train only: maximize recall at empirical precision >= 0.8 with >= 3 proposals; tie by precision then stricter cutoffs. Null disables proposals.",
    labels: "Recorded terminal duplicate closures plus explicitly deleted duplicates reconstructed from committed history; equivalence components include sibling pairs. Hard controls are unrecorded duplicate relationships, not independently adjudicated negatives.",
    archive_hash_method: "SHA-256 of JSON-encoded archive base64 via evidenceHash; data hashes include reconstructed historical items",
    source_method: "Public origin, PUBLIC visibility and public commit reachability verified; regular committed archives and certified complete SDK reads; text stays in scratch.",
    limitations: "Repository-separated populations are small and imbalanced. Closure-component siblings and shared-item controls are correlated; Wilson intervals are descriptive, not an independent-population guarantee. Frontier held-out metrics are descriptive only and never select a deployed cutoff.",
    data: corpora.map(corpus => ({ repository: corpus.repository, commit: corpus.commit, items: corpus.items.length, historical_items: corpus.historical_items, archive_sha256: corpus.archive_sha256, data_sha256: evidenceHash(corpus.items), split: duplicateSplit(corpus.repository) })),
    samples, observations, arms };
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log("COMPLETE", arms.map(({ arm, policy, train, heldout }) => ({ arm, policy, train, heldout })));
}
