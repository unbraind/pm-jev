import assert from "node:assert/strict";
import test from "node:test";
import { buildUnits, readLocalCorpus } from "../tracker-evaluation.ts";
import { bm25Rank, cosineSimilarity, EMBEDDING_MODEL, eligibleExemplars, embedTexts, embeddingAvailable, embeddingRank, estimateTokens, exemplarBudget, exemplarContext, knnVote, majorityLabel, tokenize } from "../exemplar-retrieval.ts";
import type { ExemplarUnit } from "../exemplar-retrieval.ts";
import { endpoint, project, withoutGit } from "./fixtures.ts";

/** Build one exemplar unit with defaults filled for deterministic assertions. */
function unit(overrides: Partial<ExemplarUnit> & { ids: string[] }): ExemplarUnit {
  return { created_at: "2026-01-01T00:00:00.000Z", title: "", body: "", labels: {}, example_sha256: `sha-${overrides.ids.join("-")}`, ...overrides };
}

test("tokenization lowercases alphanumerics and the token estimate stays conservative", () => {
  assert.deepEqual(tokenize("Login-Crash 42!"), ["login", "crash", "42"]);
  assert.deepEqual(tokenize("…"), []);
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("abcde"), 2);
});

test("Unicode words survive real non-git tracker retrieval with BM25 term frequency", async () => {
  const fixture = await project();
  try {
    await withoutGit(fixture.cwd, async () => {
      await fixture.pm.create({ id: "a-unrelated", type: "Task", title: "Unrelated ASCII export" });
      await fixture.pm.create({ id: "z-match", type: "Task", title: "Überprüfung 東京", body: "東京" });
      const corpus = await readLocalCorpus(fixture.pmRoot);
      const pool = buildUnits(corpus, "triage").units;
      assert.equal(bm25Rank("東京", pool)[0].ids[0], "synthetic-z-match");
      assert.deepEqual(tokenize("Überprüfung 東京 ÜBERPRÜFUNG"), ["überprüfung", "東京", "überprüfung"]);
      assert.deepEqual(tokenize("crash-crash crash"), ["crash", "crash", "crash"]);
    });
  } finally {
    fixture.dispose();
  }
});

test("UTF-8 exemplar packing charges bodies, labels, markers and array separators", () => {
  assert.equal(estimateTokens("漢".repeat(100)), 75);
  const pool = [unit({ ids: ["unicode"], title: "東京", body: "漢".repeat(100), labels: { type: "課題" } })];
  const packed = exemplarContext(pool, 35);
  assert.equal(packed.length, 1);
  assert.ok(packed[0].body.endsWith("…[truncated]"));
  assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(packed), "utf8") / 4) <= 35);
  assert.deepEqual(exemplarContext(pool, 5), []);
  assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(exemplarContext([...pool, ...pool], 120)), "utf8") / 4) <= 120);
});

test("exemplar budgets clamp to the prompt headroom the endpoint leaves open", () => {
  assert.equal(exemplarBudget("x".repeat(400), 100), 100);
  assert.equal(exemplarBudget("x".repeat(4000), 2000), 1640 - 1000 - 8);
  assert.equal(exemplarBudget("short", 1200, 1500), 132);
  assert.equal(exemplarBudget("x".repeat(40_000), 1200), 0);
});

test("bm25 ranking is similarity-ordered with stable id tie-breaks and empty pools", () => {
  const pool = [
    unit({ ids: ["a"], title: "Login crashes when session expires", body: "expired sessions crash login" }),
    unit({ ids: ["b"], title: "Export board as CSV", body: "let users download the board" }),
    unit({ ids: ["c"], title: "Login crash on startup", body: "" }),
  ];
  const ranked = bm25Rank("Login crashes on startup", pool);
  assert.equal(ranked[0].ids[0], "c");
  assert.equal(ranked[ranked.length - 1].ids[0], "b");
  assert.deepEqual(bm25Rank("anything", []), []);
  const tied = [unit({ ids: ["y"], title: "same words", body: "" }), unit({ ids: ["x"], title: "same words", body: "" })];
  assert.deepEqual(bm25Rank("same words", tied).map(/** Keep the reported id order. */ row => row.ids[0]), ["x", "y"]);
});

