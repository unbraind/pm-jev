import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { RelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import { parseQuestionsDocument, validateAnswers, JOINT_VERSION, JOINT_LIMITS, parseJointInput, validateJointDecisions, validateJointReportNumbers, JointRefusal } from "../index.ts";
import type { JointInput, JointReport, JointConstraint } from "../index.ts";
import { runJointCommand } from "../joint-command.ts";
import type { CommandHandlerContext } from "@unbrained/pm-cli/sdk/authoring";
import { answers, project, trackerSnapshot, withoutGit } from "./fixtures.ts";
import { installBuiltExtension, runBuiltCommand, cliFailure } from "./replay-fixtures.ts";

/** The shipped example is the producer/consumer fixture, never a parallel handwritten schema. */
function batch(): JointInput {
  return JSON.parse(readFileSync(new URL("../examples/joint-decisions.json", import.meta.url), "utf8")) as JointInput;
}
/** Supply one raw typed replacement without changing any other answer field. */
function select(input: JointInput, name: string, choice: string): JointInput {
  const next = structuredClone(input);
  const a = next.result.answers[name];
  assert.equal(a.type, "choice");
  if (a.type !== "choice") throw new Error("expected a choice fixture");
  return { ...next, result: { ...next.result, answers: { ...next.result.answers, [name]: { ...a, choice } } } };
}
/** Check every refusal's stable code and content-free actionable remedy. */
function refuses(run: () => unknown, code = "invalid_input"): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof JointRefusal); assert.equal(error.name, "JointRefusal");
    assert.equal(error.code, code); assert.ok(error.remedy.length > 20); return true;
  });
}
/** Conditional edges are proposals only, even when their trigger matches. */
function edge(id: string, source: string, target: string, relationship = "blocks"): JointConstraint {
  return { id, kind: "relationship", when: { question: "is_bug", value: "yes" }, source, target, relationship };
}

test("exclusive classification produces an exact two-answer witness and never edits selected answers", async () => {
  const raw = batch(); const before = structuredClone(raw);
  const report = await validateJointDecisions(raw);
  assert.equal(report.ok, false); assert.equal(report.exit_code, 1);
  assert.deepEqual(report.violations[0], { constraints: ["classification"], code: "exclusive", witness: [
    { question: "is_bug", answer: "yes", expected: "yes" }, { question: "is_feature", answer: "yes", expected: "yes" },
  ], remedy: report.violations[0].remedy });
  assert.deepEqual(raw, before); assert.equal(report.mutations, 0); assert.equal(report.inference_calls, 0); assert.equal(report.mutation_authority, "none");
  assert.ok(Buffer.byteLength(JSON.stringify(report)) < 1000);
  const allowed = await validateJointDecisions(select(raw, "is_feature", "no"));
  assert.equal(allowed.ok, true); assert.equal(allowed.exit_code, undefined); assert.deepEqual(allowed.violations, []);
  const sameShape = select(raw, "is_bug", "no");
  validateAnswers(parseQuestionsDocument(sameShape.questions), sameShape.result);
  const implied = { ...sameShape, constraints: [{ id: "needs-bug", kind: "requires", if: { question: "is_feature", value: "yes" }, then: { question: "is_bug", value: "yes" } }] };
  assert.equal((await validateJointDecisions(implied)).violations[0].code, "requires");
  assert.equal((await validateJointDecisions({ ...implied, result: raw.result })).ok, true);
  assert.equal((await validateJointDecisions({ ...implied, result: select(sameShape, "is_feature", "no").result })).ok, true);
  const detached = parseJointInput(raw); (detached.constraints[0] as { id: string }).id = "changed";
  assert.deepEqual(raw, before);
});

