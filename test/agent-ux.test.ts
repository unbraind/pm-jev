import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { answers, scenario } from "./fixtures.ts";
import { activateExtensionForTest } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import type { Questions } from "@typesafe-ai/sdk";

/** Fields inspected on compact/full receipts without weakening test type checks. */
interface OutputChoice { probabilities: Record<string, number>; confidence: number; omitted_options?: number }
/** Common test view; each command assertion reads only its own receipt fields. */
interface OutputReceipt extends OutputChoice {
  proposals: { type: OutputChoice; priority: { score: number; confidence: number }; needs_human: { probability: number } };
  answers: { route: OutputChoice; impact: { score: number }; n: OutputChoice };
  probability: number;
  duplicate_of: string | null;
  candidates: { score: number }[];
}

/** Exercise decisions against deterministic HTTP responses and the actual host context. */
test("gate expectations distinguish unsafe secrets, clean text and inclusive boundaries", async () => {
  await scenario(async (fixture, server) => {
    server.setReply((_, response, body) => {
      const request = body as { state: string; questions: Questions };
      const result = answers(request.questions);
      result.answers.proposition = { type: "noul", noul: request.state.includes("ghp_") ? 0.934567 : 0.49999 };
      response.end(JSON.stringify(result));
    });
    const run = (options: Record<string, unknown>, global = { json: true }) => fixture.harness.runCommand({ command: "jev gate", pmRoot: fixture.pmRoot, global, options: { noul: "The text contains a credential, API key or password.", text: "deploy with token ghp_SYNTHETIC_ONLY", ...options } });
    for (const [options, holds, expected, ok] of [
      [{}, true, true, true], [{ expect: "true" }, true, true, true],
      [{ expect: "false" }, true, false, false],
      [{ expect: "false", text: "Adjust the blue button." }, false, false, true],
      [{ threshold: "0.934567" }, true, true, true],
      [{ threshold: "0.934567", expect: "false" }, true, false, false],
      [{ threshold: "0.934568" }, false, true, false],
    ] as const) {
      const response = await run(options);
      const verdict = response.result as Record<string, unknown>;
      assert.equal(verdict.holds, holds);
      assert.equal(verdict.expected, expected);
      assert.equal(verdict.ok, ok);
      assert.equal("passed" in verdict, false);
      assert.equal(response.exitCode ?? 0, ok ? 0 : 1);
    }
    const rounded = await run({ text: "Adjust the blue button.", expect: "false" }, { json: false });
    assert.equal((rounded.result as Record<string, unknown>).probability, 0.5);
    assert.equal((rounded.result as Record<string, unknown>).holds, false);
    assert.equal(rounded.exitCode ?? 0, 0);
    for (const expect of ["yes", "FALSE", "", true, false]) {
      const count = server.requests.length;
      await assert.rejects(run({ expect }), /expect/);
      assert.equal(server.requests.length, count);
    }
  });
});

