/**
 * Tests for `scripts/coverage-gate.ts`.
 *
 * Drives the gate's exported {@link runCoverageGate} function against
 * purpose-built temporary fixture projects so every real failure mode — a
 * missing source, a `.d.ts` source, an `ignore` entry not under `sources`, an
 * empty source walk, a threshold miss, and the success path — is exercised
 * against a tiny `package.json` + source file + test file.
 *
 * The test is self-contained and free of anything specific to any one package:
 * it creates its own fixture projects under `mkdtemp` and passes the fixture
 * directory to `runCoverageGate`. It can be reused across the fleet by copying
 * this file into any package's `test/` directory.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { runCoverageGate, runScriptEntry } from "../scripts/coverage-gate.ts";

/**
 * The parent package's `node_modules/.bin`, prepended to `PATH` in fixtures so
 * `tsc --showConfig` (called by the gate's `resolveEmitPaths`) can find the
 * TypeScript compiler installed in the real package.
 */
const NODE_MODULES_BIN = join(import.meta.dirname, "..", "node_modules", ".bin");

/** Thresholds demanding full coverage: the fleet's published contract. */
const STRICT_THRESHOLDS = { lines: 100, branches: 100, functions: 100 } as const;

/** Thresholds demanding nothing, used to isolate the presence check. */
const ZERO_THRESHOLDS = { lines: 0, branches: 0, functions: 0 } as const;

/** Options for the fixture-writing helpers below. */
interface GateFixtureOptions {
  /** Content of the covered source module; defaults to a one-line export. */
  readonly sourceContent?: string;
  /** Name of the covered source module and its test; defaults to `"src"`. */
  readonly sourceName?: string;
  /** `coverageGate` block overrides; defaults to the full-coverage contract. */
  readonly gate?: {
    readonly sources?: readonly string[];
    readonly thresholds?: Record<string, number>;
    readonly ignore?: readonly string[];
  };
  /** Whether the fixture gets a `tsconfig.json`; defaults to true. */
  readonly tsconfig?: boolean;
}

/**
 * Creates a fixture project with a `tsconfig.json`, one covered source module
 * and its test, plus the standard `coverageGate` block, and returns the
 * fixture root.
 *
 * Every fixture used by more than one gate scenario shares this shape, so the
 * shared preparation lives in exactly one measured place rather than being
 * re-typed — and re-drifted — per test.
 *
 * @param t - The test context whose `after` hook removes the fixture.
 * @param prefix - The `mkdtemp` prefix for the temp directory.
 * @param options - Optional source content, module name, gate overrides, and
 *   tsconfig suppression.
 * @returns The fixture root directory.
 */
function createGateFixture(t: TestContext, prefix: string, options: GateFixtureOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const sourceName = options.sourceName ?? "src";
  if (options.tsconfig !== false) {
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { outDir: "dist", rootDir: "." },
    }));
  }
  writeSource(dir, sourceName, options.sourceContent);
  writeTest(dir, sourceName, sourceName);
  writePackageJson(dir, {
    sources: options.gate?.sources ?? ["."],
    tests: [`test/${sourceName}.test.ts`],
    thresholds: options.gate?.thresholds ?? STRICT_THRESHOLDS,
    ...(options.gate?.ignore === undefined ? {} : { ignore: options.gate.ignore }),
  });
  return dir;
}

/**
 * Writes a minimal `package.json` with a `coverageGate` block into a directory.
 *
 * @param dir - The fixture root directory.
 * @param gate - The `coverageGate` configuration object.
 */
function writePackageJson(dir: string, gate: Record<string, unknown>): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ coverageGate: gate }));
}

/** Write a fixture compiler artifact without repeating output-directory setup. */
function writeCompiledFile(dir: string, name: string, contents: string): void {
  const output = join(dir, "dist");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, `${name}.js`), contents);
}

/**
 * Writes a tiny TypeScript source file that exports a single constant.
 *
 * @param dir - The fixture root directory.
 * @param name - The file name (without `.ts` extension).
 * @param content - The file content (defaults to a one-line export).
 */
function writeSource(dir: string, name: string, content = "export const value = 42;\n"): void {
  writeFileSync(join(dir, `${name}.ts`), content);
}