test("score comparisons preserve fractional raw scores and noul cutoffs are explicit, inclusive and exact", async () => {
  const questions = parseQuestionsDocument({ quality: { type: "score", criteria: ["low", "high"] }, safe: { type: "noul" } });
  const result = answers(questions);
  result.answers.quality = { type: "score", score: 0.75, probabilities: { "0": 1, "1": 0 }, confidence: 0, legend: { "0": "low", "1": "high" } };
  result.answers.safe = { type: "noul", noul: 0.3 };
  const raw = { version: JOINT_VERSION, questions, result, constraints: [{ id: "score-safe", kind: "requires", if: { question: "quality", value: 0.75 }, then: { question: "safe", value: false, threshold: 0.3 } }] };
  const report = await validateJointDecisions(raw);
  assert.equal(report.ok, false); assert.equal(report.violations[0].witness[0].answer, 0.75); assert.equal(report.violations[0].witness[1].answer, 0.3);
  for (const p of [0, 0.1, 0.3, 1]) {
    result.answers.safe = { type: "noul", noul: p };
    const constraints = [{ id: "inclusive", kind: "requires", if: { question: "quality", value: 0.75 }, then: { question: "safe", value: true, threshold: p } }];
    assert.equal((await validateJointDecisions({ ...raw, result, constraints })).ok, true);
  }
  assert.deepEqual(await validateJointDecisions(JSON.parse(JSON.stringify(raw))), await validateJointDecisions(raw), "producer optional undefined fields survive JSON round trip");
});

test("producer allow corpus retains prototype-shaped names, null usage, bounded maxima and deterministic minimal witnesses", async () => {
  const names = ["__proto__", "constructor", "toString", "hasOwnProperty"];
  const questions = parseQuestionsDocument(Object.fromEntries(names.map(name => [name, { type: "choice", criteria: { yes: "Selected", no: "Unselected" }, instructions: { nested: [null, true, 1, "text"] } }])));
  const result = answers(questions); result.usage = { input_tokens: null, output_tokens: null };
  const raw = { version: JOINT_VERSION, questions, result, constraints: [{ id: "three-selected", kind: "exclusive", answers: names.map(question => ({ question, value: "yes" })) }] };
  const first = await validateJointDecisions(raw);
  assert.deepEqual(first.violations[0].witness.map(row => row.question), names.slice(0, 2));
  assert.deepEqual(await validateJointDecisions(parseJointInput(raw)), first);
  const manyQuestions = parseQuestionsDocument(Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`q${i}`, { type: "choice", criteria: Object.fromEntries(Array.from({ length: 32 }, (_, j) => [`c${j}`, "criterion"])) }])));
  const maximum = { version: JOINT_VERSION, questions: manyQuestions, result: answers(manyQuestions), constraints: Array.from({ length: 32 }, (_, i) => ({ id: `rule${i}`, kind: "exclusive", answers: [{ question: "q0", value: "c0" }, { question: "q1", value: "c0" }] })) };
  const bounded = await validateJointDecisions(maximum);
  assert.equal(bounded.violations.length, 32); assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 65536);
});

