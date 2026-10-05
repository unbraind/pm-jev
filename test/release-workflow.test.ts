import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

/** The release workflow source, read once and asserted against as text. */
const workflow = readFileSync(
  resolve(import.meta.dirname, "../.github/workflows/release.yml"),
  "utf-8"
);

/**
 * Locate a named workflow step so tests can assert on ordering between steps.
 *
 * Offsets are taken against the raw source rather than a comment-stripped copy:
 * removing text shifts every index after it, which would silently corrupt the
 * ordering comparisons these offsets exist to support.
 *
 * @param name - The exact `- name:` value of the step.
 * @returns The character offset of that step within the workflow source.
 */
function stepIndex(name: string): number {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `^[ \\t]*-[ \\t]+name:[ \\t]+${escapedName}[ \\t]*(?:#[^\\r\\n]*)?$`,
    "m"
  ).exec(workflow);
  assert.ok(match, `release workflow should contain the exact ${name} step`);
  return match.index;
}

test("npm publication authenticates by OIDC, with no stored token anywhere in the workflow", () => {
  // A stored npm token is what silently broke the whole fleet: it was rejected
  // from 2026-08-17 onward, every release job failed at the publish step with a
  // registry E404 on PUT, and main kept bumping the version regardless. Trusted
  // publishing removes the credential that can expire, so this test fails closed
  // if a token is ever reintroduced.
  const withoutComments = workflow.replace(/^[ \t]*#[^\r\n]*$/gm, "");

  assert.doesNotMatch(withoutComments, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(withoutComments, /NPM_TOKEN/);
  assert.doesNotMatch(withoutComments, /secrets\.NPM/);
});


/** Strip whole-line comments so a commented-out directive can never satisfy an
 * assertion that the directive is present. Applied to a slice, never used to
 * compute offsets — removing text shifts every index after it. */
function executable(source: string): string {
  return source.replace(/^[ \t]*#[^\r\n]*$/gm, "");
}

/**
 * Strip comments and the credential-scrub step's own deletion expressions.
 *
 * The scrub names every credential it removes, so a naive search for those names
 * matches the very code that deletes them. Removing `sed` deletion expressions
 * leaves only places a credential could actually be *configured*.
 *
 * @param source - Workflow source to filter.
 * @returns Source with comments and scrub deletion expressions removed.
 */
function withoutCredentialScrub(source: string): string {
  return executable(source)
    // Only the deletion fragments, never a whole line: a line such as
    // `sed -i'' -e '/_authToken/d' "$f"; printf '…_authToken=%s' "$S" >> "$f"`
    // deletes a credential and then restores one, and dropping the line would
    // hide the restore along with the deletion.
    .replace(/-e\s+'\/[^']*\/d'/g, "")
    .replace(/\bsed\s+-i(?:''|"")?/g, "");
}

/**
 * Extract the source of one workflow step, from its `- name:` line to the next.
 *
 * @param name - The exact `- name:` value of the step.
 * @returns That step's source alone, excluding neighbouring steps.
 */
function stepSource(name: string): string {
  const start = stepIndex(name);
  // Derive the boundary from the indentation of the step actually matched.
  // A fixed `^ {6}- name:` disagrees with stepIndex, which accepts any
  // indentation: if the workflow were reindented, the search would return -1,
  // stepSource would return the whole rest of the file, and every scoped
  // assertion would silently widen instead of failing.
  // stepIndex returns the offset of the line start, so the step's indentation is
  // the run of spaces at that offset.
  const indent = /^[ \t]*/.exec(workflow.slice(start))?.[0].length ?? 0;
  const rest = workflow.slice(start + 1);
  const next = rest.search(new RegExp(`^ {${indent}}- name:`, "m"));
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

/**
 * Resolve the permissions block that actually applies to the `release` job.
 *
 * A job-level `permissions:` block REPLACES the workflow-level one for that job
 * rather than merging with it, so reading whichever is nearest is the only
 * answer that matches GitHub's semantics.
 *
 * @returns The effective permissions source for the release job.
 */
function effectiveReleasePermissions(): string {
  const job = executable(jobSource("release"));
  const jobsAt = workflow.indexOf("jobs:");

  // `permissions: { id-token: write }` - a flow mapping is still an override.
  const inline = /^ {4}permissions:[ \t]*(\{[^}]*\})[ \t]*$/m.exec(job);
  if (inline) return inline[1];

  // `permissions: read-all` and friends are overrides that grant no id-token.
  const scalar = /^ {4}permissions:[ \t]*([A-Za-z][\w-]*)[ \t]*$/m.exec(job);
  if (scalar) return scalar[1];

  const jobBlock = /^ {4}permissions:\n((?:[ \t]*\n| {6}\S[^\n]*\n)+)/m.exec(job);
  if (jobBlock) return jobBlock[1];

  const topBlock = /^permissions:\n((?: {2}\S[^\n]*\n)+)/m.exec(
    executable(workflow.slice(0, jobsAt))
  );
  assert.ok(topBlock, "release workflow should declare permissions the release job inherits");
  return topBlock[1];
}

test("the release job effectively holds id-token: write, and no comment can stand in for it", () => {
  // Matching /id-token: write/ against the whole file is satisfied by a comment
  // reading "# id-token: write", and by a permission on some other job. Neither
  // grants this job anything, and OIDC publication fails closed without it.
  assert.match(effectiveReleasePermissions(), /(?:^|[{,\s])id-token:\s*write\s*(?:#[^\n]*)?$/m);
});

test("the npm upgrade cannot be skipped and fails closed on the version it actually gets", () => {
  // Asserting that the install command appears is not enough: the step can be
  // disabled with `if: ${{ false }}` or its failure swallowed with `|| true`,
  // and npm 10 stays active while the assertion still passes. The workflow
  // checks the EFFECTIVE version and exits non-zero, and that is what is
  // asserted here.
  const step = executable(stepSource("Use an npm that supports trusted publishing"));

  // Pinned exactly, not a caret range: a privileged publish job that resolves a
  // different npm on every run is not reproducible, and an unreviewed 11.x could
  // change publishing behaviour between two identical release commits.
  assert.match(step, /npm install -g npm@11\.19\.0(?!\S)/);
  assert.doesNotMatch(step, /npm install -g npm@[\^~]/);
  assert.doesNotMatch(step, /^ *if:/m);
  assert.match(step, /npm --version/);
  assert.match(step, /sort -V/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(step, /\|\|\s*true/);
  assert.match(step, /set -euo pipefail/);
});

test("nothing between the upgrade and the publish step can put an older npm back", () => {
  // Keeping the 11.x upgrade and then installing npm 10 later leaves trusted
  // publishing broken while every check above still passes.
  const upgrade = stepIndex("Use an npm that supports trusted publishing");
  const publish = stepIndex("Publish npm package");
  assert.ok(upgrade < publish, "npm must be upgraded before the publish step runs");

  // Through the END of the publish step, not merely up to its start: the
  // runtime version gate is the publish step's first command, so an install
  // placed after it and before `npm publish` would satisfy every check while
  // still publishing with a downgraded npm.
  const publishEnd = publish + stepSource("Publish npm package").length;
  const between = executable(workflow.slice(upgrade, publishEnd));
  const installs = [
    ...between.matchAll(/npm\s+(?:install|i|add)\s+(?:-g|--global)\s+npm@\S+/g),
    ...between.matchAll(/npm\s+(?:-g|--global)\s+(?:install|i|add)\s+npm@\S+/g),
  ];
  assert.equal(
    installs.length,
    1,
    `exactly one global npm install may appear before publication completes, found ${installs.length}`
  );
  assert.doesNotMatch(between, /corepack\s+(?:prepare|use)\s+npm@/);
  assert.doesNotMatch(between, /uses:\s*actions\/setup-node/);
  // Prepending a directory to GITHUB_PATH changes which npm later steps resolve
  // without installing anything, so it defeats an install-time check entirely.
  // The publish step re-verifies at runtime, but rejecting the write statically
  // means the run fails at review time rather than at publication time.
  assert.doesNotMatch(between, /GITHUB_PATH/);
});

/** Locate one job without widening assertions to another job's privileges. */
function jobSource(name: string): string {
  const match = new RegExp(`^ {2}${name}:`, "m").exec(workflow);
  assert.ok(match, `workflow should contain job ${name}`);
  const rest = workflow.slice(match.index + match[0].length);
  const next = rest.search(/^ {2}[A-Za-z][\w-]*:/m);
  return next === -1 ? rest : rest.slice(0, next);
}

/** Find workflow expressions in inline, literal and folded shell scripts. */
function runInterpolations(source: string): string[] {
  const offenders: string[] = [];
  let inRunBlock = false;
  for (const line of executable(source).split("\n")) {
    if (/^ {8}run: [|>]/.test(line)) {
      inRunBlock = true;
      continue;
    }
    if (/^ {8}run: /.test(line)) {
      inRunBlock = false;
      if (line.includes("${{")) offenders.push(line.trim());
      continue;
    }
    if (/^ {0,8}\S/.test(line)) inRunBlock = false;
    if (inRunBlock && line.includes("${{")) offenders.push(line.trim());
  }
  return offenders;
}

test("no run script in any release job interpolates workflow context", () => {
  assert.deepEqual(runInterpolations(workflow), []);
});

test("interpolation guard scans literal and folded scalars with modifiers", () => {
  for (const scalar of ["|", "|-", "|+", ">", ">-", ">+"]) {
    assert.deepEqual(runInterpolations(`        run: ${scalar}\n          echo \${{ github.event.title }}\n        env:\n          SAFE: \${{ github.event.title }}`), ["echo ${{ github.event.title }}"]);
  }
  assert.deepEqual(runInterpolations('        run: echo ${{ github.event.title }}'), ['run: echo ${{ github.event.title }}']);
  assert.deepEqual(runInterpolations('        run: >-\n          echo "$SAFE"\n        env:\n          SAFE: ${{ github.event.title }}'), []);
});

test("no registry credential is configured, under any name or mechanism", () => {
  // Rejecting three literal token names is not enough: the credential can come
  // back as `secrets.PUBLISH_TOKEN` piped into an .npmrc `_authToken` line, or
  // through `npm login`, none of which mention NODE_AUTH_TOKEN. What matters is
  // that the publish step reaches the registry with no stored credential at all.
  const source = withoutCredentialScrub(workflow);

  // npm accepts a registry credential under several names, and rejecting only
  // the token spelling leaves the others open: `_auth` is basic auth,
  // `username`/`_password` is the legacy pair, and `certfile`/`keyfile` is mTLS.
  // Any one of them restores a stored credential the OIDC migration removed.
  for (const key of ["_authToken", "_auth", "username", "_password", "certfile", "keyfile"]) {
    assert.doesNotMatch(
      source,
      new RegExp(`${key}\\s*[=:]`),
      `release workflow must not configure the npm credential '${key}'`
    );
  }

  assert.doesNotMatch(source, /npm\s+(?:config\s+)?set\s+["']?\/\//i);
  assert.doesNotMatch(source, /npm\s+login/i);
  assert.doesNotMatch(source, /always-auth/i);
  // `npm config set //registry.npmjs.org/:_authToken value` separates key and
  // value with a space rather than `=`, which the key-plus-`=` checks miss.
  assert.doesNotMatch(source, /:(?:_authToken|_auth|username|_password|certfile|keyfile)\s+\S/i);

  // A GLOBAL credential needs no registry scope and no `=`:
  // `npm config set _auth <value>` configures legacy authentication that npm
  // honours, while every scoped and delimited check above passes.
  // `(?:--\S+\s+)*` matters: `npm config set --global _auth <value>` and
  // `--location=global` both put a flag between `set` and the key, and a
  // global credential is written OUTSIDE the userconfig the publish step
  // scrubs - so without this the guard passes and the scrub cannot reach it.
  assert.doesNotMatch(
    source,
    /npm\s+(?:config\s+)?set\s+(?:--\S+\s+)*["']?(?:\/\/\S*?[:/])?(?:_authToken|_auth|username|_password|certfile|keyfile|email)\b/i
  );

  // The same credentials can arrive as environment overrides rather than as
  // .npmrc lines. NPM_CONFIG_USERCONFIG is the one legitimate member of that
  // family here - it is how the publish step finds the file it strips.
  for (const [, name] of source.matchAll(/\b(npm_config_[a-z0-9_]+|NPM_CONFIG_[A-Z0-9_]+)\b/gi)) {
    assert.equal(
      name.toUpperCase(),
      "NPM_CONFIG_USERCONFIG",
      `release workflow must not set ${name}, which can carry a registry credential`
    );
  }

  // The publish step must carry no secret at all. Elsewhere in the job
  // `secrets.GITHUB_TOKEN` is legitimate (the gh CLI needs it), so this is
  // scoped rather than global.
  const publish = executable(stepSource("Publish npm package"));
  assert.doesNotMatch(publish, /secrets\s*(?:\.|\[)/);
});

test("the empty credential that setup-node generates is removed before publishing", () => {
  // `registry-url` makes setup-node write
  // `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` into the npm
  // userconfig. With no token in the environment that expands to an EMPTY
  // credential, and npm treats a configured-but-empty token as legacy auth -
  // which blocks the OIDC exchange and fails with the very registry 404 this
  // migration removes. Deleting the token env is therefore NOT sufficient on
  // its own; the generated line has to go too.
  // executable(), not raw source: this step's own comments mention _authToken
  // and NODE_AUTH_TOKEN, so deleting the scrub while keeping the comment would
  // leave every assertion below green against comment text.
  const publish = executable(stepSource("Publish npm package"));

  // Checking npm at install time does not bind at publish time: a later step can
  // prepend a directory to GITHUB_PATH and change which npm resolves here.
  assert.match(publish, /npm --version/);
  assert.match(publish, /sort -V/);
  assert.ok(
    publish.indexOf("npm --version") < publish.indexOf("npm publish"),
    "the effective npm must be re-verified before publication, not only at install time"
  );

  assert.match(publish, /NPM_CONFIG_USERCONFIG/);
  // A credential written with --global or --location=global lands in npm's
  // global config, which the userconfig scrub never touches.
  assert.match(publish, /npm config get globalconfig/);
  assert.match(publish, /sed -i/);

  // Deleting only the token spelling leaves basic auth, the legacy pair and the
  // mTLS pair in place - each of which npm will use instead of the exchange.
  // Asserting `publish.includes("_auth")` is satisfied by the `_authToken`
  // expression alone, so the loop passed while the basic-auth scrub could be
  // deleted outright. Each key is asserted in the DELIMITED form the scrub
  // actually uses, which no other key's expression can satisfy.
  assert.match(publish, /-e '\/_authToken\/d'/);
  for (const key of ["_auth", "username", "_password", "certfile", "keyfile"]) {
    assert.match(
      publish,
      new RegExp(`-e '/:${key}\\[\\[:space:\\]\\]\\*=/d'`),
      `the credential scrub must remove the registry-scoped '${key}'`
    );
    // npm honours an unscoped credential too, so removing only the scoped form
    // leaves legacy authentication configured.
    assert.match(
      publish,
      new RegExp(`-e '/\\^\\[\\[:space:\\]\\]\\*${key}\\[\\[:space:\\]\\]\\*=/d'`),
      `the credential scrub must remove the global '${key}'`
    );
  }
  // The strip must happen before the publish command, not after it.
  assert.ok(
    publish.indexOf("_authToken") < publish.indexOf("npm publish"),
    "the generated credential must be removed before npm publish runs"
  );
});

test("OIDC identity is checked before any remote metadata is mutated", () => {
  // The failure this guards against is not "publish broke" - it is "publish
  // broke and nothing said so". Because the bump and the release commit land
  // before the publish step, ten days of rejected credentials still advanced
  // main to a new version every night and published nothing. A preflight that
  // asks the registry for a credential up front converts that into a run that
  // fails immediately, having changed nothing.
  const refCheck = stepIndex("Check release ref");
  const preflight = stepIndex("Verify npm will accept this workflow's OIDC identity");
  const load = stepIndex("Load verified release metadata");

  // The ref check must precede the preflight, not merely precede publication. A
  // workflow_dispatch from a feature branch would otherwise mint an id-token and
  // exchange it for a short-lived npm PUBLISH CREDENTIAL, and only then be
  // refused - obtaining a credential the run is forbidden to use. Refusing on
  // the ref is free; requesting a credential is not.
  assert.ok(
    refCheck < preflight,
    "the release ref must be checked before any credential is requested"
  );

  // A step check alone allows earlier tooling to request an OIDC credential.
  // Ref and owner opt-in checks must gate the entire publishing job.
  assert.match(executable(jobSource("release")),
    /^ {4}if: github\.ref == 'refs\/heads\/main' && vars\.PM_JEV_RELEASE_ENABLED == 'true' && needs\.prepare\.outputs\.should_release == 'true'$/m);
  assert.match(executable(stepSource("Check release ref")), /refs\/heads\/main/);
  const commit = stepIndex("Merge release metadata through protected PR");
  const publish = stepIndex("Publish npm package");

  assert.ok(preflight < load, "the OIDC check must run before prepared metadata is loaded");
  assert.ok(preflight < commit, "the OIDC check must run before the release commit");
  assert.ok(preflight < publish, "the OIDC check must run before publication");

  const step = executable(stepSource("Verify npm will accept this workflow's OIDC identity"));

  // It has to actually reach the registry: asserting only that an id-token was
  // minted would pass while npm still refuses the identity at publish time.
  assert.match(step, /oidc\/token\/exchange\/package\//);

  // A scoped name is not path-safe: @unbrained/pm-web must reach the registry as
  // %40unbrained%2Fpm-web, and sending it raw addresses a different path. The URL
  // must therefore be built from the ENCODED name, not from package.json's value.
  // npm's escapedName preserves the leading `@` and encodes only the separator,
  // so @unbrained/pm-web must address @unbrained%2fpm-web. encodeURIComponent
  // would percent-encode the `@` too and address a path npm does not know.
  assert.match(step, /replace\('\/', '%2f'\)/);
  assert.doesNotMatch(step, /encodeURIComponent/);

  // An unbounded curl in a release gate turns a hung registry into a hung job
  // rather than a failed one, and the job holds an id-token while it hangs.
  assert.equal(
    (step.match(/curl\b/g) ?? []).length,
    (step.match(/--max-time\b/g) ?? []).length,
    "every curl in the preflight must be bounded with --max-time"
  );

  // A registry outage is not an identity refusal, and must not send a maintainer
  // to reconfigure a trusted publisher that is already correct.
  assert.match(step, /-ge 500/);
  // Rate limiting says nothing about whether a trusted publisher is bound.
  assert.match(step, /"429"/);

  // Under `set -u` a bare ${ACTIONS_ID_TOKEN_*} aborts the step with "unbound
  // variable" before the diagnosis can print, so the operator is told nothing.
  // The whole purpose of this step is a legible failure.
  assert.doesNotMatch(step, /\$\{ACTIONS_ID_TOKEN_REQUEST_(?:URL|TOKEN)\}/);
  assert.match(step, /\$\{ACTIONS_ID_TOKEN_REQUEST_URL:-\}/);
  assert.match(step, /\$\{ACTIONS_ID_TOKEN_REQUEST_TOKEN:-\}/);

  // Under `set -e` an uncaptured non-zero curl aborts before the 000 branch can
  // classify it, making every message below unreachable on exactly the failure
  // they exist to describe. Each curl must run inside an `if !` capture.
  const curls = (step.match(/curl\b/g) ?? []).length;
  const captured = (step.match(/if ! \w+="\$\(curl\b/g) ?? []).length;
  assert.equal(
    captured,
    curls,
    `every curl must have its exit status captured for classification (${captured}/${curls})`
  );
  assert.match(step, /status="000"/);
  assert.match(step, /exchange\/package\/\$\{pkg_path\}/);
  assert.doesNotMatch(step, /exchange\/package\/\$\{pkg_name\}/);

  // npm answers 201 on a successful exchange. Accepting only 200 fails a release
  // whose trusted publisher is correctly configured - a preflight that blocks
  // correct releases is worse than the outage it exists to prevent.
  assert.doesNotMatch(step, /\[ "\$\{status\}" = "200" \]/);
  assert.match(step, /-ge 200/);
  assert.match(step, /-lt 300/);
  assert.match(step, /set -euo pipefail/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(step, /\|\|\s*true/);

  // Fails closed: no `continue-on-error`, which would restore the silent drift
  // while leaving every assertion above satisfied.
  assert.doesNotMatch(step, /continue-on-error/);

  // The entire publish job depends on a successful read-only preparation job.
  // Local preparation has no write credentials; the preflight is unconditional
  // in the publishing job and precedes every remote mutation.
  assert.doesNotMatch(step, /^ *if:/m);
  assert.match(executable(jobSource("release")), /^ {4}needs: prepare$/m);

  // A second `trap ... EXIT` REPLACES the first, so appending one is enough to
  // keep the credential file on disk while every assertion above still passes.
  assert.equal(
    (step.match(/\btrap\b/g) ?? []).length,
    1,
    "exactly one EXIT trap may be installed, or a later one silently replaces the cleanup"
  );

  // The exchange response carries a publish credential. Capturing the status
  // separately from the body is what keeps it out of the log.
  assert.doesNotMatch(step, /echo\s+"?\$\{?id_token/);

  // The 200 response body IS a short-lived publish credential. Every later step
  // in this job runs as the same runner user, so leaving it on disk - and at a
  // predictable path - hands that credential to build, changelog and
  // release-check code that has no business holding it.
  assert.match(step, /response="\$\(mktemp\)"/);
  assert.match(step, /trap\s+'rm -f "\$\{response\}"'\s+EXIT/);
  assert.doesNotMatch(step, /-o\s+\/tmp\/[^\s"]+/);
  assert.match(step, /-o "\$\{response\}"/);
});

test("release opt-in defaults off on both preparation and publishing", () => {
  for (const name of ["prepare", "release"]) {
    assert.match(executable(jobSource(name)), /^ {4}if: .*github\.ref == 'refs\/heads\/main'.*vars\.PM_JEV_RELEASE_ENABLED == 'true'/m);
  }
  const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8");
  assert.match(readme, /owner enables releases/);
  assert.match(readme, /`PM_JEV_RELEASE_ENABLED` to `true`/);
});

test("all actions are pinned and checkouts never persist credentials", () => {
  for (const filename of ["release.yml", "ci.yml", "codeql.yml"]) {
    const source = readFileSync(resolve(import.meta.dirname, "../.github/workflows", filename), "utf8");
    for (const [, reference] of source.matchAll(/uses: (\S+)/g)) assert.match(reference, /@[0-9a-f]{40}$/);
    const checkouts = source.split(/uses: actions\/checkout@[0-9a-f]{40}/).slice(1);
    for (const checkout of checkouts) assert.match(checkout.split(/\n {6}- name:/)[0], /persist-credentials: false/);
  }
});

test("dependencies and repository scripts run only in read-only jobs", () => {
  const prepare = executable(jobSource("prepare"));
  assert.match(prepare, /permissions:\n {6}contents: read/);
  assert.doesNotMatch(prepare, /(?:contents|actions|pull-requests|id-token): write/);
  assert.match(prepare, /npm ci/);
  assert.match(prepare, /npm run release:check/);
  assert.match(prepare, /npm pack --ignore-scripts/);
  const release = executable(jobSource("release"));
  assert.doesNotMatch(release, /npm ci|npm run|bun (?:install|add)|node scripts\//);
  // The release PR's parked CI run must be approvable, so the release job -
  // and ONLY the release job - holds actions: write. Widening the grant on a
  // job that runs dependency code would let untrusted build inputs approve
  // workflow runs; widening it beyond one job would grant it where nothing
  // needs it.
  assert.match(release, /^ {6}actions: write$/m);
  assert.equal(
    (executable(workflow).match(/^ {6}actions: write$/gm) ?? []).length,
    1,
    "actions: write may be granted on exactly one job"
  );
  const resume = executable(jobSource("resume_release"));
  assert.doesNotMatch(resume, /actions: write/);
  assert.match(resume, /uses: actions\/download-artifact@[0-9a-f]{40}/);
  // The resume job performs the single missing write (the GitHub release) and
  // no other: no publish credential, no PR writes, no run approvals.
  assert.match(resume, /permissions:\n {6}contents: write/);
  assert.doesNotMatch(resume, /(?:actions|pull-requests|id-token): write/);
  assert.doesNotMatch(resume, /npm ci|npm run|bun (?:install|add)|node scripts\//);
  assert.match(release, /npm install -g npm@11\.19\.0 --ignore-scripts/);
  assert.match(release, /uses: actions\/download-artifact@[0-9a-f]{40}/);
  assert.match(release, /sha256sum --check --strict/);
  assert.match(release, /HEAD\^\{tree\}/);
  assert.match(release, /npm publish release-artifact\/package\.tgz --access public --provenance --ignore-scripts/);
  assert.match(executable(jobSource("verify_bun")), /permissions:\n {6}contents: read/);
  // Scope the directive so diagnostic prose cannot satisfy the count.
  assert.equal((executable(workflow).match(/^ {6}id-token: write$/gm) ?? []).length, 1);
});

test("git credentials exist only in push steps and never in checkout configuration", () => {
  for (const name of ["Merge release metadata through protected PR", "Push release tag"]) {
    const source = executable(stepSource(name));
    assert.match(source, /GH_TOKEN: \$\{\{ github.token \}\}/);
    assert.match(source, /git -c "http\.https:\/\/github\.com\/\.extraheader=AUTHORIZATION: basic \$basic" push/);
    assert.doesNotMatch(source, /git config.*(?:credential|extraheader)/);
  }
});

/** Extract an inline workflow shell body for disposable behavioral fixtures. */
function stepScript(name: string): string {
  const body = stepSource(name).split("        run: |\n")[1];
  assert.ok(body, `${name} must contain a literal run block`);
  return body.split("\n").map(line => line.startsWith("          ") ? line.slice(10) : line).join("\n");
}

test("release selection refuses changed same-day coordinates and skips unchanged releases", () => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-release-selection-"));
  try {
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
    git("init", "--initial-branch=main");
    git("config", "user.name", "Synthetic Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("remote", "add", "origin", cwd);
    writeFileSync(join(cwd, "source.txt"), "initial");
    git("add", "source.txt");
    git("commit", "-m", "Synthetic base");
    // A fake gh answers the resume probe: status 0 means the GitHub release
    // exists, anything else means missing or unknown. The decide step treats
    // every non-zero outcome as "resume", because the resume job re-checks
    // before creating anything.
    const bin = join(cwd, "bin");
    mkdirSync(bin);
    const gh = join(bin, "gh");
    const fakeGh = (exitStatus: number) => {
      writeFileSync(gh, `#!/usr/bin/env bash\nif [[ "$1" != "api" ]]; then exit 2; fi\nexit ${exitStatus}\n`, { mode: 0o755 });
    };
    const script = stepScript("Decide release");
    const date = execFileSync("date", ["+%Y.%m.%d"], { encoding: "utf8", env: { ...process.env, TZ: "Europe/Vienna" } }).trim();
    const output = join(cwd, "output");
    const summary = join(cwd, "summary");
    const run = () => {
      writeFileSync(output, "");
      return spawnSync("bash", ["-c", script], { cwd, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RELEASE_TIMEZONE: "Europe/Vienna", GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, GITHUB_REPOSITORY: "unbraind/pm-jev" } });
    };
    // Duplicate keys in GITHUB_OUTPUT: the LAST value wins, so assertions must
    // read the last occurrence rather than merely match anywhere.
    const lastValue = (key: string) => {
      const values = [...readFileSync(output, "utf8").matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map((m) => m[1]);
      return values.at(-1);
    };
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.match(readFileSync(output, "utf8"), new RegExp(`tag=v${date.replaceAll(".", "\\.")}\n`));
    assert.equal(lastValue("resume_release_notes"), "false");
    git("tag", `v${date}`);
    // The GitHub release exists: a plain skip, never a resume.
    fakeGh(0);
    assert.equal(run().status, 0);
    assert.equal(lastValue("should_release"), "false");
    assert.equal(lastValue("resume_release_notes"), "false");
    // The GitHub release is missing (gh fails: 404 or unknown): the tag is
    // unchanged, so the only resumable step is release-notes creation.
    fakeGh(1);
    const resume = run();
    assert.equal(resume.status, 0, resume.stderr);
    assert.equal(lastValue("should_release"), "false");
    assert.equal(lastValue("resume_release_notes"), "true");
    assert.equal(lastValue("tag"), `v${date}`);
    assert.doesNotMatch(readFileSync(output, "utf8"), /npm_version=|base_sha=/);
    writeFileSync(join(cwd, "source.txt"), "new content");
    git("add", "source.txt");
    git("commit", "-m", "Synthetic change");
    for (const suffix of ["", "-1"]) {
      if (suffix) { git("tag", "-d", `v${date}`); git("tag", `v${date}${suffix}`, "HEAD~1"); }
      const refused = run();
      assert.equal(refused.status, 1, refused.stderr);
      assert.match(refused.stdout, /refusing a second same-day release/);
      assert.doesNotMatch(readFileSync(output, "utf8"), /should_release=true|npm_version=/);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("the release job best-effort approves its release PR's parked CI run", () => {
  // The permission itself: a comment reading "actions: write" grants nothing,
  // and the grant is meaningless on a job that cannot reach the approve API.
  assert.match(effectiveReleasePermissions(), /(?:^|[{,\s])actions:\s*write\s*(?:#[^\n]*)?$/m);
  const step = executable(stepSource("Merge release metadata through protected PR"));

  // Approval must be scoped to THIS release PR's CI run: the query is already
  // pinned to the release PR head SHA, and the workflow filter keeps a run of
  // any other workflow on the same SHA from being approved.
  assert.match(step, /head_sha=\$\{release_commit\}/);
  assert.match(step, /select\(\.name == "CI"\)/);

  // Best-effort approval, ported from the fleet standard: the approve POST may
  // fail (the token often may not approve), and that failure must neither
  // abort the merge wait nor hide the run URL a maintainer needs.
  assert.match(step, /actions\/runs\/\$\{run_id\}\/approve/);
  assert.match(step, /&& echo "Approved workflow run \$\{run_id\}; its checks can now report\." \\/);
  assert.match(step, /\|\| echo "Could not approve run \$\{run_id\} with this token; a maintainer must approve it once: \$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{run_id\}"/);
  // The URL is reported BEFORE the approval attempt too, so an approve-capable
  // token still leaves the parked run diagnosable in the log.
  assert.match(step, /::warning::CI run \$\{run_id\} for this release PR is awaiting workflow approval: \$\{GITHUB_SERVER_URL\}\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{run_id\}/);
  // Only parked runs are ever selected, never runs that are already running.
  assert.match(step, /select\(\.conclusion=="action_required" or \.status=="waiting"\)/);
});

test("a tag without its GitHub release resumes notes creation only", () => {
  const prepare = executable(jobSource("prepare"));
  // The resume decision is a prepare output, so the publishing jobs can branch
  // on it; the prepare job itself stays read-only.
  assert.match(prepare, /^ {6}resume_release_notes: \$\{\{ steps\.decide\.outputs\.resume_release_notes \}\}$/m);

  // The full-release path must never fire on a resume: no version bump, no
  // changelog commit, no publish, no tag. Each step's gate pins that.
  for (const name of ["Update release version", "Generate changelog and release notes", "Run release checks", "Commit release files", "Pack verified release artifact"]) {
    const step = executable(stepSource(name));
    assert.match(step, /^ {8}if: steps\.decide\.outputs\.should_release == 'true'$/m, `${name} must be gated on should_release alone`);
  }

  // The resume notes are generated in the read-only prepare job (it already
  // installed dependencies; the privileged jobs run none), and shipped via a
  // short-lived artifact like the verified release.
  const notes = executable(stepSource("Generate resume release notes"));
  assert.match(notes, /^ {8}if: steps\.decide\.outputs\.resume_release_notes == 'true'$/m);
  assert.match(notes, /npm run release:notes > RELEASE_NOTES\.md/);
  assert.match(notes, /\[\[ -s RELEASE_NOTES\.md \]\]/);
  assert.doesNotMatch(notes, /npm version|npm publish|git tag|git commit/);
  const upload = executable(stepSource("Upload resume release notes"));
  assert.match(upload, /^ {8}if: steps\.decide\.outputs\.resume_release_notes == 'true'$/m);
  assert.match(upload, /name: resume-release-notes/);
  assert.match(upload, /if-no-files-found: error/);

  const resume = executable(jobSource("resume_release"));
  // Same main-only, opt-in gate as the other publishing jobs, plus the resume
  // flag: without the flag this job must never run.
  assert.match(resume, /^ {4}if: github\.ref == 'refs\/heads\/main' && vars\.PM_JEV_RELEASE_ENABLED == 'true' && needs\.prepare\.outputs\.resume_release_notes == 'true'$/m);
  assert.match(resume, /^ {4}needs: prepare$/m);
  assert.match(resume, /gh release create "\$\{RELEASE_TAG\}" --title "\$\{REPO_NAME\} \$\{RELEASE_TAG\}" --notes-file RELEASE_NOTES\.md --verify-tag/);
  // Idempotent: a release that appeared between prepare and here is done, not
  // an error; gh release create would fail over an existing release.
  assert.match(resume, /releases\/tags\/\$\{RELEASE_TAG\}/);
  assert.match(resume, /already exists; nothing to resume/);
  // Resume never publishes, tags or bumps: those steps do not even exist here.
  assert.doesNotMatch(resume, /npm publish|git tag|npm version|npm ci|git push/);
  // And the publishing job stays gated on should_release alone, so a resume
  // can never republish an immutable version.
  assert.match(executable(jobSource("release")), /^ {4}if: github\.ref == 'refs\/heads\/main' && vars\.PM_JEV_RELEASE_ENABLED == 'true' && needs\.prepare\.outputs\.should_release == 'true'$/m);
});

test("artifact handoff rejects changed bytes, commit, tree and base before loading metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "jev-release-handoff-"));
  try {
    const donor = join(root, "donor");
    const receiver = join(root, "receiver");
    execFileSync("git", ["init", "--initial-branch=main", donor]);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: donor, encoding: "utf8" }).trim();
    git("config", "user.name", "Synthetic Fixture");
    git("config", "user.email", "fixture@example.invalid");
    writeFileSync(join(donor, "package.json"), '{"name":"synthetic","version":"1.0.0"}');
    git("add", "package.json");
    git("commit", "-m", "Synthetic base");
    const base = git("rev-parse", "HEAD");
    execFileSync("git", ["clone", donor, receiver]);
    writeFileSync(join(donor, "package.json"), '{"name":"synthetic","version":"1.0.1"}');
    git("add", "package.json");
    git("commit", "-m", "Synthetic release");
    git("branch", "verified-release");
    execFileSync("mkdir", [join(receiver, "release-artifact")]);
    git("bundle", "create", join(receiver, "release-artifact/metadata.bundle"), "verified-release");
    const tarball = join(receiver, "release-artifact/package.tgz");
    writeFileSync(tarball, "synthetic packed bytes");
    writeFileSync(join(receiver, "release-artifact/RELEASE_NOTES.md"), "Synthetic notes");
    const hash = execFileSync("sha256sum", [tarball], { encoding: "utf8" }).split(" ")[0];
    const script = stepScript("Verify artifact handoff");
    const env = { ...process.env, VERIFIED_COMMIT: git("rev-parse", "HEAD"), VERIFIED_TREE: git("rev-parse", "HEAD^{tree}"), ARTIFACT_SHA256: hash, RELEASE_BASE_SHA: base };
    const run = (overrides = {}) => spawnSync("bash", ["-c", script], { cwd: receiver, encoding: "utf8", env: { ...env, ...overrides } });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(readFileSync(join(receiver, "RELEASE_NOTES.md"), "utf8"), "Synthetic notes");
    for (const key of ["VERIFIED_COMMIT", "VERIFIED_TREE", "RELEASE_BASE_SHA"]) {
      assert.notEqual(run({ [key]: "0".repeat(40) }).status, 0);
    }
    assert.notEqual(run({ ARTIFACT_SHA256: "0".repeat(64) }).status, 0);
    writeFileSync(tarball, "tampered bytes");
    const tampered = run();
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stdout, /FAILED/);
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: receiver, encoding: "utf8" }).trim(), base);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