/**
 * Writes a tiny test file in a `test/` subdirectory, importing the source and
 * asserting on its value. The subdirectory is in the gate's
 * `DEFAULT_SKIP_DIRS`, so the test file is excluded from the source walk and
 * does not appear in the coverage report.
 *
 * @param dir - The fixture root directory.
 * @param sourceName - The source module name (without `.ts`).
 * @param testName - The test file name (without `.test.ts`).
 */
function writeTest(dir: string, sourceName: string, testName: string): void {
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(join(dir, "test", `${testName}.test.ts`), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    `import { value } from "../${sourceName}.ts";`,
    'test("value is 42", () => { assert.strictEqual(value, 42); });',
    "",
  ].join("\n"));
}

/** Write a platform-independent Node fixture used as a spawned command. */
function writeNodeCommand(dir: string, name: string, source: string): string {
  const path = join(dir, `${name}.mjs`);
  writeFileSync(path, source);
  return path;
}

/**
 * Captures `console.error` / `console.log` output during a callback.
 *
 * The gate prints diagnostic messages to stderr and a success message to
 * stdout. Capturing both lets each test assert on the exact text.
 *
 * @param fn - The callback to run while capturing.
 * @returns The captured stderr and stdout text.
 */
async function captureOutput(fn: () => Promise<number>): Promise<{ code: number; stderr: string; stdout: string }> {
  const chunks: string[] = [];
  const logChunks: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  console.error = (msg: string) => { chunks.push(String(msg)); };
  console.log = (msg: string) => { logChunks.push(String(msg)); };
  try {
    const code = await fn();
    return { code, stderr: chunks.join("\n"), stdout: logChunks.join("\n") };
  } finally {
    console.error = origErr;
    console.log = origLog;
  }
}

/**
 * Creates a bare fixture project directory with no files in it yet.
 *
 * @param t - The test context whose `after` hook removes the fixture.
 * @param prefix - The `mkdtemp` prefix for the temp directory.
 * @returns The fixture root directory.
 */
