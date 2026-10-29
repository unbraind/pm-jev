import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { decode } from "@toon-format/toon";
import { decodePmTableRows } from "@unbrained/pm-cli/sdk";
import type { PmEncodedTableRows } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { LABEL_QUEUE_VERSION, LABEL_QUEUE_LIMITS, LabelQueueRefusal, parseLabelQueueInput, selectLabelQueue, validateLabelQueueReportNumbers } from "../index.ts";
import type { LabelCase, LabelQueueInput, LabelQueueReport, LabelRatio, LabelOmission } from "../index.ts";
import { labelOrdinal } from "../label-schema.ts";
import { runLabelQueueCommand } from "../label-command.ts";
import { project, withoutGit, trackerSnapshot } from "./fixtures.ts";
import { installBuiltExtension, runBuiltCommand, cliFailure } from "./replay-fixtures.ts";

/** The shipped document also exercises producer and validator agreement. */
function example(): LabelQueueInput { return JSON.parse(readFileSync(new URL("../examples/label-queue.json", import.meta.url), "utf8")) as LabelQueueInput; }
/** Modify a selected case while retaining explicit provenance and source boundaries. */
function row(id: string, changes: Partial<LabelCase> = {}): LabelCase { return { ...example().cases[0], id, label: { kind: "none" }, ...changes }; }
/** A small independent oracle uses cross-products and full stable sorting at each step. */
function model(input: LabelQueueInput) {
  const p = input.policy; const chosen: LabelCase[] = []; let spent = 0;
  const omissions: Record<LabelOmission, number> = { invalid: 0, held_out: 0, other_cohort: 0, human_labeled: 0, not_pending: 0, below_uncertainty: 0, diversity: 0, budget: 0, limit: 0 };
  const compare = (a: LabelRatio, b: LabelRatio) => { const delta = BigInt(a.numerator) * BigInt(b.denominator) - BigInt(b.numerator) * BigInt(a.denominator); return delta < 0n ? -1 : delta > 0n ? 1 : 0; };
  const tie = (r: LabelCase) => createHash("sha256").update(JSON.stringify([p.seed, JSON.stringify([r.source, r.id, r.task])])).digest("hex");
  const eligible = input.cases.filter(r => {
    const cohort = input.cohorts.find(c => c.id === r.cohort)!;
    const reason = cohort.role === "held_out" ? "held_out" : r.cohort !== p.cohort ? "other_cohort" : r.label.kind === "human" ? "human_labeled" : r.state === "decided" ? "not_pending" : compare(r.uncertainty, p.min_uncertainty) < 0 ? "below_uncertainty" : null;
    if (reason) omissions[reason]++; return reason === null;
  });
  const pending = [...eligible];
  const count = (bucket: string) => chosen.filter(r => r.bucket === bucket).length;
  while (chosen.length < p.limit) {
    const possible = pending.filter(r => count(r.bucket) < p.max_per_bucket && r.cost + spent <= p.budget);
    possible.sort((a, b) => (p.diversity === "balanced" ? count(a.bucket) - count(b.bucket) : 0) || -compare(a.uncertainty, b.uncertainty) || (tie(a) < tie(b) ? -1 : 1));
    if (!possible.length) break;
    chosen.push(possible[0]); spent += possible[0].cost; pending.splice(pending.indexOf(possible[0]), 1);
  }
  for (const r of pending) omissions[count(r.bucket) >= p.max_per_bucket ? "diversity" : r.cost + spent > p.budget ? "budget" : "limit"]++;
  return { ids: chosen.map(r => r.id), spent, omissions, counts: { candidates: input.cases.length, eligible: eligible.length, selected: chosen.length, omitted: input.cases.length - chosen.length } };
}
/** Stable, content-free typed refusal assertions. */
function refuses(run: () => unknown, code = "invalid_input") {
  assert.throws(run, (error: unknown) => { assert.ok(error instanceof LabelQueueRefusal); assert.equal(error.name, "LabelQueueRefusal"); assert.equal(error.code, code); assert.ok(error.remedy.length > 20); return true; });
}
/** Verify the independent queue oracle, conservation counts and detached producer agreement. */
function check(input: LabelQueueInput): LabelQueueReport {
  const before = structuredClone(input), expected = model(input), actual = selectLabelQueue(input);
  assert.deepEqual(actual.queue.map(r => r.id), expected.ids); assert.equal(actual.spent, expected.spent);
  assert.deepEqual(actual.counts, expected.counts); assert.deepEqual(actual.omissions, expected.omissions);
  assert.deepEqual(selectLabelQueue(parseLabelQueueInput(input).input), actual);
  assert.deepEqual(selectLabelQueue(JSON.parse(JSON.stringify(input, null, 2).replaceAll("\n", "\r\n"))), actual);
  assert.deepEqual(structuredClone(input), before); assert.equal(actual.inference_calls, 0); assert.equal(actual.mutations, 0);
  return actual;
}

