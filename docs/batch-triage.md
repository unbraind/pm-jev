# Batch backlog triage

`pm jev triage --open [--type <t>] [--limit N] [--apply --min-confidence X] [--refresh]`
selects one bounded page through the host SDK's open lifecycle bucket. The configured
open status and item type aliases follow host semantics. The
default limit is 20, maximum 1000. Selection is a snapshot; newly created items wait
for another invocation. The terminal receipt includes `has_more`.

Each item uses one `systemOne` request with the existing four typed questions. The
official `@typesafe-ai/sdk` exposes one shared state and named questions per request.
The host PM SDK returns static read results and provides no asynchronous item iterator. Ollama's
[System One API](https://github.com/ollama/ollama/blob/main/docs/openapi.yaml)
likewise has no independent-state batch, and returns one JSON response. Combining
several items into shared state would mix evidence between decisions. The command
therefore reuses a client and catalog across sequential independent requests, while
streaming completed rows through public host `writeStdout` and returning
`suppressHostOutput` to prevent duplicate rendering. The previous single-item triage
already sent four questions in one HTTP request; this change does not reduce four
requests to one. No throughput or latency improvement is claimed without measurements.
The Ollama API caps named questions at 64 and text-only request bodies at 64 KiB;
the complete input must also fit the loaded model context. This command asks four
questions per item and does not expose a fictional independent-state batch endpoint.

Ollama documents `keep_alive` on `/v1/systemone` in seconds or duration strings. SDK
0.6 forwards additional properties from a request variable unchanged, so this field
travels through the official transport. It is provider-specific and never sent to
hosted TypeSafe. Redirect refusal, external opt-in, credential checks, response schema
validation and per-field probability thresholds apply to every item.

Triage sends bounded title, description, distinct body and nonempty tags. The explicit keep-current candidate names the current type and its registry definition.
Current routing fields are excluded from the evidence state, and a description repeated in body is sent once. The
receipt's SHA-256 hashes the complete untruncated title, description, body, ordered
tags and status. Type, priority, timestamps and annotations are excluded so the
receipt remains valid after apply and does not invalidate itself. Only matching
current-catalog receipt comments with a matching `type_question_sha256` are reused;
`--refresh` bypasses them. The fingerprint is SHA-256 of the JSON-serialized type
choice question (kind, instructions, ordered candidate labels and effective
definitions), with the keep-current option bound to the stable `__keep_current__`
placeholder, plus `TYPE_MARGIN_THRESHOLD` and `TYPE_CHANGE_PROBABILITY`. This
captures the keep-current instruction template while excluding the item's routing
type so an applied change does not invalidate its own receipt. Definitions use
normalized registry descriptions, built-in criteria, or the folder fallback, exactly
as sent to the model. Editing a definition or adding a candidate invalidates reuse;
edits that leave the effective question unchanged do not cause model calls.

Pre-change receipts without this fingerprint are stale for type decisions. The next
batch invocation re-evaluates each such item; an apply appends a new receipt so later
unchanged runs can skip it. Existing receipts and comments are never rewritten or
removed. Dry runs
leave items and history untouched. This is receipt reuse, not a model-result cache.

Before returning any inferred result, the command compares full evidence, current
type/priority and the host update coordinate with a fresh SDK read. Apply also
adds a redacted input revision hash and deadline to the receipt. The host
mutation guard validates those against the current document inside the item lock. Changed source or an expired deadline refuses both field writes and
receipt persistence. SDK tracker reads and persistence do not expose cancellation;
deadline checks prevent new inference and writes once expired, and the shared
AbortSignal cancels model requests and retry waits. A tracker operation already
in progress may finish its host-owned critical section after that deadline.
The SDK may scan the corpus to sort and certify the bounded page; output starts
after selection because there is no public asynchronous item iterator.

TOON output is a table with one compact row per item; host JSON output is one JSON
object per line. The final summary counts items as changed, would_change, skipped
or failed. A refreshed apply that changes no fields still writes a redacted receipt
and counts as skipped. Stale inference counts as skipped, endpoint/validation failures
as failed. Remaining selected items after deadline exhaustion receive failure rows
without additional model requests. Any failed item sets exit 1. `--quiet` suppresses
stream output while the host retains the structured terminal receipt.

Ordinary tests use real disposable trackers and deterministic loopback HTTP, without
PM SDK mocks. `npm run test:install` exercises the tarball path directly with packed
npm/Bun consumers and their installed hosts. `npm run test:live` separately exercises
local model decisions and emits batch counts/timings on synthetic tracker state.
Live acceptance must be scheduled after any external baseline measurement completes.

## Type calibration policy

Catalog `pm-jev-triage/2` describes every registered type and includes an explicit
keep-current candidate. For each item the shared catalog is bound to its current
type. Code ranks full-precision label probabilities with stable registry ordering.
A top-two margin below the frozen empirical cutoff returns no type proposal,
`abstained: true` and `reason: top_two_margin_below_threshold`. Margin equality is
accepted. This applies to labels including keep-current and the current type; those
are distinct candidates and are not merged into an inflated probability.

After the margin check, a keep-current winner or a competing label below 0.8
retains the current type with `kept_current: true` and an explicit reason. Apply
then compares a changed proposal's own probability against the requested threshold.
Abstention affects only type: an independently qualifying priority can still change.
Batch rows include `abstained` and the reason, with null type/probability on abstention.
Single-item `--full` and JSON include definitions and every label probability;
compact TOON omits definitions and preserves the existing top-three contract.
See [the measured threshold](threshold-calibration.md) and its limitations.
