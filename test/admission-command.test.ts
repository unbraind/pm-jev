import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runAdmissionCommand } from "../admission-command.ts";
import { scenario, trackerSnapshot, withoutGit } from "./fixtures.ts";

/** Persist a minimal valid batch in the disposable tracker project. */
function admissionFile(cwd: string): string {
  const file = join(cwd, "batch.json");
  writeFileSync(file, JSON.stringify({ version: "pm-jev-admission/1", state: "Synthetic", questions: { ready: { type: "noul" } } }));
  return file;
}

test("admission CLI maps only its own stalled metadata deadline", async t => {
  await scenario(async (fixture, server) => {
    const file = admissionFile(fixture.cwd);
    const before = trackerSnapshot(fixture.pmRoot);
    server.setAdmissionReply(() => {});
    const timeout = AbortSignal.timeout;
    let deadline: AbortSignal;
    const clock = t.mock.method(AbortSignal, "timeout", () => { deadline = timeout(10); return deadline; });
    try {
      await t.test("own deadline produces a structured exit-2 refusal", async () => {
        const response = await withoutGit(fixture.cwd, () => fixture.harness.runCommand({ command: "jev admit", pmRoot: fixture.pmRoot, options: { batch: file } }));
        assert.equal(response.exitCode, 2);
        assert.deepEqual(response.result, { ok: false, exit_code: 2, inference_calls: 0, mutations: 0, refusal: { code: "metadata_unavailable", remedy: "Native Ollama metadata did not answer within the total deadline. Raise jev.total_deadline_ms in settings.json or restore the endpoint, then retry; no inference was submitted." } });
      });
      await t.test("unrelated failures retain identity even after the deadline expires", async () => {
        for (const error of [new Error("Synthetic failure"), new DOMException("Unrelated timeout", "TimeoutError"), new DOMException("Caller canceled", "AbortError"),
          ...["ETIMEDOUT", "ESOCKETTIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "ABORT_ERR"].map(code => Object.assign(new Error("Synthetic transport failure"), { code })), { code: "ETIMEDOUT" }]) {
          // Inject the failure at the transport's abort check, after the real fetch deadline expires.
          const abortCheck = t.mock.method(AbortSignal.prototype, "throwIfAborted", () => { throw error; });
          try {
            await assert.rejects(runAdmissionCommand({ command: "jev admit", pm_root: fixture.pmRoot, args: [], options: { batch: file }, global: {} }), caught => {
              assert.equal(caught, error); assert.equal(deadline.aborted, true); assert.notEqual(caught, deadline.reason); return true;
            });
          } finally { abortCheck.mock.restore(); }
        }
      });
      assert.equal(server.requests.length, 0);
      assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    } finally { clock.mock.restore(); }
  });
});