test("fixed seed yields a bounded deterministic human-labeling queue and preserves provenance", () => {
  const input = example(), report = check(input);
  assert.deepEqual(report.counts, { candidates: 3, eligible: 2, selected: 2, omitted: 1 });
  assert.deepEqual(report.queue.map(r => r.id), ["case-a", "case-b"]);
  assert.deepEqual(report.queue[0].label, input.cases[0].label); assert.equal(report.queue[0].ground_truth, false);
  assert.equal(report.omissions.held_out, 1); assert.equal(report.spent, 3); assert.equal(report.remaining, 0);
  assert.equal(report.queue[0].uncertainty_display, 0.9); assert.equal(report.mutation_authority, "none");
  assert.equal(LABEL_QUEUE_VERSION, "pm-jev-label-queue/1");
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 2500);
  const reversed = { ...input, cases: [...input.cases].reverse(), cohorts: [...input.cohorts].reverse() };
  assert.deepEqual(selectLabelQueue(reversed), report);
  const parsed = parseLabelQueueInput(input); (parsed.input.cases[0].uncertainty as { numerator: number }).numerator = 0;
  assert.deepEqual(input, example());
});

test("uncertainty, balancing, caps, cost exhaustion and zero budgets have explicit counted outcomes", () => {
  const cases = [row("highest", { uncertainty: { numerator: 1, denominator: 1 }, bucket: "same", cost: 2 }), row("next", { uncertainty: { numerator: 9, denominator: 10 }, bucket: "same", cost: 1 }), row("different", { uncertainty: { numerator: 3, denominator: 4 }, bucket: "other", cost: 1 })];
  const input = { ...example(), cases, policy: { ...example().policy, max_per_bucket: 3 } };
  assert.deepEqual(check(input).queue.map(r => r.id), ["highest", "different"]);
  assert.deepEqual(check({ ...input, policy: { ...input.policy, diversity: "cap" } }).queue.map(r => r.id), ["highest", "next"]);
  for (const budget of [0, 1, 2, 3, 4, 1_000_000]) for (const limit of [0, 1, 2, 3, 100]) for (const diversity of ["cap", "balanced"] as const) check({ ...input, policy: { ...input.policy, budget, limit, diversity, max_per_bucket: 1 } });
  const rows = [row("expensive", { cost: 4 }), row("affordable", { cost: 1, bucket: "cheap" }), row("human", { label: { kind: "human", value: "feature", actor: "reviewer", evidence: "review-1" } }), row("decided", { state: "decided" }), row("low", { uncertainty: { numerator: 0, denominator: 1 } })];
  const report = check({ ...example(), cases: rows });
  assert.equal(report.omissions.budget, 1); assert.equal(report.omissions.human_labeled, 1); assert.equal(report.omissions.not_pending, 1); assert.equal(report.omissions.below_uncertainty, 1);
  assert.equal(report.queue[0].id, "affordable");
  check({ ...example(), cases: [], policy: { ...example().policy, budget: 0, limit: 0 } });
  const other = { id: "other", role: "acquisition" as const, sources: ["other-source"] };
  assert.equal(check({ ...example(), cohorts: [...example().cohorts, other], cases: [row("other", { cohort: "other", source: "other-source" })] }).omissions.other_cohort, 1);
});