function createBareFixture(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * Runs the gate against a fixture directory with `PATH` including the parent
 * package's `node_modules/.bin` so `tsc` works, and captures output.
 *
 * @param dir - The fixture root directory.
 * @returns The exit code and captured stderr/stdout text.
 */
async function runGate(dir: string): Promise<{ code: number; stderr: string; stdout: string }> {
  const savedPath = process.env.PATH;
  process.env.PATH = [NODE_MODULES_BIN, savedPath ?? ""].filter(Boolean).join(delimiter);
  try {
    return await captureOutput(() => Promise.resolve(runCoverageGate(dir, "ignore")));
  } finally {
    process.env.PATH = savedPath;
  }
}

/**
 * Runs the gate against a fixture whose test runner is a substitute Node
 * command, so scenarios like a missing report or a signal-killed runner can be
 * driven deterministically without touching the real runner.
 *
 * @param dir - The fixture root directory.
 * @param runnerPath - The Node script used in place of the test runner.
 * @returns The exit code and captured stderr/stdout text.
 */
async function runGateWithRunner(
  dir: string,
  runnerPath: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return captureOutput(() => Promise.resolve(runCoverageGate(dir, "ignore", {
    runner: { executable: process.execPath, args: [runnerPath] },
  })));
}

/**
 * Runs the gate against a fixture whose `tsc --showConfig` is a substitute Node
 * command, so compiler-output scenarios can be driven deterministically.
 *
 * @param dir - The fixture root directory.
 * @param compilerPath - The Node script used in place of the compiler.
 * @returns The exit code and captured stderr/stdout text.
 */
async function runGateWithCompiler(
  dir: string,
  compilerPath: string,
): Promise<{ code: number; stderr: string; stdout: string }> {
  return captureOutput(() => Promise.resolve(runCoverageGate(dir, "ignore", {
    compiler: { executable: process.execPath, args: [compilerPath] },
  })));
}

/**
 * Asserts the gate fails the fixture with exit code 1 and a diagnostic matching
 * the pattern, returning the captured stderr for any further assertions.
 *
 * @param dir - The fixture root directory.
 * @param pattern - The stderr pattern every failure diagnostic must match.
 * @returns The captured stderr text.
 */
async function assertGateFails(dir: string, pattern: RegExp): Promise<string> {
  const { code, stderr } = await runGate(dir);
  assert.strictEqual(code, 1, `expected failure; stderr: ${stderr}`);
  assert.match(stderr, pattern);
  return stderr;
}

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test("coverage gate passes a fully-covered fixture project", async (t) => {
  const dir = createGateFixture(t, "cg-success-");

  const { code, stdout, stderr } = await runGate(dir);
  assert.strictEqual(code, 0, `gate should pass; stderr: ${stderr}`);
  assert.match(stdout, /thresholds met/);
});

// ---------------------------------------------------------------------------
// Failure: sources entry does not exist
// ---------------------------------------------------------------------------

test("coverage gate fails when a sources entry does not exist", async (t) => {
  const dir = createBareFixture(t, "cg-missing-src-");
  writePackageJson(dir, {
    sources: ["nonexistent.ts"],
    tests: [],
    thresholds: STRICT_THRESHOLDS,
  });

  await assertGateFails(dir, /does not exist/);
});

// ---------------------------------------------------------------------------
// Failure: sources entry is a .d.ts file
// ---------------------------------------------------------------------------

test("coverage gate fails when a sources entry is a .d.ts file", async (t) => {
  const dir = createBareFixture(t, "cg-dts-src-");
  writeFileSync(join(dir, "types.d.ts"), "export type Point = { x: number; y: number };\n");
  writePackageJson(dir, {
    sources: ["types.d.ts"],
    tests: [],
    thresholds: STRICT_THRESHOLDS,
  });

  await assertGateFails(dir, /not a TypeScript source file/);
});

// ---------------------------------------------------------------------------
// Failure: ignore entry not under sources
// ---------------------------------------------------------------------------

test("coverage gate fails when an ignore entry is not under sources", async (t) => {
  const dir = createGateFixture(t, "cg-ignore-missing-", {
    gate: { ignore: ["not-walked.ts"] },
  });

  await assertGateFails(dir, /not under.*sources/);
});

// ---------------------------------------------------------------------------
// Failure: empty source walk
// ---------------------------------------------------------------------------

test("coverage gate fails when the source walk finds no files", async (t) => {
  const dir = createBareFixture(t, "cg-empty-walk-");
  writePackageJson(dir, {
    sources: ["."],
    tests: [],
    thresholds: STRICT_THRESHOLDS,
  });

  await assertGateFails(dir, /no files/);
});

// ---------------------------------------------------------------------------
// Failure: threshold miss
// ---------------------------------------------------------------------------

test("coverage gate fails when coverage falls below the threshold", async (t) => {
  // Source has two functions but the test only exercises one.
  const dir = createGateFixture(t, "cg-threshold-miss-", {
    sourceContent: [
      "export const value = 42;",
      "export function uncovered(): number { return 99; }",
      "",
    ].join("\n"),
  });

  const { code } = await runGate(dir);
  assert.notStrictEqual(code, 0, "gate should fail when coverage is below threshold");
});

// ---------------------------------------------------------------------------
// Failure: missing source in coverage report (untested file)
// ---------------------------------------------------------------------------

test("coverage gate fails when a source file is never loaded by any test", async (t) => {
  // The test imports src but never imports untested.
  const dir = createGateFixture(t, "cg-untested-", {
    gate: { thresholds: ZERO_THRESHOLDS },
  });
  writeSource(dir, "untested", "export const other = 1;\n");

  const stderr = await assertGateFails(dir, /never loaded/);
  assert.match(stderr, /untested\.ts/);
});

// ---------------------------------------------------------------------------
// Failure: no coverageGate config in package.json
// ---------------------------------------------------------------------------

test("coverage gate fails when package.json has no coverageGate block", async (t) => {
  const dir = createBareFixture(t, "cg-no-config-");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "no-gate" }));

  await assertGateFails(dir, /no.*coverageGate.*block/);
});

// ---------------------------------------------------------------------------
// Failure: ignore entry with no compiled output
// ---------------------------------------------------------------------------

test("coverage gate fails when an ignored file has no compiled output", async (t) => {
  // Create a type-only source and list it in both sources and ignore.
  // Do NOT create dist/types.js — the gate should detect the missing output.
  const dir = createGateFixture(t, "cg-ignore-no-emit-", {
    gate: { ignore: ["types.ts"] },
  });
  writeFileSync(join(dir, "types.ts"), "export type Point = { x: number; y: number };\n");

  await assertGateFails(dir, /no compiled output/);
});

