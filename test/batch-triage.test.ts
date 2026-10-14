import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { getSettingsPath, isHostOutputSuppressed, locateItem } from "@unbrained/pm-cli/sdk";
import { answers, hostedFixture, scenario, typeAnswers } from "./fixtures.ts";
import { KEEP_CURRENT_TYPE, projectTriageState, resolveJevEndpoint, triageSourceHash } from "../index.ts";
import type { BacklogTriageRow, BacklogTriageSummary, ProjectableItem, TriageDecision } from "../index.ts";
import type { Questions } from "@typesafe-ai/sdk";
import type { BeforeMutationHookContext } from "@unbrained/pm-cli/sdk/authoring";

/** Capture only extension writes while allowing test-runner diagnostics to use stdout normally. */
async function capture(run: () => Promise<unknown>): Promise<{ result: unknown; lines: string[] }> {
  const original = process.stdout.write;
  let output = "";
  process.stdout.write = (chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    if (typeof chunk !== "string") return Reflect.apply(original, process.stdout, [chunk, encoding, callback]) as boolean;
    output += chunk;
    const complete = typeof encoding === "function" ? encoding : callback;
    complete?.();
    return true;
  };
  try { return { result: await run(), lines: output.trim().split("\n").filter(Boolean) }; }
  finally { process.stdout.write = original; }
}

/** Unwrap the host's supported suppression marker into its constant-size structured result. */
function summary(value: unknown): BacklogTriageSummary {
  const envelope = (value as { result: unknown }).result;
  assert.ok(isHostOutputSuppressed(envelope));
  return envelope.result as BacklogTriageSummary;
}

test("minimal triage projection omits routing outputs and duplicated body; hash covers complete evidence", () => {
  const item: ProjectableItem = { id: "synthetic", title: "Crash", type: "Feature", priority: 3, status: "open", tags: [], description: "Evidence", body: "Evidence" };
  assert.deepEqual(projectTriageState(item), { title: "Crash", description: "Evidence" });
  assert.deepEqual(projectTriageState({ ...item, body: "Evidence\n\nExtra context" }), { title: "Crash", description: "Evidence", body: "Extra context" });
  assert.equal(projectTriageState({ ...item, body: "Evidence\r\nExtra context" }).body, "Extra context");
  assert.equal(projectTriageState({ ...item, body: "Evidence differs" }).body, "Evidence differs");
  assert.equal(projectTriageState({ ...item, body: "Unrelated body" }).body, "Unrelated body");
  assert.equal(projectTriageState({ ...item, description: undefined }).body, "Evidence");
  assert.deepEqual(projectTriageState({ ...item, description: undefined, body: undefined }), { title: "Crash" });
  assert.equal(triageSourceHash(item), triageSourceHash({ ...item, type: "Issue", priority: 0 }));
  assert.equal(triageSourceHash({ ...item, description: undefined, body: undefined }), triageSourceHash({ ...item, description: "", body: "" }));
  const long = { ...item, description: "x".repeat(5000), body: "y".repeat(5000), tags: Array.from({ length: 40 }, () => "t".repeat(200)) };
  const state = projectTriageState(long);
  assert.ok(state.description && state.description.length < 4100);
  assert.equal(state.tags?.length, 32);
  assert.equal(state.tags?.[0].length, 128);
  assert.deepEqual(projectTriageState(long), projectTriageState({ ...long, description: `${long.description}different` }));
  assert.notEqual(triageSourceHash(long), triageSourceHash({ ...long, description: `${long.description}different` }));
  assert.notEqual(triageSourceHash(item), triageSourceHash({ ...item, body: "Different body" }));
  assert.notEqual(triageSourceHash(item), triageSourceHash({ ...item, status: "in_progress" }));
});

