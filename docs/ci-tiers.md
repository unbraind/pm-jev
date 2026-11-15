# Fleet CI v2

Required checks remain `test (22)`, `test (26)` and `codeql`. PR CI and manual
runs use GitHub-hosted Ubuntu, deterministic quick seed prefixes, cancellation
of superseded PRs, and a 30-minute job limit. Deep checks are `deep (22)` and
`deep (26)`: main pushes, nightly 02:13 UTC (release is 03:23 and hourly :41),
and dispatch, with per-ref cancellation and a 120-minute job limit.

| Existing check | Code PR 22 | Code PR 26 | Docs/tracker PR (both) | Deep 22/26 |
| --- | --- | --- | --- | --- |
| npm ci / merge-driver prepare | yes | yes | yes | yes |
| Strict tracker health / required merge drivers | yes | yes | yes | yes |
| Fresh build / committed dist drift | yes | yes | — | yes |
| Build and test typecheck | quick suite | coverage suite | — | full npm + Bun |
| Public provenance / release identity | via tests | gate | both commands + identity/provenance tests | npm + Bun |
| Typecheck, lint, duplication, docstrings | — | gate | — | npm + Bun |
| Coverage, unchanged 100% lines/branches/functions (c8 also enforces 100% statements) | — | quick | — | full npm + Bun |
| Production audit | — | gate | — | npm + Bun |
| Pack dry-run / prepack provenance | — | gate | yes | npm + Bun |
| Changelog check | — | gate | yes | npm + Bun |
| Publish attestation verifier | — | gate | yes + release contract suite | npm + Bun |
| README/admission docs, packed file list, commit identity | suite | suite | applicable suites | full npm + Bun |
| Bun graph install / bunx CLI smoke | — | yes | — | graph install + Bun gate |
| CodeQL | separate required workflow on every PR/main push; weekly Monday 01:47 UTC | same | same | weekly/main workflow |

Bun setup also runs on docs-only changes so the packed guide checks every
documented Bun command. The cheap path retains tests reading README and admission docs, including
`admission-docs-install`, `admission-docs`, `agent-ux`, `release-approval`,
`identity-audit` and `source-provenance`, plus pack dry-run and the publish-attestation auditor (which recognizes shell
shebangs regardless of filename). This repository has
no separate privacy/secret command beyond its public-provenance gate and commit
identity audit. Executable tracker scripts always select code CI. CodeQL is
required, so no path filters are added. Release workflows and verifiers are unchanged.

Deep keeps the original Node 22/26 × npm/Bun full gates. It selects the `pm-local`
self-hosted pool unless `PM_LOCAL_DEEP=off`. Local runners keep their npm cache
and preinstalled Bun; hosted fallback uses setup-node's npm cache and setup-bun.
Every deep job logs `bun --version`.

`PM_TEST_DEPTH` defaults to full; quick runs a deterministic tenth of each
repetitive corpus (rounded up, at least 25, capped by full count). Product
maximum-size fixtures and all per-case assertions remain. Exact-boundary counts
are recomputed from generated iterations. `PM_TEST_TIME_SCALE` defaults to 1;
deep uses 3. Only harness watchdogs and elapsed-time headroom scale, with finite
positive validation and integer milliseconds before child spawning. Product
request/deadline configuration remains unscaled.

The normal suite already proves offline packed npx/bunx admission commands;
it does not prove actual Bun installation. The PR therefore retains
`bun install --no-save` and adds `bunx --no-install pm --version`. The networked
`test:install`, joint install acceptance, and real-provider `test:live` were
already local-only and remain so; no new provider or credential requirement.

Main baseline run [43679596301](https://github.com/unbraind/pm-jev/actions/runs/43679596301)
took 9m35s / 16m01s from job creation to completion (22/26), with execution
6m33s / 4m59s for the two full gates. Slowest Node 26 cases were public-quality
replay (~48s each gate) and seeded SDK admission (~27s). Quick timing is recorded
in the tracker and PR after local verification; full depth is certified by deep
CI after merge and was not rerun on the overloaded development host.

Fixture regression #116 came from implicit ancestor discovery. Fixtures now
own their temporary tracker root and scrub inherited Git/PM scope while
initializing. Regression cases place temporary children inside Git parents
with and without a tracker and verify that parent bytes remain unchanged.
