import assert from "node:assert/strict";
import test from "node:test";
import type { Questions } from "../index.ts";
import { AdmissionRefusal, admitDecision, createJevClient, resolveJevEndpoint, runDecision } from "../index.ts";
import { scenario } from "./fixtures.ts";

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
    await assert.rejects(admitDecision(config, "Synthetic", input), error => error instanceof AdmissionRefusal && error.code === "invalid_input" && error.remedy.includes("null"));
    await assert.rejects(runDecision(createJevClient({ config, hostedBlocked: null }, {}, 0), config, "Synthetic", input), error => (error as { context: { code: string } }).context.code === "jev_admission_invalid_input");
    assert.equal(server.admissionRequests.length, 0);
    assert.equal(server.requests.length, 0);
  });
});