test("batch dry run streams one compact JSON line per bounded host-selected item and writes nothing", async () => {
  await scenario(async (fixture, server) => {
    await fixture.pm.create({ type: "Feature", title: "First crash", description: "Details", body: "Details", priority: 3 });
    await fixture.pm.create({ type: "Feature", title: "Second crash", description: "Details", body: "Details", priority: 3 });
    await fixture.pm.create({ type: "Issue", title: "Other type", priority: 3 });
    await fixture.pm.create({ type: "Feature", title: "Active work", status: "in_progress", priority: 3 });
    const before = await fixture.pm.listAllComplete();
    const expected = await fixture.pm.list({ lifecycleBucket: "open", type: "Feature", limit: "1", fields: "id,title" });
    const captured = await capture(() => fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true, type: "feature", limit: "1" }, global: { json: true, quiet: false } }));
    const result = summary(captured.result);
    assert.deepEqual([result.selected, result.would_change, result.changed, result.skipped, result.failed, result.has_more], [1, 1, 0, 0, 0, true]);
    assert.equal(captured.lines.length, 2);
    const row = JSON.parse(captured.lines[0]) as BacklogTriageRow;
    assert.equal(row.outcome, "would_change");
    assert.equal(row.item, expected.items[0].id);
    assert.equal(row.type, "Issue");
    assert.equal(row.priority, 0);
    assert.ok(!captured.lines.join("").includes("Details"));
    assert.deepEqual((await fixture.pm.listAllComplete()).items, before.items);
    assert.equal(server.requests.length, 1);
    assert.deepEqual((server.requests[0].body as { state: unknown }).state, { title: expected.items[0].title, description: "Details" });
    assert.equal((server.requests[0].body as { keep_alive: string }).keep_alive, "5m");
    assert.equal(Object.keys((server.requests[0].body as { questions: Questions }).questions).length, 4);
  });
});

test("apply receipts survive routing writes, skip repeated source, refresh and notice changes beyond truncation", async () => {
  await scenario(async (fixture, server) => {
    const long = "x".repeat(5000);
    const item = (await fixture.pm.create({ type: "Feature", title: "Crash", description: long, priority: 3 })).item;
    const run = (options = {}) => fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true, apply: true, ...options } });
    assert.equal(summary(await run()).changed, 1);
    const receipt = (await fixture.pm.comments(item.id)).comments[0].text;
    assert.match(receipt, /source_sha256=[a-f0-9]{64}/);
    assert.ok(!receipt.includes(long.slice(0, 50)));
    assert.equal(summary(await run()).skipped, 1);
    assert.equal(server.requests.length, 1);
    assert.equal((await fixture.pm.comments(item.id)).count, 1);
    assert.equal(summary(await run({ refresh: true })).skipped, 1);
    assert.equal(server.requests.length, 2);
    await fixture.pm.update(item.id, { description: `${long}new tail` });
    assert.equal(summary(await run()).skipped, 1);
    assert.equal(server.requests.length, 3);
    assert.equal((await fixture.pm.comments(item.id)).count, 3);
  });
});

test("batch authorization uses per-field probabilities, supports abstention and ignores nonreceipt comments", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ type: "Feature", title: "Crash", priority: 3 })).item;
    await fixture.pm.comments(item.id, { add: "unrelated comment" });
    server.setReply((_, response, body) => {
      const result = answers((body as { questions: Questions }).questions);
      const priorityResponse = { type: "score", score: 0.5, confidence: 1, legend: (result.answers.priority as { legend: unknown }).legend, probabilities: { 0: 0.5, 1: 0.5, 2: 0, 3: 0, 4: 0 } };
      result.answers.priority = priorityResponse;
      response.end(JSON.stringify(result));
    });
    const response = await fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true, apply: true, minConfidence: "0.8" } });
    assert.equal(summary(response).changed, 1);
    const changed = (await fixture.pm.get(item.id)).item;
    assert.equal(changed.type, "Issue");
    assert.equal(changed.priority, 3);
    assert.match((await fixture.pm.comments(item.id)).comments[1].text, /applied=\[type=Issue\]/);
    assert.equal(summary(await fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true, refresh: true, minConfidence: "1" } })).skipped, 1);
  });
});