test("exact inclusive count boundaries and seeded equal-score ties do not use rounded displays", () => {
  let seed = 0x12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let iteration = 0; iteration < 500; iteration++) {
    const denominator = 2 + random() % 499999999, numerator = 1 + random() % (denominator - 1);
    const uncertainty = { numerator, denominator };
    const input = { ...example(), policy: { ...example().policy, min_uncertainty: uncertainty }, cases: [row("equal", { uncertainty }), row("equivalent", { uncertainty: { numerator: numerator * 2, denominator: denominator * 2 }, bucket: "other" }), row("below", { uncertainty: { numerator: numerator - 1, denominator } })] };
    const report = check(input); assert.equal(report.counts.eligible, 2); assert.equal(report.omissions.below_uncertainty, 1);
  }
  const ties = { ...example(), cases: Array.from({ length: 20 }, (_, i) => row(`tie-${i}`, { cost: 1, bucket: `b${i}` })) };
  const orders = new Set<string>();
  for (let i = 0; i < 10; i++) orders.add(check({ ...ties, policy: { ...ties.policy, seed: `seed${i}` } }).queue.map(r => r.id).join(","));
  assert.ok(orders.size > 1);
  const near = [row("below", { uncertainty: { numerator: 999999998, denominator: 999999999 }, cost: 1 }), row("above", { uncertainty: { numerator: 999999999, denominator: 1000000000 }, cost: 1 })];
  assert.equal(check({ ...example(), cases: near, policy: { ...example().policy, diversity: "cap", max_per_bucket: 2 } }).queue[0].id, "above");
});

test("cohort declarations fail closed and isolated malformed or duplicate cases never hide valid neighbors", () => {
  const input = example();
  const bad: unknown[] = [undefined, null, [], {}, { ...input, version: "old" }, { ...input, extra: true }, { ...input, policy: null }, { ...input, cases: null }, { ...input, cohorts: [] }, { ...input, policy: { ...input.policy, cohort: "validation" } }];
  for (const policy of [{ ...input.policy, extra: 1 }, { ...input.policy, uncertainty: "entropy" }, { ...input.policy, diversity: "random" }, { ...input.policy, seed: " " }]) bad.push({ ...input, policy });
  for (const key of ["budget", "limit", "max_per_bucket"] as const) for (const value of [NaN, Infinity, -Infinity, -1, 0.5, 1e300, "1", null, undefined]) bad.push({ ...input, policy: { ...input.policy, [key]: value } });
  bad.push({ ...input, policy: { ...input.policy, max_per_bucket: 0 } }, { ...input, policy: { ...input.policy, limit: 101 } }, { ...input, policy: { ...input.policy, budget: 1000001 } });
  for (const value of [null, {}, { numerator: 0, denominator: 0 }, { numerator: 2, denominator: 1 }, { numerator: 1, denominator: 1e300 }, { numerator: 0.5, denominator: 1 }, { numerator: NaN, denominator: 1 }]) bad.push({ ...input, policy: { ...input.policy, min_uncertainty: value } });
  const hole = Array(2); hole[1] = input.cases[0]; bad.push({ ...input, cases: hole });
  const extra = [...input.cases]; Object.assign(extra, { extra: true }); bad.push({ ...input, cases: extra });
  const hidden = [...input.cases]; delete hidden[0]; Object.assign(hidden, { extra: true }); bad.push({ ...input, cases: hidden });
  bad.push({ ...input, cohorts: [null] }, { ...input, cohorts: [{ ...input.cohorts[0], role: "train" }] }, { ...input, cohorts: [input.cohorts[0], input.cohorts[0]] }, { ...input, cohorts: [{ ...input.cohorts[0], sources: [] }] });
  bad.push({ ...input, cases: Array(5001).fill(input.cases[0]) }, { ...input, cohorts: Array(33).fill(input.cohorts[0]) });
  bad.push(Object.create(input), { ...input, policy: new Date() }, Object.defineProperty({ ...input }, "policy", { get() { throw new Error("must not run"); } }));
  for (const value of ["", " ", "x".repeat(97), 1, null, undefined]) bad.push({ ...input, policy: { ...input.policy, seed: value } });
  for (const value of bad) refuses(() => selectLabelQueue(value));
  for (const cohorts of [[...input.cohorts, { id: "leak", role: "held_out", sources: ["public-intake"] }], [{ ...input.cohorts[0], sources: ["public-intake", "public-intake"] }]]) refuses(() => selectLabelQueue({ ...input, cohorts }), "cohort_conflict");
  const malformed: unknown[] = [null, 1, {}, { ...input.cases[0], extra: 1 }, { ...input.cases[0], source: "foreign" }, { ...input.cases[0], cohort: "validation" }, { ...input.cases[0], state: "open" }, { ...input.cases[0], cost: Infinity }, { ...input.cases[0], cost: 0 }, { ...input.cases[0], uncertainty: { numerator: 1, denominator: 0 } }, { ...input.cases[0], label: null }, { ...input.cases[0], label: [] }, { ...input.cases[0], label: { kind: "model", value: "x", actor: "x", evidence: "x" } }, { ...input.cases[0], label: { kind: "none", value: "bad" } }];
  for (const value of malformed) {
    const report = selectLabelQueue({ ...input, cases: [value, input.cases[1]] });
    assert.equal(report.omissions.invalid, 1); assert.equal(report.queue[0].id, "case-b"); assert.deepEqual(report.rejected, [{ index: 0, code: "invalid_case" }]);
  }
  const duplicates = selectLabelQueue({ ...input, cases: [row("duplicate"), row("duplicate", { revision: "older" }), input.cases[1]] });
  assert.equal(duplicates.omissions.invalid, 2); assert.equal(duplicates.queue.length, 1); assert.equal(duplicates.rejected[0].code, "duplicate_case");
  const manyBad = selectLabelQueue({ ...input, cases: [...Array(15).fill(null), input.cases[1]] });
  assert.equal(manyBad.rejected.length, 10); assert.equal(manyBad.rejected_omitted, 5); assert.equal(manyBad.counts.candidates, 16);
  const unexpected = new Error("synthetic proxy failure");
  const proxy = new Proxy({}, { ownKeys() { throw unexpected; } });
  assert.equal(selectLabelQueue({ ...input, cases: [proxy, input.cases[1]] }).omissions.invalid, 1);
});