test("one strict boundary refuses malformed maps, holes, extreme domains, unknown fields and dangling predicates", () => {
  const raw = batch();
  const bad: unknown[] = [undefined, null, [], 0, {}, { ...raw, extra: 1 }, { ...raw, version: "old" }, { ...raw, questions: null }, { ...raw, questions: [] }, { ...raw, questions: {} }, { ...raw, result: null }, { ...raw, result: { ...raw.result, extra: 1 } }, { ...raw, constraints: [] }, { ...raw, constraints: null }, { ...raw, constraints: [null] }, { ...raw, constraints: [1] }];
  for (const value of [NaN, Infinity, -Infinity, 1e300, -1, "1", null, undefined]) {
    if (value !== null) bad.push({ ...raw, result: { ...raw.result, usage: { input_tokens: value, output_tokens: 0 } } });
    bad.push({ ...raw, result: { ...raw.result, answers: { ...raw.result.answers, is_bug: { type: "choice", choice: "yes", confidence: value, probabilities: { yes: 1, no: 0 } } } } });
  }
  bad.push({ ...raw, result: { ...raw.result, model: "" } }, { ...raw, result: { ...raw.result, answers: null } }, { ...raw, result: { ...raw.result, answers: [] } }, { ...raw, result: { ...raw.result, answers: { is_bug: null } } });
  const p = { question: "is_bug", value: "yes" };
  const constraints: unknown[] = [{ id: "", kind: "exclusive", answers: [p, p] }, { id: "x", kind: "foreign" }, { id: "x", kind: "exclusive", answers: [p] }, { id: "x", kind: "exclusive", answers: [p, p] }, { id: "x", kind: "exclusive", answers: [p, { question: "missing", value: "yes" }] }, { id: "x", kind: "requires", if: p, then: null }, { id: "x", kind: "requires", if: p, then: { ...p, threshold: 0.5 } }, { id: "x", kind: "requires", if: p, then: { ...p, value: 1 } }, { ...edge("x", "a", "b"), source: " " }, { ...edge("x", "a", "b"), surprise: true }];
  for (const c of constraints) bad.push({ ...raw, constraints: [c] });
  bad.push({ ...raw, constraints: [raw.constraints[0], raw.constraints[0]] }, { ...raw, constraints: Array(33).fill(raw.constraints[0]) });
  const holes = Array(2); holes[1] = p; bad.push({ ...raw, constraints: holes });
  const hiddenHole = [p, p]; delete hiddenHole[0]; Object.assign(hiddenHole, { extra: p }); bad.push({ ...raw, constraints: hiddenHole });
  const arrayExtra = [p, p]; Object.assign(arrayExtra, { extra: p }); bad.push({ ...raw, constraints: arrayExtra });
  bad.push({ ...raw, questions: new Date() }, { ...raw, questions: { q: { type: "box" } } }, { ...raw, questions: { q: { type: "choice", criteria: [] } } }, { ...raw, questions: { q: { type: "score", criteria: ["only"] } } }, { ...raw, questions: { q: { type: "choice", criteria: {} } } }, { ...raw, questions: { q: { type: "noul", criteria: { other: "bad" } } } }, { ...raw, questions: { q: { type: "choice", criteria: { x: 1 } } } });
  for (const value of [" ", "x".repeat(129)]) bad.push({ ...raw, constraints: [{ ...raw.constraints[0], id: value }] });
  bad.push({ ...raw, questions: { ["x".repeat(129)]: { type: "noul" } } }, { ...raw, result: { ...raw.result, model: "x".repeat(8193) } });
  const deep: unknown[] = []; let cursor = deep; for (let i = 0; i < 14; i++) { const next: unknown[] = []; cursor.push(next); cursor = next; }
  bad.push({ ...raw, questions: { q: { type: "noul", instructions: deep } } }, { ...raw, questions: { q: { type: "noul", instructions: () => 1 } } });
  bad.push({ ...raw, questions: { q: { type: "noul", instructions: Array(257).fill("a") } } }, { ...raw, questions: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`q${i}`, { type: "noul" }])) });
  bad.push({ ...raw, questions: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`q${i}`, { type: "noul" }])) });
  bad.push({ ...raw, questions: { q: { type: "choice", criteria: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`c${i}`, "option"])) } } });
  const size = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`q${i}`, { type: "noul", instructions: "a".repeat(8192) }]));
  bad.push({ ...raw, questions: size });
  bad.push({ ...raw, questions: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`q${i}`, { type: "noul", instructions: "é".repeat(4096) }])) });
  const repeated = Array(256).fill("a".repeat(8192));
  bad.push({ ...raw, questions: { q: { type: "noul", instructions: [repeated, repeated, repeated] } } });
  for (const value of bad) refuses(() => parseJointInput(value));
  const extraAnswer = { ...raw.result, answers: { ...raw.result.answers, extra: { type: "noul", noul: 1 } } };
  refuses(() => parseJointInput({ ...raw, result: extraAnswer }));
  const scoreQuestions = parseQuestionsDocument({ score: { type: "score", criteria: ["a", "b"] }, noul: { type: "noul", criteria: { true: "safe", false: "unsafe" } } });
  for (const value of [-1, 2, "1", null]) refuses(() => parseJointInput({ ...raw, questions: scoreQuestions, result: answers(scoreQuestions), constraints: [{ id: "bad", kind: "requires", if: { question: "score", value }, then: { question: "noul", value: true, threshold: 0.5 } }] }));
  for (const value of [null, "true", 1]) refuses(() => parseJointInput({ ...raw, questions: scoreQuestions, result: answers(scoreQuestions), constraints: [{ id: "bad", kind: "requires", if: { question: "score", value: 1 }, then: { question: "noul", value, threshold: 0.5 } }] }));
  for (const threshold of [-1, 2, "1", undefined]) refuses(() => parseJointInput({ ...raw, questions: scoreQuestions, result: answers(scoreQuestions), constraints: [{ id: "bad", kind: "requires", if: { question: "score", value: 1 }, then: { question: "noul", value: true, threshold } }] }));
});