test("retained type probability follows the resolved label in full, compact, receipt and batch output", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ type: "Issue", title: "Synthetic crash", priority: 0 })).item;
    for (const weights of [
      { Feature: 0.7, Issue: 0.2, [KEEP_CURRENT_TYPE]: 0.1 },
      { Feature: 0.05, Issue: 0.05, [KEEP_CURRENT_TYPE]: 0.9 },
    ]) {
      server.setReply((_, response, body) => response.end(JSON.stringify(typeAnswers((body as { questions: Questions }).questions, weights))));
      for (const json of [true, false]) {
        const result = (await fixture.harness.runCommand({ command: "jev triage", args: [item.id],
          pmRoot: fixture.pmRoot, global: { json }, options: {} })).result as TriageDecision;
        assert.equal(result.proposals.type.value, "Issue");
        assert.equal(result.proposals.type.selected_label, KEEP_CURRENT_TYPE);
        assert.equal(result.proposals.type.probability, weights.Issue);
        assert.equal(result.proposals.type.probabilities[KEEP_CURRENT_TYPE], weights[KEEP_CURRENT_TYPE]);
        assert.equal("definitions" in result.proposals.type, json);
      }
      const captured = await capture(() => fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot,
        options: { open: true, apply: true, refresh: true }, global: { json: true, quiet: false } }));
      const row = JSON.parse(captured.lines[0]) as BacklogTriageRow;
      assert.equal(row.type, "Issue");
      assert.equal(row.type_probability, weights.Issue);
      const comments = (await fixture.pm.comments(item.id)).comments;
      assert.ok(comments.at(-1)?.text.includes(`type=Issue p=${weights.Issue},`));
    }
  });
});

test("batch rejects incompatible arguments, invalid limits and unknown types before HTTP", async () => {
  await scenario(async (fixture, server) => {
    for (const [args, options] of [
      [[], {}], [["synthetic"], { open: true }], [["synthetic", "extra"], {}],
      [["synthetic"], { type: "Issue" }], [["synthetic"], { limit: "1" }], [["synthetic"], { refresh: true }],
      [[], { open: true, full: true }], ...["0", "-1", "1.5", "1001", "bad", "9007199254740992", ""].map(limit => [[], { open: true, limit }]),
      [[], { open: true, type: "MissingType" }], [[], { open: true, minConfidence: "2" }],
    ] as [string[], Record<string, unknown>][]) {
      await assert.rejects(fixture.harness.runCommand({ command: "jev triage", args, options, pmRoot: fixture.pmRoot }), /./, JSON.stringify({ args, options }));
    }
    assert.equal(server.requests.length, 0);
  });
});

test("receipt guard validates real source snapshots, expires writes and leaves unrelated mutations alone", async () => {
  await scenario(async (fixture) => {
    const id = (await fixture.pm.create({ type: "Feature", title: "Guarded crash", priority: 3 })).item.id;
    type Document = NonNullable<BeforeMutationHookContext["before"]>;
    const snapshot = async (target: string): Promise<Document> => {
      const full = await fixture.pm.get(target, { full: true });
      const { body = "", ...metadata } = full.item;
      return { metadata: metadata as Document["metadata"], body };
    };
    const before = await snapshot(id);
    await fixture.harness.runCommand({ command: "jev triage", args: [id], options: { apply: true }, pmRoot: fixture.pmRoot });
    const after = await snapshot(id);
    const sdk: BeforeMutationHookContext["sdk"] = {
      get: async target => { const document = await snapshot(target); return { item: document.metadata, body: document.body }; },
      list: () => fixture.pm.listAllItemMetadataLight(),
    };
    assert.equal((await sdk.get(id))?.item.id, id);
    assert.equal((await sdk.list()).length, 1);
    const guard = (previous: Document | null, next: Document | null) => fixture.harness.runMutationGuard({ context: { pm_root: fixture.pmRoot, operation: "update", before: previous, after: next, changed_fields: ["comments"], sdk } });
    await guard(before, after);
    await guard(null, after);
    await guard(before, null);
    const receipt = after.metadata.comments?.[0];
    assert.ok(receipt);
    const withComment = (text: string): Document => ({ ...after, metadata: { ...after.metadata, comments: [{ ...receipt, text }] } });
    await guard(before, withComment("ordinary comment"));
    await guard(before, withComment("pm-jev triage receipt: model=legacy, catalog=old."));
    await guard({ ...before, metadata: { ...before.metadata, comments: undefined } }, { ...after, metadata: { ...after.metadata, comments: undefined } });
    await assert.rejects(guard(before, withComment(receipt.text.replace(/deadline_ms=\d+/, "deadline_ms=0"))), { code: "jev_stale_inference" });
    await assert.rejects(guard({ ...before, body: "Changed after inference" }, after), { code: "jev_stale_inference" });
    const revised: Document = { ...before, metadata: { ...before.metadata, priority: 4 } };
    await assert.rejects(guard(revised, after), { code: "jev_stale_inference" });
    const handler = fixture.harness.activation.commands.handlers.find(entry => entry.command === "jev triage");
    assert.ok(handler);
    const raw = await handler.run({ command: "jev triage", pm_root: fixture.pmRoot, source_workspace_root: fixture.cwd, args: [id], options: {}, global: { json: true, quiet: true } });
    assert.deepEqual((raw as { applied: string[] }).applied, []);
  });
});

