import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { BeforeMutationHookContext } from "@unbrained/pm-cli/sdk/authoring";
import type { Questions } from "@typesafe-ai/sdk";
import { candidatePairs, orderedPair, pairKey, pairState, pairVerdict, runPairDedupe, PAIR_CALIBRATION, DUPLICATE_QUALITY_CALIBRATION } from "../dedupe.ts";
import type { PairItem, PairVerdict } from "../dedupe.ts";
import { answers, scenario as modelScenario, trackerSnapshot, hostedFixture } from "./fixtures.ts";
import { getSettingsPath, PmClient, createExtensionCommandSdk } from "@unbrained/pm-cli/sdk";

type Fixture = Parameters<Parameters<typeof modelScenario>[0]>[0];
type Server = Parameters<Parameters<typeof modelScenario>[0]>[1];

/** Script the HTTP model boundary and its policy catalog; tracker SDK operations remain real. */
async function scenario(run: (fixture: Fixture, server: Server) => Promise<void>): Promise<void> {
  const previous = process.env.PM_JEV_MODEL;
  process.env.PM_JEV_MODEL = "scripted-test-model";
  const measuredDescriptor = Object.getOwnPropertyDescriptor(DUPLICATE_QUALITY_CALIBRATION, "tev1:4b");
  Object.defineProperty(DUPLICATE_QUALITY_CALIBRATION, "tev1:4b", { configurable: true, value: { policy: { model: PAIR_CALIBRATION["tev1:4b"].threshold, lexical: 0.2 }, digest: PAIR_CALIBRATION["tev1:4b"].digest } });
  const descriptor = Object.getOwnPropertyDescriptor(DUPLICATE_QUALITY_CALIBRATION, "scripted-test-model");
  Object.defineProperty(DUPLICATE_QUALITY_CALIBRATION, "scripted-test-model", { configurable: true, value: { policy: { model: 0.8, lexical: 0.2 }, digest: "a".repeat(64) } });
  try { await modelScenario(async (fixture, server) => {
    const setReply = server.setReply;
    server.setReply = handler => setReply((request, response, body) => {
      if (request.url === "/api/tags" && process.env.PM_JEV_MODEL === "scripted-test-model") { response.end(JSON.stringify({ models: [{ name: "scripted-test-model", digest: "a".repeat(64) }] })); return; }
      handler(request, response, body);
    });
    probability(server, 0.9);
    await run(fixture, server);
  }); } finally {
    if (measuredDescriptor === undefined) Reflect.deleteProperty(DUPLICATE_QUALITY_CALIBRATION, "tev1:4b");
    else Object.defineProperty(DUPLICATE_QUALITY_CALIBRATION, "tev1:4b", measuredDescriptor);
    if (descriptor === undefined) Reflect.deleteProperty(DUPLICATE_QUALITY_CALIBRATION, "scripted-test-model");
    else Object.defineProperty(DUPLICATE_QUALITY_CALIBRATION, "scripted-test-model", descriptor); if (previous === undefined) delete process.env.PM_JEV_MODEL; else process.env.PM_JEV_MODEL = previous; }
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

test("pair verdict has inclusive cutoffs, typed related verdicts and no positive exact tie", async () => {
  await scenario(async fixture => {
    const pair = await seed(fixture);
    assert.equal(pairVerdict(pair, 0.8, 0.2, 0.8, 0.8).decision, "duplicate");
    assert.equal(pairVerdict(pair, 1 - 0.8, 0.1, 0.8, 0.8).decision, "distinct");
    assert.equal(pairVerdict(pair, 0.79, 0.2, 0.8, 0.8).decision, "abstain");
    assert.equal(pairVerdict(pair, 0.5, 0.5, 0.5, 0.5).decision, "abstain");
    assert.equal(pairVerdict(pair, 1, 1, 1, 1).decision, "duplicate");
    assert.equal(pairVerdict(pair, 0, 0, 1, 1).decision, "distinct");
    assert.equal(pairVerdict(pair, 0.2, 0.9, 0.8, 0.8).decision, "related");
    assert.equal(pairVerdict(pair, 0.4, 0.95, 0.8, 0.8).reason, "related_above_threshold");
    assert.equal(pairVerdict(pair, 0.6, 0.9, 0.8, 0.8).decision, "related");
    assert.equal(pairVerdict(pair, 0.1, 0.79, 0.8, 0.8).decision, "abstain");
    assert.equal(pairVerdict(pair, 0.9, 0.9, 0.8, 0.8).decision, "duplicate");
  });
});

test("candidate retrieval uses tags and linked files beside title text", async () => {
  await scenario(async fixture => {
    const pair = await seed(fixture);
    const item = (id: string, title: string, body: string, tags: string[], files: string[]): PairItem =>
      ({ ...pair.a, id, title, description: "", body, tags, files: files.map(/** Linked files carry the contract scope. */ path => ({ path, scope: "project" })), dependencies: undefined } as PairItem);
    const items = [
      item("tag-a", "Renew gateway tokens", "rotate signing keys nightly", ["area:auth"], []),
      item("tag-b", "Audit login flows", "review step-up prompts", ["area:auth"], []),
      item("file-a", "Purge cache rows", "drop stale rows weekly", [], ["src/auth.ts"]),
      item("file-b", "Track token latency", "emit durations per request", [], ["src/auth.ts"]),
      item("alone", "Unrelated prose", "nothing shared here", ["area:other"], ["docs/other.md"]),
    ];
    const pairs = candidatePairs(items, 20);
    const tagged = pairs.find(/** Shared tags alone must surface the pair. */ row => pairKey(row.a.id, row.b.id) === pairKey("tag-a", "tag-b"));
    const filed = pairs.find(/** Shared linked files alone must surface the pair. */ row => pairKey(row.a.id, row.b.id) === pairKey("file-a", "file-b"));
    assert.ok(tagged);
    assert.equal(tagged!.score, 1);
    assert.ok(filed);
    assert.equal(filed!.score, 1);
    assert.ok(pairs.every(/** No structural channel reaches the unrelated item; only weak trigram noise does. */ row => row.a.id !== "alone" && row.b.id !== "alone" || row.score < 0.5));
    // A tag shared by more than maxPosting items is a structural stopgram, like common trigrams.
    const crowded = Array.from({ length: 70 }, (_, i) => item(`crowd-${i}`, String(i), "", ["cli"], []));
    assert.deepEqual(candidatePairs(crowded, 20), []);
    const small = crowded.slice(0, 20);
    assert.equal(candidatePairs(small, 20).length, 20);
    assert.ok(candidatePairs(small, 20).every(/** Surviving shared tags score as full channel matches. */ row => row.score === 1));
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
    assert.equal(server.requests.filter(row => row.path === "/v1/systemone").length, 1);
    assert.ok(!JSON.stringify(server.requests).includes("PRIVATE_ANNOTATION"));
    assert.deepEqual(await scan(fixture, { type: "Feature" }), []);
    await fixture.pm.update(pair.a.id, { status: "closed", closeReason: "test complete" });
    assert.deepEqual(await scan(fixture), []);
    assert.equal((await scan(fixture, { status: "all" })).length, 1);
  });
});

test("pair apply writes only calibrated links and rejects every close flag", async () => {
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
    assert.match(current.comments![0].text, /verdict=duplicate, canonical=.*probability=0.8, threshold=0.8, .*lexical_threshold=0.2, .*relation=related, close=false/);
    await assert.rejects(scan(fixture, { apply: true, close: true }), /links-only/);
    current = (await fixture.pm.get(pair.a.id, { full: true })).item;
    assert.equal(current.status, "open");
    assert.equal((await fixture.pm.get(pair.b.id, { full: true })).item.status, "open");
  });
});

