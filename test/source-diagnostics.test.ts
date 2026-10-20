import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSource } from "../tracker-evaluation.ts";
import { ghInspectionFailure, redactedSourceLine, sourceFailureDetail } from "../source-diagnostics.ts";

/** Pin English tool diagnostics temporarily and restore the caller's locale even after an assertion fails. */
function withCLocale(run: () => void): void {
  const previous = process.env.LC_ALL;
  process.env.LC_ALL = "C";
  try { run(); } finally {
    if (previous === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = previous;
  }
}

/** Exercise a real bounded inspection process with an isolated executable and restore its environment. */
function withFailingTool(command: string, script: string, check: (error: Error) => void): void {
  const previousPath = process.env.PATH;
  const directory = mkdtempSync(join(tmpdir(), "jev-runtime-"));
  try {
    writeFileSync(join(directory, command), script, { mode: 0o755 });
    process.env.PATH = directory;
    assert.throws(() => inspectSource(command, [], directory), error => {
      assert.ok(error instanceof Error);
      check(error);
      return true;
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("real gh executables classify failures and show only the redacted first stderr line", () => {
  const bin = mkdtempSync(join(tmpdir(), "jev-gh-failures-"));
  const previous = process.env.PATH;
  try {
    process.env.PATH = bin;
    const cases = [
      ["gh: command not found", "unrecognized gh failure", "gh exited with status 127", 127],
      ["executable helper not found", "unrecognized gh failure", "gh exited with status 1", 1],
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

test("empty git repository reports rev-parse exit status and first stderr line", () => withCLocale(() => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-empty-git-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    assert.throws(() => inspectSource("git", ["rev-parse", "HEAD"], cwd), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /git rev-parse HEAD exited with status 128\. stderr: fatal: ambiguous argument 'HEAD'/);
      assert.doesNotMatch(error.message, /[Ii]nstall|Use '--' to separate/);
      return true;
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}));

test("git repository without origin reports get-url exit status and stderr", () => withCLocale(() => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-no-origin-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    assert.throws(() => inspectSource("git", ["remote", "get-url", "origin"], cwd), /git remote get-url origin exited with status 2\. stderr: error: No such remote 'origin'/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}));

test("git ls-tree missing tree path reports the actual command failure", () => withCLocale(() => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-missing-tree-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "--allow-empty", "-qm", "Synthetic empty tree"], { cwd });
    assert.throws(() => inspectSource("git", ["ls-tree", "HEAD:missing"], cwd), /git ls-tree HEAD:missing exited with status 128\. stderr: fatal: Not a valid object name HEAD:missing/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
}));

for (const command of ["git", "tar", "gh"]) {
  test(`${command} non-executable tool reports EACCES instead of installation guidance`, () => {
    const bin = mkdtempSync(join(tmpdir(), "jev-permission-"));
    const previous = process.env.PATH;
    try {
      writeFileSync(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
      process.env.PATH = bin;
      assert.throws(() => inspectSource(command, [], bin), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(`${command} could not start: permission denied (EACCES)`), error.message);
        assert.doesNotMatch(error.message, /[Ii]nstall|not authenticated/);
        return true;
      });
    } finally {
      if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test(`${command} missing tool reports not installed only for ENOENT`, () => {
    const bin = mkdtempSync(join(tmpdir(), "jev-missing-tool-"));
    const previous = process.env.PATH;
    try {
      process.env.PATH = bin;
      assert.throws(() => inspectSource(command, [], bin), new RegExp(`${command} not installed \\(ENOENT\\).*Install`));
    } finally {
      if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
      rmSync(bin, { recursive: true, force: true });
    }
  });
}

test("tar extraction errors report command exit status and first stderr line", () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-invalid-archive-"));
  try {
    assert.throws(() => inspectSource("tar", ["-xf", "-"], cwd, Buffer.from("not an archive")), /tar -xf - exited with status [1-9]\d*\. stderr: (?!\(empty\))\S[^\r\n]*/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("tool exits redact arguments and stderr and preserve empty stderr", () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-exit-detail-"));
  try {
    writeFileSync(join(cwd, "tool"), "#!/bin/sh\nprintf '%s\\n' 'token=synthetic-secret https://invalid.example/path' 'SECOND LINE SECRET' >&2\nexit 17\n", { mode: 0o755 });
    assert.throws(() => inspectSource(join(cwd, "tool"), ["password=synthetic-argument"], cwd), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /\[redacted-path\] \[redacted-credential\] exited with status 17\. stderr: \[redacted-credential\] \[redacted-url\]/);
      assert.doesNotMatch(error.message, /synthetic-secret|synthetic-argument|invalid.example|SECOND LINE/);
      return true;
    });
    writeFileSync(join(cwd, "tool"), "#!/bin/sh\nexit 17\n");
    assert.throws(() => inspectSource(join(cwd, "tool"), [], cwd), /exited with status 17\. stderr: \(empty\)/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("launch diagnostics handle EPERM other codes and absent details without install advice", () => {
  assert.match(sourceFailureDetail("git", "EPERM", null, ""), /permission denied \(EPERM\)/);
  assert.equal(sourceFailureDetail("git", undefined, null, ""), "git could not start (no launch details available)");
  assert.equal(sourceFailureDetail("tar", "EIO", undefined, ""), "tar could not start (EIO)");
  assert.match(ghInspectionFailure("public/repo", "EPERM", null, "gh auth login").message, /gh: permission\/launch failure.*permission denied \(EPERM\)/);
  assert.match(ghInspectionFailure("public/repo", undefined, undefined, "").message, /gh could not start \(no launch details available\)/);
});

test("diagnostics redact local identities and terminal controls and classify timeouts without stderr", () => {
  const posixPath = ["", "home", "synthetic", "file"].join("/");
  const windowsPath = ["C:", "Users", "synthetic", "file"].join("\\");
  assert.equal(redactedSourceLine(`\x1b[31mHTTP 401\x1b[0m ${posixPath} ${windowsPath} person@example.test\t\nsecret second line`), "HTTP 401 [redacted-path] [redacted-path] [redacted-email]");
  assert.match(ghInspectionFailure("unbraind/pm-alpha", "ETIMEDOUT", null, "").message, /gh: runtime failure.*gh timed out and was terminated/);
  assert.equal(redactedSourceLine("x".repeat(600)).length, 500);
});

test("runtime diagnostics distinguish time and output limits from signals and launch failures", () => {
  for (const [code, expected] of [
    ["ETIMEDOUT", /timed out and was terminated \(ETIMEDOUT\).*time limit/],
    ["ENOBUFS", /output exceeded the inspection buffer.*\(ENOBUFS\).*output limit/],
  ] as const) {
    const detail = sourceFailureDetail("git archive HEAD", code, null, "", "SIGTERM");
    assert.match(detail, expected);
    assert.doesNotMatch(detail, /could not start|[Ii]nstall/);
    // Partial stderr from a terminated command must not override the known runtime failure.
    const error = ghInspectionFailure("unbraind/pm-alpha", code, null, "gh auth login token=synthetic-secret", "SIGTERM");
    assert.match(error.message, /gh: runtime failure/);
    assert.match(error.message, expected);
    assert.doesNotMatch(error.message, /could not start|not authenticated|synthetic-secret/);
  }
  assert.equal(sourceFailureDetail("tar", undefined, null, "", "SIGKILL"), "tar was terminated by SIGKILL");
  assert.equal(sourceFailureDetail("tar", undefined, null, "", "token=synthetic-secret"), "tar was terminated by [redacted-credential]");
});

for (const command of ["git", "tar", "gh"]) {
  test(`real ${command} signal termination survives the inspection boundary`, () => {
    withFailingTool(command, "#!/bin/sh\nkill -TERM $$\n", error => {
      assert.match(error.message, new RegExp(`${command} was terminated by SIGTERM`));
      assert.doesNotMatch(error.message, /could not start|[Ii]nstall/);
    });
  });
}

for (const command of ["git", "gh"]) {
  test(`real ${command} output overflow reports the inspection buffer limit`, () => {
    withFailingTool(command, `#!${process.execPath}\nprocess.stdout.write(Buffer.alloc(65 * 1024 * 1024));\n`, error => {
      assert.match(error.message, new RegExp(`${command} output exceeded the inspection buffer.*ENOBUFS`));
      assert.doesNotMatch(error.message, /could not start|[Ii]nstall/);
    });
  });
}