test("Ollama keep_alive uses the supported wire field, accepts numeric residency and is omitted for hosted calls", async () => {
  await scenario(async (fixture, server) => {
    const id = (await fixture.pm.create({ type: "Feature", title: "Residency crash" })).item.id;
    for (const value of [0, -1, 300, "-1s", "1.5m"]) {
      writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify({ jev: { keep_alive: value } }));
      assert.equal((await resolveJevEndpoint(fixture.pmRoot, {})).config.keepAlive, value);
    }
    for (const value of [null, {}, "", "forever", false]) {
      writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify({ jev: { keep_alive: value } }));
      await assert.rejects(resolveJevEndpoint(fixture.pmRoot, {}), { code: "jev_invalid_keep_alive" });
    }
    writeFileSync(getSettingsPath(fixture.pmRoot), '{"jev":{"keep_alive":1e400}}');
    await assert.rejects(resolveJevEndpoint(fixture.pmRoot, {}), { code: "jev_invalid_keep_alive" });
    writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify({ jev: { keep_alive: 0 } }));
    await fixture.harness.runCommand({ command: "jev triage", args: [id], pmRoot: fixture.pmRoot });
    assert.equal((server.requests[0].body as { keep_alive: number }).keep_alive, 0);
    const restore = hostedFixture(server);
    const previousKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "synthetic";
    try {
      writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify({ jev: { provider: "typesafe", allow_external: true, keep_alive: "invalid" } }));
      await fixture.harness.runCommand({ command: "jev triage", args: [id], pmRoot: fixture.pmRoot });
      assert.ok(!("keep_alive" in (server.requests[1].body as object)));
    } finally {
      restore();
      if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = previousKey;
    }
  });
});

test("backlog selection follows custom open status roles and item type aliases", async () => {
  await scenario(async (fixture, server) => {
    await fixture.pm.schemaRemapStatus("open", "queued", {});
    await fixture.pm.schemaAddType("Bug", { description: "Defect", alias: ["defect"] });
    const item = (await fixture.pm.create({ type: "Bug", title: "Queued defect", status: "queued" })).item;
    await fixture.pm.create({ type: "Bug", title: "Active defect", status: "in_progress" });
    const response = await fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true, type: "defect" } });
    assert.equal(summary(response).selected, 1);
    assert.equal(server.requests.length, 1);
    assert.equal((await fixture.pm.get(item.id)).item.status, "queued");
  });
});

test("batch skips stale source without field writes or receipts and continues after malformed answers", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ type: "Feature", title: "Crash", priority: 3 })).item;
    server.setReply((_, response, body) => {
      void fixture.pm.update(item.id, { title: "Revised intent" }).then(() => response.end(JSON.stringify(answers((body as { questions: Questions }).questions))));
    });
    const run = () => fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true, apply: true } });
    assert.equal(summary(await run()).skipped, 1);
    assert.equal((await fixture.pm.get(item.id)).item.type, "Feature");
    assert.equal((await fixture.pm.comments(item.id)).count, 0);
    await fixture.pm.create({ type: "Feature", title: "Second crash", priority: 3 });
    let count = 0;
    server.setReply((_, response, body) => { count++; response.end(JSON.stringify(count === 1 ? {} : answers((body as { questions: Questions }).questions))); });
    const result = await run();
    assert.equal(summary(result).failed, 1);
    assert.equal(summary(result).changed, 1);
    assert.equal((result as { exitCode: number }).exitCode, 1);
  });
});

test("one batch deadline aborts in-flight inference and forbids later requests and writes", async () => {
  await scenario(async (fixture, server) => {
    writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify({ jev: { total_deadline_ms: 1000, timeout_ms: 1000 } }));
    for (let index = 0; index < 3; index++) await fixture.pm.create({ type: "Feature", title: `Crash ${index}`, priority: 3 });
    server.setReply(() => {});
    const started = performance.now();
    const response = await fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true, apply: true } });
    assert.equal(summary(response).failed, 3);
    assert.ok(performance.now() - started < 10000);
    assert.ok(server.requests.length <= 1);
    for (const item of (await fixture.pm.listAllComplete()).items) {
      assert.equal(item.type, "Feature");
      assert.equal((await fixture.pm.comments(item.id)).count, 0);
    }
  });
});