// ---------------------------------------------------------------------------
// Failure: ignore entry that emits runtime code
// ---------------------------------------------------------------------------

test("coverage gate fails when an ignored file emits runtime code", async (t) => {
  // Create a source file with runtime code and list it in ignore.
  const dir = createGateFixture(t, "cg-ignore-runtime-", {
    gate: { ignore: ["runtime.ts"] },
  });
  writeSource(dir, "runtime");
  // Manually create the compiled output with runtime code.
  writeCompiledFile(dir, "runtime", "export const value = 42;\n");

  await assertGateFails(dir, /emits runtime code/);
});

// ---------------------------------------------------------------------------
// Success: ignore entry that is genuinely type-only
// ---------------------------------------------------------------------------

test("coverage gate passes when an ignored file is genuinely type-only", async (t) => {
  // Create a type-only source.
  const dir = createGateFixture(t, "cg-ignore-typeonly-", {
    gate: { ignore: ["types.ts"] },
  });
  writeFileSync(join(dir, "types.ts"), "export type Point = { x: number; y: number };\n");
  // Manually create the compiled output with only `export {};`.
  writeCompiledFile(dir, "types", "export {};\n");

  const { code, stderr } = await runGate(dir);
  assert.strictEqual(code, 0, `a type-only ignore entry should pass; stderr: ${stderr}`);
});

// ---------------------------------------------------------------------------
// Failure: resolveEmitPaths fails (broken tsconfig)
// ---------------------------------------------------------------------------

test("coverage gate fails when tsc is unavailable to resolve emit paths", async (t) => {
  const dir = createGateFixture(t, "cg-no-tsc-", { gate: { ignore: ["src.ts"] } });

  // Run with a PATH that has no `tsc` so `resolveEmitPaths` cannot reach the
  // compiler. `tsc --showConfig` is extremely lenient — it happily reads a
  // broken tsconfig and emits defaults — so an unreachable compiler is the
  // only reliable way to exercise the "could not resolve" failure. Bypass
  // `runGate` (which prepends `NODE_MODULES_BIN` to PATH) and call
  // `captureOutput` + `runCoverageGate` directly with a bare PATH.
  const savedPath = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const { code, stderr } = await captureOutput(() => Promise.resolve(runCoverageGate(dir, "ignore")));
    assert.strictEqual(code, 1);
    assert.match(stderr, /could not resolve.*tsconfig/);
  } finally {
    process.env.PATH = savedPath;
  }
});

// ---------------------------------------------------------------------------
// Success: threshold at 0 passes with partial coverage
// ---------------------------------------------------------------------------

test("coverage gate passes at zero threshold with an untested but loaded source", async (t) => {
  const dir = createGateFixture(t, "cg-zero-threshold-", {
    sourceContent: [
      "export const value = 42;",
      "export function unused(): number { return 99; }",
      "",
    ].join("\n"),
    gate: { thresholds: ZERO_THRESHOLDS },
  });

  const { code, stderr } = await runGate(dir);
  assert.strictEqual(code, 0, `a zero threshold should pass; stderr: ${stderr}`);
});

// ---------------------------------------------------------------------------
// File source entry — collectSources returns a file entry directly
// ---------------------------------------------------------------------------

test("coverage gate accepts a single .ts file as a source entry", async (t) => {
  const dir = createGateFixture(t, "cg-file-source-", { gate: { sources: ["src.ts"] } });

  const { code, stdout, stderr } = await runGate(dir);
  assert.strictEqual(code, 0, `a file source entry should pass; stderr: ${stderr}`);
  assert.match(stdout, /thresholds met/);
});

// ---------------------------------------------------------------------------
// Recursive directory walk — collectSources descends into subdirectories
// ---------------------------------------------------------------------------

