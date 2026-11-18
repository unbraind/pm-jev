import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { guardCreate } from "../index.ts";
import type { DedupeDecision, PreCreateDraft } from "../index.ts";
import { sdkReadableResponse } from "../jev-endpoint.ts";
import { preCreateReceipt } from "../pre-create-policy.ts";
import { answers, project, scenario, trackerSnapshot } from "./fixtures.ts";

const recording = JSON.parse(readFileSync(new URL("./fixtures/pre-create-screens.json", import.meta.url), "utf8")) as {
  cases: { result: DedupeDecision }[];
};

test("replay real public choices and compare fitted and raw probability floors before rounding", () => {
  const [duplicate, none] = recording.cases.map(row => row.result);
  const hit = preCreateReceipt(duplicate, 0, true);
  assert.equal(hit.decision, "duplicate");
  assert.equal(hit.decision === "duplicate" && hit.duplicate_of, "pm-jev-undefined-choice-admission");
  assert.equal(hit.score_kind, "raw");
  assert.equal(hit.threshold, 0.8);
  assert.equal(hit.candidate_count, 3);
  assert.equal(hit.has_more, true);
  assert.equal(hit.probability, duplicate.probability);
  assert.deepEqual(hit.usage, { input_tokens: 519, output_tokens: 0 });
  assert.ok(!JSON.stringify(hit).includes(duplicate.candidates[0].title));
  assert.equal(preCreateReceipt(none, 0.8, false).decision, "no_match");
  assert.deepEqual(preCreateReceipt(none, 0.8, true), { ...preCreateReceipt(none, 0.8, false),
    has_more: true, decision: "abstain", reason: "candidate_limit" });
  assert.equal(preCreateReceipt(duplicate, duplicate.probability + Number.EPSILON, false).decision, "abstain");
  // Policy arithmetic at equality and a disabled fit uses the measured score unchanged.
  for (const [threshold, expected] of [[duplicate.probability, "duplicate"], [1, "abstain"], [null, "abstain"]] as const) {
    const calibration = { receipt_sha256: "a".repeat(64), temperature: 1, threshold, fitted_threshold: threshold,
      qualified: threshold !== null, qualifies: expected === "duplicate", reason: "synthetic boundary", raw_probability: duplicate.probability };
    const result = preCreateReceipt({ ...duplicate, calibration }, 0.5, false);
    assert.equal(result.score_kind, "calibrated");
    assert.equal(result.threshold, threshold);
    assert.equal(result.decision, expected);
  }
});

test("SDK and command screen a real tracker, abstain offline, and leave item and history bytes intact", async () => {
  const fixture = await project();
  const previousUrl = process.env.PM_JEV_BASE_URL;
  // A forbidden loopback port cannot serve inference, even on a host running Ollama.
  process.env.PM_JEV_BASE_URL = "http://127.0.0.1:1";
  try {
    const draft = { title: "Quasar photometry" };
    const empty = await guardCreate(fixture.pmRoot, draft);
    assert.equal(empty.decision, "no_match");
    assert.equal(empty.probability, null);
    assert.equal(empty.score_kind, null);
    assert.deepEqual(empty.usage, { input_tokens: 0, output_tokens: 0 });
    const command = (options: Record<string, unknown>) => fixture.harness.runCommand({
      command: "jev guard-create", pmRoot: fixture.pmRoot, global: { json: true }, options,
    });
    assert.deepEqual((await command(draft)).result, empty);
    await assert.rejects(command({ ...draft, limit: "" }), /limit must be an integer/i);
    const created = await fixture.pm.create({ type: "Task", title: draft.title, description: "Synthetic project" });
    await fixture.pm.create({ type: "Task", title: "Extend quasar photometry" });
    const snapshot = trackerSnapshot(fixture.pmRoot);
    const limited = { ...draft, body: "Synthetic evidence", limit: 1 };
    const offline = await guardCreate(fixture.pmRoot, limited);
    assert.deepEqual(offline, { candidate_count: 1, has_more: true, decision: "abstain", reason: "decision_unavailable",
      probability: null, threshold: null, score_kind: null, model: empty.model, usage: null });
    const result = await command({ ...limited, limit: "1" });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.result, { ...offline, exit_code: 1 });
    await assert.rejects(command({}), /title/);
    await assert.rejects(guardCreate(join(fixture.cwd, "missing"), draft), /not initialized/);
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), snapshot);

    const sourcePath = join(fixture.pmRoot, "tasks", created.item.id + ".toon");
    writeFileSync(sourcePath, "corrupted synthetic record");
    await assert.rejects(guardCreate(fixture.pmRoot, draft), /read|parse|invalid|complete/i);

    const settingsFile = join(fixture.pmRoot, "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    settings.jev = { provider: "typesafe", allow_external: true };
    writeFileSync(settingsFile, JSON.stringify(settings));
    process.env.PM_JEV_BASE_URL = "https://127.0.0.1:1";
    await assert.rejects(guardCreate(fixture.pmRoot, draft), /requires the Ollama provider/);
  } finally {
    if (previousUrl === undefined) delete process.env.PM_JEV_BASE_URL;
    else process.env.PM_JEV_BASE_URL = previousUrl;
    fixture.dispose();
  }
});

