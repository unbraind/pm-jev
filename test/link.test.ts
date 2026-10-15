import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEPENDENCY_KIND_VALUES, getSettingsPath, isHostOutputSuppressed, locateItem } from "@unbrained/pm-cli/sdk";
import { resolveWorkspaceRelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import type { BeforeMutationHookContext } from "@unbrained/pm-cli/sdk/authoring";
import type { Questions } from "@typesafe-ai/sdk";
import type { LinkDecision } from "../index.ts";
import { answers, scenario, trackerSnapshot } from "./fixtures.ts";

type Fixture = Parameters<Parameters<typeof scenario>[0]>[0];
type Server = Parameters<Parameters<typeof scenario>[0]>[1];

/** Produce exact-schema distributions through the existing decision endpoint double. */
function reply(server: Server, weights: Record<string, number>) {
  server.setReply((_, response, body) => {
    const questions = (body as { questions: Questions }).questions;
    const result = answers(questions);
    for (const [name, question] of Object.entries(questions)) {
      assert.equal(question.type, "choice");
      if (question.type !== "choice") throw new Error("Expected choice");
      const distribution = Object.fromEntries(Object.keys(question.criteria).map(label => [label, weights[label] ?? 0]));
      result.answers[name] = { probabilities: distribution, confidence: 1, choice: Object.keys(weights)[0], type: "choice" };
    }
    response.end(JSON.stringify(result));
  });
}

/** Dispatch through the actual host extension harness bound to its real tracker client. */
async function link(fixture: Fixture, id: string, options: Record<string, unknown> = {}): Promise<LinkDecision> {
  return (await fixture.harness.runCommand({ command: "jev link", args: [id], pmRoot: fixture.pmRoot, global: { json: true }, options })).result as LinkDecision;
}

/** Create two realistic lexical candidates with private annotations excluded from inference. */
async function pair(fixture: Fixture) {
  const source = (await fixture.pm.create({ type: "Feature", title: "Login session validation", description: "Reject expired login sessions", body: "Validate session expiry before loading the account", tags: "auth" })).item;
  const target = (await fixture.pm.create({ type: "Task", title: "Login session database migration", description: "Create the session expiry column before validation can ship" })).item;
  return { source, target };
}

/** Run backlog mode and retain the host's suppression and exit-code envelope. */
async function backlog(fixture: Fixture, options: Record<string, unknown> = {}, global: Record<string, unknown> = { quiet: true }) {
  const response = await fixture.harness.runCommand({ command: "jev link", pmRoot: fixture.pmRoot, options: { open: true, ...options }, global });
  assert.ok(isHostOutputSuppressed(response.result));
  const result = response.result.result as { selected: number; changed: number; would_change: number; skipped: number; failed: number; exit_code: number; has_more: boolean };
  if (result.failed > 0) assert.equal(response.exitCode, 1);
  return result;
}

/** Capture streamed rows without replacing the host output implementation. */
async function capture(run: () => Promise<unknown>) {
  const previous = process.stdout.write;
  const lines: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try { await run(); return lines; } finally { process.stdout.write = previous; }
}

test("link dry-run changes no authoritative tracker bytes, ranks deterministically and batches private projections", async () => {
  await scenario(async (fixture, server) => {
    const { source, target } = await pair(fixture);
    const tied = (await fixture.pm.create({ type: "Task", title: target.title })).item;
    await fixture.pm.create({ type: "Task", title: "Unconnected vegetables" });
    await fixture.pm.comments(source.id, { add: "PRIVATE_COMMENT_MARKER" });
    await fixture.pm.files(target.id, { add: ["private-metadata.ts"] });
    reply(server, { blocked_by: 0.95, none: 0.05 });
    const before = trackerSnapshot(fixture.pmRoot);
    const result = await link(fixture, source.id);
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    assert.deepEqual(result.applied, []);
    assert.equal(result.qualifying.length, 2);
    assert.equal(result.outcome, "proposals");
    assert.deepEqual(result.proposals.map(p => p.candidate), [target.id, tied.id].sort());
    assert.equal(result.proposals[0].kind, "blocked_by");
    assert.equal(result.proposals[0].probability, 0.95);
    assert.equal(server.requests.length, 1);
    const request = server.requests[0].body as { state: object; questions: Questions };
    assert.equal(Object.keys(request.questions).length, 2);
    const wire = JSON.stringify(request);
    for (const forbidden of ["PRIVATE_COMMENT_MARKER", "private-metadata.ts", "created_at", "updated_at", "author", "history", source.id, target.id]) assert.ok(!wire.includes(forbidden), forbidden);
    const q = request.questions.candidate_0;
    assert.equal(q.type, "choice");
    if (q.type !== "choice") throw new Error("Expected choice");
    const registry = resolveWorkspaceRelationshipKindRegistry();
    assert.deepEqual(Object.keys(q.criteria).sort(), [...new Set(DEPENDENCY_KIND_VALUES.map(k => registry.require(k).kind)), "none"].sort());
    assert.ok(!("duplicate" in q.criteria));
    assert.equal((await link(fixture, source.id, { limit: "1" })).proposals.length, 1);
  });
});

test("link apply writes one SDK edge and one receipt in the same history entry", async () => {
  await scenario(async (fixture, server) => {
    const { source, target } = await pair(fixture);
    reply(server, { blocked_by: 0.956, none: 0.044 });
    const result = await link(fixture, source.id, { apply: true });
    assert.deepEqual(result.applied, [`id=${target.id},kind=blocked_by`]);
    const current = (await fixture.pm.get(source.id, { full: true })).item;
    assert.equal(current.dependencies?.filter(d => d.id === target.id && d.kind === "blocked_by").length, 1);
    assert.equal(current.comments?.length, 1);
    assert.match(current.comments![0].text, /pm-jev link receipt: model=tev1:4b, catalog=pm-jev-link\/1/);
    assert.match(current.comments![0].text, /"blocked_by":0.96/);
    const history = readFileSync(join(fixture.pmRoot, "history", `${source.id}.jsonl`), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(history.length, 2);
    assert.match(JSON.stringify(history[1]), /dependencies/);
    assert.match(JSON.stringify(history[1]), /comments/);
    const before = trackerSnapshot(fixture.pmRoot);
    const repeat = await link(fixture, source.id);
    assert.equal(repeat.proposals[0].existing, true);
    assert.equal(repeat.proposals[0].kind, null);
    assert.equal(repeat.proposals[0].reason, "existing_edge");
    assert.deepEqual(repeat.qualifying, []);
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    await link(fixture, source.id, { apply: true });
    assert.equal((await fixture.pm.get(source.id, { full: true })).item.dependencies?.length, 1);
  });
});

test("link recognizes reverse inverse, symmetric, aliases and scalar hierarchy edges", async () => {
  for (const mode of ["inverse", "symmetric", "alias", "scalar", "incoming-other", "non-inverse"] as const) {
    await scenario(async (fixture, server) => {
      const { source, target } = await pair(fixture);
      let selected = "related";
      if (mode === "inverse") { await fixture.pm.update(target.id, { dep: [`id=${source.id},kind=blocks`] }); selected = "blocked_by"; }
      if (mode === "symmetric") await fixture.pm.update(target.id, { dep: [`id=${source.id},kind=related`] });
      if (mode === "alias") await fixture.pm.update(source.id, { dep: [`id=${target.id},kind=related_to`] });
      if (mode === "scalar") { await fixture.pm.update(source.id, { parent: target.id }); selected = "parent"; }
      if (mode === "incoming-other") {
        const third = (await fixture.pm.create({ type: "Task", title: "Other migration" })).item;
        await fixture.pm.update(third.id, { dep: [`id=${source.id},kind=related`] });
      }
      if (mode === "non-inverse") await fixture.pm.update(target.id, { dep: [`id=${source.id},kind=implements`] });
      reply(server, { [selected]: 1 });
      const result = await link(fixture, source.id);
      const proposal = result.proposals.find(p => p.candidate === target.id)!;
      const existing = !["incoming-other", "non-inverse"].includes(mode);
      assert.equal(proposal.existing, existing, mode);
      assert.equal(proposal.kind, existing ? null : selected, mode);
    });
  }
});

test("link margin abstention, none and probability thresholds authorize no speculative edges", async () => {
  await scenario(async (fixture, server) => {
    const { source } = await pair(fixture);
    reply(server, { related: 0.5, none: 0.5 });
    const ambiguous = await link(fixture, source.id, { apply: true, minConfidence: "0" });
    assert.equal(ambiguous.proposals[0].abstained, true);
    assert.equal(ambiguous.proposals[0].kind, null);
    assert.equal(ambiguous.proposals[0].reason, "top_two_margin_below_threshold");
    assert.deepEqual(ambiguous.applied, []);
    reply(server, { none: 1 });
    const none = await link(fixture, source.id, { apply: true });
    assert.equal(none.outcome, "none");
    assert.equal(none.proposals[0].reason, "none");
    reply(server, { related: 0.79, none: 0.21 });
    assert.deepEqual((await link(fixture, source.id, { apply: true })).applied, []);
    assert.equal((await link(fixture, source.id, { apply: true, minConfidence: "0.79" })).applied.length, 1);
  });
});

test("link refuses hierarchy application without allow-parent and permits it explicitly", async () => {
  for (const kind of ["parent", "child"]) {
    await scenario(async (fixture, server) => {
      const { source, target } = await pair(fixture);
      reply(server, { [kind]: 1 });
      const refused = await link(fixture, source.id, { apply: true });
      assert.equal(refused.proposals[0].reason, "parent_requires_allow_parent");
      assert.deepEqual(refused.applied, []);
      assert.equal((await fixture.pm.get(source.id, { full: true })).item.dependencies?.length ?? 0, 0);
      assert.deepEqual((await link(fixture, source.id, { apply: true, allowParent: true })).applied, [`id=${target.id},kind=${kind}`]);
    });
  }
});

test("link zero candidates returns none with zero inference and compact output", async () => {
  await scenario(async (fixture, server) => {
    const source = (await fixture.pm.create({ type: "Task", title: "Solitary login" })).item;
    await fixture.pm.create({ type: "Task", title: "Vegetable recipes" });
    const before = trackerSnapshot(fixture.pmRoot);
    const result = await link(fixture, source.id);
    assert.equal(result.outcome, "none");
    assert.deepEqual(result.usage, { input_tokens: 0, output_tokens: 0 });
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    assert.equal(server.requests.length, 0);
    const compact = await fixture.harness.runCommand({ command: "jev link", args: [source.id], pmRoot: fixture.pmRoot, global: { json: false } });
    assert.equal((compact.result as LinkDecision).outcome, "none");
  });
});

test("link validates arguments, candidate caps and probabilities before inference", async () => {
  await scenario(async (fixture, server) => {
    const { source } = await pair(fixture);
    const cases: [string[], Record<string, unknown>][] = [[[], {}], [[" "], {}], [[source.id, source.id], {}], [[source.id], { open: true }], [[], { open: true, full: true }],
      ...["0", "-1", "51", "bad", "1.1", "", "999999999999999999", true].map(limit => [[source.id], { limit }] as [string[], Record<string, unknown>]),
      [[source.id], { minConfidence: "-0.1" }]];
    for (const [args, options] of cases) await assert.rejects(fixture.harness.runCommand({ command: "jev link", args, options, pmRoot: fixture.pmRoot }), /./);
    assert.equal(server.requests.length, 0);
    reply(server, { none: 1 });
    assert.equal((await link(fixture, source.id, { limit: "50" })).proposals.length, 1);
  });
});

test("link fails closed on oversized requests and corrupt complete tracker reads", async () => {
  await scenario(async (fixture, server) => {
    const { source } = await pair(fixture);
    await fixture.pm.update(source.id, { title: "Login " + "x".repeat(3994), description: "y".repeat(4000), body: "z".repeat(4000) });
    for (let i = 0; i < 8; i++) await fixture.pm.create({ type: "Task", title: "Login " + "x".repeat(3994), description: "a".repeat(4000), body: "b".repeat(4000) });
    await assert.rejects(link(fixture, source.id), { code: "jev_link_state_limit" });
    assert.equal(server.requests.length, 0);
    writeFileSync(join(fixture.pmRoot, "tasks", "corrupt.toon"), "not a tracker document");
    await assert.rejects(link(fixture, source.id), /./);
    assert.equal(server.requests.length, 0);
  });
});

test("link stale source or candidate rejects inference without a receipt", async () => {
  for (const change of ["source", "candidate"]) {
    await scenario(async (fixture, server) => {
      const { source, target } = await pair(fixture);
      server.setReply(async (_, response, body) => {
        await fixture.pm.update(change === "source" ? source.id : target.id, { title: "Revised login evidence" });
        response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
      });
      await assert.rejects(link(fixture, source.id, { apply: true }), { code: "jev_stale_inference" });
      assert.equal((await fixture.pm.comments(source.id)).count, 0);
    });
  }
});

test("link item-lock guard rejects stale relationship coordinates and expired writes", async () => {
  await scenario(async (fixture, server) => {
    const { source } = await pair(fixture);
    reply(server, { related: 1 });
    type Document = NonNullable<BeforeMutationHookContext["before"]>;
    const document = async (): Promise<Document> => {
      const { body = "", ...metadata } = (await fixture.pm.get(source.id, { full: true })).item;
      return { metadata: metadata as Document["metadata"], body };
    };
    const before = await document();
    await link(fixture, source.id, { apply: true });
    const after = await document();
    const sdk: BeforeMutationHookContext["sdk"] = {
      get: async () => ({ item: before.metadata, body: before.body }), list: () => fixture.pm.listAllItemMetadataLight(),
    };
    const guard = (previous: Document | null, next: Document | null) => fixture.harness.runMutationGuard({ context: { pm_root: fixture.pmRoot, operation: "update", before: previous, after: next, changed_fields: ["dependencies", "comments"], sdk } });
    await guard(before, after);
    await guard(null, after);
    await guard(before, null);
    const receipt = after.metadata.comments![0];
    const text = (value: string): Document => ({ ...after, metadata: { ...after.metadata, comments: [{ ...receipt, text: value }] } });
    await guard(before, text("ordinary comment"));
    await guard(before, text("pm-jev link receipt: model=legacy"));
    const expired = text(receipt.text.replace(/deadline_ms=\d+/, "deadline_ms=0"));
    await assert.rejects(guard(before, expired), { code: "jev_stale_inference" });
    const stripped = [before, after].map(doc => ({ ...doc, metadata: { ...doc.metadata, comments: undefined } }));
    await guard(stripped[0], stripped[1]);
    await assert.rejects(guard({ ...before, body: "Changed" }, after), { code: "jev_stale_inference" });
    await assert.rejects(guard({ ...before, metadata: { ...before.metadata, dependencies: after.metadata.dependencies } }, after), { code: "jev_stale_inference" });
  });
});

test("link backlog bounds sources and counts changed, would_change, skipped and failed items", async () => {
  await scenario(async (fixture, server) => {
    await pair(fixture);
    reply(server, { related: 1 });
    assert.equal((await backlog(fixture, { limit: "1" })).would_change, 1);
    assert.equal((await backlog(fixture, { limit: "1" })).has_more, true);
    assert.equal((await backlog(fixture, { apply: true, limit: "1" })).changed, 1);
    assert.equal((await backlog(fixture, { limit: "1" })).skipped, 1);
    server.setReply((_, response) => response.end("{}"));
    const failed = await backlog(fixture);
    assert.equal(failed.failed, 2);
    assert.equal(failed.exit_code, 1);
    server.setReply(async (_, response, body) => {
      const items = (await fixture.pm.listAllComplete()).items;
      for (const item of items) await fixture.pm.comments(item.id, { add: "Concurrent revision" });
      response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
    });
    assert.equal((await backlog(fixture, { apply: true })).skipped, 2);
  });
});

test("link backlog streams TOON and JSON lines including empty summaries and open role selection", async () => {
  await scenario(async (fixture, server) => {
    const empty = await capture(() => backlog(fixture, {}, { json: false, quiet: false }));
    assert.match(empty[0], /^items\[0\]/);
    assert.match(empty[1], /^summary\[1\]/);
    await fixture.pm.schemaRemapStatus("open", "queued", {});
    await pair(fixture);
    reply(server, { related: 1 });
    for (const json of [true, false]) {
      const lines = await capture(() => backlog(fixture, { limit: "1" }, { json, quiet: false }));
      if (json) {
        assert.equal(JSON.parse(lines[0]).outcome, "would_change");
        assert.equal(JSON.parse(lines[0]).proposals[0].kind, "related");
        assert.equal(JSON.parse(lines[1]).selected, 1);
      } else {
        assert.match(lines[0], /^items\[1\]/);
        assert.match(lines[1], /would_change/);
      }
    }
  });
});

test("link backlog deadline fails remaining items without subsequent inference", async () => {
  await scenario(async (fixture, server) => {
    await pair(fixture);
    writeFileSync(getSettingsPath(fixture.pmRoot), JSON.stringify({ jev: { total_deadline_ms: 1000, timeout_ms: 1000 } }));
    server.setReply(() => {});
    assert.equal((await backlog(fixture, { apply: true })).failed, 2);
    assert.ok(server.requests.length <= 1);
    for (const item of (await fixture.pm.listAllComplete()).items) assert.equal((await fixture.pm.comments(item.id)).count, 0);
  });
});


test("link backlog preserves missing-source host failures and emits a fallback reason", async () => {
  await scenario(async (fixture, server) => {
    const { source, target } = await pair(fixture);
    const located = await Promise.all([source.id, target.id].map(id => locateItem(fixture.pmRoot, id)));
    server.setReply((_, response, body) => {
      for (const item of located) { assert.ok(item); rmSync(item.itemPath); }
      response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
    });
    const lines = await capture(() => backlog(fixture, { apply: true, limit: "1" }, { json: true, quiet: false }));
    assert.equal(JSON.parse(lines[0]).reason, "jev_link_failure");
    assert.equal(JSON.parse(lines[1]).failed, 1);
    assert.equal(JSON.parse(lines[1]).exit_code, 1);
  });
});
