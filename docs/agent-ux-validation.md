# Agent UX validation receipt

Branch: `feat/typed-local-decisions`, package version 2026.10.5.
Tracker: Issue `pm-jev-43xa` and Feature `pm-jev-qriu`, under `pm-jev-0w3q`.
These items remain in progress for orchestrator verification.

The gate returns `holds`, `expected` and `ok`, with `holds` computed from the
full-precision inclusive comparison `probability >= threshold`. The default
expectation is true; secret/private-data gates use `--expect false`. Exit status
is 0 exactly when `holds === expected`. The former `passed` field is removed.

Default TOON output rounds decision numbers to three decimals and keeps the top
three choice options plus the chosen option, with `omitted_options`. Dedupe
candidate details follow the retained options. JSON, `--output-format json` and
`--full` retain every option and full precision; receipt comments retain their
two-decimal formatting. The pinned host reserves JSON and output-format flags,
while `--full` belongs to these extension commands.

## Test-first evidence

Linked `node --test test/agent-ux.test.ts` commands were recorded before implementation.
The red run failed on missing gate outcome fields and unrounded default output.
The green run covers secret/clean safety gates, default/explicit true expectations,
invalid expectation rejection before inference, equality at the threshold, a
rounded 0.5 probability whose full value is below the threshold, stable choice
ties, chosen options outside the top three, omission counts, empty dedupe,
full-precision similarity scores, and renderer overrides across all four commands.

## Output measurement

A real local `tev1:4b` triage of a synthetic crash-report item used all 11 configured
item types and chose Issue. To isolate presentation from inference variability,
the saved live receipt was replayed through the real command harness and the
host's built-in TOON formatter with an unchanged receipt and item-id width.

| Output | Bytes | Visible type options |
| --- | ---: | ---: |
| Original | 1,034 | 11 |
| Compact | 574 | 3 |

The saving is 460 bytes (44.5%); `omitted_options` is 8. Counts include the host
formatter's single trailing newline. The first baseline capture added an extra
blank line and reported 1,035 bytes; the tracker records that correction.

## Local model acceptance

`npm run test:live` passed one acceptance test with seven real local `tev1:4b`
decisions: crash triage, matching-item dedupe, mixed choice/score/noul ask, positive
and negative default gates, and secret/clean safety gates. No item was mutated.

| Safety input | Probability | Expected | Holds | OK | Exit |
| --- | ---: | --- | --- | --- | ---: |
| Synthetic token and password | 0.9586815127864688 | false | true | false | 1 |
| Clean button-alignment request | 0.11993540918170091 | false | false | true | 0 |

This is bounded synthetic acceptance, not workload calibration. Hosted TypeSafe
acceptance and the existing threshold-calibration work remain deferred.

## Gates and distribution

- `npm run coverage`: 88/88 tests pass, zero failures/skips/cancellations; 100%
  statements, branches, functions and lines across all nine source files and scripts.
  c8 reports 2,599/2,599 statements and lines, 532/532 branches, 63/63 functions.
- `npm run typecheck` and `npm run build:test`: pass.
- `npm run lint`: pass. `npm run duplication`: 0% duplication, zero clone pairs.
- `npm run docstring`: 139 declarations documented across nine source files.
- `pm health --strict-exit --json`: pass with zero findings; linked PM health uses
  tracker context rather than an empty schema fixture.
- `npm run test:install`: one acceptance test passes for packed npm/Bun library
  consumers, live npx/bunx host commands, compact TOON, `--full`, and real
  secret/clean `--expect false` process exits.
- `npm run audit:prod`, `npm run pack:dry-run`, `npm run changelog:check` and
  `npm run verify:release-publish-attestation`: pass.
- `dist/` is rebuilt and tracked.

CHANGELOG.md is generated with `npm run changelog:full`. All changelog generation,
checking and release-note scripts consistently include closed and in-progress
items so the required open tracker handoff does not hide pending implementations.
This does not change the orchestrator's item-closure or release authority.
