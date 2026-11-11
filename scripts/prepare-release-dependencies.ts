import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainInvocation } from "./main-invocation.ts";

/** Record dependency changes in the pending Git range as a real, release-assigned chore.
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
  const changes = git("log", "--no-merges", "--format=%s", `${previousTag}..HEAD`).split("\n")
    .filter(/** Keep only dependency bump subjects, including capitalized squash titles. */ subject => /^[\w-]+\((?:deps|deps-dev)\): bump /i.test(subject));
  if (changes.length === 0) return;
  const id = `pm-jev-release-dependencies-${version.replaceAll(".", "-")}`;
  if (existsSync(join(root, ".agents/pm/chores", `${id}.toon`))) return;
  const pm = resolve(import.meta.dirname, "../node_modules/@unbrained/pm-cli/dist/cli.js");
  execFileSync(process.execPath, [pm, "--pm-path", join(root, ".agents/pm"), "create", "chore",
    `Update release dependencies for ${version}`, "--id", id, "--status", "closed",
    "--close-reason", "Dependency updates merged in the pending release range",
    "--release", version, "--description", changes.map(/** Preserve the original commit subject as release evidence. */ subject => `- ${subject}`).join("\n"),
    "--author", "release-preparation"], { cwd: root, stdio: "pipe" });
  console.log(`Recorded ${changes.length} dependency updates for release ${version}`);
}

if (isMainInvocation(process.argv, import.meta.url)) prepareReleaseDependencies(process.cwd(), process.argv[2]);
