/** Exercise packed consumers and live local decisions with an explicitly matched host SDK. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir, devNull } from "node:os";
import test from "node:test";
import { project } from "./fixtures.ts";

const execute = promisify(execFile);

test("packed npm and Bun consumers import the library; pm installs the local extension and runs live triage", { timeout: 240000 }, async () => {
  const root = resolve(".");
  const scratch = mkdtempSync(join(tmpdir(), "jev-install-"));
  const fixture = await project();
  /** Bind consumers to the same public SDK release used to initialize and mutate their tracker. */
  const installed = JSON.parse(readFileSync(createRequire(import.meta.url).resolve("@unbrained/pm-cli/package.json"), "utf8")) as { readonly version?: unknown };
  assert.ok(typeof installed.version === "string");
  assert.match(installed.version, /^\d+\.\d+\.\d+$/);
  /** Explicit peer installation prevents npm from selecting a newer incompatible mutation host. */
  const sdk = `@unbrained/pm-cli@${installed.version}`;
  const env: Record<string, string | undefined> = { ...process.env, PM_JEV_BASE_URL: "http://localhost:11434", PM_JEV_MODEL: "tev1:4b", PM_PATH: "", PM_GLOBAL_PATH: join(scratch, "global"), PM_TELEMETRY_OPT_OUT: "1", npm_config_userconfig: devNull, NPM_CONFIG_USERCONFIG: devNull };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
  try {
    const packed = await execute("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", scratch], { cwd: root });
    const tarball = join(scratch, (JSON.parse(packed.stdout) as { filename: string }[])[0].filename);
    for (const runtime of ["npm", "bun"]) {
      const cwd = runtime === "npm" ? fixture.cwd : join(scratch, runtime);
      if (runtime === "bun") mkdirSync(cwd);
      writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "synthetic-consumer", private: true, type: "module" }));
      const args = runtime === "npm" ? ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball, sdk] : ["add", "--ignore-scripts", tarball, sdk];
      await execute(runtime, args, { cwd, env, timeout: 120000 });
      const code = 'import {projectItemState,parseQuestionsDocument} from "pm-jev"; const state=projectItemState({id:"synthetic",title:"Synthetic",type:"Issue",status:"open",tags:[]});if(state.title!=="Synthetic"||parseQuestionsDocument({safe:{type:"noul"}}).safe.type!=="noul")throw new Error("library contract failed");console.log("packed consumer passed");';
      const result = await execute(runtime === "npm" ? process.execPath : "bun", ["--input-type=module", "-e", code], { cwd, env });
      assert.match(result.stdout, /packed consumer passed/);
      console.log(`${runtime}: packed library import passed`);
    }
    // The npm packed consumer already owns this tracker and installed SDK;
    // reuse it for activation instead of repeating the same dependency install.
    const localSource = join(scratch, "local-package");
    mkdirSync(localSource);
    await execute("tar", ["-xzf", tarball, "--strip-components=1", "-C", localSource]);
    await execute(join(root, "node_modules/.bin/pm"), ["install", localSource], { cwd: fixture.cwd, env, timeout: 120000 });
    const created = await fixture.pm.create({ type: "Feature", title: "Every login crashes with an unhandled exception", description: "Regression: the application closes and users cannot sign in", priority: 3 });
    for (const runtime of ["npm", "bun"]) {
      const executable = runtime === "npm" ? "npx" : "bunx";
      const args = [...(runtime === "bun" ? ["--bun"] : []), "--no-install", "pm", "--json", "jev", "triage", created.item.id];
      const result = await execute(executable, args, { cwd: fixture.cwd, env: { ...env, PATH: `${join(root, "node_modules/.bin")}:${env.PATH}` }, timeout: 120000 });
      const decision = JSON.parse(result.stdout) as { proposals: { type: { value: string } }; applied: string[]; model: string };
      assert.ok(["Issue", "Bug"].includes(decision.proposals.type.value));
      assert.deepEqual(decision.applied, []);
      assert.equal(decision.model, "tev1:4b");
      console.log(`${executable}: installed pm extension live triage passed`);
    }
    const pmBin = join(root, "node_modules/.bin/pm");
    const compact = await execute(pmBin, ["jev", "triage", created.item.id], { cwd: fixture.cwd, env, timeout: 120000 });
    assert.match(compact.stdout, /omitted_options: 8/);
    const full = await execute(pmBin, ["jev", "triage", created.item.id, "--full"], { cwd: fixture.cwd, env, timeout: 120000 });
    assert.doesNotMatch(full.stdout, /omitted_options/);
    assert.match(full.stdout, /Reminder: /);
    console.log("installed CLI: compact TOON and full flag passed");
    const safetyArgs = ["--json", "jev", "gate", "--noul", "The text contains a credential, API key or password.", "--expect", "false", "--text"];
    const secret = await execute(pmBin, [...safetyArgs, "Deploy with token ghp_SYNTHETIC_EXAMPLE_ONLY; password=synthetic-password"], { cwd: fixture.cwd, env }).then(() => { throw new Error("secret safety gate unexpectedly exited 0"); }, error => error as { code: number; stdout: string });
    assert.equal(secret.code, 1);
    const unsafe = JSON.parse(secret.stdout) as { holds: boolean; expected: boolean; ok: boolean };
    assert.deepEqual([unsafe.holds, unsafe.expected, unsafe.ok], [true, false, false]);
    const clean = await execute(pmBin, [...safetyArgs, "Please adjust the blue button alignment."], { cwd: fixture.cwd, env });
    const safe = JSON.parse(clean.stdout) as { holds: boolean; expected: boolean; ok: boolean };
    assert.deepEqual([safe.holds, safe.expected, safe.ok], [false, false, true]);
    console.log("installed CLI: secret safety gate exited 1; clean safety gate exited 0");
    const negative = await execute(join(root, "node_modules/.bin/pm"), ["--json", "jev", "gate", "--noul", "Does this text contain a password?", "--text", "A blue button needs alignment."], { cwd: fixture.cwd, env }).then(() => { throw new Error("negative gate unexpectedly passed"); }, error => error as { code: number; stdout: string });
    assert.equal(negative.code, 1);
    assert.equal((JSON.parse(negative.stdout) as { holds: boolean }).holds, false);
    console.log("installed CLI: negative gate emitted JSON and exited 1");
  } finally { fixture.dispose(); rmSync(scratch, { recursive: true, force: true }); }
});
