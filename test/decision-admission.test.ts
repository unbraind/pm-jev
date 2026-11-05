import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decode, encode } from "@toon-format/toon";
import { admitDecision, admitDecisionBatch, parseAdmissionInput, AdmissionRefusal, ADMISSION_VERSION, validateAdmissionReceipt, createJevClient, resolveJevEndpoint, runDecision, projectItemState, parseQuestionsDocument, buildDedupeRequest } from "../index.ts";
import type { AdmissionReceipt, Questions, ItemMetadata } from "../index.ts";
import { scenario, withoutGit, trackerSnapshot, answers } from "./fixtures.ts";
import { admissionMetadata } from "./admission-fixtures.ts";
import { installBuiltExtension, runBuiltCommand } from "./replay-fixtures.ts";

/** Use the exact published example as both a producer and input-contract fixture. */
function batch(): { version: string; state: unknown; questions: Questions } {
  return JSON.parse(readFileSync(new URL("../examples/decision-admission.json", import.meta.url), "utf8"));
}
/** Keep test assertions independent of reflected provider messages. */
function refusal(code: string) {
  return (error: unknown) => { assert.ok(error instanceof AdmissionRefusal); assert.equal(error.code, code); assert.ok(error.remedy.length > 30); assert.equal(error.message.includes("PRIVATE"), false); return true; };
}
/** Publish a tiny explicitly bounded model through the real HTTP metadata boundary. */
function serveContext(server: Parameters<Parameters<typeof scenario>[0]>[1], context: number, digest = context.toString(16).padStart(64, "0")): void {
  server.setAdmissionReply((request, response) => response.end(JSON.stringify(request.url === "/api/tags" ? { models: [{ name: "tev1:4b", digest }] } : admissionMetadata(context))));
}

test("exact multibyte overflow refuses before inference and reports the smallest count reduction", async () => {
  await scenario(async (fixture, server) => {
    serveContext(server, 8192, "b".repeat(64));
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const raw = batch(); raw.state = "漢😀".repeat(1400);
    assert.ok(Buffer.byteLength(JSON.stringify(raw)) < 65536);
    const before = trackerSnapshot(fixture.pmRoot);
    const admitted = await withoutGit(fixture.cwd, () => admitDecisionBatch(config, raw));
    assert.equal(admitted.receipt.ok, false); assert.equal(admitted.receipt.questions, 3); assert.equal(admitted.receipt.options, 7);
    assert.equal(admitted.receipt.minimum_prompt_tokens_to_remove, admitted.receipt.max_prompt_tokens + 1 - 8192);
    assert.ok(admitted.receipt.minimum_prompt_tokens_to_remove > 0);
    await assert.rejects(runDecision(createJevClient({ config, hostedBlocked: null }, {}), config, raw.state, raw.questions), (error: unknown) => {
      const e = error as { context: { code: string; details: { admission: AdmissionReceipt } } };
      assert.equal(e.context.code, "jev_context_exceeded"); assert.deepEqual(e.context.details.admission, admitted.receipt); return true;
    });
    assert.equal(server.requests.length, 0); assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    assert.ok(Buffer.byteLength(JSON.stringify(admitted.receipt)) < 700);
    // The exact usable threshold is inclusive; a one-token reduction in declared context flips it.
    server.setAdmissionReply((_, response) => response.end(JSON.stringify(admissionMetadata(admitted.receipt.max_prompt_tokens + 1))));
    const pinned = { ...config, model: `sha256:${"c".repeat(64)}` };
    assert.equal((await admitDecisionBatch(pinned, raw)).receipt.ok, true);
    server.setAdmissionReply((_, response) => response.end(JSON.stringify(admissionMetadata(admitted.receipt.max_prompt_tokens))));
    assert.equal((await admitDecisionBatch({ ...pinned, model: `sha256:${"d".repeat(64)}` }, raw)).receipt.minimum_prompt_tokens_to_remove, 1);
  });
});

