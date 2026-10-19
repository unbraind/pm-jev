import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { BeforeMutationHookContext } from "@unbrained/pm-cli/sdk/authoring";
import type { Questions } from "@typesafe-ai/sdk";
import { candidatePairs, orderedPair, pairKey, pairState, pairVerdict, runPairDedupe, PAIR_CALIBRATION } from "../dedupe.ts";
import type { PairItem, PairVerdict } from "../dedupe.ts";
import { answers, scenario as modelScenario, trackerSnapshot, hostedFixture } from "./fixtures.ts";
import { getSettingsPath, PmClient, createExtensionCommandSdk } from "@unbrained/pm-cli/sdk";

type Fixture = Parameters<Parameters<typeof modelScenario>[0]>[0];
type Server = Parameters<Parameters<typeof modelScenario>[0]>[1];

/** Use a labelled scripted model without impersonating measured production model weights. */
async function scenario(run: (fixture: Fixture, server: Server) => Promise<void>): Promise<void> {
  const previous = process.env.PM_JEV_MODEL;
  process.env.PM_JEV_MODEL = "scripted-test-model";
  try { await modelScenario(run); } finally { if (previous === undefined) delete process.env.PM_JEV_MODEL; else process.env.PM_JEV_MODEL = previous; }
}

/** Run the registered command using the real scratch tracker SDK. */
async function scan(fixture: Fixture, options: Record<string, unknown> = {}, args: string[] = []): Promise<PairVerdict[]> {
  return (await fixture.harness.runCommand({ command: "jev dedupe", pmRoot: fixture.pmRoot, global: { json: true }, options, args })).result as PairVerdict[];
}
/** Two same-work items with lexical signals present only in complete bodies. */
async function seed(fixture: Fixture) {
  const a = (await fixture.pm.create({ type: "Task", title: "Repair", description: "", body: "Reject expired sessions before displaying account details" })).item as PairItem;
  const b = (await fixture.pm.create({ type: "Task", title: "Authenticate", description: "", body: "Reject expired sessions before displaying account details" })).item as PairItem;
  return orderedPair((await fixture.pm.get(a.id, { full: true })).item as PairItem, (await fixture.pm.get(b.id, { full: true })).item as PairItem, 1);
}
/** Script only the decision model boundary, keeping all tracker reads and writes real. */
function probability(server: Server, value: number): void {
  server.setReply((_, response, body) => {
    const result = answers((body as { questions: Questions }).questions);
    result.answers.same_work = { type: "noul", noul: value };
    response.end(JSON.stringify(result));
  });
}

test("pair candidates respect bounds, body evidence, Unicode, chronology and stable ties", async () => {
  await scenario(async fixture => {
    const pair = await seed(fixture);
    const items = [pair.a, pair.b];
    for (let i = 0; i < 12; i++) items.push({ ...pair.a, id: `synthetic-${i}`, title: `Sessions ${i}` });
    assert.equal(candidatePairs(items, 3).length, 3);
    assert.equal(candidatePairs(items, 200, 1).length <= items.length, true);
    assert.deepEqual(candidatePairs(items, 20), candidatePairs([...items].reverse(), 20));
    assert.deepEqual(candidatePairs([], 20), []);
    assert.deepEqual(candidatePairs([{ ...pair.a, title: "", description: "", body: "" }], 20), []);
    assert.equal(candidatePairs([pair.a, pair.b], 1).length, 1);
    assert.equal(pairKey("a", "b"), pairKey("b", "a"));
    assert.equal(orderedPair(pair.b, pair.a, 1).a.id, pair.a.id);
    assert.equal(orderedPair({ ...pair.a, created_at: "2000" }, pair.b, 1).b.id, pair.a.id);
    assert.equal(orderedPair({ ...pair.a, created_at: pair.b.created_at, id: "z" }, pair.b, 1).a.id, "z");
    const unicode = [{ ...pair.a, title: "Änderung prüfen", description: "", body: undefined }, { ...pair.b, title: "Änderung prüfen", description: "", body: undefined }];
    assert.equal(candidatePairs(unicode, 1)[0].score, 1);
    assert.equal(candidatePairs([{ ...pair.a, title: "UTF-8 prose aaa", body: "" }, { ...pair.b, title: "UTF-8 prose zzz", body: "" }], 1)[0].score < 0.99, true);
    assert.ok(JSON.stringify(pairState(pair)).includes("Reject expired sessions"));
    assert.ok(!JSON.stringify(pairState(pair)).includes(pair.a.id));
    assert.ok(JSON.stringify(pairState({ ...pair, a: { ...pair.a, body: undefined } })).length > 0);
  });
});

