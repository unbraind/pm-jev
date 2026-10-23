import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import { scenario, answers, trackerSnapshot } from "./fixtures.ts";
import { installBuiltExtension } from "./replay-fixtures.ts";
import type { PartialReceipt } from "../index.ts";

test("built evaluation persists SIGINT, provider and budget receipts through native JSON and TOON without Git", async () => {
  await scenario(async (fixture, server) => {
    await fixture.pm.create({ id: "synthetic-first", type: "Issue", title: "Private synthetic source text", priority: "1" });
    await fixture.pm.create({ id: "synthetic-second", type: "Feature", title: "Another private synthetic source", priority: "2" });
    installBuiltExtension(fixture.pmRoot);
    const before = trackerSnapshot(fixture.pmRoot);
    for (const mode of ["provider", "sigint", "budget", "toon"] as const) {
      let attempts = 0;
      const file = join(fixture.cwd, `${mode}.json`);
      const flags = ["--receipt", file, "--run-deadline-ms", "120000", ...(mode === "budget" || mode === "toon" ? ["--max-calls", "1"] : [])];
      const child = spawn(process.execPath, [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", fixture.pmRoot,
        "jev", "eval", "--task", "triage", "--from", fixture.pmRoot, "--local-unverified", "--sample", "2", ...flags, ...(mode === "toon" ? [] : ["--json"])],
      { cwd: fixture.cwd, env: { ...process.env, PATH: "", GIT_CEILING_DIRECTORIES: dirname(fixture.cwd), PM_PATH: fixture.pmRoot, PM_GLOBAL_PATH: join(fixture.cwd, "global"), PM_JEV_BASE_URL: server.url }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
      server.setReply((request, response, body) => {
        if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: "e".repeat(64) }] })); return; }
        attempts++;
        if (attempts === 2) {
          if (mode === "sigint") { child.kill("SIGINT"); return; }
          response.statusCode = 503; response.end('{"error":"PRIVATE_PROVIDER_TEXT"}'); return;
        }
        response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
      });
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 180000);
      let code;
      try { code = await new Promise<number | null>((done, reject) => { child.once("error", reject); child.once("close", done); }); }
      finally { clearTimeout(killTimer); }
      assert.equal(code, 2, stderr);
      const receipt = JSON.parse(readFileSync(file, "utf8")) as PartialReceipt;
      assert.equal(receipt.attempted_calls, mode === "budget" || mode === "toon" ? 1 : 2);
      assert.equal(receipt.completed_calls, 1); assert.equal(receipt.completed_cases.length, 1);
      assert.equal(attempts, receipt.attempted_calls);
      assert.equal(receipt.reason, mode === "sigint" ? "sigint" : mode === "provider" ? "provider_error" : "budget_exhausted");
      if (mode === "toon") assert.match(stdout, /attempted_calls: 1/);
      else assert.deepEqual(JSON.parse(stdout).receipt, receipt);
      assert.doesNotMatch(stdout, /Private synthetic|Another private|PRIVATE_PROVIDER_TEXT|\/tmp\//);
      assert.ok(Buffer.byteLength(stdout) < 8192);
    }
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  });
});
