import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Questions } from "@typesafe-ai/sdk";
import { scenario, answers, trackerSnapshot } from "./fixtures.ts";
import { getSettingsPath } from "@unbrained/pm-cli/sdk";
import { EMBEDDING_MODEL } from "../exemplar-retrieval.ts";
import { installBuiltExtension, runBuiltCommand } from "./replay-fixtures.ts";
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


test("embedding HTTP 503 under --retrieval embedding --max-calls 1 persists one failed attempt and zero completions without Git", async () => {
  await scenario(async (fixture, server) => {
    await fixture.pm.create({ id: "synthetic-embedding", type: "Issue", title: "Synthetic embedding failure", priority: "1" });
    const settingsPath = getSettingsPath(fixture.pmRoot);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    writeFileSync(settingsPath, JSON.stringify({ ...settings, jev: { timeout_ms: 1000 } }));
    installBuiltExtension(fixture.pmRoot);
    const before = trackerSnapshot(fixture.pmRoot);
    for (const failure of ["http503", "malformed", "timeout"] as const) {
      let embeddings = 0, decisions = 0;
      server.setReply((request, response, body) => {
        if (request.url === "/api/tags") {
          response.end(JSON.stringify({ models: [{ digest: "f".repeat(64), name: "tev1:4b" }, { name: EMBEDDING_MODEL }] })); return;
        }
        if (request.url === "/api/embed") {
          embeddings++;
          if (failure === "timeout") return;
          response.statusCode = failure === "http503" ? 503 : 200;
          response.end(failure === "http503" ? '{"error":"PRIVATE_EMBEDDING_DETAIL"}' : '{"embeddings":[]}'); return;
        }
        decisions++;
        response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
      });
      const file = join(fixture.cwd, `embedding-${failure}.json`);
      await assert.rejects(runBuiltCommand(fixture, ["jev", "eval", "--task", "triage", "--from", fixture.pmRoot,
        "--local-unverified", "--retrieval", "embedding", "--max-calls", "1", "--sample", "1", "--receipt", file, "--json"]), error => {
        const rejected = error as { code: number; stdout: string };
        assert.equal(rejected.code, 2);
        const result = JSON.parse(rejected.stdout) as { ok: boolean; exit_code: number; receipt: PartialReceipt; refusal: { code: string; remedy: string } };
        assert.equal(result.ok, false); assert.equal(result.exit_code, 2);
        assert.equal(result.receipt.completed_calls, 0);
        assert.equal(result.receipt.attempted_calls, 1); assert.equal(result.receipt.inference_calls, 1); assert.equal(result.receipt.model_calls, 0);
        assert.equal(result.receipt.status, "interrupted"); assert.deepEqual(result.receipt.completed_cases, []);
        assert.equal(result.receipt.reason, failure === "timeout" ? "timeout" : "provider_error");
        assert.equal(result.receipt.tokens.unknown_calls, 1);
        assert.equal(result.receipt.tokens.known_input, 0); assert.equal(result.receipt.tokens.known_output, 0);
        assert.equal(result.receipt.tokens.input, null); assert.equal(result.receipt.tokens.output, null); assert.equal(result.receipt.cost.amount, null);
        assert.equal(result.refusal.code, "run_interrupted"); assert.ok(result.refusal.remedy.length > 20);
        assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), result.receipt);
        assert.doesNotMatch(rejected.stdout, /PRIVATE_EMBEDDING_DETAIL|Synthetic embedding failure|\/tmp\//);
        return true;
      });
      assert.equal(embeddings, 1); assert.equal(decisions, 0);
      assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    }
  });
});
