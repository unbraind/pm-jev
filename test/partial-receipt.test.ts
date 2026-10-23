import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ReceiptRun, ReceiptRefusal, withReceipt } from "../index.ts";
import type { PartialReceipt } from "../index.ts";
import { receiptOptions } from "../partial-receipt.ts";
import { createPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { project } from "./fixtures.ts";

/** Extract the typed refusal envelope while checking durable byte equality. */
function interrupted(value: unknown, file: string): PartialReceipt {
  const result = value as { ok: boolean; exit_code: number; receipt: PartialReceipt };
  assert.equal(result.ok, false); assert.equal(result.exit_code, 2);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), result.receipt);
  return result.receipt;
}

test("durable receipts count pending attempts, unknown usage, budgets and prior-run reporting", async () => {
  const fixture = await project();
  try {
    const file = join(fixture.cwd, "receipt.json");
    const report = await withReceipt("evaluation", { file, maxCalls: 2 }, async run => {
      run.identify("a".repeat(64), "fixture-model");
      await run.call(async () => ({ usage: { input_tokens: 20, output_tokens: 3 } }));
      run.evidence({ observations: [] });
      run.checkpoint("hash-one", { observations: [{ example_sha256: "hash-one" }] });
      await run.call(async () => {
        const pending = JSON.parse(readFileSync(file, "utf8")) as PartialReceipt;
        assert.equal(pending.attempted_calls, 2); assert.equal(pending.completed_calls, 1);
        assert.equal(pending.tokens.input, null);
        throw new Error("PRIVATE PROVIDER TEXT mentions deadline as advice");
      });
    });
    const receipt = interrupted(report, file);
    assert.equal(receipt.reason, "provider_error"); assert.equal(receipt.model_calls, 2); assert.equal(receipt.inference_calls, 2);
    assert.equal(receipt.completed_calls, 1); assert.deepEqual(receipt.completed_cases, ["hash-one"]);
    assert.equal(receipt.tokens.known_input, 20); assert.equal(receipt.tokens.known_output, 3); assert.equal(receipt.tokens.unknown_calls, 1);
    assert.equal(receipt.cost.amount, null); assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.doesNotMatch(JSON.stringify(receipt), /PRIVATE|receipt.json/);
    const again = await withReceipt("evaluation", { file }, async () => assert.fail("must not repeat inference"));
    assert.equal((again as { refusal: { code: string } }).refusal.code, "receipt_exists");
    const budgetFile = join(fixture.cwd, "budget.json");
    const budget = await withReceipt("replay", { file: budgetFile, maxCalls: 1 }, async run => {
      await run.call(async () => ({ usage: { input_tokens: null, output_tokens: 4 } }), false);
      await run.call(async () => assert.fail("budget prohibits second request"));
    });
    const limited = interrupted(budget, budgetFile);
    assert.equal(limited.reason, "budget_exhausted"); assert.equal(limited.model_calls, 0); assert.equal(limited.inference_calls, 1);
    assert.equal(limited.tokens.input, null); assert.equal(limited.tokens.output, 4);
    const other = new ReceiptRun("replay", { file: join(fixture.cwd, "nullable.json") });
    await other.call(async () => ({ usage: { input_tokens: 2, output_tokens: null } }));
    assert.equal(other.receipt.tokens.output, null); assert.equal(other.receipt.tokens.input, 2);
  } finally { fixture.dispose(); }
});

test("scoped SIGINT, external cancellation and deadlines persist before transport unwinds", async () => {
  const fixture = await project();
  try {
    for (const mode of ["SIGINT", "signal", "timeout", "elapsed", "already", "postcall"] as const) {
      const file = join(fixture.cwd, `${mode}.json`);
      const controller = new AbortController();
      if (mode === "already") controller.abort();
      const keepAlive = setTimeout(() => {}, 10000);
      try {
        const result = await withReceipt("replay", { file, signal: controller.signal, ...(mode === "timeout" || mode === "elapsed" ? { deadlineMs: mode === "timeout" ? 5000 : 2 } : {}) }, async run => {
          if (mode === "elapsed") await new Promise(resolve => { setTimeout(resolve, 5); });
          if (mode === "postcall") { controller.abort(); return; }
          await run.call(async () => {
            if (mode === "SIGINT") process.emit("SIGINT");
            if (mode === "signal") controller.abort();
            return new Promise<never>(() => {});
          });
        });
        const receipt = interrupted(result, file);
        assert.equal(receipt.reason, mode === "timeout" || mode === "elapsed" ? "timeout" : mode === "SIGINT" ? "sigint" : "aborted");
        assert.equal(receipt.attempted_calls, mode === "already" || mode === "elapsed" || mode === "postcall" ? 0 : 1);
        assert.equal(receipt.completed_calls, 0);
      } finally { clearTimeout(keepAlive); }
    }
  } finally { fixture.dispose(); }
});