test("short typed batches preserve questions, options, CRLF and structured descriptions through pinned inference", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const raw = batch(); raw.questions.route.instructions = { text: "Question\r\n漢 😀", nested: [" x ", 1, null] };
    if (raw.questions.route.type === "choice") raw.questions.route.criteria.wait = { reason: "Keep spaces\r\n", list: [1, 2] };
    raw.questions.empty = { type: "choice", instructions: " ", criteria: { constructor: "", "__proto__": null, final: "yes" } };
    raw.questions.no = { type: "noul", criteria: { false: { reason: "No" }, true: " " } };
    const expected = parseAdmissionInput(raw);
    const promise = admitDecisionBatch(config, raw);
    raw.state = "caller changed input"; raw.questions.route.instructions = "changed";
    const admitted = await promise;
    assert.deepEqual(admitted.state, expected.state); assert.deepEqual(admitted.questions, expected.questions);
    const result = await runDecision(createJevClient({ config, hostedBlocked: null }, {}), config, expected.state, expected.questions);
    assert.equal(result.admission?.ok, true);
    const request = server.requests.at(-1)?.body as { state: unknown; questions: Questions; model: string };
    assert.deepEqual(parseAdmissionInput({ ...expected, questions: request.questions }).questions, expected.questions); assert.deepEqual(request.state, expected.state);
    assert.equal(request.model, `sha256:${"a".repeat(64)}`);
    assert.equal((server.admissionRequests[1].body as { model: string }).model, request.model);
    assert.equal((await admitDecisionBatch({ ...config, model: request.model }, expected)).receipt.ok, true);
  });
});

test("one strict schema refuses sparse, extreme and unknown inputs before any metadata call", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const sparse = new Array(2); sparse[1] = "second";
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    const deep: unknown[] = []; let cursor = deep; for (let i = 0; i < 14; i++) { const child: unknown[] = []; cursor.push(child); cursor = child; }
    const invalid = [undefined, null, [], {}, { ...batch(), version: "other" }, { ...batch(), extra: 1 },
      ...[null, undefined, NaN, Infinity, -Infinity, 0.1, Number.MAX_VALUE, 1n, () => 1, Symbol(), sparse, cycle, deep, new Date(), "\ud800", "x".repeat(65537), "漢".repeat(30000)].map(state => ({ ...batch(), state })),
      ...[{}, [], null, { q: null }, { q: { type: "box" } }, { q: { type: "choice", criteria: {} } }, { q: { type: "choice", criteria: [] } }, { q: { type: "score", criteria: ["one"] } }, { q: { type: "score", criteria: sparse } }, { q: { type: "noul", extra: 1 } }, { q: { type: "noul", criteria: { maybe: "x" } } }, { q: { type: "noul", instructions: 1 } }, { "": { type: "noul" } }, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [String(i), { type: "noul" }]))].map(questions => ({ ...batch(), questions })),
    ];
    for (const raw of invalid) await assert.rejects(admitDecisionBatch(config, raw), refusal("invalid_input"));
    assert.equal(server.admissionRequests.length, 0);
    for (const state of [" ", false, 0, -10, Number.MAX_SAFE_INTEGER, { list: [true, null, 1, "é\r\n"] }]) {
      const parsed = parseAdmissionInput({ ...batch(), state }); assert.deepEqual(parsed.state, state);
    }
    const exotic = Object.create(null) as Record<string, unknown>; exotic.safe = "value";
    assert.deepEqual(parseAdmissionInput({ ...batch(), state: exotic }).state, structuredClone(exotic));
  });
});

test("native template whitespace preserves Unicode blanks and uses the native ASCII fallback", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const state = "Synthetic Unicode whitespace parity";
    const make = (instructions: string, formfeed: string, nbsp: string) => ({ long_question_identity_for_whitespace: { type: "choice", instructions, criteria: { formfeed, nbsp } } });
    // With a byte-only BPE, equal UTF-8/JSON-escaped field lengths are an independent count oracle.
    const unicode = await admitDecision(config, state, make("\u00a0".repeat(40), "\f".repeat(4), "\u00a0".repeat(40)));
    const ascii = await admitDecision(config, state, make("x".repeat(80), "formfeed", "x".repeat(80)));
    assert.equal(unicode.receipt.max_prompt_tokens, ascii.receipt.max_prompt_tokens);
    const vertical = await admitDecision(config, state, make("\v", "\ufeff", "\f"));
    const encoded = await admitDecision(config, state, make("long_question_identity_for_whitespace", "xxx", "nbsp"));
    assert.equal(vertical.receipt.max_prompt_tokens, encoded.receipt.max_prompt_tokens);
  });
});