test("allow corpus and maximum output retain exact identities including prototype names and whitespace", () => {
  assert.equal(labelOrdinal("a", "b"), -1); assert.equal(labelOrdinal("b", "a"), 1); assert.equal(labelOrdinal("a", "a"), 0);
  for (const value of ["__proto__", "constructor", " toString ", "unicode-λ", "line\r\nbreak"]) {
    const input = { ...example(), policy: { ...example().policy, cohort: value, seed: value }, cohorts: [{ id: value, role: "acquisition" as const, sources: [value] }], cases: [row(value, { source: value, cohort: value, revision: value, task: value, bucket: value, uncertainty: { numerator: 0, denominator: 1 } })] };
    check({ ...input, policy: { ...input.policy, min_uncertainty: { numerator: 0, denominator: 1 } } });
  }
  const maximum = selectLabelQueue({ ...example(), policy: { ...example().policy, budget: 1000000, limit: 100, max_per_bucket: 100 }, cases: Array.from({ length: 5000 }, (_, i) => row(`case-${i}`, { cost: 1, bucket: `bucket-${i % 10}` })) });
  assert.equal(maximum.queue.length, 100); assert.equal(maximum.omissions.limit, 4900); assert.ok(Buffer.byteLength(JSON.stringify(maximum)) < 65536);
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, example()); check(nullPrototype as unknown as LabelQueueInput);
  const huge = { ...example(), cohorts: Array.from({ length: 32 }, (_, i) => ({ id: `c${i}`, role: "acquisition" as const, sources: Array.from({ length: 128 }, (_, j) => `s${i}-${j}`) })),
    policy: { ...example().policy, cohort: "c0" }, cases: Array.from({ length: 5000 }, (_, i) => row(`${i}${"x".repeat(90)}`, { source: "s0-0", cohort: "c0", revision: "r".repeat(96), task: "t".repeat(96), bucket: "b".repeat(96), label: { kind: "inferred" as const, value: "v".repeat(96), actor: "a".repeat(96), evidence: "e".repeat(96) } })) };
  refuses(() => selectLabelQueue(huge));
});

