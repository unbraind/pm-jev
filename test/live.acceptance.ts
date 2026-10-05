import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { project } from "./fixtures.ts";
import type { TriageDecision, DedupeDecision, AskDecision, GateDecision } from "../index.ts";

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
    assert.ok(["Bug", "Issue"].includes(triage.proposals.type.value));
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
  } finally { if (previousUrl === undefined) delete process.env.PM_JEV_BASE_URL; else process.env.PM_JEV_BASE_URL = previousUrl; if (previousModel === undefined) delete process.env.PM_JEV_MODEL; else process.env.PM_JEV_MODEL = previousModel; fixture.dispose(); }
});