test("exemplar eligibility refuses the target, future items and the evaluation sample", () => {
  const target = { ids: ["t"], created_at: "2026-01-05T00:00:00.000Z" };
  const pool = [
    unit({ ids: ["a"], created_at: "2026-01-01T00:00:00.000Z" }),
    unit({ ids: ["t"], created_at: "2026-01-01T00:00:00.000Z" }),
    unit({ ids: ["f"], created_at: "2026-01-06T00:00:00.000Z" }),
    unit({ ids: ["s"], created_at: "2026-01-01T00:00:00.000Z" }),
    unit({ ids: ["t", "a2"], created_at: "2026-01-04T00:00:00.000Z" }),
    unit({ ids: ["e"], created_at: "2026-01-05T00:00:00.000Z" }),
  ];
  const eligible = eligibleExemplars(target, pool, new Set(["s", "a2"]));
  assert.deepEqual(eligible.map(/** Keep the reported id order. */ row => row.ids.join("+")), ["a", "e"]);
});

test("exemplar context truncates bodies within the token budget and stops at unfittable titles", () => {
  const ranked = [
    unit({ ids: ["a"], title: "Login crashes", body: "x".repeat(400), labels: { type: "Issue", priority: "1" } }),
    unit({ ids: ["b"], title: "Export CSV", body: "small", labels: { type: "Feature", priority: "3" } }),
  ];
  const entries = exemplarContext(ranked, 40);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Login crashes");
  assert.ok(entries[0].body.endsWith("…[truncated]"));
  assert.ok(estimateTokens(JSON.stringify(entries)) <= 40);
  assert.deepEqual(exemplarContext([], 100), []);
  assert.deepEqual(exemplarContext([unit({ ids: ["z"], title: "This title alone is far too long for the budget", body: "x" })], 1), []);
  const markerless = unit({ ids: ["m"], title: "T", body: "y".repeat(20), labels: {} });
  const skeleton = JSON.stringify({ title: markerless.title, body: "", ...markerless.labels }).length;
  const cramped = exemplarContext([markerless], Math.ceil((skeleton + 2) / 4));
  assert.equal(cramped.length, 1);
  assert.equal(cramped[0].body, "");
  const escaped = unit({ ids: ["e"], title: "T", body: "\\".repeat(200), labels: {} });
  const inflated = exemplarContext([escaped], 25);
  assert.equal(inflated.length, 1);
  assert.ok(inflated[0].body.endsWith("…[truncated]"));
  assert.ok(estimateTokens(JSON.stringify(inflated[0])) <= 25);
  const empty = exemplarContext([unit({ ids: ["n"], title: "T", body: "", labels: {} })], 10);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].body, "");
  const tiny = unit({ ids: ["q"], title: "", body: "", labels: {} });
  const two = exemplarContext([tiny, tiny], 11);
  assert.equal(two.length, 1);
  assert.ok(estimateTokens(JSON.stringify(two)) <= 11);
});

test("majority and kNN baselines are deterministic and abstain without evidence", () => {
  const pool = [
    unit({ ids: ["a"], labels: { type: "Issue" } }),
    unit({ ids: ["b"], labels: { type: "Feature" } }),
    unit({ ids: ["c"], labels: { type: "Feature" } }),
  ];
  assert.equal(majorityLabel(pool, "type"), "Feature");
  assert.equal(majorityLabel([unit({ ids: ["a"], labels: { type: "Feature" } }), unit({ ids: ["b"], labels: { type: "Issue" } })], "type"), "Feature");
  assert.equal(majorityLabel(pool, "priority"), null);
  const retrieved = [
    unit({ ids: ["a"], labels: { type: "Issue", priority: "1" } }),
    unit({ ids: ["b"], labels: { type: "Issue", priority: "2" } }),
    unit({ ids: ["c"], labels: { type: "Feature", priority: "1" } }),
  ];
  assert.deepEqual(knnVote(retrieved, "type"), { Issue: 2 / 3, Feature: 1 / 3 });
  assert.deepEqual(knnVote(retrieved, "priority"), { "1": 2 / 3, "2": 1 / 3 });
  assert.equal(knnVote([], "type"), null);
  assert.deepEqual(knnVote([unit({ ids: ["a"], labels: { x: "1" } }), unit({ ids: ["b"], labels: {} })], "x"), { "1": 0.5 });
});