test("pair verdict has inclusive cutoffs, an abstain band and no positive exact tie", async () => {
  await scenario(async fixture => {
    const pair = await seed(fixture);
    assert.equal(pairVerdict(pair, 0.8, 0.8).decision, "duplicate");
    assert.equal(pairVerdict(pair, 1 - 0.8, 0.8).decision, "distinct");
    assert.equal(pairVerdict(pair, 0.79, 0.8).decision, "abstain");
    assert.equal(pairVerdict(pair, 0.5, 0.5).decision, "abstain");
    assert.equal(pairVerdict(pair, 1, 1).decision, "duplicate");
    assert.equal(pairVerdict(pair, 0, 1).decision, "distinct");
  });
});

test("pair dry-run is read-only, bounds inference and filters complete SDK items", async () => {
  await scenario(async (fixture, server) => {
    const pair = await seed(fixture);
    await fixture.pm.comments(pair.a.id, { add: "PRIVATE_ANNOTATION" });
    const before = trackerSnapshot(fixture.pmRoot);
    const rows = await scan(fixture, { limitPairs: "1", type: "task", full: true });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].decision, "duplicate");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    assert.equal(server.requests.length, 1);
    assert.ok(!JSON.stringify(server.requests).includes("PRIVATE_ANNOTATION"));
    assert.deepEqual(await scan(fixture, { type: "Feature" }), []);
    await fixture.pm.update(pair.a.id, { status: "closed", closeReason: "test complete" });
    assert.deepEqual(await scan(fixture), []);
    assert.equal((await scan(fixture, { status: "all" })).length, 1);
  });
});

test("pair apply writes only above threshold and closes only with the extra flag", async () => {
  await scenario(async (fixture, server) => {
    const pair = await seed(fixture);
    probability(server, 0.79);
    const before = trackerSnapshot(fixture.pmRoot);
    const below = await scan(fixture, { apply: true });
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    assert.equal(below[0].decision, "abstain");
    probability(server, 0.9);
    assert.equal((await scan(fixture, { apply: true, minConfidence: "0.95" }))[0].decision, "abstain");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    probability(server, 0.8);
    assert.equal((await scan(fixture, { apply: true }))[0].reason, "linked_with_receipt");
    let current = (await fixture.pm.get(pair.a.id, { full: true })).item;
    assert.equal(current.status, "open");
    assert.equal(current.close_reason, undefined);
    assert.ok(current.dependencies?.some(dep => dep.id === pair.b.id && dep.kind === "related"));
    assert.equal(current.comments?.length, 1);
    assert.match(current.comments![0].text, /canonical=.*probability=0.8, threshold=0.8, relation=related, close=false/);
    await scan(fixture, { apply: true, close: true });
    current = (await fixture.pm.get(pair.a.id, { full: true })).item;
    assert.equal(current.status, "closed");
    assert.equal(current.close_reason, `duplicate of ${pair.b.id}`);
    const history = readFileSync(join(fixture.pmRoot, "history", `${pair.a.id}.jsonl`), "utf8").trim().split("\n");
    assert.match(history.at(-2)!, /comments/);
    assert.match(history.at(-1)!, /close_reason/);
    assert.equal((await fixture.pm.get(pair.b.id, { full: true })).item.status, "open");
  });
});

test("pair scan rejects invalid flags and refuses unavailable models with a remedy", async () => {
  await scenario(async (fixture, server) => {
    await seed(fixture);
    for (const options of [{ status: "closed" }, { close: true }, { body: "x" }, { limit: "3" }, ...["0", "201", "1.5", "bad", "9007199254740992"].map(limitPairs => ({ limitPairs })), ...["bad", "0.4", "1.1"].map(minConfidence => ({ minConfidence }))]) await assert.rejects(scan(fixture, options));
    await assert.rejects(scan(fixture, {}, ["extra"]));
    server.setReply((_, response) => { response.statusCode = 404; response.end(JSON.stringify({ error: "model unavailable" })); });
    const before = trackerSnapshot(fixture.pmRoot);
    await assert.rejects(scan(fixture, { apply: true, close: true }), /ollama pull|doctor/);
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  });
});

