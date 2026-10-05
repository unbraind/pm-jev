import { writeFileSync } from "node:fs";
import { getSettingsPath } from "@unbrained/pm-cli/sdk";
import assert from "node:assert/strict";
import test from "node:test";
import { TypeSafeClient, APIConnectionError, APITimeoutError, APIUserAbortError, APIError } from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { createJevClient, resolveJevEndpoint, runDecision, translateDecisionError, createPmCliExpectedError, listDecisionModels } from "../index.ts";
import { answers, scenario } from "./fixtures.ts";

const questions: Questions = { safe: { type: "noul", instructions: "Is it synthetic?" } };

test("SDK retries rate and overload responses at most twice, under a total deadline", async () => {
  await scenario(async (fixture, server) => {
    const resolved = await resolveJevEndpoint(fixture.pmRoot, process.env);
    const client = createJevClient(resolved, process.env);
    for (const status of [429, 529]) {
      const start = server.requests.length;
      server.setReply((_, response) => { response.statusCode = status; response.setHeader("retry-after-ms", "1"); response.end(JSON.stringify({ error: "SENSITIVE_REFLECTION" })); });
      await assert.rejects(runDecision(client, resolved.config, "PRIVATE_STATE", questions), error => {
        assert.equal((error as Error).message.includes("SENSITIVE_REFLECTION"), false);
        assert.equal((error as Error).message.includes("PRIVATE_STATE"), false);
        assert.match((error as Error).message, /bounded retries/); return true;
      });
      assert.equal(server.requests.length - start, 3);
    }
    for (const status of [404, 400, 401, 403, 422, 418]) {
      const start = server.requests.length;
      server.setReply((_, response) => { response.statusCode = status; response.end("reflected private state"); });
      await assert.rejects(runDecision(client, resolved.config, "PRIVATE_STATE", questions), status === 404 ? /ollama pull tev1:4b/ : new RegExp(`HTTP ${status}`));
      assert.equal(server.requests.length - start, 1);
    }
    let attempts = 0;
    server.setReply((_, response) => { if (++attempts === 1) { response.statusCode = 429; response.setHeader("retry-after-ms", "1"); response.end(); } else response.end(JSON.stringify(answers(questions))); });
    assert.equal((await runDecision(client, resolved.config, "synthetic", questions)).model, "tev1:4b");
    server.setReply((_, response) => { response.statusCode = 529; response.setHeader("retry-after-ms", "1000"); response.end(); });
    const start = Date.now();
    await assert.rejects(runDecision(client, { ...resolved.config, totalDeadlineMs: 40 }, "synthetic", questions), /total deadline/);
    assert.ok(Date.now() - start < 500);
    server.setReply(() => {});
    const impatient = new TypeSafeClient({ apiKey: "ollama", baseURL: server.url, timeout: 20, logLevel: "off", retry: { maxRetries: 0 } });
    await assert.rejects(runDecision(impatient, resolved.config, "synthetic", questions), /timed out/);
    await assert.rejects(runDecision(client, { ...resolved.config, totalDeadlineMs: 20 }, "synthetic", questions), /total deadline/);
  });
});

test("malformed HTTP answers fail before apply and redirect targets receive no state", async () => {
  await scenario(async (fixture, server) => {
    const item = await fixture.pm.create({ type: "Feature", title: "Synthetic crash", priority: 3 });
    server.setReply((_, response, body) => {
      const q = (body as { questions: Questions }).questions;
      const result = answers(q);
      result.answers.type = { type: "choice", choice: "Injected", confidence: 1, probabilities: { Injected: 1 } };
      response.end(JSON.stringify(result));
    });
    await assert.rejects(fixture.harness.runCommand({ command: "jev triage", args: [item.item.id], options: { apply: true }, pmRoot: fixture.pmRoot }), /malformed/);
    assert.equal((await fixture.pm.get(item.item.id)).item.type, "Feature");
    assert.equal((await fixture.pm.comments(item.item.id)).count, 0);
    server.setReply((_, response) => { response.statusCode = 307; response.setHeader("Location", `${server.url}/stolen`); response.end(); });
    const resolved = await resolveJevEndpoint(fixture.pmRoot, process.env);
    await assert.rejects(runDecision(createJevClient(resolved, process.env), resolved.config, "synthetic", questions));
    assert.equal(server.requests.some(request => request.path === "/stolen"), false);
    const client = new TypeSafeClient({ apiKey: "ollama", baseURL: "http://127.0.0.1:1", logLevel: "off", retry: { maxRetries: 0 } });
    await assert.rejects(runDecision(client, resolved.config, "synthetic", questions), /unreachable/);
    server.setReply((_, response) => response.end("not json"));
    await assert.rejects(runDecision(createJevClient(resolved, process.env), resolved.config, "synthetic", questions), /validation/);
  });
});

