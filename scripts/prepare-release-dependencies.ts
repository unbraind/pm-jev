import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainInvocation } from "./main-invocation.ts";

/** Record dependency changes in the pending Git range as real, release-assigned chores.
 * This bridges pm-changelog#343 without changing old items or the pinned generator.
 * A plain tracker without Git has no dependency range and is left alone.
 */
export function prepareReleaseDependencies(root: string, previousTag?: string): void {
  if (!previousTag) return;
  const version: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Expected a numeric release version");
  const git = /** Read a bounded Git query without exposing diagnostics. */ (...args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try { git("rev-parse", "--show-toplevel"); } catch { return; }
  git("merge-base", "--is-ancestor", previousTag, "HEAD");
  const changes = git("log", "--no-merges", "--format=%H%x09%s", `${previousTag}..HEAD`).trim().split("\n")
    .map(/** Split Git's full identity from the original public subject. */ line => ({ sha: line.slice(0, 40), subject: line.slice(41) }))
    .filter(/** Keep only dependency bump subjects, including capitalized squash titles. */ row => /^[\w-]+\((?:deps|deps-dev)\): bump /i.test(row.subject));
  const pm = resolve(import.meta.dirname, "../node_modules/@unbrained/pm-cli/dist/cli.js");
  for (const { sha, subject } of changes) {
    const id = `pm-jev-release-dependencies-${version.replaceAll(".", "-")}-${sha.slice(0, 12)}`;
    if (existsSync(join(root, ".agents/pm/chores", `${id}.toon`))) {
      // Let the pinned host recover a pending transaction before checking its paired evidence.
      execFileSync(process.execPath, [pm, "--pm-path", join(root, ".agents/pm"), "show", id], { cwd: root, stdio: "pipe" });
      if (!existsSync(join(root, ".agents/pm/history", `${id}.jsonl`))) throw new Error("Dependency evidence has no history; retain it and recover the pending tracker transaction before retrying");
      continue;
    }
    execFileSync(process.execPath, [pm, "--pm-path", join(root, ".agents/pm"), "create", "chore",
      subject.slice(subject.indexOf(": ") + 2), "--id", id, "--status", "closed",
      "--close-reason", "Dependency update merged in the pending release range",
      "--release", version, "--description", `Dependency commit ${sha}: ${subject}`,
      "--author", "release-preparation"], { cwd: root, stdio: "pipe" });
  }
  console.log(`Recorded ${changes.length} dependency updates for release ${version}`);
}

if (isMainInvocation(process.argv, import.meta.url)) prepareReleaseDependencies(process.cwd(), process.argv[2]);
