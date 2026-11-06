import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { AdmissionRefusal, admitDecision, admitDecisionBatch, createJevClient, resolveJevEndpoint, runDecision, translateDecisionError, validateAdmissionReceipt } from "../index.ts";
import type { AdmissionRefusalCode } from "../index.ts";
import { admissionMetadata } from "./admission-fixtures.ts";
import { scenario, withoutGit } from "./fixtures.ts";

const guide = readFileSync(new URL("../docs/decision-admission.md", import.meta.url), "utf8");
const questions = { route: { type: "choice" as const, criteria: { keep: "Keep", change: "Change" } } };

test("admission guide scopes refusal guarantees to each decision and preserves earlier backlog changes", () => {
  assert.match(guide, /Every refusal and\s+overflow happens before inference or tracker mutation for that individual\s+decision/);
  assert.match(guide, /During `pm jev triage --open --apply`, changes already applied to\s+earlier backlog items remain when a later decision is refused/);
  assert.match(guide, /the session is\s+not rolled back/);
});

/** Capture a real refusal without replacing the admission or tracker implementation. */
async function refused(run: () => unknown): Promise<AdmissionRefusal> {
  try { await run(); } catch (error) { assert.ok(error instanceof AdmissionRefusal); return error; }
  throw new Error("Expected an admission refusal");
}

test("admission guide limits refits to compatible calibration identities and represented candidate counts", () => {
  assert.match(guide, /refit with the current request builder is required to use fitted\s+temperatures and thresholds/);
  assert.match(guide, /model digest, fixed question semantics, exemplar setting, or candidate count/);
  assert.match(guide, /Refitting is optional when\s+using the uncalibrated fallback policy, or when a compatible fit already exists/);
  assert.match(guide, /changing candidate identities or scores alone does not require a refit/);
  assert.match(guide, /refit covers only candidate counts represented in the calibration split/);
  assert.match(guide, /at most eight candidates \(plus `none`\)/);
  assert.match(guide, /more than eight candidates still use uncalibrated probabilities/);
  assert.match(guide, /fitted threshold may remain\s+unqualified \(`null`\) if calibration or held-out precision evidence is\s+insufficient/);
});

