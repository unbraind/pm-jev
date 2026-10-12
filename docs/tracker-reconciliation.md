# Merged-main tracker reconciliation

Acceptance was checked against main commit `7c0f0e0`, which includes PR #4.
The tracker schema supports draft, open, in_progress, blocked, closed and canceled;
it has no review status. All ten requested items remain in_progress for the
orchestrator to close after review. Their comments link the evidence below.

Targeted validation uses real temporary trackers, the official model SDK and a
loopback HTTP boundary: `node --test test/agent-ux.test.ts test/decisions.test.ts
test/transport.test.ts test/release-workflow.test.ts test/calibration.test.ts`.
The same command is linked to pm-jev-qriu and executed through `pm test --run
--only-last --progress`. No live or hosted inference is implied by these tests.
Both the direct run and linked run passed **51/51**, with zero failures, canceled,
skipped or TODO tests. Direct execution took 175.8 seconds; the isolated linked
snapshot took 127.9 seconds under the current shared-host load.

| Item | Acceptance evidence on main | Remaining boundary |
| --- | --- | --- |
| pm-jev-qriu | `index.ts:857` compacts to three decimals and keeps the top three choices plus the selected option; `index.ts:887` preserves JSON/full precision. Test: "compact all four commands while JSON and full retain precision and every option" (`test/agent-ux.test.ts:57`). | Criteria implemented. |
| pm-jev-ny9g | `index.ts:275` resolves environment/settings and enforces hosted opt-in and credential origin checks; `index.ts:351` refuses redirects and disables logging; `index.ts` now reads the tracker's typed `providers.ollama` base_url/model through the SDK's `readSettings` when the `jev` section does not set them (local provider only). Tests: "provider settings refuse every external command before any HTTP request", "hosted credentials require HTTPS and custom origins require an environment override", "malformed HTTP answers fail before apply and redirect targets receive no state", "typed providers.ollama settings supply the local endpoint when jev does not", "environment and jev settings outrank typed providers.ollama; blanks fall back to built-ins", "a non-loopback providers.ollama endpoint still requires explicit opt-in", "hosted typesafe resolution never adopts the ollama provider endpoint". | Typed providers.ollama fallback delivered on feat/providers-ollama-fallback. Hosted live acceptance remains separately tracked. |
| pm-jev-f8t5 | `index.ts:1488` lists SDK models with capability-filtered native fallback; `index.ts:1536` reports endpoint/model degradation. Tests: "discovery falls back to capability-filtered Ollama tags and diagnoses missing models", "doctor distinguishes a missing hosted model on the synthetic endpoint". | Criteria implemented; doctor proves discovery, not model accuracy. |
| pm-jev-nn3x | `index.ts:1367` accepts exactly one text/item source, checks a typed noul against an inclusive threshold and returns exit_code=1 for a mismatched expectation. Test: "ask, dedupe, gate and discovery dispatch on a real temporary tracker"; near-threshold transport test. | Criteria implemented. Default thresholds remain provisional, not production-calibrated. |
| pm-jev-2e0n | `index.ts:1270` reads/validates a question document, projects the item and returns typed answers plus model/usage. Tests: "typed question files reject invalid shapes and preserve every primitive", "ask, dedupe, gate and discovery dispatch on a real temporary tracker". | Criteria implemented. |
| pm-jev-m9v5 | `index.ts:1158` ranks complete SDK item metadata deterministically and bounds candidates; `index.ts:1182` asks one candidate-or-none choice, skips inference for no candidates and returns duplicate_of. Tests: "ask, dedupe, gate and discovery dispatch on a real temporary tracker", "none is a real model option and hosted discovery failures have no native fallback". | Criteria implemented. |
| pm-jev-43xa | `index.ts:1393` returns holds/expected/ok with full-precision arithmetic. Test: "gate expectations distinguish unsafe secrets, clean text and inclusive boundaries" (`test/agent-ux.test.ts:19`). | Criteria implemented. |
| pm-jev-3zuo | `docs/pr-1-review-findings.md:9` maps all eight comments; runtime tests cover HTTPS/origin, malformed URLs and thresholds. Workflow tests cover pinned actions, opt-in, privilege separation, handoff tampering, same-day refusal and folded scalars. | Criteria implemented. Subsequent pm-jev-uqu6 deliberately adds narrowly scoped actions:write to publication; original documentation's no-actions-write statement is historical. Actual OIDC/protected-release execution is untested. |
| pm-jev-uqu6 | `.github/workflows/release.yml:241` scopes actions:write to publication; `:566` checks parked CI runs before best-effort approval; `:65` selects notes-only recovery; `:875` defines the separate resume job. Tests: "the release job best-effort approves its release PR's parked CI run", "a tag without its GitHub release resumes notes creation only" (`test/release-workflow.test.ts:603`, `:628`). | Criteria implemented. Approval remains best-effort and release execution is untested. |
| pm-jev-6uoz | `calibration.ts:28` generates the seeded four-family corpus; `:117`, `:162` derive calibration cutoffs before held-out scoring; `:204` uses the production decision path locally. `scripts/calibrate.ts:31` atomically replaces complete output. Test: "committed local receipt replays against the generated corpus and frozen curves" and the real HTTP/atomic output/seed tests. | Criteria implemented. Committed receipt is 64/64 correct on a narrow synthetic corpus; it does not establish production or choice/score accuracy. Earlier packed acceptance deadline failures were recorded and remain separate from corpus/harness acceptance. |

Line numbers refer to the checked main revision and may move in the batch feature.