test("coverage gate walks subdirectories to find source files", async (t) => {
  const dir = createGateFixture(t, "cg-recursive-walk-");
  // Replace the flat source with one in a subdirectory (not in
  // DEFAULT_SKIP_DIRS) whose test imports the nested source.
  rmSync(join(dir, "src.ts"));
  rmSync(join(dir, "test", "src.test.ts"), { force: true });
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "utils.ts"), "export const value = 42;\n");
  writeFileSync(join(dir, "test", "utils.test.ts"), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { value } from "../lib/utils.ts";',
    'test("value is 42", () => { assert.strictEqual(value, 42); });',
    "",
  ].join("\n"));
  writePackageJson(dir, {
    sources: ["."],
    tests: ["test/utils.test.ts"],
    thresholds: STRICT_THRESHOLDS,
  });

  const { code, stdout, stderr } = await runGate(dir);
  assert.strictEqual(code, 0, `recursive walk should find lib/utils.ts; stderr: ${stderr}`);
  assert.match(stdout, /thresholds met/);
});

// ---------------------------------------------------------------------------
// Re-throw non-CoverageGateFailure errors from collectSources
// ---------------------------------------------------------------------------

test("coverage gate propagates unexpected filesystem errors from the source walk", async (t) => {
  const dir = createBareFixture(t, "cg-walk-error-");
  writePackageJson(dir, {
    sources: ["."],
    tests: [],
    thresholds: STRICT_THRESHOLDS,
  });
  const filesystemError = Object.assign(new Error("source walk failed"), { code: "EIO" });
  await assert.rejects(
    () => captureOutput(() => Promise.resolve(runCoverageGate(dir, "ignore", {
      sourceCollector: () => { throw filesystemError; },
    }))),
    (err: unknown) => err === filesystemError,
    "the gate must re-throw the original filesystem error",
  );
});

// ---------------------------------------------------------------------------
// Re-throw non-CoverageGateFailure errors from resolveEmitPaths
// ---------------------------------------------------------------------------

test("coverage gate propagates non-JSON tsc output as an unexpected error", async (t) => {
  // Create a fake `tsc` that exits 0 but prints non-JSON — JSON.parse will
  // throw SyntaxError, which is not a CoverageGateFailure and must be re-thrown.
  const dir = createGateFixture(t, "cg-bad-tsc-output-", { gate: { ignore: ["src.ts"] } });
  const fakeTsc = writeNodeCommand(dir, "fake-tsc", 'console.log("this is not json");\n');

  await assert.rejects(
    () => runGateWithCompiler(dir, fakeTsc),
    (err: unknown) => err instanceof SyntaxError,
    "the gate must re-throw the JSON.parse SyntaxError, not swallow it",
  );
});

// ---------------------------------------------------------------------------
// spawnSync error — the test runner binary cannot start
// ---------------------------------------------------------------------------

test("coverage gate reports a runner startup failure when the binary is missing", async (t) => {
  const dir = createGateFixture(t, "cg-spawn-error-");

  const { code, stderr } = await captureOutput(() => Promise.resolve(runCoverageGate(dir, "ignore", {
    runner: { executable: "/nonexistent-node-binary", args: [] },
  })));
  assert.strictEqual(code, 1);
  assert.match(stderr, /failed to start the test runner/);
});

// ---------------------------------------------------------------------------
// No coverage report — the test runner exits 0 but writes no lcov file
// ---------------------------------------------------------------------------

test("coverage gate reports a missing coverage report when the runner exits 0 but writes nothing", async (t) => {
  const dir = createGateFixture(t, "cg-no-report-");
  const fakeNode = writeNodeCommand(dir, "fake-node", "process.exit(0);\n");

  const { code, stderr } = await runGateWithRunner(dir, fakeNode);
  assert.strictEqual(code, 1);
  assert.match(stderr, /no coverage report was written/);
});

// ---------------------------------------------------------------------------
// Script entry point — the module runs the gate when executed directly
// ---------------------------------------------------------------------------

test("runScriptEntry runs the gate and exits when argv[1] matches the script path", async (t) => {
  const dir = createGateFixture(t, "cg-entry-fn-");

  // Compute the absolute path of the coverage-gate script so we can set
  // process.argv[1] to match what `fileURLToPath(import.meta.url)` resolves to
  // inside the script module.
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "coverage-gate.ts");
  const savedArgv1 = process.argv[1];
  const savedExit = process.exit;
  let exitCode: number | undefined;
  process.argv[1] = scriptPath;
  // Mock process.exit so the true branch runs without killing the test runner.
  process.exit = ((code?: number) => { exitCode = code; }) as typeof process.exit;
  try {
    runScriptEntry(dir);
    assert.strictEqual(exitCode, 0, "the gate should pass and call process.exit(0)");
  } finally {
    process.argv[1] = savedArgv1;
    process.exit = savedExit;
  }
});

