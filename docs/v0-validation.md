# pm-jev v0 validation receipt

This is the initial v0 snapshot. See [the agent UX validation receipt](agent-ux-validation.md)
for the gate outcome and compact-output updates, current checks and measurements.

Date: 2026-10-05. Package version: 2026.10.5, an unpublished v0 slice.
Branch: `feat/typed-local-decisions`. This is synthetic local evidence; no hosted
TypeSafe request, GitHub repository creation, push, or npm publication occurred.
Companion specification: `pm-cli-website-flnt` (read only).

## Mandatory gates

- `npm run coverage`: 86 tests, 86 passed, 0 failed/skipped/canceled; 100% statements,
  branches, functions and lines across all 9 source files, including every script.
  Both the Node source-presence/coverage gate and the four-dimension c8 gate pass.
  No source exemptions or coverage-ignore directives are used. c8 reports 2,531/2,531
  statements and lines, 481/481 branches, and 61/61 functions.
- `npm run typecheck` and `npm run build:test`: strict, erasable TypeScript passes.
- `npm run lint`: fleet ESLint policy passes.
- `npm run duplication`: 0% duplication, 0 clone pairs.
- `npm run docstring`: all 131 function/export checks pass across 9 source files.
  The full syntax-tree supplement includes callbacks and short internal helpers.
- `pm health --strict-exit --json`: `ok: true`, exit 0, zero findings.
- `npm run audit:prod`: zero production dependency vulnerabilities.
- `npm run release:check`: typecheck, lint, duplication, build, docstrings, coverage,
  production audit, package dry run, changelog check and publish-attestation check pass.
  This command validates release prerequisites; it does not publish anything.
- The generated CHANGELOG.md has no releases because no release tag exists.
  The daily workflow and release-note generation use pm-changelog.

The HTTP tests use a real in-process server and the official SDK, with the host's
`createExtensionTestHarness` and real disposable projects initialized by `pm init`.
Fixtures use the SDK workspace-only resolver so inherited PM_PATH cannot redirect them
into the caller's tracker. Linked `pm test --run --progress` executions of coverage, live
acceptance, and installation all pass in the supported schema context.

They cover proposal-only behavior, probability-gated apply with one SDK update and
receipt, configured/custom types, deterministic candidate ranking, all question
primitives, malformed schemas/answers, prototype-like option names, hosted refusal,
redirect refusal, reflected error-body suppression, 400/401/403/404/422/429/529,
retry exhaustion and recovery, total deadline, timeout, unreachable endpoint,
model-discovery fallback and near-threshold gate precision.

## Real local model

`npm run test:live` passes one acceptance test against the real local `tev1:4b`.
Synthetic crash-report triage chooses a bug-like configured type and priority 0;
dedupe selects the existing synthetic item; mixed ask returns valid choice, score,
and noul answers; positive and negative gates produce the expected verdicts.
No item is mutated. Receipts and measured results are also recorded on `pm-jev-0w3q`.

A measured run with the semantic built-in type catalog returned:

| Decision | Observed answer |
| --- | --- |
| Triage type | Bug, probability 0.730584; Issue received 0.268022 |
| Triage priority | Level 0, probability 0.980728 |
| Dedupe | Existing synthetic item, probability 0.766467 |
| Ask defect | bug, probability 0.991604 |
| Ask impact | score 1.978899 on a three-level rubric |
| Ask broken | noul 0.983936 |
| Positive gate | passed, probability 0.940974 |
| Negative gate | failed, probability 0.015977, exit 1 |

The Bug/Issue overlap illustrates why field probabilities and configured thresholds
matter. These observations establish bounded schema/plausibility acceptance, not
calibration, robustness to all adversarial state, production readiness, or accuracy
on real private projects. Latency varies with model warmth and concurrent requests.

The SDK model listing was tested against real Ollama: `/v1/models` has an incompatible
OpenAI-shaped payload. `/api/tags` advertises `tev1:4b` with capability `decision`;
models/doctor fall back to that filtered native listing.

## Installed consumers

`npm run test:install` passes one acceptance test:

1. Pack the actual compiled distribution and install its archive separately with npm
   and Bun; import and exercise the public library from each isolated consumer.
2. Install dependencies in a scratch pm project, extract the shipped package into a
   small local directory, then install that directory with the real `pm install`.
3. Run live triage through both `npx --no-install pm` and `bunx --no-install pm`.
4. Verify the installed CLI emits JSON and exits 1 for a negative live gate.

pm's directory scanner refuses the full development checkout once it reaches 10,000
entries. That refusal was reproduced. The packed local directory workaround avoids
copying the dependency tree and passes actual extension activation. The host copies
extension files; dependency installation is a separate npm/Bun consumer step.

Both acceptance commands use only disposable synthetic projects and need local Ollama.
They are deliberately separate from CI; no CI run exists without a remote repository.

## Tracker and remaining work

| Item | Scope |
| --- | --- |
| pm-jev-0w3q | Package epic and companion specification link |
| pm-jev-f5zk | Triage |
| pm-jev-m9v5 | Dedupe |
| pm-jev-2e0n | Ask |
| pm-jev-nn3x | Gate |
| pm-jev-f8t5 | Models and doctor |
| pm-jev-ny9g | Provider configuration and privacy |
| pm-jev-0q58 | Packaging, gates and CI |
| pm-jev-q96v | Deferred Rust/OpenAPI client |
| pm-jev-6psc | Deferred hosted live acceptance and credentials |
| pm-jev-6uoz | Deferred pm-rl threshold calibration dataset |
| pm-jev-5h61 | Host development-checkout scan-cap follow-up |
| pm-jev-2rp1 | Development glob-toolchain dependency audit follow-up |

Full npm audit reports four high findings through the development-only braces,
micromatch, fast-glob and pm-ops graph. The production audit passes. The automatic
suggested remediation downgrades pm-ops, so compatible upstream remediation remains
open rather than replacing verified gates with an older toolchain. No production
exploit is established by this development dependency report.

Items remain open/in progress for orchestrator verification and closure. Claims are
released at handoff. The daily release workflow must be disabled by the orchestrator
when a repository is created until the owner approves release of this new package.
