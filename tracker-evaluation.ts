import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { listAllComplete, readSettings } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { RelationshipGraph, resolveWorkspaceRelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import type { ItemMetadata, PmSettings } from "@unbrained/pm-cli/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { buildClassificationQuestions, buildLinkQuestion, buildDedupeRequest, projectTriageState, rankDedupeCandidates, existingLinkKinds } from "./index.ts";
import { evidenceHash } from "./decision-calibration.ts";
import type { EvaluationTask } from "./decision-calibration.ts";

/** Immutable committed public tracker snapshot projected through the host SDK. */
export interface TrackerCorpus {
  repository: string;
  commit: string;
  data_sha256: string;
  settings: PmSettings;
  items: (ItemMetadata & { body?: string })[];
}
/** A labelled request; only state and questions cross the model boundary. */
export interface EvaluationExample {
  repository: string;
  commit: string;
  data_sha256: string;
  example_sha256: string;
  state: unknown;
  questions: Questions;
  labels: Record<string, string>;
}
/** Run bounded external inspection tools without a shell or credential-bearing output. */
export function inspectSource(command: string, args: string[], cwd: string, input?: Buffer): Buffer {
  try { return execFileSync(command, args, { cwd, input, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }); }
  catch { throw new Error(`Public tracker inspection failed (${command})`); }
}
/** Verify a fleet clone's public identity before touching tracker contents; private repos are skipped. */
export async function readPublicCorpus(from: string, inspect = inspectSource): Promise<TrackerCorpus | null> {
  const root = await realpath(from);
  const repo = resolve(root, "../..");
  const name = basename(repo);
  if (basename(root) !== "pm" || basename(dirname(root)) !== ".agents" || basename(dirname(repo)) !== "fleet" ||
      !/^pm-[a-z0-9-]+$/.test(name) || ["pm-cli", "pm-cli-companion"].includes(name)) throw new Error("Sources must be public package trackers in fleet clones");
  const origin = inspect("git", ["remote", "get-url", "origin"], repo).toString().trim();
  if (![ `https://github.com/unbraind/${name}.git`, `https://github.com/unbraind/${name}`, `git@github.com:unbraind/${name}.git` ].includes(origin)) throw new Error("Source origin must match its public fleet repository");
  const repository = `unbraind/${name}`;
  const visibility = JSON.parse(inspect("gh", ["repo", "view", repository, "--json", "visibility"], repo).toString()) as { visibility?: string };
  if (visibility.visibility === "PRIVATE") return null;
  if (visibility.visibility !== "PUBLIC") throw new Error("Source public visibility could not be verified");
  const commit = inspect("git", ["rev-parse", "HEAD"], repo).toString().trim();
  const tree = inspect("git", ["ls-tree", "-r", commit, "--", ".agents/pm"], repo).toString();
  if (!tree || tree.split("\n").some(/** Refuse links before extracting an untrusted tree. */ line => /^(120000|160000) /.test(line))) throw new Error("Tracker snapshot must contain regular committed files only");
  const archive = inspect("git", ["archive", "--format=tar", commit, ".agents/pm"], repo);
  const scratch = await mkdtemp(join(tmpdir(), "jev-corpus-"));
  try {
    inspect("tar", ["-xf", "-", "-C", scratch], repo, archive);
    const pmRoot = join(scratch, ".agents/pm");
    const result = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot, cwd: scratch, noExtensions: true }));
    return { repository, commit, data_sha256: evidenceHash(archive.toString("base64")), settings: await readSettings(pmRoot), items: result.items };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