test("admission guide refusal table matches every declared code, runtime remedy and host outcome", async () => {
  const schema = readFileSync(new URL("../admission-schema.ts", import.meta.url), "utf8");
  const declaration = schema.match(/export type AdmissionRefusalCode = ([^;]+);/);
  assert.ok(declaration);
  const codes = [...declaration[1].matchAll(/"([a-z_]+)"/g)].map(match => match[1]).sort();
  const rows = guide.split("\n").filter(line => /^\| `[a-z_]+` \|/.test(line)).map(line => line.split(" | ").map(cell => cell.replace(/^\| | \|$/g, "").replaceAll("`", "")));
  assert.deepEqual(rows.map(row => row[0]).sort(), codes);
  await scenario(async (fixture, server) => withoutGit(fixture.cwd, async () => {
    const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
    const refusals = new Map<AdmissionRefusalCode, AdmissionRefusal>();
    const invalid = await refused(() => admitDecisionBatch(config, {})); refusals.set(invalid.code, invalid);
    const unsupported = await refused(() => admitDecision({ ...config, provider: "typesafe" }, "Synthetic", questions)); refusals.set(unsupported.code, unsupported);
    const unsupportedRow = rows.find(row => row[0] === "unsupported_model"); assert.ok(unsupportedRow);
    let inventory: unknown = {};
    server.setAdmissionReply((request, response) => response.end(JSON.stringify(request.url === "/api/tags" ? inventory : admissionMetadata())));
    for (const entry of [
      { model: "/tev1", inventory: { models: [] } },
      { model: config.model, inventory: {} },
      { model: config.model, inventory: { models: [] } },
      { model: config.model, inventory: { models: [{ name: config.model }] } },
      { model: config.model, inventory: { models: [{ name: config.model, digest: "bad" }] } },
    ]) {
      inventory = entry.inventory;
      const error = await refused(() => admitDecision({ ...config, model: entry.model }, "Synthetic", questions));
      assert.equal(error.code, "unsupported_model");
      assert.ok(error.remedy.includes(unsupportedRow[4]), "Every native identity refusal retains the documented recovery");
    }
    assert.equal(server.admissionRequests.some(request => request.path === "/api/show"), false);
    assert.equal(server.requests.length, 0);
    inventory = { models: [{ name: config.model, digest: "a".repeat(64) }] };
    const admitted = await admitDecision(config, "Synthetic", questions);
    const report = await refused(() => validateAdmissionReceipt({ ...admitted.receipt, questions: 0 })); refusals.set(report.code, report);
    const large = { route: { type: "choice" as const, criteria: Object.fromEntries(Array.from({ length: 27 }, (_, i) => [`option-${i}`, null])) } };
    const options = await refused(() => admitDecision(config, "Synthetic", large)); refusals.set(options.code, options);
    server.setAdmissionReply((_, response) => response.end(JSON.stringify({ models: [{ name: config.model, digest: "a".repeat(64) }, { name: config.model.toUpperCase(), digest: "b".repeat(64) }] })));
    const ambiguous = await refused(() => admitDecision(config, "Synthetic", questions)); refusals.set(ambiguous.code, ambiguous);
    server.setAdmissionReply((_, response) => { response.statusCode = 503; response.end("unavailable"); });
    const metadata = await refused(() => admitDecision(config, "Synthetic", questions)); refusals.set(metadata.code, metadata);
    // The reserved code has no producer; verify the public mapper still preserves it.
    const reserved = rows.find(row => row[0] === "context_exceeded"); assert.ok(reserved);
    assert.equal(reserved[4], "Reserved code, not emitted by current admission; a supplied refusal preserves its remedy in context.required.");
    for (const file of ["../admission-schema.ts", "../decision-admission.ts", "../admission-command.ts", "../index.ts"]) {
      assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /new AdmissionRefusal\("context_exceeded"/);
    }
    refusals.set("context_exceeded", new AdmissionRefusal("context_exceeded", "Synthetic caller remedy"));
    for (const row of rows) {
      const error = refusals.get(row[0] as AdmissionRefusalCode); assert.ok(error);
      const mapped = translateDecisionError(error, config);
      assert.ok(isPmCliExpectedError(mapped)); assert.equal(mapped instanceof AdmissionRefusal, false);
      assert.equal(mapped.context.code, row[1]); assert.equal(String(mapped.exitCode), row[2]);
      assert.equal(row[3], "none"); assert.equal(mapped.context.details, undefined);
      assert.equal(mapped.context.required, error.remedy);
      if (error.code !== "context_exceeded") assert.ok(error.remedy.includes(row[4]), `${error.code}: documented remedy must match runtime`);
    }
    // Actual runDecision must use the same mapping rather than leaking the typed refusal.
    server.setAdmissionReply((request, response) => response.end(JSON.stringify(request.url === "/api/tags" ? { models: [{ name: config.model, digest: "a".repeat(64) }] } : admissionMetadata())));
    await assert.rejects(runDecision(createJevClient({ config, hostedBlocked: null }, {}), config, "Synthetic", large), error => {
      assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "jev_admission_option_limit_exceeded");
      assert.equal(error.exitCode, 2); assert.equal(error.context.required, options.remedy); return true;
    });
    server.setAdmissionReply((request, response) => response.end(JSON.stringify(request.url === "/api/tags" ? { models: [{ name: config.model, digest: "b".repeat(64) }] } : admissionMetadata(2))));
    const overflow = await admitDecision(config, "Synthetic", questions); assert.equal(overflow.receipt.ok, false);
    await assert.rejects(runDecision(createJevClient({ config, hostedBlocked: null }, {}), config, "Synthetic", questions), error => {
      assert.ok(isPmCliExpectedError(error)); assert.equal(error.context.code, "jev_context_exceeded"); assert.equal(error.exitCode, 2);
      assert.deepEqual(error.context.details?.admission, overflow.receipt); return true;
    });
    assert.match(guide, /Direct admission returns `receipt.ok: false`; `jev admit`\s+returns that receipt with exit 1 and a `remedy`/);
    assert.match(guide, /`jev_context_exceeded` with exit 2 and the same receipt in\s+`context.details.admission`/);
    assert.match(guide, /`jev admit` CLI returns exit 2/);
    assert.equal(server.requests.length, 0);
  }));
});
