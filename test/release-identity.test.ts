/**
 * Release identity: the version the extension exports must be the version npm publishes.
 *
 * Issue #68: the release workflow rewrote the first version-shaped text in
 * index.ts, which was the comment describing that rewrite, so every release
 * shipped an export still declaring 2026.10.5. These tests check exported
 * properties of evaluated modules instead of searching source text, and the
 * rewrite runs against fixtures carrying the misleading comment and unrelated
 * version strings.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { archiveMismatches, packageExports, readReleaseVersions, run, runIfMain, setExtensionVersion, versionMismatches, type ReleaseExports } from "../scripts/release-identity.ts";

const repository = resolve(import.meta.dirname, "..");
const script = join(repository, "scripts/release-identity.ts");
const packageVersion = (JSON.parse(readFileSync(join(repository, "package.json"), "utf8")) as { version: string }).version;

/**
 * The pre-#68 release rewrite, kept verbatim so the regression shows what it did.
 *
 * @param source - The index.ts source.
 * @param version - The release version.
 * @returns The source after the first-match replacement.
 */
const firstMatchRewrite = (source: string, version: string): string => source.replace(/version:\s*["'][^"']+["']/, `version: "${version}"`);

/**
 * Exports that each report the given version.
 *
 * @param version - The version both exports declare.
 * @returns Source and built exports.
 */
const exportsAt = (version: string): ReleaseExports => ({ "index.ts": { name: "pm-jev", version }, "dist/index.js": { name: "pm-jev", version } });

/**
 * An index.ts shaped like pm-jev's: a comment quoting a version literal, unrelated
 * version strings, then the exported identity.
 *
 * @param version - The version the identity declares.
 * @returns The module source.
 */
function identitySource(version: string): string {
  return [
    "const defineExtension = <T,>(extension: T): T => extension;",
    "// The daily release workflow rewrites the first `version: \"2026.10.28\"` literal in this file.",
    "export const catalog = { catalog_version: \"tev1\", schema: { version: \"0.1.0\" } };",
    "export const examples = [\"pm jev replay --policy-version candidate-v2\"];",
    "export default defineExtension({",
    "  name: \"pm-jev\",",
    `  version: "${version}",`,
    "  description: \"fixture\",",
    "});",
    "",
  ].join("\n");
}

/** Overrides for one fixture package; every surface defaults to the package version. */
interface FixtureVersions {
  readonly package?: unknown;
  readonly manifest?: unknown;
  readonly lockPackages?: boolean;
}

/**
 * Write a disposable package whose metadata reports the given versions.
 *
 * @param t - The test that owns the directory and removes it afterwards.
 * @param versions - The versions each metadata file reports.
 * @returns The package root.
 */
function fixture(t: TestContext, versions: FixtureVersions = {}): string {
  const root = mkdtempSync(join(tmpdir(), "pm-jev-identity-"));
  t.after(/** Remove the fixture package. */ () => rmSync(root, { recursive: true, force: true }));
  const version = versions.package ?? "2026.11.4";
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pm-jev", version, type: "module" }));
  const lock = { name: "pm-jev", version, lockfileVersion: 3, ...(versions.lockPackages === false ? {} : { packages: { "": { name: "pm-jev", version } } }) };
  writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock));
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ name: "pm-jev", version: versions.manifest ?? version }));
  writeFileSync(join(root, "index.ts"), identitySource("2026.10.5"));
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.js"), `export default { name: "pm-jev", version: ${JSON.stringify(String(version))} };\n`);
  return root;
}

/**
 * Evaluate a module in a child process and return its default export's version.
 *
 * A real evaluation of the module, so the check reads the exported property and
 * not text that merely looks like it.
 *
 * @param file - The module to evaluate.
 * @returns The exported identity's version.
 */