test("discovery falls back to capability-filtered Ollama tags and diagnoses missing models", async () => {
  await scenario(async (fixture, server) => {
    const run = (command: string) => fixture.harness.runCommand({ command: `jev ${command}`, pmRoot: fixture.pmRoot });
    server.setReply((request, response) => response.end(JSON.stringify(request.url === "/v1/models" ? { data: [] } : { models: [null, 42, { name: 42 }, { name: "chat" }, { name: "plain", capabilities: [] }, { name: "tev1:4b", capabilities: ["decision"] }] })));
    assert.deepEqual(((await run("models")).result as { models: unknown[] }).models, [{ name: "tev1:4b", decision: true }]);
    server.setReply((request, response) => response.end(JSON.stringify(request.url === "/v1/models" ? {} : { models: [] })));
    assert.equal(((await run("doctor")).result as { status: string }).status, "degraded");
    server.setReply((_, response) => { response.statusCode = 422; response.end(); });
    await assert.rejects(run("models"), /HTTP 422/);
    assert.equal(((await run("doctor")).result as { status: string }).status, "degraded");
    for (const payload of [null, {}, { models: false }]) {
      server.setReply((request, response) => response.end(JSON.stringify(request.url === "/v1/models" ? {} : payload)));
      await assert.rejects(run("models"));
    }
    server.setReply(() => {});
    const resolved = await resolveJevEndpoint(fixture.pmRoot, process.env);
    const start = Date.now();
    await assert.rejects(listDecisionModels({ ...resolved, config: { ...resolved.config, totalDeadlineMs: 20 } }, process.env), /deadline/);
    assert.ok(Date.now() - start < 500);
  });
});

test("safe error mapping preserves expected errors and hides arbitrary provider data", async () => {
  await scenario(async (fixture) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, process.env);
    const expected = createPmCliExpectedError("Synthetic expected error");
    assert.equal(translateDecisionError(expected, config), expected);
    for (const error of [new APIConnectionError(), new APITimeoutError(20), new APIUserAbortError(), new Error("SENSITIVE"), "SENSITIVE", new APIError(404, "SENSITIVE", new Headers()), new APIError(529, "SENSITIVE", new Headers())]) {
      const mapped = translateDecisionError(error, { ...config, provider: "typesafe" });
      assert.equal(mapped.message.includes("SENSITIVE"), false);
    }
  });
});

test("none is a real model option and hosted discovery failures have no native fallback", async () => {
  await scenario(async (fixture, server) => {
    await fixture.pm.create({ type: "Issue", title: "Synthetic title" });
    server.setReply((_, response, body) => {
      const result = answers((body as { questions: Questions }).questions);
      result.answers.duplicate_of = { type: "choice", choice: "none", confidence: 0.8, probabilities: Object.fromEntries(Object.keys(((body as { questions: Questions }).questions.duplicate_of as { criteria: object }).criteria).map(label => [label, label === "none" ? 1 : 0])) };
      response.end(JSON.stringify(result));
    });
    const dedupe = await fixture.harness.runCommand({ command: "jev dedupe", options: { title: "Synthetic title" }, pmRoot: fixture.pmRoot });
    assert.equal((dedupe.result as { duplicate_of: null }).duplicate_of, null);
    const resolved = await resolveJevEndpoint(fixture.pmRoot, process.env);
    server.setReply((_, response) => { response.statusCode = 422; response.end(); });
    const start = server.requests.length;
    await assert.rejects(listDecisionModels({ ...resolved, config: { ...resolved.config, provider: "typesafe" } }, { TYPESAFE_API_KEY: "synthetic" }), /HTTP 422/);
    assert.equal(server.requests.length - start, 1);
  });
});

test("doctor distinguishes a missing hosted model on the synthetic endpoint", async () => {
  await scenario(async (fixture, server) => {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "synthetic";
    try {
      writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify({ jev: { provider: "typesafe", allow_external: true } }));
      server.setReply((_, response) => response.end(JSON.stringify({ models: [{ name: "other" }] })));
      const result = await fixture.harness.runCommand({ command: "jev doctor", pmRoot: fixture.pmRoot });
      assert.equal((result.result as { status: string }).status, "degraded");
    } finally { if (previous === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previous; }
  });
});

test("near-threshold gate output preserves the probability used for its exit code", async () => {
  await scenario(async (fixture, server) => {
    server.setReply((_, response) => response.end(JSON.stringify({ model: "tev1:4b", answers: { proposition: { type: "noul", noul: 0.4999 } }, usage: { input_tokens: 1, output_tokens: 1 } })));
    const gate = await fixture.harness.runCommand({ command: "jev gate", options: { noul: "synthetic proposition", text: "synthetic text", threshold: "0.5" }, pmRoot: fixture.pmRoot });
    assert.equal(gate.exitCode, 1);
    assert.equal((gate.result as { probability: number }).probability, 0.4999);
    assert.equal((gate.result as { passed: boolean }).passed, false);
  });
});
