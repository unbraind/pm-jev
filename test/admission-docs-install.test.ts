import assert from "node:assert/strict";
import type { ExecFileOptions } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { decode } from "@toon-format/toon";
import { npmInvocation, unpackOfflineConsumer } from "./admission-install-fixtures.ts";
import { admissionMetadata } from "./admission-fixtures.ts";
import { endpoint, trackerSnapshot } from "./fixtures.ts";

const runFile = promisify(execFile);
/** Run package managers through Node on every platform, leaving native Bun executables direct. */
function execute(bin: string, args: string[], options: ExecFileOptions) {
  const invocation = bin === "npm" || bin === "npx" ? npmInvocation(bin, args, options.env?.PATH) : { bin, args };
  return runFile(invocation.bin, invocation.args, { ...options, encoding: "utf8" });
}

test("documented admission commands run unchanged through npx and bunx against one packed install", { timeout: 600000 }, async t => {
  const root = resolve(".");
  const scratch = mkdtempSync(join(tmpdir(), "jev-admission-docs-"));
  const server = await endpoint();
  const env = { PM_JEV_BASE_URL: server.url, PM_JEV_MODEL: "tev1:4b", PM_GLOBAL_PATH: join(scratch, "global"),
    NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_REGISTRY: "http://127.0.0.1:1", NPM_CONFIG_CACHE: join(scratch, "npm-cache"), PM_AUTHOR: "fixture", PATH: process.env.PATH,
    BUN_INSTALL_CACHE_DIR: join(scratch, "bun-cache"), HOME: scratch, PM_TELEMETRY_OPT_OUT: "1",
    SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, USERPROFILE: scratch, TEMP: scratch, TMP: scratch,
    NPM_CONFIG_USERCONFIG: devNull, TMPDIR: scratch, GIT_CEILING_DIRECTORIES: scratch, npm_config_userconfig: devNull };
  try {
    const packed = await execute("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch], { cwd: root, env, timeout: 120000 });
    const [manifest] = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string }>; filename: string }>;
    for (const path of ["examples/decision-admission.json", "docs/decision-admission.md", "dist/index.js"]) assert.ok(manifest.files.some(file => file.path === path));
    const archive = join(scratch, manifest.filename);
    const digest = createHash("sha512").update(readFileSync(archive)).digest("hex");
    const local = join(scratch, "consumer"); mkdirSync(local);
    writeFileSync(join(local, "package.json"), JSON.stringify({ private: true, type: "module" }));
    await unpackOfflineConsumer(root, local, archive);
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version: string }> };
    const host = JSON.parse(readFileSync(join(local, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { version: string };
    assert.equal(host.version, lock.packages["node_modules/@unbrained/pm-cli"].version);
    await execute("npx", ["--no-install", "pm", "init", "synthetic", "--defaults", "--agent-guidance", "skip"], { cwd: local, env, timeout: 120000 });
    await execute("npx", ["--no-install", "pm", "package", "install", "./node_modules/pm-jev"], { cwd: local, env, timeout: 120000 });
    const guide = readFileSync(join(local, "node_modules/pm-jev/docs/decision-admission.md"), "utf8");
    const block = guide.match(/```sh\n([\s\S]*?)\n```/); assert.ok(block);
    const commands = block[1].split("\n");
    assert.equal(commands.length, 4);
    const before = trackerSnapshot(join(local, ".agents/pm"));
    const receipts: unknown[] = [];
    /** Execute one unchanged documented command and inspect its non-mutating receipt. */
    const checkCommand = async (command: string) => {
      const [bin, ...args] = command.split(" ");
      assert.ok(bin === "npx" || bin === "bunx"); assert.ok(args.includes("--no-install"));
      const result = await execute(bin, args, { cwd: local, env, timeout: 120000 });
      const receipt = (args.includes("--json") ? JSON.parse(result.stdout) : decode(result.stdout)) as { ok: boolean; questions: number; options: number; inference_calls: number; mutations: number };
      assert.equal(receipt.ok, true); assert.equal(receipt.questions, 3); assert.equal(receipt.options, 7);
      assert.equal(receipt.inference_calls, 0); assert.equal(receipt.mutations, 0); receipts.push(receipt);
    };
    for (const command of commands.slice(0, 2)) await checkCommand(command);
    const bunAvailable = await execute("bunx", ["--version"], { env }).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    const skip = bunAvailable ? false : "Bun is unavailable; Node admission coverage remains active";
    if (skip) t.diagnostic(skip);
    await t.test("documented Bun commands", { skip }, async () => {
      for (const command of commands.slice(2)) await checkCommand(command);
    });
    assert.deepEqual(commands.map(command => command.split(" ")[0]), ["npx", "npx", "bunx", "bunx"]);
    assert.deepEqual(receipts, new Array(bunAvailable ? 4 : 2).fill(receipts[0]));
    assert.deepEqual(trackerSnapshot(join(local, ".agents/pm")), before); assert.equal(server.requests.length, 0);
    const example = commands[0];
    assert.ok(readFileSync(join(local, "node_modules/pm-jev/README.md"), "utf8").includes(`\`${example}\``));
    const help = await execute("npx", ["--no-install", "pm", "jev", "admit", "--help"], { cwd: local, env, timeout: 120000 });
    assert.ok(help.stdout.includes(example));
    await assert.rejects(execute("npx", ["--no-install", "pm", "jev", "admit", "--batch", "missing.json", "--json"], { cwd: local, env, timeout: 120000 }), error => {
      const failed = error as { code: number; stdout: string }; assert.equal(failed.code, 2);
      const report = JSON.parse(failed.stdout) as { refusal: { code: string; remedy: string }; admission?: unknown };
      assert.equal(report.refusal.code, "invalid_input"); assert.equal(report.admission, undefined);
      assert.ok(report.refusal.remedy.includes("node_modules/pm-jev/examples/decision-admission.json")); return true;
    });
    server.setAdmissionReply((request, response) => response.end(JSON.stringify(request.url === "/api/tags" ? { models: [{ name: "tev1:4b", digest: "b".repeat(64) }] } : admissionMetadata(2))));
    const [bin, ...args] = example.split(" ");
    await assert.rejects(execute(bin, args, { cwd: local, env, timeout: 120000 }), error => {
      const failed = error as { code: number; stdout: string }; assert.equal(failed.code, 1);
      const report = JSON.parse(failed.stdout) as { ok: boolean; minimum_prompt_tokens_to_remove: number; remedy: string };
      assert.equal(report.ok, false); assert.ok(report.minimum_prompt_tokens_to_remove > 0); assert.match(report.remedy, /Remove at least/); return true;
    });
    assert.deepEqual(trackerSnapshot(join(local, ".agents/pm")), before); assert.equal(server.requests.length, 0);
    assert.equal(createHash("sha512").update(readFileSync(archive)).digest("hex"), digest);
    console.log(`packed guide: ${receipts.length} commands passed offline (JSON/TOON); sha512=${digest}`);
  } finally { await server.close(); rmSync(scratch, { recursive: true, force: true }); }
});