test("pair apply refuses concurrent changes and avoids duplicate chains in a batch", async () => {
  await scenario(async (fixture, server) => {
    const pair = await seed(fixture);
    server.setReply(async (_, response, body) => {
      await fixture.pm.update(pair.b.id, { body: "Changed requested work" });
      response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
    });
    await assert.rejects(scan(fixture, { apply: true }), /evidence changed/);
    assert.equal((await fixture.pm.get(pair.a.id, { full: true })).item.comments?.length ?? 0, 0);
    probability(server, 0.9);
    await fixture.pm.create({ type: "Task", title: "Repair expired sessions", body: pair.a.body });
    const rows = await scan(fixture, { apply: true, minConfidence: "0.8" });
    assert.ok(rows.some(row => row.reason === "linked_with_receipt"));
    assert.ok(rows.some(row => row.reason === "same_work_above_threshold"));
  });
});

test("pair source lock guard rejects stale or expired receipts", async () => {
  await scenario(async fixture => {
    const pair = await seed(fixture);
    const document = () => fixture.pm.get(pair.a.id, { full: true });
    const original = await document();
    await scan(fixture, { apply: true });
    const updated = await document();
    const before = { metadata: original.item, body: original.item.body ?? "" };
    const after = { metadata: updated.item, body: updated.item.body ?? "" };
    type Document = BeforeMutationHookContext["before"];
    const sdk: BeforeMutationHookContext["sdk"] = { get: async () => ({ item: original.item as PairItem, body: before.body }), list: () => fixture.pm.listAllItemMetadataLight() };
    const guard = (previous: Document, next: Document) => fixture.harness.runMutationGuard({ context: { pm_root: fixture.pmRoot, operation: "update", before: previous, after: next, changed_fields: ["comments"], sdk } });
    await guard(before as Document, after as Document);
    await guard(null, after as Document);
    await guard(before as Document, null);
    const receipt = updated.item.comments![0];
    const text = (value: string) => ({ ...after, metadata: { ...after.metadata, comments: [{ ...receipt, text: value }] } }) as Document;
    await guard(before as Document, text("ordinary comment"));
    await guard({ ...before, metadata: { ...before.metadata, comments: undefined } } as Document, text("ordinary comment"));
    await guard(before as Document, { ...after, metadata: { ...after.metadata, comments: undefined } } as Document);
    await assert.rejects(guard(before as Document, text(receipt.text.replace(/deadline_ms=\d+/, "deadline_ms=0"))), { code: "jev_stale_inference" });
    await assert.rejects(guard({ ...before, body: "Changed" } as Document, after as Document), { code: "jev_stale_inference" });
  });
});

test("pair scans reject mixed pre-create flags and prune high-frequency trigrams", async () => {
  await scenario(async fixture => {
    await assert.rejects(scan(fixture, { title: "candidate", apply: true }), /cannot be combined/);
    const pair = await seed(fixture);
    const items = Array.from({ length: 70 }, (_, i) => ({ ...pair.a, id: `synthetic-${i}`, title: "Common session policy", body: "shared body" }));
    assert.equal(candidatePairs(items, 20).length, 20);
    assert.ok(candidatePairs(items, 20).every(row => row.score === 1));
    const handler = fixture.harness.activation.commands.handlers.find(entry => entry.command === "jev dedupe");
    assert.ok(handler);
    const ctx = { pm_root: fixture.pmRoot, source_workspace_root: fixture.cwd, args: [], options: {}, global: { author: "fixture" }, command: "jev dedupe" };
    assert.equal((await runPairDedupe(ctx)).length, 1);
  });
});

