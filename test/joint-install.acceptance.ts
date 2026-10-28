/** Exercise the exact same packed bytes through global symlinks and local package runners. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, devNull } from "node:os";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("one archive validates through npm global, Bun global, project-local, npx and bunx installs", { timeout: 900000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "jev-joint-install-"));
  const root = resolve(".");
  // A minimal child environment avoids forwarding ambient registry/provider credentials.
  const env = { PATH: process.env.PATH, HOME: scratch, TMPDIR: scratch, NPM_CONFIG_USERCONFIG: devNull, npm_config_userconfig: devNull,
    NPM_CONFIG_CACHE: join(scratch, "npm-cache"), BUN_INSTALL: join(scratch, "bun"), BUN_INSTALL_GLOBAL_DIR: join(scratch, "bun-global"), BUN_INSTALL_BIN: join(scratch, "bun-bin"),
    BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache"), PM_AUTHOR: "fixture", PM_TELEMETRY_OPT_OUT: "1", GIT_CEILING_DIRECTORIES: scratch };
  const pin = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { devDependencies: Record<string, string> }).devDependencies["@unbrained/pm-cli"];
  const host = `@unbrained/pm-cli@${pin}`;
  try {
    const packed = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root, env, timeout: 120000 });
    const manifest = (JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[])[0];
    const archive = join(scratch, manifest.filename);
    const digest = createHash("sha512").update(readFileSync(archive)).digest("hex");
    for (const path of ["dist/joint-decisions.js", "docs/joint-decisions.md", "docs/joint-decisions-evidence.json", "examples/joint-decisions.json"]) assert.ok(manifest.files.some(file => file.path === path));
    const local = join(scratch, "local"), npmGlobal = join(scratch, "npm-global"); mkdirSync(local);
    writeFileSync(join(local, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await execute("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", archive, host], { cwd: local, env, timeout: 600000 });
    await execute("npm", ["install", "--global", "--prefix", npmGlobal, "--ignore-scripts", "--no-audit", "--no-fund", archive, host], { cwd: scratch, env, timeout: 600000 });
    await execute("bun", ["add", "--global", "--ignore-scripts", archive, host], { cwd: scratch, env, timeout: 600000 });
    const npmBin = join(npmGlobal, "bin", "pm"), bunBin = join(scratch, "bun-bin", "pm"), localBin = join(local, "node_modules/.bin/pm");
    assert.ok(existsSync(npmBin)); assert.ok(existsSync(bunBin));
    const modes = [
      { name: "project-local", bin: localBin, args: [], cwd: local },
      { name: "npm-global", bin: npmBin, args: [], cwd: join(scratch, "npm-tracker") },
      { name: "bun-global", bin: bunBin, args: [], cwd: join(scratch, "bun-tracker") },
      { name: "npx", bin: "npx", args: ["--no-install", "pm"], cwd: local },
      { name: "bunx", bin: "bunx", args: ["--bun", "--no-install", "pm"], cwd: local },
    ];
    for (const mode of modes) {
      mkdirSync(mode.cwd, { recursive: true });
      const tracker = join(scratch, `tracker-${mode.name}`);
      mkdirSync(tracker);
      const runtimeEnv = { ...env, PM_PATH: join(tracker, ".agents/pm"), PM_GLOBAL_PATH: join(scratch, `global-${mode.name}`), PATH: `${join(local, "node_modules/.bin")}:${env.PATH}` };
      await execute(mode.bin, [...mode.args, "init", "synthetic", "--defaults", "--agent-guidance", "skip"], { cwd: mode.cwd, env: runtimeEnv, timeout: 120000 });
      await execute(mode.bin, [...mode.args, "install", archive], { cwd: mode.cwd, env: runtimeEnv, timeout: 120000 });
      const file = join(scratch, "batch.json");
      writeFileSync(file, readFileSync(join(root, "examples/joint-decisions.json")));
      const refused = await execute(mode.bin, [...mode.args, "--json", "jev", "validate", "--batch", file], { cwd: mode.cwd, env: runtimeEnv, timeout: 120000 }).then(() => { throw new Error("incompatible archive example passed"); }, error => error as { code: number; stdout: string });
      assert.equal(refused.code, 1); const report = JSON.parse(refused.stdout) as { ok: boolean; mutations: number; violations: { witness: unknown[] }[] };
      assert.equal(report.ok, false); assert.equal(report.mutations, 0); assert.equal(report.violations[0].witness.length, 2);
      const good = JSON.parse(readFileSync(file, "utf8")) as { result: { answers: { is_feature: { choice: string } } } };
      good.result.answers.is_feature.choice = "no"; writeFileSync(file, JSON.stringify(good));
      assert.equal(JSON.parse((await execute(mode.bin, [...mode.args, "--json", "jev", "validate", "--batch", file], { cwd: mode.cwd, env: runtimeEnv, timeout: 120000 })).stdout).ok, true);
      const ids: string[] = [];
      for (const title of ["First native target", "Second native target"]) {
        const created = await execute(mode.bin, [...mode.args, "--json", "create", "Task", title, "--parent", "none", "--blocked-by", "none", "--goal", "none", "--objective", "none"], { cwd: mode.cwd, env: runtimeEnv, timeout: 120000 });
        ids.push((JSON.parse(created.stdout) as { id: string }).id);
      }
      const graph = JSON.parse(readFileSync(join(root, "examples/joint-decisions.json"), "utf8")) as { constraints: unknown[] };
      graph.constraints = ids.map((source, i) => ({ id: `edge${i}`, kind: "relationship", when: { question: "is_bug", value: "yes" }, source, target: ids[1 - i], relationship: "blocks" }));
      writeFileSync(file, JSON.stringify(graph));
      const native = await execute(mode.bin, [...mode.args, "--json", "jev", "validate", "--batch", file], { cwd: mode.cwd, env: runtimeEnv, timeout: 120000 }).then(() => { throw new Error("native cycle passed"); }, error => error as { code: number; stdout: string });
      assert.equal(native.code, 1); assert.equal(JSON.parse(native.stdout).violations[0].code, "relationship_ordering");
      assert.equal(createHash("sha512").update(readFileSync(archive)).digest("hex"), digest);
      console.log(`${mode.name}: packed conflict, compatible batch and host SDK relationship cycle passed`);
    }
    const code = 'import {validateJointDecisions} from "pm-jev"; import {readFileSync} from "node:fs"; const raw=JSON.parse(readFileSync(process.argv[1],"utf8")); const r=await validateJointDecisions(raw); if(r.ok || r.violations[0].witness.length!==2) throw new Error("packed SDK failed");';
    await execute(process.execPath, ["--input-type=module", "-e", code, join(root, "examples/joint-decisions.json")], { cwd: local, env, timeout: 120000 });
    console.log(`packed SDK: passed; sha512=${digest}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
