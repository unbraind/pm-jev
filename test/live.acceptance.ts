import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { KEEP_CURRENT_TYPE } from "../index.ts";
import { project } from "./fixtures.ts";
import { isHostOutputSuppressed } from "@unbrained/pm-cli/sdk";
import type { BacklogTriageSummary, TriageDecision, DedupeDecision, AskDecision, GateDecision } from "../index.ts";

/** Restore scoped provider overrides after a live scenario. */
function restoreLiveEnvironment(url: string | undefined, model: string | undefined): void {
  for (const [key, value] of [["PM_JEV_BASE_URL", url], ["PM_JEV_MODEL", model]]) {
    if (value === undefined) delete process.env[key as string]; else process.env[key as string] = value;
  }
}

test("real local tev1: triage, dedupe, ask and gate on synthetic state", { timeout: 240000 }, async () => {
  const fixture = await project();
  const previousUrl = process.env.PM_JEV_BASE_URL, previousModel = process.env.PM_JEV_MODEL;
  process.env.PM_JEV_BASE_URL = "http://localhost:11434"; process.env.PM_JEV_MODEL = "tev1:4b";
  try {
    await fixture.pm.schemaAddType("Bug", { description: "A software defect, crash, exception, or broken existing behavior" });
    const created = await fixture.pm.create({ type: "Feature", title: "Login crashes for every user with an unhandled exception", description: "After the latest update, opening login throws an exception and closes the application. Nobody can sign in. Existing login worked before the regression.", priority: 3 });
    const id = created.item.id;
    const run = async (command: string, options: Record<string, unknown> = {}, args: string[] = []) => {
      const start = performance.now();
      const response = await fixture.harness.runCommand({ command: `jev ${command}`, pmRoot: fixture.pmRoot, args, options });
      assert.equal(response.handled, true);
      console.log(`${command}: ${Math.round(performance.now() - start)}ms ${JSON.stringify(response.result)}`);
      return response.result;
    };
    const triage = await run("triage", {}, [id]) as TriageDecision;
    const semantic = Object.entries(triage.proposals.type.probabilities).filter(([label]) => label !== KEEP_CURRENT_TYPE).sort(([, a], [, b]) => b - a);
    assert.ok(["Bug", "Issue"].includes(semantic[0][0]), "the strongest semantic label must still describe a defect");
    assert.ok(triage.proposals.type.abstained || triage.proposals.type.kept_current || ["Bug", "Issue"].includes(triage.proposals.type.value as string));
    if (triage.proposals.type.abstained) assert.equal(triage.proposals.type.reason, "top_two_margin_below_threshold");
    assert.ok(triage.proposals.priority.level <= 2);
    assert.equal(triage.applied.length, 0);
    assert.equal(triage.model, "tev1:4b");
    assert.ok(triage.usage.input_tokens > 0);
    assert.equal((await fixture.pm.get(id)).item.type, "Feature");
    const dedupe = await run("dedupe", { title: created.item.title, body: "Same login crash for every user" }) as DedupeDecision;
    assert.equal(dedupe.duplicate_of, id);
    const path = join(fixture.cwd, "questions.json");
    writeFileSync(path, JSON.stringify({ defect: { type: "choice", instructions: "Is this a software defect or a new feature?", criteria: { bug: "An existing behavior broke", feature: "A request for a new capability" } }, impact: { type: "score", instructions: "How many users are impacted?", criteria: ["no users affected", "some users affected", "every user affected"] }, broken: { type: "noul", instructions: "Does login fail for users?" } }));
    const ask = await run("ask", { questions: path }, [id]) as AskDecision;
    assert.equal(ask.answers.defect.kind, "choice");
    if (ask.answers.defect.kind === "choice") assert.equal(ask.answers.defect.value, "bug");
    const gate = await run("gate", { noul: "Does the text describe a login crash?", text: "The login page crashes with an unhandled exception and closes the application." }) as GateDecision;
    assert.equal(gate.holds, true);
    assert.equal(gate.expected, true);
    assert.equal(gate.ok, true);
    assert.ok(gate.probability >= gate.threshold);
    const negative = await run("gate", { noul: "Does the text contain a password or API key?", text: "Please adjust the blue button alignment." }) as GateDecision;
    assert.equal(negative.holds, false);
    assert.equal(negative.ok, false);
    assert.equal(negative.exit_code, 1);
    const secret = await run("gate", { noul: "The text contains a credential, API key or password.", text: "Deploy with token ghp_SYNTHETIC_EXAMPLE_ONLY; password=synthetic-password", expect: "false" }) as GateDecision;
    assert.equal(secret.holds, true);
    assert.equal(secret.expected, false);
    assert.equal(secret.ok, false);
    assert.equal(secret.exit_code, 1);
    const clean = await run("gate", { noul: "The text contains a credential, API key or password.", text: "Please adjust the blue button alignment.", expect: "false" }) as GateDecision;
    assert.equal(clean.holds, false);
    assert.equal(clean.expected, false);
    assert.equal(clean.ok, true);
    assert.equal(clean.exit_code, undefined);
    console.log("LIVE ACCEPTANCE: schema and plausibility passed for triage, dedupe, ask, positive gate, negative gate, secret safety gate and clean safety gate; no item mutation");
  } finally { restoreLiveEnvironment(previousUrl, previousModel); fixture.dispose(); }
});

