import { execFileSync } from "node:child_process";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { evidenceHash } from "../decision-calibration.ts";
import type { DuplicateCorpus } from "../dedupe-evaluation.ts";

/** Committed public snapshot provenance; reconstructed historical evidence is counted separately. */
export type PublicDuplicateCorpus = DuplicateCorpus & { archive_sha256: string; historical_items?: number };
/** Inspect only a named public clone; no tracker mutation or shell interpretation. */
function inspect(command: string, args: string[], cwd: string, input?: Buffer): Buffer {
  return execFileSync(command, args, { cwd, input, timeout: 60_000, maxBuffer: 512 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
}
/** Reject archives that could materialize links rather than tracker documents. */
function requireRegularTree(tree: string): void {
  const entries = tree.trim().split("\n");
  if (tree.length === 0 || entries.some(entry => /^(120000|160000) /.test(entry))) throw new Error("Tracker must contain regular committed files");
}
/** Collect public committed archives and certified complete reads without modifying any source tracker. */
export async function snapshotPublicFleet(fleet: string, scratch: string, reference = "HEAD"): Promise<{ corpora: PublicDuplicateCorpus[]; skipped: string[] }> {
const corpora: PublicDuplicateCorpus[] = [];
const skipped: string[] = [];

for (const name of (await readdir(fleet)).filter(name => /^pm-[a-z0-9-]+$/.test(name) && name !== "pm-cli-companion").sort()) {
  const repo = join(fleet, name), repository = `unbraind/${name}`;
  const origin = inspect("git", ["remote", "get-url", "origin"], repo).toString().trim();
  if (![`${repository}.git`, repository].some(suffix => origin === `https://github.com/${suffix}`) && origin !== `git@github.com:${repository}.git`) throw new Error("Unexpected source origin");
  const visibility = JSON.parse(inspect("gh", ["repo", "view", repository, "--json", "visibility"], repo).toString()) as { visibility: string };
  if (visibility.visibility !== "PUBLIC") { skipped.push("nonpublic source omitted"); continue; }
  const commit = inspect("git", ["rev-parse", reference], repo).toString().trim();
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
  return { corpora, skipped };
}