// ---------------------------------------------------------------------------
// resolveEmitPaths: stderr in error message (line 163 true branch)
// ---------------------------------------------------------------------------

test("coverage gate includes tsc stderr in the resolve-failure message", async (t) => {
  // Create a fake `tsc` that exits 1 with stderr — the gate should include
  // the stderr text in the CoverageGateFailure message.
  const dir = createGateFixture(t, "cg-tsc-stderr-", { gate: { ignore: ["src.ts"] } });
  const fakeTsc = writeNodeCommand(dir, "fake-tsc", 'console.error("tsconfig syntax error");\nprocess.exit(1);\n');

  const { code, stderr } = await runGateWithCompiler(dir, fakeTsc);
  assert.strictEqual(code, 1);
  assert.match(stderr, /could not resolve.*tsconfig/);
  assert.match(stderr, /tsconfig syntax error/, "the tsc stderr must appear in the message");
});

// ---------------------------------------------------------------------------
// resolveEmitPaths: missing compilerOptions uses defaults (lines 169-170)
// ---------------------------------------------------------------------------

test("coverage gate uses default emit paths when tsc output has no compilerOptions", async (t) => {
  // Two source files: one type-only (ignored), one with runtime code (tested).
  // Manually create the compiled output for the type-only file.
  const dir = createGateFixture(t, "cg-no-compopts-", {
    sourceName: "main",
    gate: { thresholds: ZERO_THRESHOLDS, ignore: ["types.ts"] },
  });
  writeFileSync(join(dir, "types.ts"), "export type Point = { x: number; y: number };\n");
  writeCompiledFile(dir, "types", "export {};\n");
  // Fake `tsc` that outputs `{}` — no compilerOptions, so defaults are used.
  const fakeTsc = writeNodeCommand(dir, "fake-tsc", 'console.log("{}");\n');

  const { code, stdout, stderr } = await runGateWithCompiler(dir, fakeTsc);
  assert.strictEqual(code, 0, `gate should pass with default emit paths; stderr: ${stderr}`);
  assert.match(stdout, /thresholds met/);
});

// ---------------------------------------------------------------------------
// result.status null fallback (line 380)
// ---------------------------------------------------------------------------

test("coverage gate returns 1 when the test runner is killed by a signal", async (t) => {
  const dir = createGateFixture(t, "cg-signal-kill-");

  // Fake "node" that kills itself with SIGTERM — spawnSync returns
  // status: null, signal: 'SIGTERM', error: undefined, so the gate reaches
  // `result.status ?? 1` and returns the fallback 1.
  const fakeNode = writeNodeCommand(dir, "fake-node", 'process.kill(process.pid, "SIGTERM");\n');
  const { code } = await runGateWithRunner(dir, fakeNode);
  assert.strictEqual(code, 1, "a signal-killed runner should yield exit code 1");
});

// ---------------------------------------------------------------------------
// Absolute SF: path in lcov report (line 399 true branch)
// ---------------------------------------------------------------------------

test("coverage gate normalises absolute SF: paths in the lcov report", async (t) => {
  const dir = createGateFixture(t, "cg-abs-lcov-", { gate: { thresholds: ZERO_THRESHOLDS } });

  // Fake "node" that writes an lcov file with an absolute SF: path, then
  // exits 0. The gate must normalise the absolute path to a repo-relative
  // one so the presence check matches the walked source set.
  const fakeNode = writeNodeCommand(dir, "fake-node", [
    'import { writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    'const prefix = "--test-reporter-destination=";',
    'const destination = process.argv.find((argument) => argument.startsWith(prefix) && argument !== `${prefix}stdout`);',
    'if (destination) writeFileSync(destination.slice(prefix.length), `SF:${join(process.cwd(), "src.ts")}\\nend_of_record\\n`);',
    "",
  ].join("\n"));
  const { code, stdout, stderr } = await runGateWithRunner(dir, fakeNode);
  assert.strictEqual(code, 0, `gate should pass with absolute SF: paths; stderr: ${stderr}`);
  assert.match(stdout, /thresholds met/);
});