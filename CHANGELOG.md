# Changelog

## Unreleased

### Dependencies

- Bump unbraind/pm-ops/.github/workflows/daily-release.yml

## 2026.11.25 - 2026-11-25

### Other

- Adopt pm-cli 2026.11.24 host-aligned SDK behaviour ([pm-jev-sdk-host-alignment](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/chores/pm-jev-sdk-host-alignment.toon))

## 2026.11.24 - 2026-11-24

### Dependencies

- Bump unbraind/pm-github/.github/workflows/pm-github-closeout.yml ([#132](https://github.com/unbraind/pm-jev/pull/132))
- Bump unbraind/pm-ops/.github/workflows/daily-release.yml ([#134](https://github.com/unbraind/pm-jev/pull/134))
- Bump the codeql-action group with 2 updates ([#131](https://github.com/unbraind/pm-jev/pull/131))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml from 2026.11.15 to 2026.11.19 ([#133](https://github.com/unbraind/pm-jev/pull/133))
- Bump the dependencies group with 2 updates ([#135](https://github.com/unbraind/pm-jev/pull/135))

## 2026.11.19 - 2026-11-20

### Added

- Screen proposed items through a typed pre-create duplicate guard ([pm-jev-pre-create-guard](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-pre-create-guard.toon))

### Dependencies

- Bump eslint ([#124](https://github.com/unbraind/pm-jev/pull/124))

## 2026.11.16 - 2026-11-17

### Other

- Split quick PR checks from exhaustive local CI ([pm-jev-ci-v2](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/tasks/pm-jev-ci-v2.toon))
- Adopt pm-cli option contract and current pm-toolchain ([pm-jev-option-contract-1114](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/chores/pm-jev-option-contract-1114.toon))

### Dependencies

- Bump the dependencies group with 3 updates ([#121](https://github.com/unbraind/pm-jev/pull/121))
- Bump jscpd ([#112](https://github.com/unbraind/pm-jev/pull/112))
- Bump the pm-toolchain group across 1 directory with 3 updates ([#106](https://github.com/unbraind/pm-jev/pull/106))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#109](https://github.com/unbraind/pm-jev/pull/109))
- Bump the codeql-action group across 1 directory with 2 updates ([#107](https://github.com/unbraind/pm-jev/pull/107))
- Bump unbraind/pm-github/.github/workflows/pm-github-closeout.yml ([#108](https://github.com/unbraind/pm-jev/pull/108))

## 2026.11.7 - 2026-11-07

### Fixed

- Count choice options from the JSON request representation ([pm-jev-undefined-choice-admission](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-undefined-choice-admission.toon))
- Refuse ambiguous native model aliases before replay pinning ([pm-jev-replay-ambiguity](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-replay-ambiguity.toon))

### Closed

- Closed: Admission counts undefined choice entries that disappear from the inference request ([pm-jev-github-21e139da0658-101](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-github-21e139da0658-101.toon))
- Closed: Replay bypasses ambiguous_model admission by pinning the first equivalent inventory entry ([pm-jev-github-21e139da0658-100](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-github-21e139da0658-100.toon))

## 2026.11.6 - 2026-11-06

### Added

- Refuse local decisions that exceed digest-bound tokenizer context ([pm-jev-tokenizer-admission](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-tokenizer-admission.toon))

### Fixed

- Retry packed admission fixture teardown within a finite bound ([pm-jev-admission-teardown](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-admission-teardown.toon))
- PR \#92 rejects valid Unicode after item-state truncation splits a surrogate pair ([pm-jev-github-21e139da0658-94](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-github-21e139da0658-94.toon))
- PR \#92 admission rejects equivalent native Ollama model references ([pm-jev-github-21e139da0658-93](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-github-21e139da0658-93.toon))
- SDK 2026.10.30 upgrade aborts five native-state regressions on placeholder parent fixtures ([pm-jev-github-21e139da0658-84](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-github-21e139da0658-84.toon))
- Release version replacement updates a comment instead of the exported extension identity ([pm-jev-nl5n](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-nl5n.toon))

### Closed

- Closed: Make packed admission smoke teardown resilient to ENOTEMPTY after successful commands ([pm-jev-github-21e139da0658-98](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-github-21e139da0658-98.toon))

### Dependencies

- Bump the dependencies group with 2 updates ([#97](https://github.com/unbraind/pm-jev/pull/97))
- Bump the pm-toolchain group across 1 directory with 3 updates ([#83](https://github.com/unbraind/pm-jev/pull/83))

## 2026.11.4 - 2026-11-04

### Changed

- Update triage and link backlog tests for typed host lookup refusals on the pinned toolchain ([pm-jev-6fs0](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/chores/pm-jev-6fs0.toon))

### Fixed

- Daily release never publishes: npm reads release-artifact/package.tgz as a GitHub repository ([pm-jev-tl8w](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-tl8w.toon))

### Closed

- Closed: Release publish resolves verified tarball argument as a GitHub SSH repository ([pm-jev-github-21e139da0658-62](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-github-21e139da0658-62.toon))

### Dependencies

- Bump the pm-toolchain group with 3 updates ([#75](https://github.com/unbraind/pm-jev/pull/75))
- Bump the dependencies group across 1 directory with 4 updates ([#76](https://github.com/unbraind/pm-jev/pull/76))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#78](https://github.com/unbraind/pm-jev/pull/78))
- Bump unbraind/pm-github/.github/workflows/pm-github-closeout.yml ([#77](https://github.com/unbraind/pm-jev/pull/77))

## 2026.10.31 - 2026-10-31

### Dependencies

- Bump the pm-toolchain group with 3 updates ([#72](https://github.com/unbraind/pm-jev/pull/72))

## 2026.10.30 - 2026-10-30

### Dependencies

- Bump the pm-toolchain group with 3 updates ([#69](https://github.com/unbraind/pm-jev/pull/69))

## 2026.10.29 - 2026-10-29

### Added

- Queue budgeted human labeling with deterministic uncertainty and diversity selection ([pm-jev-h8hx](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-h8hx.toon))
- Explain incompatible joint decision proposals before apply ([pm-jev-79ht](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-79ht.toon))

### Dependencies

- Bump the pm-toolchain group with 3 updates ([#64](https://github.com/unbraind/pm-jev/pull/64))

## 2026.10.28 - 2026-10-28

### Added

- Detect calibration population and explicit-label drift without inference ([pm-jev-t1h1](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-t1h1.toon))
- Compare frozen decision proposals before adopting a local policy ([pm-jev-7esl](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-7esl.toon))
- Explain typed decisions by bounded evidence removal ([pm-jev-ygvl](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-ygvl.toon))
- Select measured cost-sensitive abstention policies ([pm-jev-do7y](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-do7y.toon))
- pm-jev packaging, gates and CI ([pm-jev-0q58](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-0q58.toon))
- Detect existing duplicate items with calibrated pair decisions ([pm-jev-vouf](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-vouf.toon))
- Retrieve same-tracker labelled exemplars for evaluation and calibration ([pm-jev-f4ba](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-f4ba.toon))
- Evaluate decisions against public tracker ground truth ([pm-jev-82ip](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-82ip.toon))
- Fit and validate repository-separated decision calibration ([pm-jev-hx9w](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-hx9w.toon))
- Propose typed relationship edges with the local decision model ([pm-jev-3ntg](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-3ntg.toon))
- pm-jev triage command: batched typed decisions over one item ([pm-jev-f5zk](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-f5zk.toon))
- pm-jev provider config and privacy gate ([pm-jev-ny9g](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-ny9g.toon))
- pm-jev dedupe command: model-confirmed duplicate screening before create ([pm-jev-m9v5](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-m9v5.toon))
- pm-jev ask command: caller-defined typed questions against an item ([pm-jev-2e0n](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-2e0n.toon))
- pm-jev gate command: calibrated noul exit gate for agents and CI ([pm-jev-nn3x](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-nn3x.toon))
- pm-jev models and doctor commands ([pm-jev-f8t5](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-f8t5.toon))
- Compact decision output for agent context budgets ([pm-jev-qriu](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-qriu.toon))
- Batch open backlog triage with bounded streaming and stable receipts ([pm-jev-k8qe](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-k8qe.toon))

### Changed

- Adopt pm-github 2026.10.16: default-branch-safe gated sync and daily gated closeout PRs ([pm-jev-qlnw](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/chores/pm-jev-qlnw.toon))
- Enable the gated GitHub issue sync and drop the braces chain ([pm-jev-maint1014](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/chores/pm-jev-maint1014.toon))

### Fixed

- Resolve development glob toolchain audit findings without downgrading fleet gates ([pm-jev-2rp1](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-2rp1.toon))
- Preserve unknown token usage after TypeSafe SDK update ([pm-jev-ls5n](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-ls5n.toon))
- Name evaluation source failures and support local tracker reads without GitHub ([pm-jev-0s07](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-0s07.toon))
- Preserve partial evaluation receipts and call counts on interruption ([pm-jev-w1zj](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-w1zj.toon))
- Calibrate triage type proposals for projects with many item types ([pm-jev-2mg8](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-2mg8.toon))
- Synthetic threshold calibration dataset and local harness ([pm-jev-6uoz](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-6uoz.toon))
- Port best-effort CI approval and release-notes resume into the release workflow (Greptile PR 1) ([pm-jev-uqu6](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-uqu6.toon))
- Address PR 1 eight CodeRabbit review findings ([pm-jev-3zuo](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-3zuo.toon))
- Gate outcomes need explicit proposition and expected-result semantics ([pm-jev-43xa](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-43xa.toon))

### Other

- Stop Hound from linting generated dist/ output ([pm-jev-hound-generated-dist](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/chores/pm-jev-hound-generated-dist.toon))
- Release readiness behind PM_RELEASE_APPROVED ([pm-jev-release-gate](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/chores/pm-jev-release-gate.toon))
- Preserve Unicode exemplar retrieval and UTF-8 prompt budgets ([pm-jev-sdk-unicode](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/tasks/pm-jev-sdk-unicode.toon))
- pm-jev: typed local-first System One decisions for pm items ([pm-jev-0w3q](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/epics/pm-jev-0w3q.toon))

### Dependencies

- Bump the pm-toolchain group across 1 directory with 3 updates ([#59](https://github.com/unbraind/pm-jev/pull/59))
- Bump @toon-format/toon ([#60](https://github.com/unbraind/pm-jev/pull/60))
- Bump the codeql-action group across 1 directory with 2 updates ([#54](https://github.com/unbraind/pm-jev/pull/54))
- Bump unbraind/pm-github/.github/workflows/pm-github-sync.yml ([#56](https://github.com/unbraind/pm-jev/pull/56))
- Bump unbraind/pm-github/.github/workflows/pm-github-closeout.yml ([#55](https://github.com/unbraind/pm-jev/pull/55))
- Bump the dependencies group across 1 directory with 2 updates ([#53](https://github.com/unbraind/pm-jev/pull/53))
- Bump the pm-toolchain group with 3 updates ([#52](https://github.com/unbraind/pm-jev/pull/52))
- Bump jscpd ([#46](https://github.com/unbraind/pm-jev/pull/46))
- Bump the pm-toolchain group across 1 directory with 3 updates ([#38](https://github.com/unbraind/pm-jev/pull/38))
- Bump the pm-toolchain group with 2 updates ([#35](https://github.com/unbraind/pm-jev/pull/35))
- Bump the dependencies group across 1 directory with 2 updates ([#32](https://github.com/unbraind/pm-jev/pull/32))
- Bump the pm-toolchain group with 3 updates ([#31](https://github.com/unbraind/pm-jev/pull/31))
- Bump the codeql-action group with 2 updates ([#33](https://github.com/unbraind/pm-jev/pull/33))
- Bump the pm-toolchain group with 2 updates ([#22](https://github.com/unbraind/pm-jev/pull/22))
- Bump the pm-toolchain group with 2 updates ([#20](https://github.com/unbraind/pm-jev/pull/20))
- Bump @unbrained/pm-cli ([#18](https://github.com/unbraind/pm-jev/pull/18))
- Bump actions/setup-node from 7.0.0 to 7.1.0 ([#14](https://github.com/unbraind/pm-jev/pull/14))
- Bump actions/download-artifact from 8.0.1 to 8.0.2 ([#15](https://github.com/unbraind/pm-jev/pull/15))
- Bump actions/upload-artifact from 7.0.1 to 7.0.2 ([#13](https://github.com/unbraind/pm-jev/pull/13))
- Bump the codeql-action group with 2 updates ([#12](https://github.com/unbraind/pm-jev/pull/12))
- Bump the dependencies group with 4 updates ([#11](https://github.com/unbraind/pm-jev/pull/11))
- Bump the pm-toolchain group with 3 updates ([#6](https://github.com/unbraind/pm-jev/pull/6))
- Bump pm-ops ([#5](https://github.com/unbraind/pm-jev/pull/5))
- Bump actions/download-artifact from 4.3.0 to 8.0.1 ([#2](https://github.com/unbraind/pm-jev/pull/2))
- Bump actions/upload-artifact from 4.6.2 to 7.0.1 ([#3](https://github.com/unbraind/pm-jev/pull/3))
