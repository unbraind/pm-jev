import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { listAllComplete } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { trackerSnapshot } from "./fixtures.ts";

/** Archive only verified published tracker bytes into an empty read-only, non-git scratch project. */
export function copyPublicTracker(source: string, scratch: string, repository: string) {
  mkdirSync(scratch, { recursive: true }); assert.equal(readdirSync(scratch).length, 0);
  assert.equal((JSON.parse(execFileSync("gh", ["repo", "view", repository, "--json", "visibility"], { encoding: "utf8" })) as { visibility: string }).visibility, "PUBLIC");
  const gitEnv = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  const origin = execFileSync("git", ["remote", "get-url", "origin"], { cwd: source, env: gitEnv, encoding: "utf8" }).trim();
  assert.ok([`https://github.com/${repository}.git`, `git@github.com:${repository}.git`].includes(origin));
  const commit = execFileSync("git", ["rev-parse", "origin/main"], { cwd: source, env: gitEnv, encoding: "utf8" }).trim();
  assert.equal(execFileSync("gh", ["api", `repos/${repository}/commits/${commit}`, "--jq", ".sha"], { encoding: "utf8" }).trim(), commit);
  const tree = execFileSync("git", ["ls-tree", "-r", commit, "--", ".agents/pm"], { cwd: source, env: gitEnv, encoding: "utf8" });
  assert.ok(tree.length > 0 && !/^(120000|160000) /m.test(tree));
  const archive = execFileSync("git", ["archive", "--format=tar", commit, ".agents/pm"], { cwd: source, env: gitEnv, maxBuffer: 64 * 1024 * 1024 });
  execFileSync("tar", ["-xf", "-", "-C", scratch], { input: archive });
  assert.equal(existsSync(join(scratch, ".git")), false);
  for (const line of tree.trim().split("\n")) {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/.exec(line); assert.ok(match);
    const bytes = readFileSync(join(scratch, match[2]));
    assert.equal(createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"), match[1], "archive bytes match public Git blob");
  }
  const root = join(scratch, ".agents/pm");
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) chmodSync(join(entry.parentPath, entry.name), 0o444);
  const before = trackerSnapshot(root);
  return { root, before, commit, archive };
}

/** Hide Git during acceptance and return the exact environment-restoration callback. */
export function hideGit(scratch: string): () => void {
  const savedPath = process.env.PATH, savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.PATH = "";
  process.env.GIT_CEILING_DIRECTORIES = dirname(scratch);
  return () => {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  };
}

/** Install already-built extension bytes in a real scratch tracker without a package download. */
export function installBuiltExtension(pmRoot: string): void {
  const directory = join(pmRoot, "extensions", "pm-jev");
  mkdirSync(directory, { recursive: true });
  cpSync(resolve("dist"), join(directory, "dist"), { recursive: true });
  cpSync(resolve("manifest.json"), join(directory, "manifest.json"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
}

/** Resolve acceptance arguments and public provenance without coupling decisions to Git. */
export function publicAcceptanceInput(usage: string) {
  const [source, scratch, output] = process.argv.slice(2);
  if (!source || !scratch || !output) throw new Error(usage);
  const repository = "unbraind/pm-lint";
  const copy = copyPublicTracker(source, scratch, repository);
  return { ...copy, scratch, output, repository, provenance: {
    repository, commit: copy.commit, archive_sha256: createHash("sha256").update(copy.archive).digest("hex"),
  } };
}

/** Use the certified SDK complete read before deterministic public-item sampling. */
export async function readPublicSample(root: string, scratch: string, count: number) {
  const read = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot: root, cwd: scratch, noExtensions: true }));
  return { read, selected: [...read.items].sort((a, b) => a.id.localeCompare(b.id)).slice(0, count) };
}

/** Invoke the built host parser in a real tracker with Git unavailable. */
export function runBuiltCommand(fixture: { cwd: string; pmRoot: string }, words: string[], overrides: Record<string, string> = {}) {
  return promisify(execFile)(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", fixture.pmRoot, ...words], {
    cwd: fixture.cwd, timeout: 60000,
    env: { ...process.env, PATH: "", PM_PATH: fixture.pmRoot, PM_GLOBAL_PATH: join(fixture.cwd, "global"), GIT_CEILING_DIRECTORIES: dirname(fixture.cwd), ...overrides },
  });
}

/** Assert host exit 2 and selected native JSON fields without swallowing parser failures. */
export function cliFailure(expected: Readonly<Record<string, unknown>>) {
  return (error: unknown): boolean => {
    const failed = error as { code: number; stdout: string };
    assert.equal(failed.code, 2);
    const payload = JSON.parse(failed.stdout) as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(payload[key], value);
    return true;
  };
}