test("a project directory uses the nested tracker's decision policy", async () => {
  await scenario(async (fixture, server) => {
    const title = "Quasar photometry";
    const { item } = await fixture.pm.create({ type: "Task", title });
    const settingsFile = join(fixture.pmRoot, "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    settings.jev = { min_confidence: 1 };
    writeFileSync(settingsFile, JSON.stringify(settings));
    server.setReply((_, response) => response.end(JSON.stringify({
      model: "tev1:4b",
      answers: { duplicate_of: { type: "choice", choice: "none", confidence: 0.9, probabilities: { [item.id]: 0.1, none: 0.9 } } },
      usage: { input_tokens: 50, output_tokens: 4 },
    })));
    const receipt = await guardCreate(fixture.cwd, { title });
    assert.equal(receipt.decision, "abstain");
    assert.equal(receipt.threshold, 1);
    assert.equal(receipt.candidate_count, 1);
  });
});

test("the guard receipt keeps only the validated token counts from the endpoint", async () => {
  await scenario(async (fixture, server) => {
    const title = "Quasar photometry";
    await fixture.pm.create({ type: "Task", title });
    server.setReply((_, response, body) => {
      const result = answers((body as { questions: Questions }).questions);
      response.end(JSON.stringify({ ...result, usage: { ...result.usage, input_tokens: null, endpoint_note: "Synthetic draft evidence" } }));
    });
    const receipt = await guardCreate(fixture.pmRoot, { title });
    assert.equal(receipt.decision, "duplicate");
    assert.deepEqual(receipt.usage, { input_tokens: null, output_tokens: 4 });
  });
});

test("the guard consumes the tracker list after a single host certification", async (t) => {
  await scenario(async (fixture) => {
    const listAllComplete = PmClient.prototype.listAllComplete;
    let envelopeReads = 0;
    const list = t.mock.method(PmClient.prototype, "listAllComplete", async function (this: PmClient) {
      const result = await listAllComplete.call(this);
      assert.equal(result.complete_list.source_complete, true);
      return { ...result, get count() { envelopeReads += 1; return result.count; } };
    });
    const receipt = await guardCreate(fixture.pmRoot, { title: "Quasar photometry" });
    assert.equal(receipt.decision, "no_match");
    assert.equal(list.mock.callCount(), 1);
    assert.equal(envelopeReads, 0);
  });
});

test("invalid SDK inputs fail before tracker discovery", async () => {
  for (const root of [null, " "]) await assert.rejects(guardCreate(root as string, { title: "Draft" }), /tracker root/);
  for (const draft of [null, { title: 8 }, { title: "  " }]) await assert.rejects(guardCreate(".", draft as PreCreateDraft), /title/);
  for (const draft of [{ body: 8 }, { limit: NaN }, { limit: 0 }, { limit: 33 }, { limit: 1.5 }]) {
    await assert.rejects(guardCreate(".", { title: "Draft", ...draft } as PreCreateDraft), /integer/);
  }
});

test("the SDK can drain a cloned body and then parse the original stream with its response metadata", async () => {
  const original = await fetch("data:application/json,%7B%22decision%22%3Atrue%7D");
  assert.equal(sdkReadableResponse(original, false), original);
  const empty = new Response(null, { status: 204 });
  assert.equal(sdkReadableResponse(empty, true), empty);
  const response = sdkReadableResponse(original, true);
  assert.equal(response.url, original.url);
  assert.equal(response.redirected, original.redirected);
  assert.equal(response.type, original.type);
  assert.equal(response.status, original.status);
  assert.equal(response.headers.get("content-type"), "application/json");
  const copy = response.clone();
  const reader = response.body!.getReader();
  assert.deepEqual(await copy.json(), { decision: true });
  reader.releaseLock();
  assert.deepEqual(await response.json(), { decision: true });
});
