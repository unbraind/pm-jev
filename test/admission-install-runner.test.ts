import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { npmInvocation } from "./admission-install-fixtures.ts";

const execute = promisify(execFile);

test("default npm discovery works with only native shims in PATH and no npm caller", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "jev-native-shims-"));
  try {
    for (const command of ["npm", "npx"]) writeFileSync(join(scratch, command), "native shim");
    const code = `import { npmInvocation } from ${JSON.stringify(new URL("./admission-install-fixtures.ts", import.meta.url).href)};
      console.log(JSON.stringify(["npm", "npx"].map(command => npmInvocation(command, []).args[0])));`;
    const result = await execute(process.execPath, ["--input-type=module", "-e", code], {
      env: { PATH: scratch, HOME: scratch, NPM_CONFIG_USERCONFIG: devNull, SystemRoot: process.env.SystemRoot },
    });
    const paths = JSON.parse(result.stdout) as string[];
    assert.equal(paths.length, 2);
    for (const [index, command] of ["npm", "npx"].entries()) {
      assert.equal(statSync(paths[index]).isFile(), true);
      assert.equal(paths[index].endsWith(`${command}-cli.js`), true);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("package runners ignore native PATH shims and preserve literal arguments", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "jev-runner-"));
  try {
    const bin = join(scratch, "space bin");
    const scripts = join(bin, "node_modules/npm/bin");
    mkdirSync(scripts, { recursive: true });
    const node = join(bin, process.platform === "win32" ? "node.exe" : "node");
    copyFileSync(process.execPath, node);
    for (const command of ["npm", "npx"] as const) {
      // Native/shim stand-ins must never be executed or interpreted as JavaScript.
      writeFileSync(join(bin, command), "native shim");
      writeFileSync(join(bin, `${command}.cmd`), "@exit /b 99\r\n");
      writeFileSync(join(scripts, `${command}-cli.js`), 'console.log(JSON.stringify(process.argv.slice(2)))');
      const args = ["a path with spaces", "literal & argument"];
      const invocation = npmInvocation(command, args, {
        execPath: node, platform: process.platform,
        /** Only actual installed files qualify. */
        isFile: file => existsSync(file) && statSync(file).isFile(),
      });
      const result = await execute(invocation.bin, invocation.args, { env: { PATH: bin, SystemRoot: process.env.SystemRoot } });
      assert.deepEqual(JSON.parse(result.stdout), args);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("npm entrypoints resolve verified POSIX and win32 installation fixtures without PATH", () => {
  const scratch = mkdtempSync(join(tmpdir(), "jev-layout-"));
  try {
    for (const platform of ["linux", "win32"] as const) {
      const path = platform === "win32" ? win32 : posix;
      const root = platform === "win32" ? "C:\\runtime" : "/opt/runtime";
      const node = path.join(root, "bin", platform === "win32" ? "node.exe" : "node");
      const nativeNode = path.join(root, platform === "win32" ? "node.exe" : "node");
      for (const [index, layout] of [
        { execPath: node, base: path.join(root, "lib/node_modules/npm/bin") },
        { execPath: nativeNode, base: path.join(root, "node_modules/npm/bin") },
        { execPath: node, base: path.join(root, "custom/npm/bin"), npmExecPath: path.join(root, "custom/npm/bin/npm-cli.js") },
      ].entries()) {
        const files = join(scratch, platform, String(index)); mkdirSync(files, { recursive: true });
        for (const command of ["npm", "npx"] as const) writeFileSync(join(files, `${command}-cli.js`), "// fixture");
        /** Map foreign path syntax onto real fixture files on this host. */
        const isFile = (candidate: string) => {
          if (path.dirname(candidate) !== layout.base) return false;
          const fixture = join(files, path.basename(candidate));
          return existsSync(fixture) && statSync(fixture).isFile();
        };
        for (const command of ["npm", "npx"] as const) {
          assert.deepEqual(npmInvocation(command, ["literal & argument"], { ...layout, platform, isFile }), {
            bin: layout.execPath, args: [path.join(layout.base, `${command}-cli.js`), "literal & argument"],
          });
        }
        // A missing requested CLI must refuse even if its sibling CLI is installed.
        rmSync(join(files, "npx-cli.js")); mkdirSync(join(files, "npx-cli.js"));
        assert.throws(() => npmInvocation("npx", [], { ...layout, platform, isFile }), /Cannot locate the installed npx-cli\.js; install npm alongside Node/);
      }
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("npm caller paths select the requested CLI and fall back only to verified Node installation files", () => {
  const execPath = posix.join("/opt", "runtime/bin/node");
  const npmCli = posix.join("/opt", "caller/npm-cli.js");
  const npxCli = posix.join("/opt", "caller/npx-cli.js");
  const fallback = posix.join("/opt", "runtime/lib/node_modules/npm/bin/npm-cli.js");
  const files = new Set([npmCli, npxCli, fallback]);
  const installation = {
    execPath, platform: "linux" as const,
    /** The fixture's explicit installed-file inventory. */
    isFile: (file: string) => files.has(file),
  };
  assert.equal(npmInvocation("npm", [], { ...installation, npmExecPath: npxCli }).args[0], npmCli);
  assert.equal(npmInvocation("npx", [], { ...installation, npmExecPath: npmCli }).args[0], npxCli);
  for (const npmExecPath of [undefined, "", "relative/npm-cli.js", "/opt/native-shim", "/missing/npm-cli.js"]) {
    assert.equal(npmInvocation("npm", [], { ...installation, npmExecPath }).args[0], fallback);
  }
  files.clear();
  assert.throws(() => npmInvocation("npm", [], installation), /valid npm_execpath/);
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
