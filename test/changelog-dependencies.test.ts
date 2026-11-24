import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("every changelog entry point includes published dependency updates", () => {
  const { scripts } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };

  for (const name of ["changelog", "changelog:full", "changelog:check", "release:notes"]) {
    assert.match(scripts[name], /^pm-changelog\s/, name);
    assert.match(scripts[name], /(?:^|\s)--dependency-updates(?:\s|$)/, name);
  }
});
