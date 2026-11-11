import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { prepareReleaseDependencies } from "../scripts/prepare-release-dependencies.ts";

const pm = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
const preparation = resolve("scripts/prepare-release-dependencies.ts");
const changelog = resolve("node_modules/pm-changelog/dist/cli.js");

test("dependency preparation makes an old-closed-only release window render and regenerate after tagging", () => {
  const root = mkdtempSync(join(tmpdir(), "release-dependency-"));
  const env = { ...process.env, PM_PATH: join(root, ".agents/pm"), PM_AUTHOR: "synthetic", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (bin: string, args: string[], extra: NodeJS.ProcessEnv = {}): string => execFileSync(bin, args, { cwd: root, env: { ...env, ...extra }, encoding: "utf8", stdio: "pipe" });
  const git = (...args: string[]): string => run("git", args);
  try {
    git("init");
    git("config", "user.name", "Release Fixture");
    git("config", "user.email", "fixture@example.invalid");
    run(process.execPath, [pm, "init", "pm-jev", "--defaults", "--agent-guidance", "skip"]);
    run(process.execPath, [pm, "create", "chore", "Previously delivered work", "--status", "closed", "--close-reason", "Delivered", "--completed-at", "2020-01-01T00:00:00Z"]);
    writeFileSync(join(root, "package.json"), '{"version":"2026.11.7"}\n');
    writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## 2026.11.7 - 2026-11-07\n\nPreviously delivered work.\n");
    git("add", ".agents", "package.json", "CHANGELOG.md");
    run("git", ["commit", "-m", "Release fixture"], { GIT_AUTHOR_DATE: "2026-11-07T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-07T12:00:00Z" });
    git("tag", "v2026.11.07");
    writeFileSync(join(root, "dependency.txt"), "synthetic update\n");
    git("add", "dependency.txt");
    git("commit", "-m", "Build(deps-dev): Bump synthetic dependency (#106)");
    writeFileSync(join(root, "package.json"), '{"version":"2026.11.11"}\n');
    const flags = ["--pm-root", ".agents/pm", "--pm-bin", pm, "--release-version-from-package", "--date-from-version", "--respect-item-release", "--status", "closed,in_progress"];
    const notes = [...flags, "--stdout", "--since-previous-tag", "--until-release-tag"];
    const before = spawnSync(process.execPath, [changelog, ...notes], { cwd: root, env, encoding: "utf8" });
    assert.notEqual(before.status, 0);
    assert.match(before.stderr, /MISSING_REQUESTED_RELEASE/);
    run(process.execPath, [preparation, "v2026.11.07"]);
    prepareReleaseDependencies(root, "v2026.11.07");
    const result = run(process.execPath, [changelog, ...notes]);
    assert.match(result, /## 2026\.11\.11/);
    assert.match(result, /Bump synthetic dependency/);
    assert.doesNotMatch(result, /Previously delivered work/);
    const histories = join(root, ".agents/pm/history");
    const history = join(histories, readdirSync(histories).find(name => name.startsWith("pm-jev-release-dependencies-"))!);
    assert.equal(readFileSync(history, "utf8").trim().split("\n").length, 1);
    writeFileSync(join(root, "dependency.txt"), "Another dependency update\n");
    git("add", "dependency.txt"); git("commit", "-m", "Build(deps): Bump another synthetic package (#107)");
    run(process.execPath, [preparation, "v2026.11.07"]);
    const refreshed = run(process.execPath, [changelog, ...notes]);
    assert.match(refreshed, /Bump synthetic dependency/);
    assert.match(refreshed, /Bump another synthetic package/);
    assert.equal(readdirSync(histories).filter(name => name.startsWith("pm-jev-release-dependencies-")).length, 2);
    run(process.execPath, [changelog, ...flags, "--all-release-tags", "--output", "CHANGELOG.md"]);
    git("add", ".agents", "package.json", "CHANGELOG.md");
    git("commit", "-m", "Prepare synthetic release");
    git("tag", "v2026.11.11");
    run(process.execPath, [changelog, ...flags, "--all-release-tags", "--output", "CHANGELOG.md", "--check"]);
    rmSync(history);
    assert.throws(() => prepareReleaseDependencies(root, "v2026.11.07"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("release workflow records and stages dependency evidence before generating notes", () => {
  const source = readFileSync(".github/workflows/release.yml", "utf8");
  const workflow = parse(source) as { jobs: { prepare: { steps: { name?: string; run?: string; env?: Record<string, string> }[] } } };
  const steps = workflow.jobs.prepare.steps;
  const preparation = steps.findIndex(step => step.name === "Record pending dependency changes");
  assert.ok(preparation >= 0 && preparation < steps.findIndex(step => step.name === "Generate changelog and release notes"));
  assert.match(steps[preparation].run ?? "", /node scripts\/prepare-release-dependencies\.ts "\$PREVIOUS_TAG"/);
  assert.equal(steps[preparation].env?.PREVIOUS_TAG, "${{ steps.decide.outputs.latest_tag }}");
  const commit = steps.find(step => step.name === "Commit release files")?.run ?? "";
  assert.match(commit, /\.agents\/pm\/chores\/pm-jev-release-dependencies-\*\.toon/);
  assert.match(commit, /\.agents\/pm\/history\/pm-jev-release-dependencies-\*\.jsonl/);
});

test("preparation skips absent ranges and plain directories and refuses invalid versions", () => {
  const root = mkdtempSync(join(tmpdir(), "release-no-git-"));
  try {
    prepareReleaseDependencies(root);
    writeFileSync(join(root, "package.json"), '{"version":"invalid"}');
    assert.throws(() => prepareReleaseDependencies(root, "v2026.11.07"), /numeric release version/);
    writeFileSync(join(root, "package.json"), '{"version":null}');
    assert.throws(() => prepareReleaseDependencies(root, "v2026.11.07"), /numeric release version/);
    writeFileSync(join(root, "package.json"), '{"version":"2026.11.11"}');
    prepareReleaseDependencies(root, "v2026.11.07");
    const result = spawnSync(process.execPath, [resolve("scripts/prepare-release-dependencies.ts")], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "add", "package.json"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic baseline"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["tag", "v2026.11.07"], { cwd: root });
    prepareReleaseDependencies(root, "v2026.11.07");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