test("deleted and missing source documents retain host errors without applying receipts", async () => {
  for (const mode of ["deleted", "missing"] as const) {
    await scenario(async (fixture, server) => {
      const item = (await fixture.pm.create({ type: "Feature", title: "Source disappears", priority: 3 })).item;
      const located = await locateItem(fixture.pmRoot, item.id);
      assert.ok(located);
      server.setReply(async (_, response, body) => {
        if (mode === "deleted") await fixture.pm.delete(item.id);
        else rmSync(located.itemPath);
        response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
      });
      const output = await capture(() => fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true, apply: true }, global: { json: true, quiet: false } }));
      assert.equal(summary(output.result).failed, 1);
      assert.equal((JSON.parse(output.lines[0]) as BacklogTriageRow).reason, mode === "deleted" ? "item_deleted" : "jev_triage_failure");
      assert.equal((await fixture.pm.listAllComplete()).items.length, 0);
      assert.equal(server.requests.length, 1);
    });
  }
});

test("TOON batches stream a table row per item; empty backlogs have a zero summary without inference", async () => {
  await scenario(async (fixture, server) => {
    const run = (global = { json: false, quiet: false }) => fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true }, global });
    const empty = await capture(() => run());
    assert.equal(summary(empty.result).selected, 0);
    assert.equal(server.requests.length, 0);
    assert.match(empty.lines[0], /^items\[0\]/);
    for (const [global, json] of [
      [{ json: false, outputFormat: "json" }, true],
      [{ json: undefined, outputFormat: undefined, defaultOutputFormat: "json" }, true],
      [{ json: false, defaultOutputFormat: "json", outputFormat: "toon" }, false],
      [{ json: undefined, defaultOutputFormat: "toon" }, false],
      [{ json: undefined, outputFormat: "toon" }, false],
    ] as const) {
      const output = await capture(() => fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true }, global: { ...global, quiet: false } }));
      if (json) assert.equal(JSON.parse(output.lines[0]).selected, 0);
      else assert.match(output.lines[0], /^items\[0\]/);
    }
    await fixture.pm.create({ type: "Feature", title: "Crash", priority: 3 });
    const toon = await capture(() => run());
    assert.equal(toon.lines.length, 4);
    assert.match(toon.lines[1], /"would_change"/);
    assert.match(toon.lines[2], /^summary\[1\]/);
    const json = await capture(() => run({ json: true, quiet: false }));
    assert.equal(JSON.parse(json.lines[0]).outcome, "would_change");
    const settings = readFileSync(getSettingsPath(fixture.pmRoot), "utf8");
    assert.ok(settings.length > 0);
  });
});

test("batch margin abstention emits an explicit null type in JSON and TOON while priority remains independent", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ type: "Feature", title: "Synthetic ambiguous work", priority: 3 })).item;
    server.setReply((_, response, body) => {
      response.end(JSON.stringify(typeAnswers((body as { questions: Questions }).questions, { Issue: 0.5, Feature: 0.5 })));
    });
    const run = (json: boolean, apply: boolean) => capture(() => fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot,
      options: { open: true, refresh: true, apply }, global: { json, quiet: false } }));
    const json = await run(true, true);
    const row = JSON.parse(json.lines[0]) as BacklogTriageRow;
    assert.equal(row.type, null);
    assert.equal(row.type_probability, null);
    assert.equal(row.abstained, true);
    assert.equal(row.reason, "top_two_margin_below_threshold");
    assert.equal(row.outcome, "changed");
    assert.equal((await fixture.pm.get(item.id)).item.type, "Feature");
    assert.equal((await fixture.pm.get(item.id)).item.priority, 0);
    assert.match((await fixture.pm.comments(item.id)).comments[0].text, /abstained=true/);
    const toon = await run(false, false);
    assert.match(toon.lines[0], /abstained/);
    assert.match(toon.lines[1], /top_two_margin_below_threshold/);
  });
});
