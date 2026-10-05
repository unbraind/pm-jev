import assert from "node:assert/strict";
import test from "node:test";
import "../scripts/lint.ts";
import "../scripts/duplication-gate.ts";

test("the lint and duplication launchers execute the canonical gates successfully", () => {
  assert.equal(process.exitCode ?? 0, 0);
});
