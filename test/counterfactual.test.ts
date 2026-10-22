import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { cpSync, mkdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Questions } from "@typesafe-ai/sdk";
import { CounterfactualRefusal, explainDecision, resolveJevEndpoint } from "../index.ts";
import { runExplanationCommand } from "../counterfactual-command.ts";
import type { CounterfactualOptions, CounterfactualReceipt } from "../index.ts";
import { answers, scenario, trackerSnapshot } from "./fixtures.ts";

const questions: Questions = {
  route: { type: "choice", criteria: { keep: null, change: null } },
  impact: { type: "score", criteria: ["minor", "major"] },
  sensitive: { type: "noul" },
};

/** Invoke the real SDK transport using an endpoint resolved from the scratch tracker. */
async function options(pmRoot: string): Promise<CounterfactualOptions> {
  return { endpoint: await resolveJevEndpoint(pmRoot, process.env), questions,
    evidence: { title: "Decisive evidence", tags: ["unrelated"], description: "Additional evidence" }, fields: ["tags", "title", "description"] };
}

test("removing unrelated fields preserves typed decisions; relevant fields change all three kinds", async () => {
  await scenario(async (fixture, server) => {
    server.setReply((_, response, body) => {
      const request = body as { state: Record<string, unknown>; questions: Questions };
      const strong = Object.hasOwn(request.state, "title");
      const p = strong ? 0.9 : 0.1;
      const result = answers(request.questions);
      result.answers.route = { type: "choice", choice: strong ? "keep" : "change", probabilities: { keep: p, change: 1 - p }, confidence: 0.9 };
      result.answers.impact = { type: "score", score: 0.2, probabilities: { "0": p, "1": 1 - p }, confidence: 0.9, legend: { "0": "minor", "1": "major" } };
      result.answers.sensitive = { type: "noul", noul: p };
      response.end(JSON.stringify(result));
    });
    const input = await options(fixture.pmRoot);
    const report = await explainDecision(input);
    assert.equal(report.complete, true);
    assert.deepEqual(report.calls, { attempted: 4, succeeded: 4, limit: 5, retries: 0 });
    assert.deepEqual(report.comparisons.map(row => row.changed), [[], ["route", "impact", "sensitive"], []]);
    assert.equal(report.comparisons[0].max_probability_delta, 0);
    assert.equal(report.comparisons[1].max_probability_delta, 0.8);
    assert.equal(report.baseline!.impact.value, 0, "score proposals use the winning rubric level");
    assert.equal(report.comparisons[1].proposals.impact.value, 1);
    assert.deepEqual(report.omitted, []);
    assert.equal(server.requests.length, 4);
    const states = server.requests.map(row => (row.body as { state: Record<string, unknown> }).state);
    assert.deepEqual(states, [input.evidence, { title: "Decisive evidence", description: "Additional evidence" }, { tags: ["unrelated"], description: "Additional evidence" }, { title: "Decisive evidence", tags: ["unrelated"] }]);
    assert.deepEqual(input.evidence, states[0], "caller evidence remains unchanged");
    assert.equal(new Set([report.evidence_digest, ...report.comparisons.map(row => row.evidence_digest)]).size, 4);
    assert.match(report.evidence_digest, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(JSON.stringify(report), /Decisive evidence|Additional evidence|unrelated/);
    assert.ok(report.uncertainty.includes("model_stochasticity_unmeasured"));
    assert.ok(report.uncertainty.includes("sensitivity_is_not_causation"));
    const again = await explainDecision(input);
    assert.equal(again.questions_sha256, report.questions_sha256);
    assert.notEqual(again.evidence_digest, report.evidence_digest, "evidence identities are opaque per run");
  });
});

test("budgets count the baseline, cap requests, preserve ordered omissions and allow the maximum", async () => {
  await scenario(async (fixture, server) => {
    const input = await options(fixture.pmRoot);
    for (const limit of [1, 2, 3, 4]) {
      const before = server.requests.length;
      const report = await explainDecision({ ...input, maxCalls: limit });
      assert.equal(server.requests.length - before, limit);
      assert.equal(report.calls.attempted, limit);
      assert.equal(report.comparisons.length, limit - 1);
      assert.deepEqual(report.omitted, input.fields.slice(limit - 1).map(field => ({ field, reason: "call_limit" })));
      assert.equal(report.complete, limit === 4);
    }
    const evidence = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`f${i}`, i]));
    const report = await explainDecision({ ...input, evidence, fields: Object.keys(evidence), maxCalls: 17 });
    assert.equal(report.calls.attempted, 17);
    assert.equal(report.comparisons.length, 16);
    assert.equal(report.complete, true);
  });
});