test("host graph validates the entire selected batch on one real non-git tracker with zero mutations", async () => {
  const f = await project();
  try { await withoutGit(f.cwd, async () => {
    const a = (await f.pm.create({ type: "Task", title: "A", parent: "none", blockedBy: "none", goal: "none", objective: "none" })).item.id;
    const b = (await f.pm.create({ type: "Task", title: "B", parent: "none", blockedBy: "none", goal: "none", objective: "none" })).item.id;
    const c = (await f.pm.create({ type: "Task", title: "C", parent: "none", blockedBy: "none", goal: "none", objective: "none" })).item.id;
    const before = (await f.pm.listAllComplete({ includeBody: true })).items, bytes = trackerSnapshot(f.pmRoot);
    const raw = { ...batch(), constraints: [edge("ab", a, b), edge("ba", b, a)] };
    const context = { client: f.pm };
    const report = await validateJointDecisions(raw, context);
    assert.equal(report.violations[0].code, "relationship_ordering"); assert.equal(report.violations[0].witness.length, 2);
    for (const relationship of ["parent", "child"]) {
      const cyclic = { ...raw, constraints: [edge("ab", a, b, relationship), edge("ba", b, a, relationship)] };
      assert.equal((await validateJointDecisions(cyclic, context)).violations[0].code, "relationship_hierarchy");
    }
    assert.equal((await validateJointDecisions({ ...raw, constraints: [edge("ab", a, b, "parent"), edge("ac", a, c, "parent")] }, context)).violations[0].code, "relationship_hierarchy");
    for (const constraints of [[edge("self", a, a)], [edge("missing", a, "unresolved")], [edge("kind", a, b, "unsupported")]]) assert.equal((await validateJointDecisions({ ...raw, constraints }, context)).violations[0].code, "relationship_edge");
    for (const constraints of [[edge("alias", ` ${a} `, ` ${b} `, "BLOCKS")], [edge("same", a, b), edge("same2", a, b)], [edge("ab", a, b, "related_to"), edge("ba", b, a, "related_to")]]) assert.equal((await validateJointDecisions({ ...raw, constraints }, context)).ok, true);
    const registry = new RelationshipKindRegistry();
    registry.register({ kind: "one_target", compatibilityVersion: 1, direction: "directed", ordering: false, hierarchy: false, outgoing: "one", incoming: "many", lifecycle: "persistent", allowSelf: false });
    assert.equal((await validateJointDecisions({ ...raw, constraints: [edge("ab", a, b, "one_target"), edge("ac", a, c, "one_target")] }, { ...context, registry })).violations[0].code, "relationship_cardinality");
    assert.equal((await validateJointDecisions({ ...raw, constraints: [edge("ab", a, b)] }, context)).ok, true);
    await assert.rejects(validateJointDecisions(raw), (error: unknown) => error instanceof JointRefusal && error.code === "host_required");
    assert.equal((await validateJointDecisions(select(raw, "is_bug", "no"))).ok, true, "unselected relationship mapping needs no host");
    assert.deepEqual((await f.pm.listAllComplete({ includeBody: true })).items, before); assert.deepEqual(trackerSnapshot(f.pmRoot), bytes);
    await f.pm.update(a, { dep: [`id=${b},kind=blocks`] });
    assert.equal((await validateJointDecisions({ ...raw, constraints: [edge("ab", a, b)] }, context)).ok, true, "unchanged is read from the current target");
    const file = join(f.cwd, "not-a-tracker"); writeFileSync(file, "not a directory");
    await assert.rejects(validateJointDecisions(raw, { client: new PmClient({ cwd: f.cwd, pmRoot: file, noExtensions: true }) }), (error: unknown) => error instanceof JointRefusal && error.code === "host_read_failed");
  }); } finally { f.dispose(); }
});