function evaluatedVersion(file: string): unknown {
  const directory = mkdtempSync(join(tmpdir(), "pm-jev-identity-eval-"));
  try {
    const runner = join(directory, "print.mts");
    writeFileSync(runner, `import identity from ${JSON.stringify(pathToFileURL(file).href)};\nprocess.stdout.write(JSON.stringify(identity.version));\n`);
    return JSON.parse(execFileSync(process.execPath, [runner], { encoding: "utf8" }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Pack a fixture package the way npm lays out an archive (everything under `package/`).
 *
 * @param root - The fixture package root.
 * @param edit - Changes applied to the packed copy only.
 * @returns The archive path.
 */
function packFixture(root: string, edit: (packed: string) => void = () => {}): string {
  const staging = join(root, "staging");
  const packed = join(staging, "package");
  mkdirSync(join(packed, "dist"), { recursive: true });
  for (const file of ["package.json", "manifest.json", "dist/index.js"]) writeFileSync(join(packed, file), readFileSync(join(root, file)));
  edit(packed);
  const archive = join(root, "package.tgz");
  execFileSync("tar", ["-czf", archive, "-C", staging, "package"]);
  return archive;
}

test("the release rewrite changes the exported identity and nothing else that looks like a version", (t) => {
  const root = fixture(t);
  const stale = identitySource("2026.10.5");
  const file = join(root, "index.ts");

  // The defect: the old first-match rewrite edits the comment and leaves the export stale.
  const old = firstMatchRewrite(stale, "2026.11.4");
  assert.match(old, /rewrites the first `version: "2026\.11\.4"` literal/);
  writeFileSync(file, old);
  assert.equal(evaluatedVersion(file), "2026.10.5");

  const rewritten = setExtensionVersion(stale, "2026.11.4");
  assert.equal(rewritten, stale.replace('  version: "2026.10.5",', '  version: "2026.11.4",'));
  assert.match(rewritten, /rewrites the first `version: "2026\.10\.28"` literal/);
  assert.match(rewritten, /catalog_version: "tev1", schema: \{ version: "0\.1\.0" \}/);
  writeFileSync(file, rewritten);
  assert.equal(evaluatedVersion(file), "2026.11.4");
});

test("the release rewrite refuses versions and sources it cannot apply exactly", () => {
  const source = identitySource("2026.10.5");
  for (const version of ["2026.11.4-rc.1", "2026.11", "2026.11.4\", evil: \"1", "undefined"]) {
    assert.throws(() => setExtensionVersion(source, version), /refusing release version/, version);
  }
  assert.throws(() => setExtensionVersion(source.replace('name: "pm-jev"', 'name: "pm-other"'), "2026.11.4"), /found 0/);
  const twice = `${source}/*\n${source.slice(source.indexOf("export default"))}*/\n`;
  assert.throws(() => setExtensionVersion(twice, "2026.11.4"), /found 2/);
});

test("every release surface must report the package version", (t) => {
  assert.deepEqual(versionMismatches(readReleaseVersions(fixture(t), exportsAt("2026.11.4"))), []);
  assert.deepEqual(versionMismatches(readReleaseVersions(fixture(t), exportsAt("2026.10.5"))), [
    'index.ts default export reports "2026.10.5", package.json reports "2026.11.4"',
    'dist/index.js default export reports "2026.10.5", package.json reports "2026.11.4"',
  ]);
  assert.deepEqual(versionMismatches(readReleaseVersions(fixture(t, { manifest: "2026.11.3", lockPackages: false }), exportsAt("2026.11.4"))), [
    'package-lock.json packages[""] reports undefined, package.json reports "2026.11.4"',
    'manifest.json reports "2026.11.3", package.json reports "2026.11.4"',
  ]);

  // An export that is not an object, or an object without an identity, reports no version.
  for (const identity of [undefined, null, "2026.11.4", {}]) {
    assert.equal(readReleaseVersions(fixture(t), { "index.ts": identity, "dist/index.js": identity })["index.ts default export"], undefined, JSON.stringify(identity));
  }

  // A package version that is missing or not a plain release can never be what every surface agrees on.
  assert.deepEqual(versionMismatches({ "package.json": undefined, "manifest.json": undefined }), ["package.json reports undefined, not a plain release version"]);
  assert.deepEqual(versionMismatches({ "package.json": "next" }), ['package.json reports "next", not a plain release version']);
});

test("this repository's source and built exports report its package version", () => {
  assert.deepEqual(versionMismatches(readReleaseVersions(repository, packageExports)), []);
  assert.equal(evaluatedVersion(join(repository, "dist/index.js")), packageVersion);
});

test("a packed archive must carry the verified version and the verified build", (t) => {
  const root = fixture(t);
  assert.deepEqual(archiveMismatches(root, packFixture(root), "2026.11.4"), []);
  const drifted = fixture(t);
  const archive = packFixture(drifted, /** Pack a stale manifest and a rebuilt entry point. */ (packed) => {
    writeFileSync(join(packed, "manifest.json"), JSON.stringify({ version: "2026.11.3" }));
    writeFileSync(join(packed, "dist/index.js"), 'export default { name: "pm-jev", version: "2026.11.4" };\n// rebuilt\n');
  });
  assert.deepEqual(archiveMismatches(drifted, archive, "2026.11.4"), [
    `${archive}: manifest.json reports "2026.11.3", expected "2026.11.4"`,
    `${archive}: dist/index.js differs from the verified build`,
  ]);
  const incomplete = fixture(t);
  assert.throws(() => archiveMismatches(incomplete, packFixture(incomplete, /** Drop the built entry point. */ (packed) => rmSync(join(packed, "dist/index.js"))), "2026.11.4"), /ENOENT/);
  assert.throws(() => archiveMismatches(incomplete, join(incomplete, "missing.tgz"), "2026.11.4"), /tar/);
});

test("this repository packs the build whose export it verified", (t) => {
  const destination = mkdtempSync(join(tmpdir(), "pm-jev-identity-pack-"));
  t.after(/** Remove the packed archive. */ () => rmSync(destination, { recursive: true, force: true }));
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--loglevel=error", "--pack-destination", destination], { cwd: repository, encoding: "utf8" })) as { filename: string }[];
  assert.deepEqual(archiveMismatches(repository, join(destination, packed[0]?.filename ?? ""), packageVersion), []);
});

test("each mode sets or verifies the identity and reports every problem", (t) => {
  const lines: string[] = [];
  /**
   * Collect one reported problem.
   *
   * @param line - The problem.
   */
  const report = (line: string): void => { lines.push(line); };

  const root = fixture(t);
  assert.equal(run([], root, report, exportsAt("2026.10.5")), 1);
  assert.deepEqual(lines.splice(0), [
    'index.ts default export reports "2026.10.5", package.json reports "2026.11.4"',
    'dist/index.js default export reports "2026.10.5", package.json reports "2026.11.4"',
  ]);
  assert.equal(run(["--write"], root, report), 0);
  assert.equal(evaluatedVersion(join(root, "index.ts")), "2026.11.4");
  assert.equal(run([], root, report, exportsAt("2026.11.4")), 0);
  assert.equal(run(["--archive", packFixture(root)], root, report, exportsAt("2026.11.4")), 0);
  assert.deepEqual(lines, []);

  // The archive is compared only once the tree itself agrees, so a stale tree is reported once, not twice.
  assert.equal(run(["--archive", join(root, "never-read.tgz")], root, report, exportsAt("2026.10.5")), 1);
  assert.equal(lines.splice(0).length, 2);
  const repacked = fixture(t);
  assert.equal(run(["--archive", packFixture(repacked, /** Pack a package.json without a version. */ (packed) => writeFileSync(join(packed, "package.json"), "{}"))], repacked, report, exportsAt("2026.11.4")), 1);
  assert.match(lines.splice(0).join("\n"), /package\.json reports undefined, expected "2026\.11\.4"/);

  for (const args of [["--archive"], ["--write", "2026.11.4"], ["--verify"]]) {
    assert.equal(run(args, root, report), 1);
    assert.match(lines.splice(0).join("\n"), /^usage: release-identity\.ts/, JSON.stringify(args));
  }
  assert.throws(() => run(["--write"], fixture(t, { package: 7 }), report), /refusing release version "7"/);
});

test("the entry point runs only as the process entry and reports through the exit code", (t) => {
  const write = t.mock.method(process.stderr, "write", /** Swallow the reported problem. */ () => true);
  t.after(/** Restore the exit code a failing mode sets. */ () => { process.exitCode = undefined; });
  const root = fixture(t);
  assert.equal(runIfMain(["node", join(repository, "test/release-identity.test.ts")], pathToFileURL(script).href, root, exportsAt("2026.10.5")), false);
  assert.equal(process.exitCode, undefined);
  assert.equal(runIfMain(["node", script], pathToFileURL(script).href, root, exportsAt("2026.10.5")), true);
  assert.equal(process.exitCode, 1);
  assert.equal(write.mock.callCount(), 2);
  assert.match(String(write.mock.calls[0]?.arguments[0]), /index\.ts default export reports "2026\.10\.5"/);
  write.mock.restore();
  assert.equal(runIfMain(["node", script], pathToFileURL(script).href, repository), true);
  assert.equal(process.exitCode, 0);
});