test("malformed input and hosted privacy refusals make zero calls and provide typed remedies", async () => {
  await scenario(async (fixture, server) => {
    const input = await options(fixture.pmRoot);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    const invalid = [
      { evidence: null }, { evidence: [] }, { evidence: circular }, { evidence: { title: "x".repeat(32769) } },
      { fields: [] }, { fields: ["title", "title"] }, { fields: ["missing"] }, { fields: [""] }, { fields: [1] },
      { fields: ["x".repeat(65)] }, { fields: Array.from({ length: 17 }, (_, i) => `f${i}`) },
      { questions: {} }, { questions: { bad: { type: "box" } } },
      { questions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`n${i}`, { type: "noul" }])) },
      { questions: { ["x".repeat(65)]: { type: "noul" } } },
      { questions: { route: { type: "choice", criteria: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, null])) } } },
      { questions: { route: { type: "choice", criteria: { ["x".repeat(65)]: null, other: null } } } },
      { questions: { n: { type: "noul", instructions: "x".repeat(16385) } } },
      ...[0, -1, 18, 1.1, NaN, Infinity].map(maxCalls => ({ maxCalls })),
    ];
    for (const patch of invalid) await assert.rejects(explainDecision({ ...input, ...patch } as CounterfactualOptions), (error: unknown) => {
      assert.ok(error instanceof CounterfactualRefusal);
      assert.equal(error.code, "invalid_request"); assert.ok(error.remedy.includes("--max-calls")); return true;
    });
    for (const hostedBlocked of ["missing_opt_in", "missing_api_key"] as const) {
      await assert.rejects(explainDecision({ ...input, endpoint: { ...input.endpoint, hostedBlocked } }), (error: unknown) => {
        assert.ok(error instanceof CounterfactualRefusal); assert.equal(error.code, "endpoint_refused"); assert.match(error.remedy, /doctor/); return true;
      });
    }
    assert.equal(server.requests.length, 0);
  });
});

test("partial receipts preserve successes and account for failures without retries or raw errors", async () => {
  await scenario(async (fixture, server) => {
    const input = await options(fixture.pmRoot);
    for (const failureAt of [1, 2, 3]) {
      let calls = 0;
      server.setReply((_, response, body) => {
        calls++;
        if (calls === failureAt) { response.statusCode = 500; response.end(JSON.stringify({ error: "PRIVATE_PROVIDER_DETAIL" })); return; }
        response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
      });
      const report = await explainDecision(input);
      assert.equal(report.complete, false);
      assert.equal(report.calls.attempted, failureAt);
      assert.equal(calls, failureAt, "retryable HTTP errors must not trigger hidden requests");
      assert.equal(report.calls.succeeded, failureAt - 1);
      assert.equal(report.comparisons.length, Math.max(0, failureAt - 2));
      assert.deepEqual(report.omitted, input.fields.slice(Math.max(0, failureAt - 2)).map(field => ({ field, reason: "provider_failure" })));
      assert.equal(report.usage.input_tokens, null);
      assert.equal(report.usage.output_tokens, null);
      assert.equal(report.usage.unknown_calls, 1);
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE_PROVIDER_DETAIL/);
      assert.equal(report.baseline === null, failureAt === 1);
    }
    server.setReply((_, response) => response.end(JSON.stringify({ malformed: true })));
    const malformed = await explainDecision(input);
    assert.equal(malformed.calls.attempted, 1);
    assert.equal(malformed.baseline, null);
  });
});

test("model changes invalidate comparisons and total deadline preserves all omissions", async () => {
  await scenario(async (fixture, server) => {
    const input = await options(fixture.pmRoot);
    let calls = 0;
    server.setReply((_, response, body) => {
      const result = answers((body as { questions: Questions }).questions);
      result.model = ++calls === 1 ? "model-a" : "model-b";
      response.end(JSON.stringify(result));
    });
    const report = await explainDecision(input);
    assert.equal(report.model, "model-a"); assert.equal(report.calls.attempted, 2);
    assert.equal(report.calls.succeeded, 2); assert.equal(report.comparisons.length, 0);
    assert.deepEqual(report.omitted, input.fields.map(field => ({ field, reason: "model_changed" })));
    server.setReply(() => {});
    const timed = await explainDecision({ ...input, endpoint: { ...input.endpoint, config: { ...input.endpoint.config, totalDeadlineMs: 20 } } });
    assert.equal(timed.calls.attempted, 1);
    assert.deepEqual(timed.omitted, input.fields.map(field => ({ field, reason: "deadline" })));
    assert.equal(timed.complete, false);
  });
});

