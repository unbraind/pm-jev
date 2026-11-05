import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { npmInvocation } from "./admission-install-fixtures.ts";

const execute = promisify(execFile);

test("package runners bypass Windows cmd shims and follow POSIX symlinks with literal arguments", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "jev-runner-"));
  try {
    const bin = join(scratch, "space bin");
    const scripts = join(bin, "node_modules/npm/bin");
    mkdirSync(scripts, { recursive: true });
    const linked = join(scratch, "linked bin"); mkdirSync(linked);
    for (const command of ["npm", "npx"] as const) {
      writeFileSync(join(bin, `${command}.cmd`), "@exit /b 99\r\n");
      writeFileSync(join(scripts, `${command}-cli.js`), 'console.log(JSON.stringify(process.argv.slice(2)))');
      const args = ["a path with spaces", "literal & argument"];
      const searchPaths = [bin];
      if (process.platform !== "win32") {
        symlinkSync(join(scripts, `${command}-cli.js`), join(linked, command));
        searchPaths.push(linked);
      }
      for (const searchPath of searchPaths) {
        const invocation = npmInvocation(command, args, searchPath);
        const result = await execute(invocation.bin, invocation.args, { env: { PATH: searchPath, SystemRoot: process.env.SystemRoot } });
        assert.deepEqual(JSON.parse(result.stdout), args);
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("Node packed admission smoke stays offline and logs an explicit Bun skip without Bun in PATH", { timeout: 600000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "jev-node-only-"));
  try {
    // Include Node, the npm shell, and the existing npm module, without Bun or package-manager shims.
    const modules = join(scratch, "node_modules"); mkdirSync(modules);
    const cli = npmInvocation("npm", []).args[0];
    symlinkSync(resolve(dirname(cli), ".."), join(modules, "npm"), "junction");
    copyFileSync(process.execPath, join(scratch, process.platform === "win32" ? "node.exe" : "node"));
    if (process.platform !== "win32") symlinkSync("/bin/sh", join(scratch, "sh"));
    const result = await execute(process.execPath, ["--test", "--test-concurrency=2", "test/admission-docs-install.test.ts"], {
      cwd: resolve("."), env: { PATH: scratch, SystemRoot: process.env.SystemRoot }, timeout: 540000, maxBuffer: 1024 * 1024,
    });
    assert.match(result.stdout, /Bun is unavailable; Node admission coverage remains active/);
    assert.match(result.stdout, /2 commands passed offline/);
    assert.match(result.stdout, /skip(?:ped)?[: ]+1/i);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