/** Use a non-argmax selected option to ensure compaction cannot hide the actual choice. */
test("compact all four commands while JSON and full retain precision and every option", async () => {
  await scenario(async (fixture, server) => {
    const item = (await fixture.pm.create({ type: "Feature", title: "Login crash report", priority: 3 })).item;
    for (let i = 0; i < 4; i++) await fixture.pm.create({ type: "Issue", title: "Login crash" });
    const selected = await fixture.harness.runCommand({ command: "jev dedupe", options: { title: item.title }, pmRoot: fixture.pmRoot, global: { json: false } });
    assert.equal((selected.result as OutputReceipt).duplicate_of, item.id);
    assert.equal((selected.result as OutputReceipt).omitted_options, 3);
    const labels = ["a", "b", "c", "d", "e"];
    const questions = { route: { type: "choice", criteria: Object.fromEntries(labels.map(label => [label, null])) }, impact: { type: "score", criteria: ["minor", "major"] }, sensitive: { type: "noul" } };
    const path = `${fixture.cwd}/questions.json`;
    writeFileSync(path, JSON.stringify(questions));
    server.setReply((_, response, body) => {
      const result = answers((body as { questions: Questions }).questions);
      for (const [key, raw] of Object.entries(result.answers)) {
        const answer = raw as Record<string, unknown>;
        if (answer.type === "noul") answer.noul = 0.123456789;
        else {
          answer.confidence = 0.876543219;
          const keys = Object.keys(answer.probabilities as object);
          answer.probabilities = Object.fromEntries(keys.map((label, i) => [label, i < 3 ? 0.3 : 0.1 / (keys.length - 3)]));
          if (answer.type === "choice") answer.choice = keys.at(-1);
          else { answer.score = 0.123456789; answer.probabilities = Object.fromEntries(keys.map((label, i) => [label, i === 0 ? 0.876543211 : 0.123456789 / (keys.length - 1)])); }
        }
        result.answers[key] = answer;
      }
      response.end(JSON.stringify(result));
    });
    const commands = [
      { command: "triage", options: {}, args: [item.id] },
      { command: "dedupe", options: { title: item.title }, args: [] },
      { command: "ask", options: { questions: path }, args: [item.id] },
      { command: "gate", options: { noul: "Contains sensitive data", text: "Synthetic text" }, args: [] },
    ];
    const choice = (result: OutputReceipt, command: string) => command === "triage" ? result.proposals.type : command === "ask" ? result.answers.route : result;
    for (const invocation of commands) {
      const run = (global: Record<string, unknown>, options: Record<string, unknown> = invocation.options) => fixture.harness.runCommand({ command: `jev ${invocation.command}`, options, args: invocation.args, pmRoot: fixture.pmRoot, global });
      const original = (await run({ json: true })).result as OutputReceipt;
      const compact = (await run({ json: false })).result as OutputReceipt;
      const full = (await run({ json: false }, { ...invocation.options, full: true })).result;
      assert.deepEqual(full, original);
      assert.deepEqual((await run({ json: false, outputFormat: "json" })).result, original);
      assert.deepEqual((await run({ json: undefined, defaultOutputFormat: "json" })).result, original);
      assert.deepEqual((await run({ json: false, defaultOutputFormat: "json", outputFormat: "toon" })).result, compact);
      assert.deepEqual((await run({ json: undefined, defaultOutputFormat: "toon" })).result, compact);
      assert.deepEqual((await run({ json: undefined, outputFormat: "toon" })).result, compact);
      if (invocation.command === "gate") {
        assert.equal(original.probability, 0.123456789);
        assert.equal(compact.probability, 0.123);
      } else {
        const slim = choice(compact, invocation.command), raw = choice(original, invocation.command);
        assert.equal(slim.confidence, 0.877);
        assert.equal(raw.confidence, 0.876543219);
        const keys = Object.keys(raw.probabilities);
        const retained = invocation.command === "triage" ? keys.slice(0, 3) : [...keys.slice(0, 3), keys.at(-1)];
        assert.deepEqual(Object.keys(slim.probabilities), retained);
        assert.equal(slim.omitted_options, keys.length - retained.length);
        assert.equal("omitted_options" in raw, false);
        if (invocation.command === "triage") {
          assert.equal(compact.proposals.priority.score, 0.123);
          assert.equal(original.proposals.priority.score, 0.123456789);
          assert.equal(compact.proposals.priority.confidence, 0.877);
          assert.equal(compact.proposals.needs_human.probability, 0.123);
        } else if (invocation.command === "ask") {
          assert.equal(compact.answers.impact.score, 0.123);
          assert.equal(original.answers.impact.score, 0.123456789);
        } else {
          assert.equal(compact.duplicate_of, null);
          assert.equal(compact.probability, 0.033);
          assert.equal(compact.candidates.length, 3);
          assert.equal(original.candidates.length, 5);
          assert.ok(original.candidates.some(candidate => candidate.score === 2 / 3));
          assert.ok(compact.candidates.some(candidate => candidate.score === 0.667));
        }
      }
    }
    const empty = await fixture.harness.runCommand({ command: "jev dedupe", options: { title: "Unrelated nebula" }, pmRoot: fixture.pmRoot, global: { json: false } });
    assert.equal((empty.result as OutputReceipt).omitted_options, 0);
    assert.deepEqual((empty.result as OutputReceipt).candidates, []);
    writeFileSync(path, JSON.stringify({ n: { type: "choice", criteria: { first: null, second: null } } }));
    server.setReply((_, response, body) => response.end(JSON.stringify(answers((body as { questions: Questions }).questions))));
    const small = await fixture.harness.runCommand({ command: "jev ask", args: [item.id], options: { questions: path }, pmRoot: fixture.pmRoot, global: { json: false } });
    assert.equal((small.result as OutputReceipt).answers.n.omitted_options, 0);
    assert.deepEqual(Object.keys((small.result as OutputReceipt).answers.n.probabilities), ["first", "second"]);
  });
});