test("low duplicate confidence abstains without proposing a link", async () => {
  await scenario(async (fixture, server) => {
    await seed(fixture);
    probability(server, 0.2);
    const before = trackerSnapshot(fixture.pmRoot);
    const rows = await scan(fixture, { apply: true });
    assert.equal(rows[0].decision, "abstain");
    assert.equal(rows[0].reason, "unsure_below_calibrated_confidence");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  });
});

test("pair scan and apply work without a git repository and with no git on PATH", async () => {
  await scenario(async (fixture, server) => {
    const pair = await seed(fixture);
    const previousPath = process.env.PATH;
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    const stripped = mkdtempSync(join(tmpdir(), "jev-nogit-path-"));
    process.env.PATH = stripped;
    process.env.GIT_CEILING_DIRECTORIES = dirname(fixture.cwd);
    try {
      const rows = await scan(fixture, { apply: true });
      assert.equal(rows[0].decision, "duplicate");
      assert.equal(rows[0].reason, "linked_with_receipt");
      const linked = (await fixture.pm.get(pair.a.id, { full: true })).item;
      assert.ok(linked.dependencies?.some(dep => dep.id === pair.b.id && dep.kind === "related"));
      assert.match(linked.comments![0].text, /pm-jev dedupe pair receipt:/);
      await assert.rejects(scan(fixture, { apply: true, close: true }), /links-only/);
      assert.equal((await fixture.pm.get(pair.a.id)).item.status, "open");
    } finally {
      if (previousPath !== undefined) process.env.PATH = previousPath; else delete process.env.PATH;
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
      rmSync(stripped, { recursive: true, force: true });
    }
  });
});