test("the existing dedupe producer admits fractional ranking metadata without changing candidates or options", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const candidate = { id: "synthetic-candidate", title: "Existing task", type: "Task", status: "open", score: 2 / 3 };
    const before = structuredClone(candidate);
    const request = buildDedupeRequest("Proposed task", "Context", [candidate]);
    const result = await runDecision(createJevClient({ config, hostedBlocked: null }, {}), config, request.state, request.questions);
    assert.equal(result.admission?.ok, true); assert.equal(result.admission.questions, 1); assert.equal(result.admission.options, 2);
    assert.deepEqual(candidate, before);
    const question = request.questions.duplicate_of; assert.ok(question.type === "choice");
    assert.equal(Object.keys(question.criteria).length, 2);
  });
});

test("native metadata refusals are bounded, content-free and never fall through to inference", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url }); const raw = batch();
    await assert.rejects(admitDecisionBatch({ ...config, provider: "typesafe" }, raw), refusal("unsupported_model"));
    for (const tags of [{}, { models: [] }, { models: [null, 1, { name: "tev1:4b", digest: "bad" }] }]) {
      server.setAdmissionReply((_, response) => response.end(JSON.stringify(tags)));
      await assert.rejects(admitDecisionBatch(config, raw), refusal("unsupported_model"));
    }
    const pinned = { ...config, model: `sha256:${"a".repeat(64)}` };
    const good = admissionMetadata();
    const info = good.model_info as Record<string, unknown>;
    const changes: Record<string, unknown>[] = [{ capabilities: [] }, { model_info: null }, { parameters: undefined }, { parameters: "num_ctx 100\nnum_ctx 200" }, { parameters: "num_ctx 1" }, { parameters: "num_ctx 99999999999" },
      ...Object.entries({ "qwen35.decision.type": "clef", "tokenizer.chat_template.systemone": "PRIVATE", "tokenizer.ggml.pre": "qwen2", "tokenizer.ggml.model": "other", "tokenizer.ggml.add_bos_token": true, "tokenizer.ggml.add_eos_token": true, "tokenizer.ggml.tokens": ["small"], "tokenizer.ggml.token_type": [], "tokenizer.ggml.merges": ["bad merge entry"], "qwen35.context_length": 1 }).map(([k, v]) => ({ model_info: { ...info, [k]: v } })),
      { model_info: { ...info, "tokenizer.ggml.tokens": new Array(258).fill("duplicate") } },
      { model_info: { ...info, "tokenizer.ggml.tokens": (info["tokenizer.ggml.tokens"] as string[]).map((t, i) => i === 0 ? "not-a-byte" : t) } },
      { model_info: { ...info, "tokenizer.ggml.tokens": (info["tokenizer.ggml.tokens"] as string[]).map((t, i) => i === 256 ? "no-control" : t) } },
      { model_info: { ...info, "tokenizer.ggml.merges": ["missing piece"] } },
      { model_info: { ...info, "tokenizer.ggml.merges": ["a missing"] } },
      { model_info: { ...info, "tokenizer.ggml.merges": ["a b"] } },
    ];
    for (const change of changes) {
      server.setAdmissionReply((_, response) => response.end(JSON.stringify({ ...good, ...change })));
      await assert.rejects(admitDecisionBatch(pinned, raw), refusal("unsupported_model"));
    }
    server.setAdmissionReply((_, response) => response.end(JSON.stringify({ ...good, model_info: { ...info, "tokenizer.ggml.tokens": [...info["tokenizer.ggml.tokens"] as string[], "ab"], "tokenizer.ggml.token_type": [...info["tokenizer.ggml.token_type"] as number[], 1], "tokenizer.ggml.merges": ["a b"] } })));
    assert.equal((await admitDecisionBatch(pinned, raw)).receipt.ok, true);
    pinned.model = `sha256:${"b".repeat(64)}`;
    for (const data of ["not JSON", "null", "[]", '"PRIVATE"']) {
      server.setAdmissionReply((_, response) => response.end(data));
      await assert.rejects(admitDecisionBatch(pinned, raw), refusal("metadata_unavailable"));
    }
    server.setAdmissionReply((_, response) => { response.statusCode = 404; response.end("PRIVATE"); });
    await assert.rejects(admitDecisionBatch(pinned, raw), refusal("metadata_unavailable"));
    server.setAdmissionReply((_, response) => { response.statusCode = 204; response.end(); });
    await assert.rejects(admitDecisionBatch(pinned, raw), refusal("metadata_unavailable"));
    server.setAdmissionReply((_, response) => response.end(" ".repeat(32 * 1024 * 1024 + 1)));
    await assert.rejects(admitDecisionBatch(pinned, raw), refusal("metadata_unavailable"));
    assert.equal(server.requests.length, 0);
  });
});