test("measured pair cutoffs cannot be lowered and model digest drift refuses writes", async () => {
  await scenario(async (fixture, server) => {
    await seed(fixture);
    process.env.PM_JEV_MODEL = "tev1:0.8b";
    const measured = PAIR_CALIBRATION["tev1:0.8b"];
    let p = measured.threshold - 0.0001, tags = 0, drift = false;
    server.setReply((request, response, body) => {
      if (request.url === "/api/tags") { tags++; response.end(JSON.stringify({ models: [{ name: "tev1:0.8b", digest: drift && tags > 1 ? "c".repeat(64) : measured.digest }] })); return; }
      const result = answers((body as { questions: Questions }).questions);
      result.answers.same_work = { type: "noul", noul: p };
      response.end(JSON.stringify(result));
    });
    const before = trackerSnapshot(fixture.pmRoot);
    assert.equal((await scan(fixture, { minConfidence: "0.5", apply: true }))[0].decision, "abstain");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    p = measured.threshold;
    assert.equal((await scan(fixture))[0].decision, "duplicate");
    tags = 0; drift = true;
    await assert.rejects(scan(fixture, { apply: true }), /digest changed/);
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    await assert.rejects(scan(fixture), /digest changed/);
    process.env.PM_JEV_MODEL = "tev1:4b";
    server.setReply((request, response, body) => {
      if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: PAIR_CALIBRATION["tev1:4b"].digest }] })); return; }
      response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
    });
    assert.equal((await scan(fixture))[0].decision, "duplicate");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  });
});

test("hosted pair scanning reuses the existing explicit provider privacy boundary", async () => {
  await scenario(async (fixture, server) => {
    await seed(fixture);
    const path = getSettingsPath(fixture.pmRoot);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.jev = { provider: "typesafe", allow_external: true };
    writeFileSync(path, JSON.stringify(settings));
    const oldKey = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "synthetic";
    const restore = hostedFixture(server);
    try { assert.equal((await scan(fixture)).length, 1); }
    finally { restore(); if (oldKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = oldKey; }
  });
});

/** Load the production guard through the real SDK extension lifecycle. */
function guardedClient(fixture: Fixture): PmClient {
  const directory = join(fixture.pmRoot, "extensions", "synthetic-dedupe-guard");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ name: "synthetic-dedupe-guard", version: "1.0.0", entry: "index.mjs", capabilities: ["hooks"] }));
  writeFileSync(join(directory, "index.mjs"), `import { guardDedupeMutation } from ${JSON.stringify(new URL("../dedupe.ts", import.meta.url).href)}; export default { activate(api) { api.hooks.beforeMutation(guardDedupeMutation); } };`);
  return new PmClient({ cwd: fixture.cwd, pmRoot: fixture.pmRoot, author: "fixture" });
}

test("stopgram fallback preserves normalized punctuation variants with bounded stable retrieval", async () => {
  await scenario(async fixture => {
    const pair = await seed(fixture);
    const items = Array.from({ length: 70 }, (_, i) => ({ ...pair.a, id: `variant-${i.toString().padStart(2, "0")}`, title: `Common session policy${"!?".repeat(i)}`, description: "", body: "" }));
    const pairs = candidatePairs(items, 20);
    assert.equal(pairs.length, 20);
    assert.ok(pairs.every(row => row.score === 1));
    assert.deepEqual(pairs, candidatePairs([...items].reverse(), 20));
  });
});

