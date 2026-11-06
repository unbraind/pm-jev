import assert from "node:assert/strict";
import test from "node:test";
import { AdmissionRefusal, admitDecision, createJevClient, resolveJevEndpoint, runDecision } from "../index.ts";
import { ollamaModelName } from "../ollama-model.ts";
import { admissionMetadata } from "./admission-fixtures.ts";
import { scenario, trackerSnapshot, withoutGit } from "./fixtures.ts";

const questions = { keep: { type: "noul" as const } };

test("native references apply defaults and fold all ASCII name parts without aliasing invalid names", () => {
  for (const name of ["custom-tev1", "custom-tev1:latest", "library/custom-tev1", "registry.ollama.ai/library/custom-tev1:latest", "REGISTRY.OLLAMA.AI/Library/Custom-Tev1:LATEST", "https://registry.ollama.ai/library/custom-tev1"]) {
    assert.equal(ollamaModelName(name), "registry.ollama.ai/library/custom-tev1:latest");
  }
  assert.equal(ollamaModelName("registry.example:5000/team/tev1"), "registry.example:5000/team/tev1:latest");
  assert.equal(ollamaModelName("Team/Tev1:Q8_0"), "registry.ollama.ai/team/tev1:q8_0");
  for (const name of [undefined, null, 1, "", ":latest", "tev1:", "/tev1", "/library/tev1", "host//tev1", "a/b/c/d", "tev1 extra", "tëv1", "host/invalid.namespace/tev1", "tev1:bad/tag", "https://other://registry.ollama.ai/library/tev1:4b", `${"h".repeat(351)}/team/tev1`, "host/" + "n".repeat(81) + "/tev1", "m".repeat(81), "tev1:" + "t".repeat(81)]) {
    assert.equal(ollamaModelName(name), undefined, String(name));
  }
});

test("equivalent native references resolve through the real SDK with digest-pinned inspection and inference", async () => {
  await scenario(async (fixture, server) => {
    const digest = "6".repeat(64);
    const models = [{ name: "custom-tev1:latest", digest }, { name: "tev1:4b", digest }];
    server.setAdmissionReply((request, response) => response.end(JSON.stringify(request.url === "/api/tags" ? { models } : admissionMetadata())));
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    await withoutGit(fixture.cwd, async () => {
      const created = await fixture.pm.create({ type: "Task", title: "Synthetic native reference" });
      const before = trackerSnapshot(fixture.pmRoot);
      const names = ["custom-tev1", "custom-tev1:latest", "library/custom-tev1", "REGISTRY.OLLAMA.AI/LIBRARY/CUSTOM-TEV1:LATEST", "tev1:4b", "registry.ollama.ai/library/tev1:4b", "REGISTRY.OLLAMA.AI/Library/Tev1:4B"];
      for (const model of names) {
        const scoped = { ...config, model };
        const result = await runDecision(createJevClient({ config: scoped, hostedBlocked: null }, {}), scoped, { title: created.item.title }, questions);
        assert.equal(result.admission?.ok, true); assert.equal(result.admission.model_digest, digest);
        assert.equal((server.requests.at(-1)?.body as { model: string }).model, `sha256:${digest}`);
      }
      const shows = server.admissionRequests.filter(r => r.path === "/api/show");
      assert.equal(shows.length, 1); assert.equal((shows[0].body as { model: string }).model, `sha256:${digest}`);
      assert.equal(server.requests.length, names.length); assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    });
  });
});

test("native lookup refuses unknown, malformed and ambiguous inventory names before inspection or inference", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const digest = "7".repeat(64);
    let models: unknown[] = [{ name: "tev1:4b", digest }];
    server.setAdmissionReply((request, response) => response.end(JSON.stringify(request.url === "/api/tags" ? { models } : admissionMetadata())));
    for (const model of ["unknown", "team/tev1:4b", "another.registry/library/tev1:4b", "tev1:other", "/tev1", "", "https://other://registry.ollama.ai/library/tev1:4b"]) {
      await assert.rejects(admitDecision({ ...config, model }, "Synthetic", questions), error => error instanceof AdmissionRefusal && error.code === "unsupported_model");
    }
    models = [{ name: "tev1:4b", digest }, { name: "REGISTRY.OLLAMA.AI/Library/Tev1:4B", digest: "8".repeat(64) }];
    for (const inventory of [models, [...models].reverse()]) {
      models = inventory;
      await assert.rejects(admitDecision(config, "Synthetic", questions), error => error instanceof AdmissionRefusal && error.code === "ambiguous_model");
      await assert.rejects(runDecision(createJevClient({ config, hostedBlocked: null }, {}), config, "Synthetic", questions), error => (error as { context: { code: string } }).context.code === "jev_admission_ambiguous_model");
    }
    assert.equal(server.admissionRequests.some(r => r.path === "/api/show"), false); assert.equal(server.requests.length, 0);
    models = [{ name: "tev1:4b", digest }, { name: "registry.ollama.ai/library/tev1:4b", digest }];
    assert.equal((await admitDecision(config, "Synthetic", questions)).receipt.model_digest, digest);
  });
});

test("reference canonicalization stays linear on colon-heavy and oversized input", () => {
  const started = performance.now();
  assert.equal(ollamaModelName(":".repeat(100_000)), undefined);
  assert.equal(ollamaModelName(`${":".repeat(100_000)}/`), undefined);
  assert.equal(ollamaModelName("a" + ":".repeat(600)), undefined);
  assert.equal(ollamaModelName(`registry.example:5000/team/${"m".repeat(80)}:${"t".repeat(80)}`), `registry.example:5000/team/${"m".repeat(80)}:${"t".repeat(80)}`);
  assert.equal(ollamaModelName("x".repeat(641)), undefined);
  assert.ok(performance.now() - started < 2000, "canonicalization must not scale polynomially with ':' runs (the old regex needs ~13 s on this input)");
});