test("retargeting the alias at every network boundary and retry never changes the pinned inference model", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const raw = batch();
    for (const [i, boundary] of ["tags", "show", "retry"].entries()) {
      const digest = String(i + 1).repeat(64);
      let alias = digest; let attempts = 0;
      server.setAdmissionReply((request, response, body) => {
        if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [null, { name: "tev1:4b", digest: alias }] })); if (boundary === "tags") alias = "b".repeat(64); }
        else { assert.equal((body as { model: string }).model, `sha256:${digest}`); if (boundary === "show") alias = "b".repeat(64); response.end(JSON.stringify(admissionMetadata())); }
      });
      const saved = server.requests.length;
      server.setReply((_, response, body) => {
        assert.equal((body as { model: string }).model, `sha256:${digest}`);
        if (boundary === "retry" && attempts++ === 0) { alias = "b".repeat(64); response.statusCode = 429; response.setHeader("retry-after-ms", "1"); response.end(); }
        else response.end(JSON.stringify({ ...answers(raw.questions), model: (body as { model: string }).model }));
      });
      const result = await runDecision(createJevClient({ config, hostedBlocked: null }, {}), config, raw.state, raw.questions);
      assert.equal(result.admission?.model_digest, digest); assert.equal(alias, "b".repeat(64));
      assert.equal(server.requests.length - saved, boundary === "retry" ? 2 : 1);
    }
  });
});

test("registered admission shares the same SDK path and propagates host privacy errors", async () => {
  await scenario(async (fixture, server) => {
    const file = join(fixture.cwd, "batch.json"); writeFileSync(file, JSON.stringify(batch()));
    const run = (options: Record<string, unknown>) => fixture.harness.runCommand({ command: "jev admit", pmRoot: fixture.pmRoot, options });
    assert.equal((await run({ batch: file })).exitCode ?? 0, 0);
    assert.equal((await run({ batch: join(fixture.cwd, "missing") })).exitCode, 2);
    serveContext(server, 2);
    assert.equal((await run({ batch: file })).exitCode, 1);
    const before = process.env.PM_JEV_BASE_URL; process.env.PM_JEV_BASE_URL = "https://external.example";
    try { await assert.rejects(run({ batch: file }), /opt-in/); }
    finally { process.env.PM_JEV_BASE_URL = before; }
  });
});

test("every emitted numeric field rejects extremes and contradictory affirmative receipts", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const raw = batch(); const { receipt } = await admitDecision(config, raw.state, raw.questions);
    for (const [key, value] of Object.entries(receipt)) if (typeof value === "number") {
      for (const bad of [NaN, Infinity, -Infinity, -1, -0, Number.MAX_VALUE, 0.5]) assert.throws(() => validateAdmissionReceipt({ ...receipt, [key]: bad }), refusal("invalid_report"));
    }
    assert.throws(() => validateAdmissionReceipt({ ...receipt, ok: false }), refusal("invalid_report"));
    assert.throws(() => validateAdmissionReceipt({ ...receipt, minimum_prompt_tokens_to_remove: 1 }), refusal("invalid_report"));
    validateAdmissionReceipt(receipt);
    assert.deepEqual(decode(encode(receipt)), receipt);
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), receipt);
  });
});