test("pair scan rejects invalid flags and refuses unavailable models with a remedy", async () => {
  await scenario(async (fixture, server) => {
    await seed(fixture);
    for (const options of [{ status: "closed" }, { close: true }, { body: "x" }, { limit: "3" }, ...["0", "201", "1.5", "bad", "9007199254740992"].map(limitPairs => ({ limitPairs })), ...["bad", "0.4", "1.1"].map(minConfidence => ({ minConfidence }))]) await assert.rejects(scan(fixture, options));
    await assert.rejects(scan(fixture, {}, ["extra"]));
    server.setReply((_, response) => { response.statusCode = 404; response.end(JSON.stringify({ error: "model unavailable" })); });
    const before = trackerSnapshot(fixture.pmRoot);
    await assert.rejects(scan(fixture, { apply: true }), /ollama pull|doctor/);
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  });
});

test("pair scans clamp low configured confidence while preserving floors and explicit flag validation", async () => {
  await scenario(async (fixture, server) => {
    const pair = await seed(fixture);
    const path = getSettingsPath(fixture.pmRoot);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    for (const min_confidence of [0, 0.3]) {
      settings.jev = { min_confidence };
      writeFileSync(path, JSON.stringify(settings));
      const before = trackerSnapshot(fixture.pmRoot);
      probability(server, 0.79);
      assert.equal((await scan(fixture))[0].decision, "abstain");
      assert.equal((await scan(fixture, { apply: true }))[0].decision, "abstain");
      assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
      for (const minConfidence of ["0.3", "1.1", "bad"]) await assert.rejects(scan(fixture, { minConfidence }), /--min-confidence must be between 0.5 and 1/);
    }
    probability(server, 0.8);
    assert.equal((await scan(fixture, { apply: true }))[0].reason, "linked_with_receipt");
    const linked = (await fixture.pm.get(pair.a.id, { full: true })).item;
    assert.equal(linked.status, "open");
    assert.match(linked.comments![0].text, /verdict=duplicate, canonical=.*probability=0.8, threshold=0.8, .*lexical_threshold=0.2,/);
    settings.jev = { min_confidence: 0.95 };
    writeFileSync(path, JSON.stringify(settings));
    const before = trackerSnapshot(fixture.pmRoot);
    probability(server, 0.9);
    assert.equal((await scan(fixture, { apply: true }))[0].decision, "abstain");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    assert.equal((await scan(fixture, { min_confidence: "0.5" }))[0].decision, "duplicate");
    settings.jev = { min_confidence: 0.3 };
    writeFileSync(path, JSON.stringify(settings));
    const calibratedBefore = trackerSnapshot(fixture.pmRoot);
    process.env.PM_JEV_MODEL = "tev1:4b";
    const measured = PAIR_CALIBRATION["tev1:4b"];
    server.setReply((request, response, body) => {
      if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: measured.digest }] })); return; }
      const result = answers((body as { questions: Questions }).questions);
      result.answers.same_work = { type: "noul", noul: measured.threshold - 0.001 };
      response.end(JSON.stringify(result));
    });
    assert.equal((await scan(fixture, { apply: true }))[0].decision, "abstain");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), calibratedBefore);
  });
});