test("nullable usage stays unknown and non-winning distribution drift remains visible", async () => {
  await scenario(async (fixture, server) => {
    const input = await options(fixture.pmRoot);
    server.setReply((_, response, body) => {
      const request = body as { state: Record<string, unknown>; questions: Questions };
      const p = Object.hasOwn(request.state, "tags") ? 0.8 : 0.7;
      const result = answers(request.questions);
      result.answers.route = { type: "choice", choice: "keep", confidence: 0.9, probabilities: { keep: p, change: 1 - p } };
      result.answers.impact = { type: "score", score: 0.5, confidence: 0.9, probabilities: { "0": 0.5, "1": 0.5 }, legend: { "0": "minor", "1": "major" } };
      result.usage = { input_tokens: null, output_tokens: null };
      response.end(JSON.stringify(result));
    });
    const report = await explainDecision(input);
    assert.equal(report.usage.unknown_calls, 4);
    assert.equal(report.usage.input_tokens, null);
    assert.equal(report.usage.output_tokens, null);
    assert.equal(report.comparisons[0].changed.length, 0);
    assert.ok(report.comparisons[0].max_probability_delta > 0.09);
  });
});

test("noul confidence follows the selected boolean in baseline, comparisons and CLI output", async () => {
  await scenario(async (fixture, server) => {
    const input = await options(fixture.pmRoot);
    const noulQuestions: Questions = { sensitive: { type: "noul" } };
    let p = 0;
    server.setReply((_, response, body) => {
      const request = body as { state: Record<string, unknown>; questions: Questions };
      const result = answers(request.questions);
      result.answers.sensitive = { type: "noul", noul: Object.hasOwn(request.state, "title") ? p : 1 - p };
      response.end(JSON.stringify(result));
    });
    for (p of [0, 0.1, 0.49, 0.5, 0.9, 1]) {
      const receipt = await explainDecision({ ...input, questions: noulQuestions, fields: ["title"], maxCalls: 2 });
      assert.deepEqual(receipt.baseline!.sensitive, { kind: "noul", value: p >= 0.5, probability: Math.max(p, 1 - p) });
      const compared = receipt.comparisons[0];
      assert.equal(compared.proposals.sensitive.value, 1 - p >= 0.5);
      assert.ok(Math.abs(compared.proposals.sensitive.probability - Math.max(p, 1 - p)) < 1e-12);
      assert.ok(Math.abs(compared.max_probability_delta - Math.abs(1 - 2 * p)) < 1e-12);
      assert.deepEqual(compared.changed, p === 0.5 ? [] : ["sensitive"]);
    }
    p = 0.1;
    const item = (await fixture.pm.create({ type: "Task", title: "Synthetic boolean evidence" })).item;
    const file = join(fixture.cwd, "noul.json"); writeFileSync(file, JSON.stringify(noulQuestions));
    for (const json of [true, false]) {
      const result = await fixture.harness.runCommand({ command: "jev explain", pmRoot: fixture.pmRoot, args: [item.id], options: { questions: file, fields: "title", maxCalls: "2" }, global: { json } });
      const receipt = result.result as CounterfactualReceipt;
      assert.equal(receipt.baseline!.sensitive.value, false);
      assert.equal(receipt.baseline!.sensitive.probability, 0.9);
      assert.equal(receipt.comparisons[0].proposals.sensitive.value, true);
      assert.equal(receipt.comparisons[0].proposals.sensitive.probability, 0.9);
    }
  });
});