/** Inspect dedupe metadata registered through the real extension lifecycle. */
async function dedupeHelp() {
  const activation = await activateExtensionForTest(extension, { capabilities: ["commands", "schema", "hooks"] });
  const command = activation.registrations.commands.find(registered => registered.command === "jev dedupe");
  assert.ok(command, "jev dedupe command is registered");
  return { command, flags: activation.registrations.flags };
}

/** Dedupe help guidance must match the dispatcher: --title is optional screening, and pair scanning has an example. */
test("dedupe help presents --title as optional screening with a pair-scan example", async () => {
  const { command, flags } = await dedupeHelp();
  const title = flags.find(registered => registered.target_command === "jev dedupe")?.flags.find(flag => flag.long === "--title");
  assert.ok(title, "--title flag is registered");
  assert.match(title.description ?? "", /Pre-create screening/);
  assert.match(title.description ?? "", /omit to scan existing pairs/);
  assert.doesNotMatch(title.description ?? "", /required/);
  assert.ok(command.examples.some(example => example.includes("--limit-pairs")), "a pair-scan example is listed");
  assert.ok(command.examples.some(example => example.includes("--title")), "the title screening example is retained");
});

/** Public command metadata must describe the deployed duplicate-only policy. */
test("dedupe description and intent promise calibrated duplicate links only", async () => {
  const { command } = await dedupeHelp();
  assert.ok(command.description);
  assert.ok(command.intent);
  assert.match(command.description, /calibrated duplicate/i);
  assert.match(command.description, /abstention/i);
  assert.match(command.description, /never closes items/i);
  for (const text of [command.description, command.intent]) {
    assert.match(text, /duplicate/i);
    assert.match(text, /screen a title before creation/i);
    assert.doesNotMatch(text, /related/i);
  }
});

/** The command table is a public policy contract alongside the detailed guide. */
test("README pair-scan command documents same_work abstention and no writes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const row = readme.split("\n").find(line => line.startsWith("| `pm jev dedupe --status open --type Issue --limit-pairs 20`"));
  assert.ok(row);
  assert.match(row, /calibrated `same_work`/);
  assert.match(row, /unsure pairs abstain/);
  assert.match(row, /no writes/);
  assert.doesNotMatch(row, /related/);
});

/** Document the deterministic lexical contribution separately from model evidence. */
test("README tags and linked files describe lexical decisions and model exclusion", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const paragraph = readme.slice(readme.indexOf("Tags and linked files contribute"), readme.indexOf("Precision-first scans"));
  assert.match(paragraph, /candidate retrieval and the lexical decision/);
  assert.match(paragraph, /`duplicateSimilarity`[\s\S]*tags\/files overlap at 0\.05/);
  assert.match(paragraph, /Tags and linked files are excluded from model\s+input/);
});
