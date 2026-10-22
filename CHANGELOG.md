# Changelog

## 2026.10.5 - 2026-10-05

### Added

- Compact decision output for agent context budgets ([pm-jev-qriu](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-qriu.toon))
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
- Batch open backlog triage with bounded streaming and stable receipts ([pm-jev-k8qe](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/features/pm-jev-k8qe.toon))

### Changed

- Adopt pm-github 2026.10.16: default-branch-safe gated sync and daily gated closeout PRs ([pm-jev-qlnw](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/chores/pm-jev-qlnw.toon))
- Enable the gated GitHub issue sync and drop the braces chain ([pm-jev-maint1014](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/chores/pm-jev-maint1014.toon))

### Fixed

- Gate outcomes need explicit proposition and expected-result semantics ([pm-jev-43xa](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-43xa.toon))
- Resolve development glob toolchain audit findings without downgrading fleet gates ([pm-jev-2rp1](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-2rp1.toon))
- Preserve unknown token usage after TypeSafe SDK update ([pm-jev-ls5n](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-ls5n.toon))
- Name evaluation source failures and support local tracker reads without GitHub ([pm-jev-0s07](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-0s07.toon))
- Calibrate triage type proposals for projects with many item types ([pm-jev-2mg8](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-2mg8.toon))
- Synthetic threshold calibration dataset and local harness ([pm-jev-6uoz](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-6uoz.toon))
- Port best-effort CI approval and release-notes resume into the release workflow (Greptile PR 1) ([pm-jev-uqu6](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-uqu6.toon))
- Address PR 1 eight CodeRabbit review findings ([pm-jev-3zuo](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/issues/pm-jev-3zuo.toon))

### Other

- pm-jev: typed local-first System One decisions for pm items ([pm-jev-0w3q](https://github.com/unbraind/pm-jev/blob/main/.agents/pm/epics/pm-jev-0w3q.toon))