test("endpoint configuration failures have endpoint remedies and unexpected command errors propagate", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ type: "Task", title: "Synthetic refusal evidence" })).item;
    const file = join(fixture.cwd, "questions.json"); writeFileSync(file, JSON.stringify(questions));
    const ctx = { command: "jev explain", pm_root: fixture.pmRoot, source_workspace_root: fixture.cwd, args: [item.id], options: { questions: file, fields: "title" }, global: {} };
    const before = trackerSnapshot(fixture.pmRoot);
    const originalUrl = process.env.PM_JEV_BASE_URL;
    const settingsPath = join(fixture.pmRoot, "settings.json");
    const settings = readFileSync(settingsPath, "utf8");
    /** Verify refusal recovery without exposing bad configuration or making requests. */
    const endpointRefused = async () => {
      const result = await runExplanationCommand(ctx);
      assert.ok("refusal" in result && result.refusal);
      assert.equal(result.refusal.code, "endpoint_refused");
      assert.match(result.refusal.remedy, /pm jev doctor/);
      assert.match(result.refusal.remedy, /PM_JEV_BASE_URL/);
      assert.doesNotMatch(result.refusal.remedy, /--questions/);
    };
    try {
      for (const url of ["not a URL", "ftp:synthetic", "https://synthetic.invalid"]) {
        process.env.PM_JEV_BASE_URL = url;
        await endpointRefused();
      }
      process.env.PM_JEV_BASE_URL = originalUrl;
      writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(settings), jev: { provider: "unsupported" } }));
      await endpointRefused();
      writeFileSync(settingsPath, settings);
      const unexpected = new Error("unexpected option boundary failure");
      const invalidOptions = Object.defineProperty({}, "questions", { get() { throw unexpected; } });
      await assert.rejects(runExplanationCommand({ ...ctx, options: invalidOptions }), error => error === unexpected);
      const parseFailure = mock.method(JSON, "parse", () => { throw unexpected; });
      try { await assert.rejects(runExplanationCommand(ctx), error => error === unexpected); }
      finally { parseFailure.mock.restore(); }

      const savedSettings = join(fixture.cwd, "settings.saved");
      renameSync(settingsPath, savedSettings); mkdirSync(settingsPath);
      try { await assert.rejects(runExplanationCommand(ctx), { code: "EISDIR" }); }
      finally { rmdirSync(settingsPath); renameSync(savedSettings, settingsPath); }

      const itemPath = join(fixture.pmRoot, "tasks", `${item.id}.toon`);
      const originalItem = readFileSync(itemPath, "utf8");
      writeFileSync(itemPath, "not a valid item document");
      try { await assert.rejects(runExplanationCommand(ctx), error => error instanceof Error && !(error instanceof CounterfactualRefusal)); }
      finally { writeFileSync(itemPath, originalItem); }
      assert.equal(server.requests.length, 0);
      assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    } finally {
      if (originalUrl === undefined) delete process.env.PM_JEV_BASE_URL; else process.env.PM_JEV_BASE_URL = originalUrl;
      writeFileSync(settingsPath, settings);
    }
  });
});

test("unexpected SDK construction and between-call boundary errors keep their original identity", async () => {
  await scenario(async (fixture, server) => {
    const input = await options(fixture.pmRoot);
    const unexpected = new Error("unexpected SDK boundary failure");
    const unreadableInput = { ...input, get evidence(): Record<string, unknown> { throw unexpected; } };
    await assert.rejects(explainDecision(unreadableInput), error => error === unexpected);
    const refusedEndpoint = { ...input.endpoint, get hostedBlocked(): null { throw unexpected; } };
    await assert.rejects(explainDecision({ ...input, endpoint: refusedEndpoint }), error => error === unexpected);
    assert.equal(server.requests.length, 0);
    const changingEndpoint = { ...input.endpoint };
    server.setReply((_, response, body) => {
      Object.defineProperty(changingEndpoint, "config", { get() { throw unexpected; } });
      response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
    });
    await assert.rejects(explainDecision({ ...input, endpoint: changingEndpoint }), error => error === unexpected);
    assert.equal(server.requests.length, 1);
  });
});

