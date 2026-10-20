import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSource } from "../tracker-evaluation.ts";
import { ghInspectionFailure, redactedSourceLine } from "../source-diagnostics.ts";

test("real gh executables classify failures and show only the redacted first stderr line", () => {
  const bin = mkdtempSync(join(tmpdir(), "jev-gh-failures-"));
  const previous = process.env.PATH;
  try {
    process.env.PATH = bin;
    const cases = [
      ["gh: command not found", "gh missing", "Install GitHub CLI", 127],
      ["To get started with GitHub CLI, please run: gh auth login", "not authenticated", "gh auth login", 1],
      ["GraphQL: Could not resolve to a Repository with the name 'unbraind/pm-alpha'.", "repository not found/private", "public visibility", 1],
      ["gh: Not Found (HTTP 404)", "repository not found/private", "public visibility", 1],
      ["HTTP 403: API rate limit exceeded", "rate-limited", "gh api rate_limit", 1],
      ["error connecting to api.github.com", "network", "DNS, proxy, TLS and firewall", 1],
      ["unexpected service response", "unrecognized gh failure", "Run gh repo view", 1],
    ] as const;
    for (const [stderr, kind, fix, status] of cases) {
      writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' '${stderr.replaceAll("'", "'\\''")} Bearer synthetic-secret token=synthetic-token ghp_synthetictoken https://user:pass@invalid.example/?key=secret' 'SECOND LINE SECRET' >&2\nexit ${status}\n`, { mode: 0o755 });
      assert.throws(() => inspectSource("gh", ["repo", "view", "unbraind/pm-alpha", "--json", "visibility"], bin), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`gh: ${kind}`), error.message);
        assert.ok(error.message.includes(fix));
        assert.ok(error.message.includes("unbraind/pm-alpha"));
        assert.ok(error.message.includes("--from <tracker>"));
        assert.ok(error.message.includes("gh stderr:"));
        assert.ok(error.message.includes("[redacted-token]"));
        assert.ok(!/synthetic-secret|synthetic-token|synthetictoken|user:pass|SECOND LINE|invalid.example/.test(error.message));
        return true;
      });
    }
    rmSync(join(bin, "gh"));
    assert.throws(() => inspectSource("gh", [], bin), /requested repository \(gh: gh missing\).*gh stderr: \(empty\)/);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("diagnostics redact local identities and terminal controls and classify timeouts without stderr", () => {
  const posixPath = ["", "home", "synthetic", "file"].join("/");
  const windowsPath = ["C:", "Users", "synthetic", "file"].join("\\");
  assert.equal(redactedSourceLine(`\x1b[31mHTTP 401\x1b[0m ${posixPath} ${windowsPath} person@example.test\t\nsecret second line`), "HTTP 401 [redacted-path] [redacted-path] [redacted-email]");
  assert.match(ghInspectionFailure("unbraind/pm-alpha", "ETIMEDOUT", null, "").message, /gh: network/);
  assert.equal(redactedSourceLine("x".repeat(600)).length, 500);
});