test("500 seeded SDK read-back sequences preserve replayed native states and every typed option", async () => {
  await scenario(async (fixture, server) => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const created = await fixture.pm.create({ type: "Task", title: "Initial", unset: ["parent", "blocked_by", "goal", "objective"] });
    const snapshots: ItemMetadata[] = [created.item];
    let seed = 0x5eed2026;
    const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    await withoutGit(fixture.cwd, async () => {
      let reference: ItemMetadata = created.item;
      for (let sequence = 0; sequence < 500; sequence++) {
        const replay = snapshots[next() % snapshots.length];
        const text = ["漢 😀", " é ", "\r\n line \r\n", "constructor", "__proto__"][next() % 5];
        // The reference consumes canonical SDK write results, never a handwritten normalizer.
        for (const candidate of [replay, { ...reference, title: `Sequence ${sequence} ${text}`, description: text, body: `${text}\r\n${sequence}`, tags: [`tag${next() % 7}`], type: next() % 2 ? "Task" : "Feature" }]) {
          const updated = await fixture.pm.update(reference.id, { title: candidate.title, description: candidate.description ?? "", body: typeof candidate.body === "string" ? candidate.body : "", tags: candidate.tags.join(","), type: candidate.type, status: candidate.status, unset: ["parent", "blocked_by", "goal", "objective"] });
          reference = updated.item as unknown as ItemMetadata;
          const canonical = (await fixture.pm.get(reference.id)).item;
          for (const [key, value] of Object.entries(reference)) assert.deepEqual(canonical[key], value);
          reference = canonical as unknown as ItemMetadata;
        }
        snapshots.push(reference);
        const read = (await fixture.pm.get(reference.id)).item;
        const questions = parseQuestionsDocument({ [text]: { type: "choice", criteria: Object.fromEntries([" none ", "constructor", `option${sequence}`].map(label => [label, text])) }, score: { type: "score", criteria: [text, "major"] }, noul: { type: "noul", instructions: text } });
        const input = { version: ADMISSION_VERSION, state: projectItemState(read as unknown as ItemMetadata), questions };
        const current = await admitDecisionBatch(config, JSON.parse(JSON.stringify(input)));
        assert.deepEqual(current.state, projectItemState(reference)); assert.deepEqual(current.questions, parseAdmissionInput(input).questions);
        assert.equal(current.receipt.ok, true); assert.equal(current.receipt.questions, 3); assert.equal(current.receipt.options, 7);
        assert.deepEqual(parseAdmissionInput({ ...input, state: current.state, questions: current.questions }), parseAdmissionInput(input));
      }
    });
    assert.equal(server.requests.length, 0);
  });
});

test("real no-git CLI emits equivalent TOON/JSON admission and actionable nonzero refusals", async () => {
  await scenario(async (fixture, server) => {
    installBuiltExtension(fixture.pmRoot);
    const file = join(fixture.cwd, "batch.json"); writeFileSync(file, JSON.stringify(batch()));
    const overrides = { PM_JEV_BASE_URL: server.url, PM_JEV_MODEL: "tev1:4b" };
    const before = trackerSnapshot(fixture.pmRoot);
    const json = await runBuiltCommand(fixture, ["--json", "jev", "admit", "--batch", file], overrides);
    const toon = await runBuiltCommand(fixture, ["jev", "admit", "--batch", file], overrides);
    assert.deepEqual(JSON.parse(json.stdout), decode(toon.stdout));
    assert.equal(JSON.parse(json.stdout).ok, true);
    for (const words of [["--batch", join(fixture.cwd, "missing")], []]) {
      await assert.rejects(runBuiltCommand(fixture, ["--json", "jev", "admit", ...words], overrides), (error: unknown) => { const e = error as { code: number; stdout: string }; assert.equal(e.code, 2); assert.equal(JSON.parse(e.stdout).refusal.code, "invalid_input"); return true; });
    }
    serveContext(server, 2);
    await assert.rejects(runBuiltCommand(fixture, ["--json", "jev", "admit", "--batch", file], overrides), (error: unknown) => { const e = error as { code: number; stdout: string }; assert.equal(e.code, 1); assert.equal(JSON.parse(e.stdout).ok, false); assert.match(JSON.parse(e.stdout).remedy, /Remove at least/); return true; });
    assert.equal(server.requests.length, 0); assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  });
});
