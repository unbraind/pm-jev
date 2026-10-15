/** Native glob discovery must preserve the documentation scanner's authored scope. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { auditFunctionDocs } from "../scripts/function-docs.ts";

test("native glob scanner awaits TS/TSX discovery and excludes generated, test and hidden paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "function-docs-glob-"));
  try {
    writeFileSync(join(root, "index.ts"), "/** Compute the documented fixture value. */\nexport function documented() { return 1; }\n");
    writeFileSync(join(root, "component.tsx"), "const component = () => <div />;\n");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "source.ts"), "function internal() { return 1; }\n");
    for (const directory of ["node_modules", "dist", "dist-test", "coverage", "test", "tests", ".agents", ".git", ".hidden"]) {
      mkdirSync(join(root, directory));
      writeFileSync(join(root, directory, "ignored.ts"), "this is not valid TypeScript {{{");
    }
    writeFileSync(join(root, ".ignored.ts"), "this is not valid TypeScript {{{");
    // A directory whose name matches the pattern must be skipped, not read as a file.
    mkdirSync(join(root, "fixtures.ts"));
    writeFileSync(join(root, "fixtures.ts", "inner.ts"), "function inner() { return 1; }\n");
    const pending = auditFunctionDocs(root);
    assert.ok(pending instanceof Promise, "native asynchronous discovery must be awaited");
    const report = await pending;
    assert.equal(report.checked, 5);
    assert.deepEqual(report.violations.map(violation => violation.file.replaceAll("\\", "/")).sort(), ["component.tsx", "fixtures.ts/inner.ts", "nested/source.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