for (const change of ["none", "body", "comment", "removed receipt", "expired", "historical", "different canonical"] as const) {
  test(`separate close lock checks live receipt and source on a real tracker: ${change}`, async t => {
    await scenario(async fixture => {
      const pair = await seed(fixture);
      const pm = guardedClient(fixture);
      const original = pair.a;
      const input = createHash("sha256").update(JSON.stringify([original.id, original.title, original.description, original.body, original.type, original.status, original.created_at, original.updated_at, original.dependencies])).digest("hex");
      const deadline = Date.now() + 5000;
      const receipt = `pm-jev dedupe pair receipt: input_sha256=${input}, deadline_ms=${deadline}, canonical=${pair.b.id}, close=true.`;
      await pm.update(original.id, { dep: [`id=${pair.b.id},kind=related`], comment: [receipt] });
      const linked = (await fixture.pm.get(original.id, { full: true })).item;
      assert.equal(linked.comments?.[0].text, receipt);
      assert.equal(linked.dependencies?.[0].id, pair.b.id);
      // A separate real SDK client edits after the link commit and before the close lock.
      if (change === "body") await fixture.pm.update(original.id, { body: "Concurrent requested work revision" });
      if (change === "comment") await fixture.pm.comments(original.id, { add: "Concurrent evidence" });
      if (change === "removed receipt") await fixture.pm.update(original.id, { clearComments: true });
      // Deterministic clock advancement expires the actual persisted receipt without a slow sleep.
      const clock = change === "expired" ? t.mock.method(Date, "now", () => deadline) : undefined;
      const close = () => pm.update(original.id, { status: "closed", closeReason: `duplicate of ${change === "different canonical" ? "another-canonical" : pair.b.id}` });
      try {
        if (change === "none" || change === "historical") await close();
        else await assert.rejects(close(), { code: "jev_stale_inference" });
      } finally { clock?.mock.restore(); }
      if (change === "historical") {
        await fixture.pm.update(original.id, { status: "open" });
        await assert.rejects(close(), { code: "jev_stale_inference" });
      }
      const after = (await fixture.pm.get(original.id, { full: true })).item;
      assert.equal(after.status, change === "none" ? "closed" : "open");
      assert.deepEqual(after.dependencies, linked.dependencies);
      if (change === "removed receipt") assert.equal(after.comments?.length ?? 0, 0);
      else assert.deepEqual(after.comments?.[0], linked.comments?.[0]);
      if (change === "body") assert.equal(after.body, "Concurrent requested work revision");
      if (change === "historical") {
        await pm.update(original.id, { status: "closed", closeReason: "Completed independently of the duplicate proposal" });
        assert.equal((await fixture.pm.get(original.id)).item.status, "closed");
      }
    });
  });
}

test("pair command closes unchanged evidence through the active real SDK guard", async () => {
  await scenario(async fixture => {
    const pair = await seed(fixture);
    const pm = guardedClient(fixture);
    const rows = await runPairDedupe({ pm_root: fixture.pmRoot, source_workspace_root: fixture.cwd, args: [], options: { apply: true, close: true }, global: { author: "fixture" }, command: "jev dedupe", sdk: createExtensionCommandSdk(fixture.pmRoot, pm, "fixture", "jev dedupe") });
    assert.equal(rows[0].reason, "linked_and_closed_with_receipt");
    assert.equal((await fixture.pm.get(pair.a.id)).item.status, "closed");
  });
});

for (const delayedRead of [1, 2]) {
  test(`pair preview digest read ${delayedRead} shares the total run deadline`, async () => {
    await scenario(async (fixture, server) => {
      await seed(fixture);
      process.env.PM_JEV_MODEL = "tev1:0.8b";
      const path = getSettingsPath(fixture.pmRoot);
      const settings = JSON.parse(readFileSync(path, "utf8"));
      settings.jev = { total_deadline_ms: 1000, timeout_ms: 5000 };
      writeFileSync(path, JSON.stringify(settings));
      let tags = 0;
      let delayedClosed: Promise<boolean> | undefined;
      server.setReply((request, response, body) => {
        if (request.url === "/api/tags") {
          const payload = JSON.stringify({ models: [{ name: "tev1:0.8b", digest: PAIR_CALIBRATION["tev1:0.8b"].digest }] });
          if (++tags === delayedRead) {
            const timer = setTimeout(() => response.end(payload), 1200);
            delayedClosed = new Promise(resolve => { response.once("close", () => { clearTimeout(timer); resolve(!response.writableEnded); }); });
          } else response.end(payload);
        } else response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
      });
      const before = trackerSnapshot(fixture.pmRoot);
      await assert.rejects(scan(fixture), /timeout|abort|deadline/i);
      assert.equal(await delayedClosed, true, "shared abort must cancel the delayed digest response before it completes");
      assert.equal(tags, delayedRead);
      assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    });
  });
}


test("pair guard permits unrelated closes with absent or ordinary comments", async () => {
  await scenario(async fixture => {
    const pm = guardedClient(fixture);
    for (const comment of [[], ["Ordinary lifecycle evidence"]]) {
      const item = (await pm.create({ type: "Task", title: "Unrelated completed work", comment })).item;
      await pm.update(item.id, { status: "closed", closeReason: "Work completed" });
      assert.equal((await fixture.pm.get(item.id)).item.status, "closed");
    }
  });
});