/** Deterministic response writer for one embedding endpoint scenario. */
function replyJson(response: { end: (chunk: string) => void }, payload: unknown): void {
  response.end(JSON.stringify(payload));
}

test("embedding availability, batching, cosine ranking and failure fallbacks are deterministic", async () => {
  const server = await endpoint();
  /** Install one scripted tags/embed scenario on the shared loopback server. */
  const install = (scenario: { tags: (response: { statusCode?: number; end: (chunk: string) => void }) => void; embed: (response: { statusCode?: number; end: (chunk: string) => void }, input: string[]) => void }) =>
    server.setReply((request, response, body) => {
      if (request.url === "/api/tags") { scenario.tags(response); return; }
      if (request.url === "/api/embed") { scenario.embed(response, (body as { input: string[] }).input); return; }
      response.end("{}");
    });
  const listed = (response: { end: (chunk: string) => void }) => replyJson(response, { models: [{ name: EMBEDDING_MODEL }] });
  const failing = (status: number) => (response: { statusCode?: number; end: (chunk: string) => void }) => { response.statusCode = status; response.end("{}"); };
  try {
    install({ tags: listed, embed: (response, input) => replyJson(response, { embeddings: input.map(/** Crash texts and export texts point to opposite directions. */ text => (text.includes("crash") ? [2, 0] : [0, 2])) }) });
    assert.equal(await embeddingAvailable(server.url, 5000), true);
    const vectors = await embedTexts(server.url, ["login crash", "export csv"], 5000);
    assert.deepEqual(vectors, [[2, 0], [0, 2]]);
    const pool = [
      { ...unit({ ids: ["a"], title: "login crash", body: "" }), vector: [2, 0] as const },
      { ...unit({ ids: ["b"], title: "export csv", body: "" }), vector: [0, 2] as const },
    ];
    assert.deepEqual(embeddingRank([2, 0], pool).map(/** Keep the reported id order. */ row => row.ids[0]), ["a", "b"]);
    assert.deepEqual(embeddingRank([0, 2], pool).map(/** Keep the reported id order. */ row => row.ids[0]), ["b", "a"]);
    assert.deepEqual(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
    assert.equal(cosineSimilarity([1], [1, 2]), 0);
    // An empty model list and a malformed per-text vector both refuse the whole batch.
    install({ tags: response => replyJson(response, { models: [] }), embed: (response, input) => replyJson(response, { embeddings: input.map((_, index) => (index === 0 ? [0.5] : [])) }) });
    assert.equal(await embeddingAvailable(server.url, 5000), false);
    assert.equal(await embedTexts(server.url, ["a", "b"], 5000), null);
    install({ tags: listed, embed: (response, input) => replyJson(response, { embeddings: input.map((_, index) => (index === 0 ? [0.5] : "not a vector")) }) });
    assert.equal(await embedTexts(server.url, ["first", "second"], 5000), null);
    install({ tags: listed, embed: (response, input) => replyJson(response, { embeddings: input.map(() => [Number.NaN, 1]) }) });
    assert.equal(await embedTexts(server.url, ["left", "right"], 5000), null);
    install({ tags: listed, embed: response => replyJson(response, { embeddings: [[0.5]] }) });
    assert.equal(await embedTexts(server.url, ["a", "b"], 5000), null);
    install({ tags: listed, embed: response => replyJson(response, { embeddings: "not an array" }) });
    assert.equal(await embedTexts(server.url, ["a"], 5000), null);
    install({ tags: response => response.end("not json"), embed: response => response.end("not json") });
    assert.equal(await embeddingAvailable(server.url, 5000), false);
    assert.equal(await embedTexts(server.url, ["a"], 5000), null);
    install({ tags: failing(500), embed: failing(503) });
    assert.equal(await embeddingAvailable(server.url, 5000), false);
    assert.equal(await embedTexts(server.url, ["a"], 5000), null);
  } finally {
    await server.close();
    assert.equal(await embeddingAvailable(server.url, 1000), false);
    assert.equal(await embedTexts(server.url, ["x"], 1000), null);
  }
});