test("receipt option validation, storage refusals and crash checkpoints remain actionable", async () => {
  const fixture = await project();
  try {
    const base = join(fixture.cwd, "data");
    assert.equal(receiptOptions({ "max-calls": "2", run_deadline_ms: "3", receipt: base }, fixture.cwd, "replay").maxCalls, 2);
    assert.ok(receiptOptions({}, fixture.cwd, "evaluation").file.includes(".jev-receipts"));
    assert.equal(receiptOptions({ receipt: " " }, fixture.cwd, "replay").file, "");
    for (const options of [{ file: " " }, { file: base, maxCalls: 0 }, { file: base, deadlineMs: 1.5 }]) {
      const result = await withReceipt("replay", options, async () => assert.fail());
      assert.equal((result as { refusal: { code: string } }).refusal.code, "invalid_receipt_options");
    }
    const run = new ReceiptRun("replay", { file: base });
    const prior = await withReceipt("replay", { file: base }, async () => assert.fail());
    assert.equal((prior as { receipt: PartialReceipt }).receipt.reason, "process_interrupted");
    writeFileSync(base, "{}");
    assert.throws(() => new ReceiptRun("replay", { file: base }), ReceiptRefusal);
    const result = await withReceipt("replay", { file: join(base, "child") }, async () => assert.fail());
    assert.equal((result as { refusal: { code: string } }).refusal.code, "receipt_io");
    mkdirSync(`${base}.next`);
    assert.throws(() => run.save(), ReceiptRefusal);
    const failing = await withReceipt("replay", { file: join(fixture.cwd, "fail.json") }, async () => { throw new Error("secret"); });
    assert.equal((failing as { receipt: PartialReceipt }).receipt.reason, "provider_error");
    assert.equal(await withReceipt("replay", { file: join(fixture.cwd, "ok.json") }, async () => "complete"), "complete");
    const io = await withReceipt("replay", { file: join(fixture.cwd, "io.json") }, async () => { throw new ReceiptRefusal("receipt_io", "Restore storage"); });
    assert.equal((io as { refusal: { code: string } }).refusal.code, "receipt_io");
  } finally { fixture.dispose(); }
});


test("typed endpoint timeouts and storage failures retain actionable accounting", async () => {
  const fixture = await project();
  try {
    for (const [index, failure] of [createPmCliExpectedError("opaque", { context: { code: "jev_timeout" } }), createPmCliExpectedError("opaque", { context: { code: "jev_deadline_exceeded" } }), Object.assign(new Error("opaque"), { name: "TimeoutError" })].entries()) {
      const result = await withReceipt("evaluation", { file: join(fixture.cwd, `timeout-${index}.json`) }, async run => { await run.call(async () => { throw failure; }); });
      assert.equal((result as { receipt: PartialReceipt }).receipt.reason, "timeout");
    }
    const timeoutSignal = new AbortController(); timeoutSignal.abort(Object.assign(new Error("opaque"), { name: "TimeoutError" }));
    const externalTimeout = await withReceipt("replay", { file: join(fixture.cwd, "external-timeout.json"), signal: timeoutSignal.signal }, async run => { await run.call(async () => assert.fail()); });
    assert.equal((externalTimeout as { receipt: PartialReceipt }).receipt.reason, "timeout");
    const postCall = await withReceipt("replay", { file: join(fixture.cwd, "post-call-timeout.json") }, async () => { throw Object.assign(new Error("opaque"), { name: "TimeoutError" }); });
    assert.equal((postCall as { receipt: PartialReceipt }).receipt.reason, "timeout");
    await assert.rejects(withReceipt("replay", { get file(): string { throw new Error("unexpected option getter"); } }, async () => assert.fail()), /unexpected option getter/);
    const file = join(fixture.cwd, "io-signal.json");
    const result = await withReceipt("replay", { file }, async run => {
      mkdirSync(`${file}.next`);
      process.emit("SIGINT");
      await run.call(async () => assert.fail());
    });
    assert.equal((result as { refusal: { code: string } }).refusal.code, "receipt_io");
    const invalid = await withReceipt("replay", { file: null as unknown as string }, async () => assert.fail());
    assert.equal((invalid as { refusal: { code: string } }).refusal.code, "invalid_receipt_options");
  } finally { fixture.dispose(); }
});