test("500 seeded operation sequences replay earlier inputs and read unchanged native SDK state", async () => {
  const f = await project(); let seed = 0x5e1ec7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  try { await withoutGit(f.cwd, async () => {
    const none = { parent: "none", blockedBy: "none", goal: "none", objective: "none" };
    const a = (await f.pm.create({ ...none, type: "Task", title: "Original \r\n title", description: "Whitespace \r\n description  ", body: "## Body\r\n\r\nRetain this.  ", priority: 3, tags: "original", status: "open", comment: ["text=Native comment"], note: ["text=Native note"], file: ["path=index.ts"], doc: ["path=README.md"] })).item.id;
    const b = (await f.pm.create({ ...none, type: "Task", title: "Related native item", parent: a, blockedBy: a, dep: [`id=${a},kind=related`], status: "in_progress" })).item.id;
    for (const status of ["open", "in_progress", "closed", "canceled", "blocked"]) await f.pm.schemaRemapStatus(status, `custom_${random()}`, {});
    const nativeReference = structuredClone((await f.pm.listAllComplete({ includeBody: true })).items);
    const bytes = trackerSnapshot(f.pmRoot); const prior: LabelQueueInput[] = [example()];
    for (let sequence = 0; sequence < 500; sequence++) {
      let input = structuredClone(prior[random() % prior.length]);
      for (let operation = 0; operation < 6; operation++) {
        const action = random() % 8;
        if (action === 0) input = structuredClone(prior[random() % prior.length]);
        else if (action === 1) input = { ...input, policy: { ...input.policy, budget: random() % 8, limit: random() % 5 } };
        else if (action === 2) input = { ...input, cases: [...input.cases, row(`new-${sequence}-${operation}`, { bucket: `b${random() % 3}`, cost: 1 + random() % 4 })] };
        else if (action === 3) input = { ...input, cases: input.cases.map((r, i) => i === random() % input.cases.length ? { ...r, label: { kind: "human", value: " explicit \r\n label ", actor: "reviewer", evidence: `review-${sequence}` } } : r) };
        else if (action === 4) input = { ...input, policy: { ...input.policy, diversity: random() % 2 ? "cap" : "balanced", max_per_bucket: 1 + random() % 3, seed: `seed-${random()}` } };
        else if (action === 5) input = { ...input, cases: input.cases.map((r, i) => i === 0 ? { ...r, state: random() % 2 ? "decided" : "abstained", revision: `revision-${random()}`, uncertainty: { numerator: random() % 11, denominator: 10 } } : r) };
        else if (action === 6) input = JSON.parse(JSON.stringify(input, null, 2).replaceAll("\n", "\r\n")) as LabelQueueInput;
        else input = { ...input, cases: [...input.cases].reverse() };
        check(input);
      }
      prior.push(structuredClone(input));
      if (sequence % 25 === 0) await f.pm.focus(random() % 2 ? a : b);
      assert.deepEqual((await f.pm.listAllComplete({ includeBody: true })).items, nativeReference, `SDK readback seed 0x5e1ec7 sequence ${sequence}`);
    }
    assert.deepEqual(trackerSnapshot(f.pmRoot), bytes);
  }); } finally { f.dispose(); }
});