test("pair apply skips changed evidence and avoids duplicate chains in a batch", async () => {
  await scenario(async (fixture, server) => {
    const pair = await seed(fixture);
    server.setReply(async (_, response, body) => {
      await fixture.pm.update(pair.b.id, { body: "Changed requested work" });
      response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
    });
    const stale = await scan(fixture, { apply: true });
    assert.equal(stale.length, 1);
    assert.equal(stale[0].decision, "duplicate");
    assert.equal(stale[0].reason, "skipped_stale_evidence");
    assert.equal((await fixture.pm.get(pair.a.id, { full: true })).item.comments?.length ?? 0, 0);
    probability(server, 0.9);
    await fixture.pm.create({ type: "Task", title: "Repair expired sessions", body: pair.a.body });
    const rows = await scan(fixture, { apply: true, minConfidence: "0.8" });
    assert.ok(rows.some(row => row.reason === "linked_with_receipt"));
    assert.ok(rows.some(row => row.reason === "calibrated_duplicate"));
  });
});

test("pair apply preserves earlier writes and continues past stale pairs", async () => {
  await scenario(async (fixture, server) => {
    const twinIds: string[] = [];
    for (const [group, title, body] of [["a", "Anchor audit", "prune stale anchor rows nightly"], ["c", "Zulu sweep", "erase leaked zulu tokens weekly"], ["e", "Quux flux", "blueprints quux flux"]]) {
      await fixture.pm.create({ id: `batch-${group}-original`, type: "Task", title, body });
      twinIds.push((await fixture.pm.create({ id: `batch-${group}-twin`, type: "Task", title, body })).item.id);
    }
    let calls = 0;
    server.setReply(async (_, response, body) => {
      if (++calls === 1) await fixture.pm.update(twinIds[1], { body: "concurrent requested work revision" });
      response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
    });
    const rows = await scan(fixture, { apply: true, limitPairs: "3" });
    assert.deepEqual(rows.map(row => row.reason), ["linked_with_receipt", "skipped_stale_evidence", "linked_with_receipt"]);
    assert.ok([rows[1].a, rows[1].b].includes(twinIds[1]));
    for (const row of [rows[0], rows[2]]) {
      const linked = (await fixture.pm.get(row.a, { full: true })).item;
      assert.equal(linked.status, "open");
      assert.ok(linked.dependencies?.some(dep => dep.id === row.b && dep.kind === "related"));
      assert.equal(linked.comments?.length, 1);
      assert.match(linked.comments![0].text, /pm-jev dedupe pair receipt:.*canonical=/);
    }
    for (const id of [rows[1].a, rows[1].b]) {
      const skipped = (await fixture.pm.get(id, { full: true })).item;
      assert.equal(skipped.status, "open");
      assert.equal(skipped.comments?.length ?? 0, 0);
      assert.equal(skipped.dependencies, undefined);
    }
  });
});