test("seeded model: 500 random operation sequences replay older documents and JSON whitespace variants without changing SDK-read state", async () => {
  const f = await project();
  let seed = 0x79a71;
  /** A reproducible generator independent of the implementation. */
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  try { await withoutGit(f.cwd, async () => {
    const a = (await f.pm.create({ type: "Task", title: "Native fields \r\n preserved", description: " keep whitespace \r\n", body: "## Body\r\n\r\nUnchanged.  ", priority: 2, status: "open", parent: "none", blockedBy: "none", goal: "none", objective: "none", tags: "native" })).item.id;
    const b = (await f.pm.create({ type: "Task", title: "Native blocker", status: "in_progress", parent: "none", blockedBy: a, goal: "none", objective: "none" })).item.id;
    const c = (await f.pm.create({ type: "Task", title: "Native parent and dependency", status: "open", parent: a, blockedBy: "none", goal: "none", objective: "none", dep: [`id=${b},kind=related`] })).item.id;
    const nodes = [a, b, c];
    let prior = "open";
    for (let i = 0; i < 6; i++) { const next = `custom_${random()}`; await f.pm.schemaRemapStatus(prior, next, {}); prior = next; }
    const referenceState = structuredClone((await f.pm.listAllComplete({ includeBody: true })).items);
    const history = [batch()];
    for (let sequence = 0; sequence < 500; sequence++) {
      let raw = batch();
      for (let operation = 0; operation < 8; operation++) {
        const action = random() % 7;
        if (action < 2) raw = select(raw, action === 0 ? "is_bug" : "is_feature", random() % 2 ? "yes" : "no");
        else if (action === 2) raw = structuredClone(history[random() % history.length]);
        else if (action === 3) raw = { ...raw, constraints: [{ id: "classification", kind: "requires", if: { question: "is_bug", value: "yes" }, then: { question: "is_feature", value: "no" } }] };
        else if (action === 4) raw = JSON.parse(JSON.stringify(raw, null, 2).replaceAll("\n", "\r\n")) as JointInput;
        else if (action === 5) raw = { ...raw, constraints: [edge("joint-edge", nodes[random() % 3], nodes[random() % 3])] };
        else raw = { ...raw, constraints: batch().constraints };
        const choice = (name: string) => { const a = raw.result.answers[name]; assert.equal(a.type, "choice"); return a.type === "choice" ? a.choice : ""; };
        const rule = raw.constraints[0];
        // Independent model: the seed has only a -> b in the execution graph.
        const relationshipAllowed = rule.kind !== "relationship" || choice("is_bug") !== "yes" || (rule.source !== rule.target && !(rule.source === b && rule.target === a));
        const expected = rule.kind === "exclusive" ? !(choice("is_bug") === "yes" && choice("is_feature") === "yes") : rule.kind === "requires" ? choice("is_bug") !== "yes" || choice("is_feature") === "no" : relationshipAllowed;
        const before = structuredClone(raw);
        assert.equal((await validateJointDecisions(raw, { client: f.pm })).ok, expected, `seed 0x79a71 sequence ${sequence} operation ${operation}`);
        assert.equal((await validateJointDecisions(parseJointInput(raw), { client: f.pm })).ok, expected, "producer outputs validate and round-trip");
        assert.deepEqual(raw, before);
      }
      history.push(structuredClone(raw));
      if (sequence % 50 === 0) await f.pm.focus(nodes[random() % 3]);
      assert.deepEqual((await f.pm.listAllComplete({ includeBody: true })).items, referenceState, "state read BACK through the SDK, no normalization oracle");
    }
  }); } finally { f.dispose(); }
});