test("emitted numeric domains reject extremes in counts, ratios, costs, ranks and conservation laws", () => {
  const original = selectLabelQueue(example());
  const setters: ((r: Record<string, unknown>, value: number) => void)[] = [
    (r, v) => { (r.counts as Record<string, unknown>).candidates = v; }, (r, v) => { (r.omissions as Record<string, unknown>).budget = v; },
    (r, v) => { (r.policy as Record<string, unknown>).budget = v; }, (r, v) => { (r.policy as Record<string, unknown>).limit = v; }, (r, v) => { (r.policy as Record<string, unknown>).max_per_bucket = v; },
    (r, v) => { ((r.policy as Record<string, unknown>).min_uncertainty as Record<string, unknown>).denominator = v; },
    (r, v) => { r.spent = v; }, (r, v) => { r.remaining = v; }, (r, v) => { r.inference_calls = v; }, (r, v) => { r.mutations = v; }, (r, v) => { r.rejected_omitted = v; },
  ];
  for (const set of setters) for (const value of [NaN, Infinity, -Infinity, -1, 0.5, 1e300]) { const r = structuredClone(original); set(r as unknown as Record<string, unknown>, value); refuses(() => validateLabelQueueReportNumbers(r), "invalid_report"); }
  for (const key of ["rank", "cost", "uncertainty_display"] as const) for (const value of [NaN, Infinity, -Infinity, -1, 1e300]) {
    const r = structuredClone(original); (r.queue[0] as unknown as Record<string, unknown>)[key] = value; refuses(() => validateLabelQueueReportNumbers(r), "invalid_report");
  }
  const invalidIndex = selectLabelQueue({ ...example(), cases: [null, example().cases[1]] });
  for (const value of [-1, NaN, Infinity, 2]) { const r = structuredClone(invalidIndex); (r.rejected[0] as { index: number }).index = value; refuses(() => validateLabelQueueReportNumbers(r), "invalid_report"); }
  const wrong = structuredClone(original); (wrong.queue[0].uncertainty as { numerator: number }).numerator = 11; refuses(() => validateLabelQueueReportNumbers(wrong), "invalid_report");
});

test("native JSON/TOON CLI and host-injected command need no Git, model or tracker mutation", async () => {
  const f = await project();
  try {
    installBuiltExtension(f.pmRoot); const file = join(f.cwd, "queue.json"); writeFileSync(file, JSON.stringify(example()));
    const before = trackerSnapshot(f.pmRoot), expected = selectLabelQueue(example());
    const json = await runBuiltCommand(f, ["--json", "jev", "label-queue", "--input", file]); assert.deepEqual(JSON.parse(json.stdout), expected);
    const toon = await runBuiltCommand(f, ["jev", "label-queue", "--input", file]);
    const compact = decode(toon.stdout) as unknown as { counts: unknown; queue: PmEncodedTableRows["rows"]; queue_encoding: PmEncodedTableRows["encoding"] };
    assert.deepEqual(compact.counts, expected.counts); assert.deepEqual(compact.queue.map(r => r.id), expected.queue.map(r => r.id));
    assert.deepEqual(compact.queue_encoding.json_columns, ["uncertainty", "label"]);
    assert.deepEqual(decodePmTableRows({ rows: compact.queue, encoding: compact.queue_encoding }), expected.queue);
    assert.ok(toon.stdout.length < 2500);
    const run = await f.harness.runCommand({ command: "jev label-queue", options: { input: file }, args: [], pmRoot: f.pmRoot }); assert.deepEqual(run.result, expected);
    const ctx = { options: { input: file }, pm_root: f.pmRoot, source_workspace_root: f.cwd, global: {}, args: [], command: "jev label-queue" } as CommandHandlerContext;
    assert.deepEqual(await runLabelQueueCommand(ctx), expected);
    for (const input of [undefined, " ", f.cwd, join(f.cwd, "missing")]) {
      const result = await runLabelQueueCommand({ ...ctx, options: { input } }); assert.equal(result.ok, false);
      await assert.rejects(runBuiltCommand(f, ["--json", "jev", "label-queue", ...(input === undefined ? [] : ["--input", input])]), cliFailure({ ok: false, exit_code: 2 }));
    }
    for (const bytes of ["{", "x".repeat(LABEL_QUEUE_LIMITS.bytes + 1), "{}"] ) {
      writeFileSync(file, bytes); assert.equal((await runLabelQueueCommand(ctx)).ok, false);
    }
    const unexpected = new Error("synthetic unexpected option failure");
    const options = Object.defineProperty({}, "input", { get() { throw unexpected; } });
    await assert.rejects(runLabelQueueCommand({ ...ctx, options }), error => error === unexpected);
    assert.deepEqual(trackerSnapshot(f.pmRoot), before);
  } finally { f.dispose(); }
});