for (const failure of ["stale", "invalid status"] as const) {
  test(`pair apply handles real SDK mutation failures: ${failure}`, async () => {
    await scenario(async fixture => {
      const pair = await seed(fixture);
      const pm = guardedClient(fixture);
      const racing = new Proxy(pm, {
        /** Inject a concurrent edit or invalid input, then execute the real SDK mutation. */
        get(target, property, receiver) {
          if (property !== "update") return Reflect.get(target, property, receiver);
          return async (id: string, options: Record<string, unknown>) => {
            if (failure === "stale") await fixture.pm.update(id, { body: "Concurrent requested work revision" });
            return target.update(id, { ...options, ...(failure === "invalid status" ? { status: "invalid-status" } : {}) });
          };
        },
      });
      const run = () => runPairDedupe({ pm_root: fixture.pmRoot, source_workspace_root: fixture.cwd, args: [], options: { apply: true }, global: { author: "fixture" }, command: "jev dedupe", sdk: createExtensionCommandSdk(fixture.pmRoot, racing, "fixture", "jev dedupe") });
      if (failure === "invalid status") await assert.rejects(run(), /status/i);
      else {
        const rows = await run();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].decision, "duplicate");
        assert.equal(rows[0].reason, "skipped_stale_evidence");
      }
      const after = (await fixture.pm.get(pair.a.id, { full: true })).item;
      assert.equal(after.status, "open");
      assert.equal(after.comments?.length ?? 0, 0);
      assert.equal(after.body, failure === "stale" ? "Concurrent requested work revision" : pair.a.body);
      assert.equal(after.dependencies, undefined);
      assert.equal((await fixture.pm.get(pair.b.id, { full: true })).item.dependencies, undefined);
    });
  });
}

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
    process.env.PM_JEV_MODEL = "tev1:4b";
    const measured = PAIR_CALIBRATION["tev1:4b"];
    let p = measured.threshold - 0.0001, tags = 0, drift = false;
    server.setReply((request, response, body) => {
      if (request.url === "/api/tags") { tags++; response.end(JSON.stringify({ models: [{ name: "tev1:4b", digest: drift && tags > 1 ? "c".repeat(64) : measured.digest }] })); return; }
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
    const before = trackerSnapshot(fixture.pmRoot);
    try {
      for (const apply of [false, true]) {
        const rows = await scan(fixture, { apply });
        assert.deepEqual(server.requests, [], "uncalibrated hosted scans send no item evidence");
        assert.equal(rows.length, 1);
        assert.equal(rows[0].reason, "unsure_uncalibrated_model");
        assert.equal(rows[0].decision, "abstain");
        assert.equal(rows[0].probability, 0);
      }
      assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    }
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
      const deadline = Date.now() + 120_000;
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

test("pair command rejects close through an active real SDK guard", async () => {
  await scenario(async fixture => {
    const pair = await seed(fixture);
    const pm = guardedClient(fixture);
    await assert.rejects(runPairDedupe({ pm_root: fixture.pmRoot, source_workspace_root: fixture.cwd, args: [], options: { apply: true, close: true }, global: { author: "fixture" }, command: "jev dedupe", sdk: createExtensionCommandSdk(fixture.pmRoot, pm, "fixture", "jev dedupe") }), /links-only/);
    assert.equal((await fixture.pm.get(pair.a.id)).item.status, "open");
  });
});

for (const delayedRead of [1, 2]) {
  test(`pair preview digest read ${delayedRead} shares the total run deadline`, async () => {
    await scenario(async (fixture, server) => {
      await seed(fixture);
      process.env.PM_JEV_MODEL = "tev1:4b";
      const path = getSettingsPath(fixture.pmRoot);
      const settings = JSON.parse(readFileSync(path, "utf8"));
      settings.jev = { total_deadline_ms: 1000, timeout_ms: 5000 };
      writeFileSync(path, JSON.stringify(settings));
      let tags = 0;
      let delayedClosed: Promise<boolean> | undefined;
      server.setReply((request, response, body) => {
        if (request.url === "/api/tags") {
          const payload = JSON.stringify({ models: [{ name: "tev1:4b", digest: PAIR_CALIBRATION["tev1:4b"].digest }] });
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

test("title-only retrieval survives unrelated long bodies", async () => {
  await scenario(async fixture => {
    const pair = await seed(fixture);
    const a = { ...pair.a, title: "Reject expired sessions", body: "alpha ".repeat(2000), description: "" };
    const b = { ...pair.b, title: a.title, body: "zulu ".repeat(2000), description: "" };
    assert.equal(candidatePairs([a, b], 1)[0].score, 1);
  });
});

test("common-title retrieval survives stopgrams without full-text or structural neighbors", async () => {
  await scenario(async fixture => {
    const template = (await fixture.pm.create({ type: "Task", title: "Fix", body: "Independent title retrieval" })).item;
    const items = Array.from({ length: 70 }, (_, i) => ({
      ...template, id: `title-${i.toString().padStart(2, "0")}`,
      title: i % 2 === 0 ? "Ｆｉｘ!" : "fix", description: "",
      body: String.fromCodePoint(0x4e00 + i).repeat(80), tags: [], files: [], docs: [],
    }));
    const pairs = candidatePairs(items, items.length * 8);
    assert.ok(pairs.length > 0, "title candidates survive when all shared title trigrams are stopgrams");
    assert.ok(pairs.every(row => row.score === 1), "title similarity remains undiluted by disjoint bodies");
    assert.ok(pairs.length <= items.length * 8, "independent title retrieval preserves the top-K bound");
    assert.equal(new Set(pairs.flatMap(row => [row.a.id, row.b.id])).size, items.length);
    assert.deepEqual(pairs, candidatePairs([...items].reverse(), items.length * 8));
    assert.deepEqual(candidatePairs(items, 3), pairs.slice(0, 3));
  });
});

test("uncalibrated models abstain without inference or mutation for every pair", async () => {
  await scenario(async (fixture, server) => {
    await seed(fixture);
    await fixture.pm.create({ type: "Task", title: "Repair", body: "Reject expired sessions before displaying account details" });
    process.env.PM_JEV_MODEL = "unmeasured-model";
    probability(server, 1);
    const before = trackerSnapshot(fixture.pmRoot);
    for (const apply of [false, true]) {
      const rows = await scan(fixture, { apply });
      assert.deepEqual(server.requests, [], "uncalibrated local scans do not call the model");
      assert.equal(rows.length, 3);
      assert.ok(rows.every(row => row.decision === "abstain" && row.reason === "unsure_uncalibrated_model" && row.probability === 0));
    }
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  });
});

test("disabled calibration cutoffs abstain without pair inference or writes", async () => {
  await scenario(async (fixture, server) => {
    await seed(fixture);
    const before = trackerSnapshot(fixture.pmRoot);
    for (const policy of [{ model: null, lexical: 0.2 }, { model: 0.8, lexical: null }]) {
      Object.defineProperty(DUPLICATE_QUALITY_CALIBRATION, "scripted-test-model", { configurable: true, value: { policy, digest: "a".repeat(64) } });
      for (const apply of [false, true]) {
        const rows = await scan(fixture, { apply });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].reason, "unsure_uncalibrated_model");
        assert.equal(rows[0].probability, 0);
        assert.equal(rows[0].decision, "abstain");
      }
    }
    assert.ok(server.requests.every(request => request.path === "/api/tags"), "disabled policies retain digest checks without scoring item evidence");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  });
});

test("default pair scans honor the fitted raw cutoff while explicit confidence can only tighten it", async () => {
  await scenario(async (fixture, server) => {
    await seed(fixture);
    Object.defineProperty(DUPLICATE_QUALITY_CALIBRATION, "scripted-test-model", { configurable: true, value: { policy: { model: 0.7, lexical: 0.2 }, digest: "a".repeat(64) } });
    probability(server, 0.71);
    assert.equal((await scan(fixture))[0].decision, "duplicate");
    assert.equal((await scan(fixture, { minConfidence: "0.8" }))[0].decision, "abstain");
    const path = getSettingsPath(fixture.pmRoot);
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.jev = { min_confidence: 0.9 };
    writeFileSync(path, JSON.stringify(settings));
    assert.equal((await scan(fixture))[0].decision, "abstain");
    assert.equal((await scan(fixture, { minConfidence: "0.5" }))[0].decision, "duplicate");
    probability(server, 0.69);
    assert.equal((await scan(fixture, { minConfidence: "0.5" }))[0].decision, "abstain");
  });
});
