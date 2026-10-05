# PR 1 review findings

All eight CodeRabbit comments were checked against the implementation. Each finding
was valid and fixed; none was declined. Work is tracked by
[pm-jev-3zuo](../.agents/pm/issues/pm-jev-3zuo.toon) under epic
[pm-jev-0w3q](../.agents/pm/epics/pm-jev-0w3q.toon).

| Comment | Disposition and evidence |
| --- | --- |
| 4181327570 | Fixed: CI and release actions use full commit SHAs; every checkout disables credential persistence. |
| 4181327572 | Fixed: preparation and publication require main and `vars.PM_JEV_RELEASE_ENABLED == 'true'`. Owner opt-in is documented in README. |
| 4181327583 | Fixed: dependency installation, builds, checks and packing run with `contents: read`. The publishing job receives the packed artifact and metadata bundle, verifies the tarball SHA-256 and commit/tree/base, and checks the protected merged tree before publishing. It runs no package dependency installation or repository scripts. Only publication holds OIDC; no actions-write permission remains. Git authentication is passed per push invocation. Bun acceptance runs in a separate read-only job. |
| 4181327585 | Fixed: changed content following a same-day standard or numbered release tag is refused; unchanged content skips. Shell regression tests cover each case. |
| 4181327596 | Fixed: hosted TypeSafe destinations require HTTPS; a custom origin requires an explicit environment URL override. Tracker settings cannot independently authorize credential transfer. |
| 4181327600 | Fixed: URL parse failures produce the expected `jev_invalid_url` configuration error. |
| 4181327602 | Fixed: gate threshold and triage minimum confidence validate before inference; invalid flags send zero HTTP requests and write no receipt. |
| 4181327609 | Fixed: the interpolation guard scans literal and folded run scalars, including chomping modifiers; adversarial scalar fixtures exercise the guard. |

The protected metadata PR flow remains in place. OIDC identity preflight runs before
any remote metadata mutation; local version preparation needs no write credential.
The publishing job downloads the checked tarball and publishes it with provenance
and lifecycle scripts disabled. Artifact tampering tests exercise the actual handoff
shell, including rejection before the prepared metadata is loaded.

Validation commands:

- `node --test test/decisions.test.ts test/transport.test.ts test/release-workflow.test.ts`: passed targeted regressions through the PM linked-test runner; the final workflow suite has 15 passing tests.
- `npm run release:check`: passed the full package gate: 99 tests, zero failures or skips. Coverage inventories all nine authored source files, with 100% statements, branches, functions and lines. Typecheck, lint, zero duplication, complete docstrings, production audit, package contents, changelog and publish attestation pass.
- `npm run test:install`: passed through the PM linked-test runner. Packed npm/Node and Bun imports, installed-extension npx/bunx live triage, compact/full output and negative/safety CLI gate exit codes passed using synthetic data and the local tev1 model.
- `pm health --strict-exit --require-merge-drivers --json`: passed with zero warnings or findings.
- Actionlint 1.7.12 with `-shellcheck=''` on CI, release and CodeQL workflows: passed.
- `npm run changelog:full`: generated CHANGELOG.md with pm-changelog.

PM linked-test result tracking is disabled in this repository; durable results are
recorded here and in the issue comments. Items remain open/in progress for the
orchestrator to verify and close. No GitHub replies, bot mentions, merge or npm
publication were performed. Actual npm OIDC and protected-PR release execution remain
owner-controlled and have not been exercised by this patch.

The inherited registry recovery path accepts nonempty `dist.attestations` as its
recovery signal without comparing the artifact integrity or provenance subject.
Exact recovery verification is recorded separately in
[pm-jev-5jw9](../.agents/pm/issues/pm-jev-5jw9.toon); that behavior is outside these eight
findings and remains an open risk.