test("emitted numbers are finite and bounded, including extreme witness and count fuzz", async () => {
  const report = await validateJointDecisions(batch()); validateJointReportNumbers(report);
  for (const key of ["questions", "constraints", "relationship_additions", "mutations", "inference_calls", "exit_code"] as const) for (const value of [NaN, Infinity, -Infinity, -1, 1e300, 0.5]) refuses(() => validateJointReportNumbers({ ...report, [key]: value } as JointReport), "invalid_report");
  for (const key of ["answer", "expected", "threshold"] as const) for (const value of [NaN, Infinity, -Infinity, -1, 1e300]) {
    const next = structuredClone(report); (next.violations[0].witness[0] as unknown as Record<string, unknown>)[key] = value;
    refuses(() => validateJointReportNumbers(next), "invalid_report");
  }
  validateJointReportNumbers({ ...report, violations: [{ ...report.violations[0], witness: [{ question: "q", answer: 0, expected: false, threshold: 0 }] }] });
  assert.equal(JOINT_LIMITS.questions, 32);
});

test("native CLI and SDK agree in JSON and compact TOON without Git, inference or mutation", async () => {
  const f = await project();
  try {
    installBuiltExtension(f.pmRoot);
    const file = join(f.cwd, "batch.json"); writeFileSync(file, JSON.stringify(batch()));
    const before = trackerSnapshot(f.pmRoot);
    // The native host honors semantic exit 1; inspect it independently of refusal exit 2.
    const failure = await runBuiltCommand(f, ["--json", "jev", "validate", "--batch", file]).then(() => { throw new Error("conflict unexpectedly passed"); }, error => error as { code: number; stdout: string });
    assert.equal(failure.code, 1); assert.deepEqual(JSON.parse(failure.stdout), await validateJointDecisions(batch()));
    const toon = await runBuiltCommand(f, ["jev", "validate", "--batch", file]).catch(error => error as { code: number; stdout: string });
    assert.match(toon.stdout, /classification/); assert.match(toon.stdout, /is_bug/); assert.ok(toon.stdout.length < 1500);
    writeFileSync(file, JSON.stringify(select(batch(), "is_bug", "no")));
    assert.equal(JSON.parse((await runBuiltCommand(f, ["--json", "jev", "validate", "--batch", file])).stdout).ok, true);
    for (const args of [[], ["--batch", join(f.cwd, "missing")], ["--batch", f.cwd]]) await assert.rejects(runBuiltCommand(f, ["--json", "jev", "validate", ...args]), cliFailure({ ok: false, exit_code: 2 }));
    for (const bytes of ["{", "x".repeat(JOINT_LIMITS.bytes + 1)]) { writeFileSync(file, bytes); await assert.rejects(runBuiltCommand(f, ["--json", "jev", "validate", "--batch", file]), cliFailure({ ok: false, exit_code: 2 })); }
    writeFileSync(file, "{}");
    const ctx = { options: { batch: file }, pm_root: f.pmRoot, source_workspace_root: f.cwd, global: {}, args: [], command: "jev validate" } as CommandHandlerContext;
    assert.equal((await runJointCommand(ctx)).ok, false);
    for (const value of [undefined, " ", f.cwd, join(f.cwd, "missing")]) assert.equal((await runJointCommand({ ...ctx, options: { batch: value } })).ok, false);
    for (const bytes of ["{", "x".repeat(JOINT_LIMITS.bytes + 1)]) { writeFileSync(file, bytes); assert.equal((await runJointCommand(ctx)).ok, false); }
    const unexpected = new Error("synthetic unexpected option failure");
    const options = Object.defineProperty({}, "batch", { get() { throw unexpected; } });
    await assert.rejects(runJointCommand({ ...ctx, options }), error => error === unexpected);
    writeFileSync(file, JSON.stringify(batch()));
    const harness = await f.harness.runCommand({ command: "jev validate", args: [], options: { batch: file }, pmRoot: f.pmRoot });
    assert.deepEqual(harness.result, await validateJointDecisions(batch()));
    writeFileSync(file, JSON.stringify({ ...batch(), constraints: [edge("missing-endpoints", "a", "b")] }));
    const fallback = await runJointCommand(ctx); assert.equal(fallback.ok, false);
    const injected = await f.harness.runCommand({ command: "jev validate", args: [], options: { batch: file }, pmRoot: f.pmRoot });
    assert.deepEqual(injected.result, fallback);
    assert.deepEqual(trackerSnapshot(f.pmRoot), before);
  } finally { f.dispose(); }
});