test("real local tev1: bounded batch dry-run, apply, receipt reuse and refresh counts/timings", { timeout: 360000 }, async () => {
  const fixture = await project();
  const previousUrl = process.env.PM_JEV_BASE_URL;
  const previousModel = process.env.PM_JEV_MODEL;
  const previousFetch = globalThis.fetch;
  /** Restore the transport within the same scoped test ownership. */
  const restoreFetch = () => { globalThis.fetch = previousFetch; };
  let requests = 0;
  globalThis.fetch = (input, init) => {
    if (String(input).endsWith("/v1/systemone")) requests++;
    return previousFetch(input, init);
  };
  process.env.PM_JEV_BASE_URL = "http://localhost:11434";
  process.env.PM_JEV_MODEL = "tev1:4b";
  try {
    for (let index = 0; index < 2; index++) await fixture.pm.create({ type: "Feature", title: `Login regression ${index}: every user crashes`, description: "Login throws an exception and closes the application. Existing login worked before the update.", priority: 3 });
    const run = async (phase: string, options: Record<string, unknown>) => {
      const countBefore = requests;
      const started = performance.now();
      const response = await fixture.harness.runCommand({ command: "jev triage", pmRoot: fixture.pmRoot, options: { open: true, limit: "2", ...options } });
      assert.ok(isHostOutputSuppressed(response.result));
      const result = response.result.result as BacklogTriageSummary;
      assert.equal(result.selected, 2);
      assert.equal(result.failed, 0);
      console.log(JSON.stringify({ phase, requests: requests - countBefore, wall_ms: Math.round(performance.now() - started), ...result }));
      return result;
    };
    const dry = await run("batch-dry", {});
    assert.equal(dry.changed, 0);
    for (const item of (await fixture.pm.listAllComplete()).items) assert.equal((await fixture.pm.comments(item.id)).count, 0);
    await run("batch-apply", { apply: true });
    const countBefore = requests;
    assert.equal((await run("batch-reuse", { apply: true })).skipped, 2);
    assert.equal(requests, countBefore);
    await run("batch-refresh", { refresh: true });
    assert.equal(requests, 6);
    console.log("LIVE BATCH ACCEPTANCE: 2 synthetic items; 6 independent-state requests; receipt reuse made zero requests");
  } finally {
    restoreFetch();
    restoreLiveEnvironment(previousUrl, previousModel);
    fixture.dispose();
  }
});
