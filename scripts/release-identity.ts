/**
 * Keep the exported extension identity on the package version through every release.
 *
 * The release workflow used to rewrite the first `version`-shaped text in
 * index.ts. That text was the comment describing the rewrite, so every release
 * since v0 updated the comment and left the exported identity at 2026.10.5
 * (issue #68). The rewrite here targets only the `version` property of the
 * `export default defineExtension({` call and refuses a source that does not
 * declare exactly one such identity. Verification reads the version from this
 * package's real default exports, imported statically from index.ts and
 * dist/index.js, rather than from text, so a rewrite that misses fails the
 * release instead of shipping a stale identity.
 *
 * - `--write` sets the identity in index.ts to the package.json version.
 * - No argument checks that package.json, package-lock.json, manifest.json and
 *   the source and built default exports report one version.
 * - `--archive <tgz>` also checks that a packed archive carries that version and
 *   the exact built entry point whose export was verified.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import builtIdentity from "../dist/index.js";
import sourceIdentity from "../index.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** The identity declaration: `name` then `version` as the first properties of the default `defineExtension` call. */
const IDENTITY = /^(export default defineExtension\(\{\r?\n[ \t]+name: "pm-jev",\r?\n[ \t]+version: )"[^"\r\n]*"/gm;

/** Plain release versions; anything else is refused before it reaches source text. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/** Where each release surface reports its version, keyed by the surface's name. */
export type ReleaseVersions = Record<string, unknown>;

/** The default exports a release must keep on the package version, keyed by the file each was imported from. */
export interface ReleaseExports {
  readonly "index.ts": unknown;
  readonly "dist/index.js": unknown;
}

/** This package's own default exports. Importing them never activates the extension. */
export const packageExports: ReleaseExports = { "index.ts": sourceIdentity, "dist/index.js": builtIdentity };

/**
 * Set the version of the exported extension identity, leaving every other version-shaped text alone.
 *
 * @param source - The index.ts source.
 * @param version - The release version to declare.
 * @returns The source with only the identity's version replaced.
 * @throws When the version is not a plain `x.y.z` release, or the source does not declare exactly one identity.
 */
export function setExtensionVersion(source: string, version: string): string {
  if (!RELEASE_VERSION.test(version)) throw new Error(`refusing release version ${JSON.stringify(version)}: expected digits.digits.digits`);
  const found = [...source.matchAll(IDENTITY)].length;
  if (found !== 1) throw new Error(`index.ts must declare exactly one exported identity (export default defineExtension({ name: "pm-jev", version: ... })); found ${String(found)}`);
  return source.replace(IDENTITY, /** Keep the matched declaration prefix and swap only the quoted version. */ (_declaration: string, prefix: string) => `${prefix}"${version}"`);
}

/**
 * Read a JSON object from disk.
 *
 * @param path - The file to read.
 * @returns The parsed object.
 */
function readObject(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Read the `version` property of an exported identity.
 *
 * @param identity - A module's default export.
 * @returns Its version, or undefined when the export is not an object or has none.
 */
function versionOf(identity: unknown): unknown {
  return typeof identity === "object" && identity !== null ? (identity as { version?: unknown }).version : undefined;
}

/**
 * Collect the version every release surface reports, from the parsed metadata and the real exports.
 *
 * @param root - The package root.
 * @param exports - The package's default exports.
 * @returns Each surface's reported version.
 */
export function readReleaseVersions(root: string, exports: ReleaseExports): ReleaseVersions {
  const lock = readObject(join(root, "package-lock.json"));
  const packages = lock.packages as Record<string, { version?: unknown }> | undefined;
  return {
    "package.json": readObject(join(root, "package.json")).version,
    "package-lock.json": lock.version,
    'package-lock.json packages[""]': packages?.[""]?.version,
    "manifest.json": readObject(join(root, "manifest.json")).version,
    "index.ts default export": versionOf(exports["index.ts"]),
    "dist/index.js default export": versionOf(exports["dist/index.js"]),
  };
}

/**
 * Name every surface whose version differs from package.json.
 *
 * @param versions - The versions read by {@link readReleaseVersions}.
 * @returns One line per disagreement; empty when every surface agrees.
 */
export function versionMismatches(versions: ReleaseVersions): string[] {
  const expected = versions["package.json"];
  if (typeof expected !== "string" || !RELEASE_VERSION.test(expected)) return [`package.json reports ${JSON.stringify(expected)}, not a plain release version`];
  return Object.entries(versions)
    .filter(/** Keep the surfaces that disagree with package.json. */ ([, version]) => version !== expected)
    .map(/** Describe one disagreement. */ ([surface, version]) => `${surface} reports ${JSON.stringify(version)}, package.json reports ${JSON.stringify(expected)}`);
}

/**
 * Compare a packed archive with the verified tree.
 *
 * Its package.json and manifest.json must report the verified version, and its
 * built entry point must be byte-identical to the dist/index.js whose export was
 * verified. The packed entry point is not evaluated itself: an extracted archive
 * has no dependencies to resolve against.
 *
 * @param root - The package root that was verified.
 * @param archive - The packed archive.
 * @param version - The verified version.
 * @returns One line per disagreement; empty when the archive matches.
 * @throws When the archive cannot be extracted or lacks one of the compared files.
 */
export function archiveMismatches(root: string, archive: string, version: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "pm-jev-release-identity-"));
  try {
    execFileSync("tar", ["-xzf", resolve(root, archive), "-C", directory], { stdio: ["ignore", "ignore", "pipe"] });
    const packed = join(directory, "package");
    const problems = ["package.json", "manifest.json"]
      .map(/** Read one packed metadata file's version. */ (file) => [file, readObject(join(packed, file)).version] as const)
      .filter(/** Keep the files that disagree with the verified version. */ ([, packedVersion]) => packedVersion !== version)
      .map(/** Describe one disagreement. */ ([file, packedVersion]) => `${archive}: ${file} reports ${JSON.stringify(packedVersion)}, expected ${JSON.stringify(version)}`);
    if (!readFileSync(join(packed, "dist/index.js")).equals(readFileSync(join(root, "dist/index.js")))) problems.push(`${archive}: dist/index.js differs from the verified build`);
    return problems;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Run one mode against the package root.
 *
 * @param args - The arguments after the script path.
 * @param root - The package root.
 * @param report - Receives one line per problem.
 * @param exports - The default exports the verification modes check.
 * @returns The process exit code: 0 when the mode succeeded, 1 otherwise.
 */
export function run(args: readonly string[], root: string, report: (line: string) => void, exports: ReleaseExports = packageExports): number {
  if (args.length === 1 && args[0] === "--write") {
    const file = join(root, "index.ts");
    writeFileSync(file, setExtensionVersion(readFileSync(file, "utf8"), String(readObject(join(root, "package.json")).version)));
    return 0;
  }
  const archive = args.length === 2 && args[0] === "--archive" ? args[1] : undefined;
  if (args.length > 0 && archive === undefined) {
    report(`usage: release-identity.ts [--write | --archive <tgz>]; got ${JSON.stringify(args)}`);
    return 1;
  }
  const versions = readReleaseVersions(root, exports);
  const problems = versionMismatches(versions);
  if (archive !== undefined && problems.length === 0) problems.push(...archiveMismatches(root, archive, String(versions["package.json"])));
  for (const problem of problems) report(problem);
  return problems.length === 0 ? 0 : 1;
}

/**
 * Run the requested mode, but only when this module is the process entry point.
 *
 * The guard is a function rather than a bare `if` at module scope so the suite
 * can execute both answers.
 *
 * @param argv - The process argv to judge.
 * @param moduleUrl - This module's `import.meta.url`.
 * @param root - The package root.
 * @param exports - The default exports the verification modes check.
 * @returns True when a mode ran.
 */
export function runIfMain(argv: string[], moduleUrl: string, root: string, exports: ReleaseExports = packageExports): boolean {
  if (!isMainInvocation(argv, moduleUrl)) return false;
  process.exitCode = run(argv.slice(2), root, /** Report a problem on stderr. */ (line) => process.stderr.write(`${line}\n`), exports);
  return true;
}

runIfMain(process.argv, import.meta.url, resolve(import.meta.dirname, ".."));