/** Remove routing fields and bound semantic text identically for evaluation and calibrated inference. */
export function semanticState(item: ItemMetadata & { body?: string }) {
  return projectTriageState(item);
}
/** Recover explicit known-duplicate targets, never infer truth from title similarity. */
export function duplicateTarget(item: ItemMetadata): string | undefined {
  const fields = item as ItemMetadata & { duplicate_of?: string };
  const explicit = fields.duplicate_of ?? item.type_options?.duplicate_of ?? item.type_options?.duplicateOf;
  if (explicit) return explicit;
  if (item.status !== "closed" && item.status !== "canceled") return undefined;
  return /\bduplicate(?:\s+of|_of|:)\s*[`"']?([a-z0-9]+(?:-[a-z0-9]+)+)/i.exec(`${item.close_reason ?? ""} ${item.resolution ?? ""}`)?.[1];
}
/** Build a content-hashed labelled decision without sending labels or source metadata. */
function example(corpus: TrackerCorpus, state: unknown, questions: Questions, labels: Record<string, string>): EvaluationExample {
  return { repository: corpus.repository, commit: corpus.commit, data_sha256: corpus.data_sha256,
    example_sha256: evidenceHash([corpus.repository, corpus.commit, state, questions, labels]), state, questions, labels };
}
/** Build labels from tracker types/priorities, canonical edges and explicit duplicate resolutions. */
export function buildExamples(corpus: TrackerCorpus, task: EvaluationTask): { examples: EvaluationExample[]; retrieval_misses: number } {
  const items = [...corpus.items].sort(/** Make SDK enumeration order irrelevant. */ (a, b) => a.id.localeCompare(b.id));
  if (task === "triage") {
    const questions = buildClassificationQuestions(corpus.settings);
    return { examples: items.map(/** Ground truth is excluded from the semantic state and question wording. */ item => example(corpus, semanticState(item), questions, { type: item.type, priority: String(item.priority) })), retrieval_misses: 0 };
  }
  const examples: EvaluationExample[] = [];
  if (task === "link") {
    const graph = RelationshipGraph.fromItems(items, resolveWorkspaceRelationshipKindRegistry());
    const question = buildLinkQuestion("candidate_0");
    const criteria = (question as { criteria: Record<string, string> }).criteria;
    // Explicit edges supply positives; missing edges are closed-world negatives, not proof of semantic independence.
    const positives: EvaluationExample[] = [];
    const negatives: EvaluationExample[] = [];
    for (const source of items) {
      const connected = new Set(graph.incidentEdges(source.id).flatMap(/** Enumerate only existing neighbors rather than every item pair. */ edge => [edge.source, edge.target]));
      const targets = items.filter(/** Existing edges provide positive labels. */ target => target.id !== source.id && connected.has(target.id));
      const negative = items.filter(/** Use a deterministic sampled non-edge per source. */ target => target.id !== source.id && !connected.has(target.id))
        .sort(/** Hash pair identities to avoid relying on alphabetical adjacency. */ (a, b) => evidenceHash([source.id, a.id]).localeCompare(evidenceHash([source.id, b.id])))[0];
      if (negative !== undefined) targets.push(negative);
      for (const target of targets) {
        const kinds = [...existingLinkKinds(graph, source.id, target.id)].filter(/** Retain only ontology kinds the production command can propose. */ kind => kind in criteria).sort();
        // Multi-labelled pairs cannot be honestly evaluated as one categorical choice.
        if (kinds.length > 1) continue;
        const row = example(corpus, { source: semanticState(source), candidates: { candidate_0: semanticState(target) } }, { candidate_0: question }, { candidate_0: kinds[0] ?? "none" });
        if (kinds.length === 1) positives.push(row);
        else negatives.push(row);
      }
    }
    const sampled = deterministicSample(negatives, Math.max(positives.length, 1), "non-edges-v1");
    return { examples: [...positives, ...sampled], retrieval_misses: 0 };
  }
  let retrieval_misses = 0;
  for (const item of items) {
    const target = duplicateTarget(item);
    // Only explicitly labelled duplicate items supply dedupe ground truth.
    if (target === undefined) continue;
    const candidates = rankDedupeCandidates(items.filter(/** Simulate screening before the duplicate existed. */ candidate => candidate.id !== item.id), item.title, 8);
    if (!candidates.some(/** Report retrieval failure separately rather than fabricating a negative label. */ candidate => candidate.id === target)) { retrieval_misses++; continue; }
    const request = buildDedupeRequest(item.title, item.body ?? item.description, candidates);
    examples.push(example(corpus, request.state, request.questions, { duplicate_of: target }));
    const remaining = items.filter(/** Remove the known duplicate group to create an explicit missing-target control. */ candidate => candidate.id !== item.id && candidate.id !== target && duplicateTarget(candidate) !== target);
    const negativeCandidates = rankDedupeCandidates(remaining, item.title, 8);
    if (negativeCandidates.length > 0) {
      const negative = buildDedupeRequest(item.title, item.body ?? item.description, negativeCandidates);
      examples.push(example(corpus, negative.state, negative.questions, { duplicate_of: "none" }));
    }
  }
  return { examples, retrieval_misses };
}
/** Stable seeded hash sampling without replacement, balanced across repositories by round-robin. */
export function deterministicSample(examples: readonly EvaluationExample[], count: number, seed: string): EvaluationExample[] {
  const groups = new Map<string, EvaluationExample[]>();
  for (const row of [...examples].sort(/** Seed affects example selection but never depends on input ordering. */ (a, b) => evidenceHash([seed, a.example_sha256]).localeCompare(evidenceHash([seed, b.example_sha256])))) {
    const group = groups.get(row.repository) ?? [];
    group.push(row);
    groups.set(row.repository, group);
  }
  const repositories = [...groups.keys()].sort();
  const sampled: EvaluationExample[] = [];
  for (let offset = 0; sampled.length < Math.min(count, examples.length); offset++) {
    for (const repository of repositories) {
      const row = (groups.get(repository) as EvaluationExample[])[offset];
      if (row !== undefined && sampled.length < count) sampled.push(row);
    }
  }
  return sampled;
}