test("CLI uses host SDK reads in a non-git tracker, handles aliases and refuses invalid inputs", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ type: "Task", title: "Synthetic decision evidence" })).item;
    const file = join(fixture.cwd, "questions.json"); writeFileSync(file, JSON.stringify(questions));
    const before = trackerSnapshot(fixture.pmRoot);
    const oldPath = process.env.PATH, oldCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.PATH = ""; process.env.GIT_CEILING_DIRECTORIES = dirname(fixture.cwd);
    try {
      const invoke = (options: Record<string, unknown>, args = [item.id]) => fixture.harness.runCommand({ command: "jev explain", pmRoot: fixture.pmRoot, args, options, global: { json: true } });
      const base = { questions: file, fields: " title, tags " };
      const fallback = await runExplanationCommand({ command: "jev explain", pm_root: fixture.pmRoot, source_workspace_root: fixture.cwd, args: [item.id], options: base, global: {} });
      assert.ok("complete" in fallback && fallback.complete);
      for (const name of ["maxCalls", "max_calls", "max-calls"]) {
        const result = await invoke({ ...base, [name]: "2" });
        assert.equal(result.exitCode ?? 0, 0);
        assert.equal((result.result as CounterfactualReceipt).calls.attempted, 2);
      }
      for (const [patch, args] of [
        [{ questions: undefined }, [item.id]], [{ fields: undefined }, [item.id]], [{}, []], [{}, [" "]],
        [{ questions: fixture.cwd }, [item.id]], [{ questions: join(fixture.cwd, "missing") }, [item.id]],
        [{ fields: "comments" }, [item.id]], [{ maxCalls: " " }, [item.id]], [{ maxCalls: "18" }, [item.id]], [{}, ["missing-item"]],
      ] as const) {
        const count = server.requests.length;
        const result = await invoke({ ...base, ...patch }, [...args]);
        assert.equal(result.exitCode, 2, JSON.stringify({ patch, args, result })); assert.equal(server.requests.length, count);
        assert.equal((result.result as { refusal: { code: string } }).refusal.code, "invalid_request");
      }
      for (const contents of ["invalid json", "{}", " ".repeat(16385)]) {
        writeFileSync(file, contents);
        assert.equal((await invoke(base)).exitCode, 2);
      }
      writeFileSync(file, JSON.stringify(questions));
      server.setReply((_, response) => { response.statusCode = 503; response.end("{}"); });
      const failed = await invoke(base);
      assert.equal(failed.exitCode, 2);
      assert.equal((failed.result as CounterfactualReceipt).baseline, null);
      assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      if (oldCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = oldCeiling;
    }
  });
});

test("built command runs through the actual host parser in TOON and JSON with no git executable", async () => {
  await scenario(async (fixture) => {
    const item = (await fixture.pm.create({ type: "Task", title: "Synthetic parser evidence" })).item;
    const directory = join(fixture.pmRoot, "extensions", "pm-jev");
    mkdirSync(directory, { recursive: true });
    cpSync(resolve("dist"), join(directory, "dist"), { recursive: true });
    cpSync(resolve("manifest.json"), join(directory, "manifest.json"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
    const file = join(fixture.cwd, "questions.json"); writeFileSync(file, JSON.stringify(questions));
    const before = trackerSnapshot(fixture.pmRoot);
    const base = [resolve("node_modules/@unbrained/pm-cli/dist/cli.js"), "--pm-path", fixture.pmRoot, "jev", "explain", item.id, "--questions", file, "--fields", "title,tags", "--max-calls", "2"];
    const env = { ...process.env, PATH: "", PM_PATH: fixture.pmRoot, PM_GLOBAL_PATH: join(fixture.cwd, "global"), GIT_CEILING_DIRECTORIES: dirname(fixture.cwd) };
    const run = promisify(execFile);
    const json = await run(process.execPath, [...base, "--json"], { cwd: fixture.cwd, env, timeout: 60000 });
    const receipt = JSON.parse(json.stdout) as CounterfactualReceipt;
    assert.equal(receipt.calls.attempted, 2); assert.equal(receipt.omitted[0].field, "tags");
    const toon = await run(process.execPath, base, { cwd: fixture.cwd, env, timeout: 60000 });
    assert.match(toon.stdout, /call_limit/); assert.match(toon.stdout, /sensitivity_is_not_causation/);
    assert.ok(Buffer.byteLength(json.stdout) < 6000); assert.ok(Buffer.byteLength(toon.stdout) < 5000);
    const invalid = [...base]; invalid[invalid.indexOf("--fields") + 1] = "comments";
    await assert.rejects(run(process.execPath, [...invalid, "--json"], { cwd: fixture.cwd, env, timeout: 60000 }), (error: unknown) => {
      const failed = error as { code: number; stdout: string }; assert.equal(failed.code, 2);
      assert.equal((JSON.parse(failed.stdout) as { refusal: { code: string } }).refusal.code, "invalid_request"); return true;
    });
    await assert.rejects(run(process.execPath, [...base, "--json"], { cwd: fixture.cwd, env: { ...env, PM_JEV_BASE_URL: "not a URL" }, timeout: 60000 }), (error: unknown) => {
      const failed = error as { code: number; stdout: string }; assert.equal(failed.code, 2);
      const refusal = (JSON.parse(failed.stdout) as { refusal: { code: string; remedy: string } }).refusal;
      assert.equal(refusal.code, "endpoint_refused"); assert.match(refusal.remedy, /PM_JEV_BASE_URL/); return true;
    });
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  });
});
