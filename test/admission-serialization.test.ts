import assert from "node:assert/strict";
import test from "node:test";
import type { JevConfig, Questions } from "../index.ts";
import { ADMISSION_VERSION, AdmissionRefusal, admitDecision, admitDecisionBatch, createJevClient, resolveJevEndpoint, runDecision } from "../index.ts";
import { scenario } from "./fixtures.ts";

const singleChoice: Questions = { route: { type: "choice", criteria: { keep: null } } };

/** Check both admission entrypoints retain typed, content-free refusals for invalid choices. */
async function assertInvalidChoice(config: JevConfig, input: Questions): Promise<void> {
  await assert.rejects(admitDecision(config, "Synthetic", input), error => error instanceof AdmissionRefusal && error.code === "invalid_input" && error.remedy.includes("null") && !error.message.includes("PRIVATE_CHOICE_VALUE"));
  await assert.rejects(runDecision(createJevClient({ config, hostedBlocked: null }, {}, 0), config, "Synthetic", input), error => (error as { context: { code: string } }).context.code === "jev_admission_invalid_input");
}

test("admission counts exactly the choice identities serialized by the real SDK", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    // Runtime producers can supply undefined even though the declared EntryType excludes it.
    const choices: Record<string, string | null | undefined>[] = [{ keep: "Keep", drop: undefined, wait: null }, { keep: "Keep", drop: undefined }];
    for (const criteria of choices) {
      const input = { route: { type: "choice", instructions: undefined, criteria } } as unknown as Questions;
      const admitted = await admitDecision(config, "Synthetic", input);
      const result = await runDecision(createJevClient({ config, hostedBlocked: null }, {}, 0), config, "Synthetic", input).finally(/** Compare wire options even if response validation detects the original mismatch. */ () => {
        const wire = server.requests.at(-1)?.body as { questions: Questions };
        assert.equal(wire.questions.route.type, "choice");
        assert.equal(admitted.questions.route.type, "choice");
        if (wire.questions.route.type !== "choice" || admitted.questions.route.type !== "choice") throw new Error("Expected choice");
        const labels = Object.keys(wire.questions.route.criteria);
        assert.equal(admitted.receipt.options, labels.length);
        assert.deepEqual(labels, Object.keys(admitted.questions.route.criteria));
        assert.deepEqual(labels, Object.keys(criteria).filter(key => criteria[key] !== undefined));
      });
      assert.equal(result.admission?.options, Object.values(criteria).filter(value => value !== undefined).length);
      assert.equal(admitted.receipt.max_prompt_tokens, result.admission?.max_prompt_tokens);
      assert.ok(Object.hasOwn(criteria, "drop"), "Admission must not mutate caller objects");
    }
    assert.equal(server.requests.filter(request => request.path === "/v1/systemone").length, 2);
  });
});

test("a sole undefined choice becomes empty and refuses before metadata or inference", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const input = { route: { type: "choice", criteria: { drop: undefined } } } as unknown as Questions;
    await assertInvalidChoice(config, input);
    assert.equal(server.admissionRequests.length, 0);
    assert.equal(server.requests.length, 0);
  });
});

test("function and symbol choice values refuse before JSON can silently omit them", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    for (const value of [() => "PRIVATE_CHOICE_VALUE", Symbol("PRIVATE_CHOICE_VALUE")]) {
      const input = { route: { type: "choice", criteria: { keep: "Keep", invalid: value } } } as unknown as Questions;
      await assertInvalidChoice(config, input);
      assert.equal(server.admissionRequests.length, 0);
      assert.equal(server.requests.length, 0);
    }
    const persisted = JSON.parse('{"route":{"type":"choice","criteria":{"keep":null}}}') as Questions;
    const admitted = await admitDecision(config, "Synthetic", persisted);
    assert.equal(admitted.receipt.options, 1);
    assert.equal(admitted.questions.route.type, "choice");
    assert.deepEqual(admitted.questions.route.criteria, { keep: null });
  });
});

test("serialized state values are validated before metadata while valid JSON hooks remain compatible", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const questions = singleChoice;
    for (const value of [1.5, "\ud800", { nested: 2.5 }]) {
      const state = Object.defineProperty({}, "toJSON", { value: () => value });
      await assert.rejects(admitDecision(config, state, questions), error => error instanceof AdmissionRefusal && error.code === "invalid_input");
    }
    assert.equal(server.admissionRequests.length, 0);
    assert.equal(server.requests.length, 0);
    // Previously persisted JSON and hooks yielding the same safe JSON retain their meaning.
    const persisted = JSON.parse('{"title":"Synthetic","count":2,"nested":[null,true,"Keep"]}') as unknown;
    for (const state of [persisted, Object.defineProperty({}, "toJSON", { value: () => persisted })]) {
      const admitted = await admitDecision(config, state, questions);
      assert.deepEqual(admitted.state, persisted);
      assert.equal(admitted.receipt.options, 1);
      const result = await runDecision(createJevClient({ config, hostedBlocked: null }, {}, 0), config, state, questions);
      assert.equal(result.admission?.ok, true);
      assert.deepEqual((server.requests.at(-1)?.body as { state: unknown }).state, persisted);
    }
    assert.equal(server.requests.length, 2);
  });
});


test("serialization failures and undefined documents refuse with typed content-free invalid input", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const questions = singleChoice;
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const hooks = [() => 1n, () => cycle, () => { throw new Error("PRIVATE_SERIALIZATION_TEXT"); }, () => undefined];
    for (const hook of hooks) {
      const state = Object.defineProperty({}, "toJSON", { value: hook });
      await assert.rejects(admitDecision(config, state, questions), error => error instanceof AdmissionRefusal && error.code === "invalid_input" && !error.message.includes("PRIVATE_SERIALIZATION_TEXT"));
      await assert.rejects(runDecision(createJevClient({ config, hostedBlocked: null }, {}, 0), config, state, questions), error => (error as { context: { code: string } }).context.code === "jev_admission_invalid_input");
    }
    // Only a root hook can cause JSON.stringify to return undefined rather than omitting state.
    const document = Object.defineProperty({ version: ADMISSION_VERSION, state: "Synthetic", questions }, "toJSON", { value: () => undefined });
    await assert.rejects(admitDecisionBatch(config, document), error => error instanceof AdmissionRefusal && error.code === "invalid_input");
    assert.equal(server.admissionRequests.length, 0);
    assert.equal(server.requests.length, 0);
    const admitted = await admitDecision(config, JSON.parse('{"title":"Synthetic","count":2}') as unknown, questions);
    assert.deepEqual(admitted.state, { title: "Synthetic", count: 2 });
    assert.equal(admitted.receipt.options, 1);
  });
});
