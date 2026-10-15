# Typed relationship proposals

Tracking: [pm-jev-3ntg](../.agents/pm/features/pm-jev-3ntg.toon), under
[pm-jev-0w3q](../.agents/pm/epics/pm-jev-0w3q.toon).

An agent opening an item receives useful project context when dependency and
relationship edges exist. `pm jev link` proposes those edges using deterministic
candidate retrieval and bounded typed judgments from the local decision model.

```sh
pm jev link <id>
pm --json jev link <id> --limit 8
pm jev link <id> --apply --min-confidence 0.8
pm jev link <id> --apply --allow-parent
pm --json jev link --open --limit 20
```

## Contract

A complete, fail-closed SDK read includes every lifecycle status and full metadata
and bodies. Corrupt or incomplete reads fail; they never become an empty corpus.
The source is excluded. Dedupe's deterministic title-similarity function ranks
positive matches, with stable item-id tie-breaking. Single-item `--limit` defaults
to 8 candidates and accepts integers 1–50. Zero candidates returns `none`, zero
usage and the configured model, without inference. Lexical retrieval can miss
relationships whose titles share no words; no semantic-recall guarantee is made.

Each candidate gets one named typed choice question. All questions for one source
share a single request, with distinct indexed candidate projections. The catalog
is `pm-jev-link/1`. Canonical labels are derived from the host SDK's accepted
dependency kinds and relationship registry, plus `none`. Compatibility aliases
collapse to canonical labels. The pinned host supports `blocked_by`, `blocks`,
`child`, `discovered_from`, `implements`, `incident_from`, `parent`, `recurs_from`,
`related`, `supersedes` and `verifies`. It does not support `duplicate`, so the
model cannot propose that label. Registry direction, precedence, hierarchy parent
endpoint and temporal order describe each label. Source-to-candidate direction
is explicit in every question.

Code selects the maximum label probability, preserving registry order for ties.
The type-calibration rule applies first: a top-two margin strictly below
`0.05136322250317049` abstains with `kind: null`, `abstained: true` and
`reason: top_two_margin_below_threshold`. This reused synthetic type cutoff is
conservative policy, **not relationship calibration**. Probability and model
confidence are distinct; authorization uses probability only.

Each candidate reports its id, lexical score, proposed `kind`, `selected_kind`,
probability, full distribution, margin, abstention, reason and `existing` flag.
`none` produces a null proposal. Existing edges also produce null proposals,
with `existing_edge`, even when the model selects them confidently. SDK graph
normalization detects aliases, inverse kinds, symmetric edges, scalar parents
and legacy blockers. It suppresses the specific existing kind, allowing a
different justified relationship between the same pair.

Dry-run is the default. `--apply` compares full-precision probability against
`--min-confidence` (inclusive, default `jev.min_confidence`, otherwise 0.8;
valid range 0–1), then adds only new, non-abstained edges. Hierarchy edges in
either direction require `--allow-parent`; otherwise they retain a visible
proposal with `parent_requires_allow_parent` and never qualify for application.
Host hierarchy, cardinality, cycle and reference validation remain authoritative.
All qualifying additions use the SDK's ordinary `update` dependency path,
`dep: ["id=<target>,kind=<kind>"]`, together with exactly one comment in the same
update. Nothing edits dependency storage or history files directly.

The receipt contains resolved model, catalog, threshold, rounded label
probabilities, policy reasons, candidate ids and applied edges. It excludes item
text. Even an apply invocation with no qualifying edges appends one receipt.
A rerun can append a new receipt, but cannot re-add an existing edge.
Inference source and candidate snapshots are re-read before return or mutation;
stale inference is refused. A receipt hash covering complete source text, update
coordinate and relationship coordinates is also checked inside the host item
lock, together with the invocation deadline. A candidate can change after its
last read: the SDK has no cross-item inference transaction. The source lock does
not claim to freeze the whole tracker.

## Backlog and output

With `--open`, `--limit` bounds source items (default 8, maximum 50), and each
source independently ranks up to 8 candidates. Selection uses the host's strict,
role-derived open lifecycle bucket, ordering and bounded page receipt. The
terminal summary includes `has_more`. An id and `--open` are incompatible;
`--full` is single-item only. No receipt cache or `--refresh` flag is introduced.

Sources run sequentially under one shared invocation deadline, client and
Ollama `keep_alive` policy. Each source streams one JSON line or TOON table row
with item, outcome, qualifying-edge count, reason and compact per-candidate
proposals (kind, probability, abstention, existing-edge flag and reason).
TOON encodes the proposals array as a JSON string cell; JSON lines retain a typed
array and full precision. Single-item text output follows the existing compact
three-decimal convention; `--full` and JSON retain every label probability.

Counts are **source items**, not edges: `changed`, `would_change`, `skipped` and
`failed`. A source with no qualifying edges is skipped; stale evidence is skipped
without a receipt. Operational errors count as failed, continue to later selected
sources and exit nonzero. A single-item operational failure also exits nonzero;
`none` is a successful exit. No requests or writes begin after deadline abort.

## Privacy and bounds

The same triage projection sends only bounded title, description, distinct body
and nonempty tags. Each text field is capped at 4,000 characters; at most 32 tags
of 128 characters each are sent. The model sees indexed candidates, not tracker
ids, current routing fields, comments, history, authors, linked files or metadata
paths. Text inside title/body remains content, so this is minimization rather
than secret sanitization. The complete serialized request must fit 64 KiB;
oversized batches fail before inference and advise reducing `--limit`. The
model's context window can impose a smaller practical bound.

The existing external-provider opt-in, credential destination checks, redirect
refusal, response validation and retry/deadline policy apply unchanged.
The default remains local `tev1:4b`; no hosted acceptance is claimed.

Every authoritative item, history, schema and settings file stays byte-identical
during dry-run. The pinned host SDK itself writes disposable `runtime/` metadata
caches and context-usage records during reads. There is no public per-call option
to suppress them. The regression and live acceptance snapshots exclude only that
host runtime directory. Thus dry-run has no persistent project-management mutation;
it is not a claim of zero filesystem writes by the host. No runtime cleanup,
telemetry configuration change or SDK patch is used to conceal this limitation.

## Acceptance and regression evidence

`node --test test/link.test.ts` exercises real temporary trackers and the real
host extension harness, using the repository's existing decision endpoint double.
It covers deterministic ranking and ties, supported labels, projection privacy,
zero candidates, existing inverse/symmetric/alias/scalar edges, full-precision
thresholds, abstention, hierarchy opt-in, atomic edge/comment history, corrupt
reads, payload bounds, stale source/candidate evidence, item-lock expiry, backlog
counts, stream formats and deadline abort.

`npm run build && node --test test/link.acceptance.ts` installs the packed package
and pinned real pm host into a disposable project. It creates eight realistic
synthetic items, runs the actual `pm --json jev link` command against local
`tev1:4b`, compares all authoritative tracker file hashes and checks the installed
host's lock guard by attempting an expired receipt. The unrelated thumbnail item
must be excluded by lexical ranking.

Measured local acceptance and independent behavioural revert proofs are recorded
below after execution. These synthetic judgments establish bounded integration
behavior; they do not establish production relationship precision or recall.

### Recorded local tev1:4b run (2026-10-15)

Model digest: `9b5bb969e46c4b776826d6f2d401e22893205693f172653af6254897255025b8`.
The packed real host run passed 1/1. Eight items produced six ranked candidates
in one decision request; the unrelated image-upload item was excluded. CLI wall
latency was **42,453 ms**, with **10,458 input / 7 output tokens** reported by the
provider. Catalog: `pm-jev-link/1`. Source: “Login session expiry validation”.
The source explicitly named its prerequisite migration, downstream rollout and
umbrella security epic. One `blocked_by` edge to the migration already existed.

| Candidate | Top kind | Probability | Proposed kind | Policy result |
| --- | --- | ---: | --- | --- |
| Login session expiry tests | child | 0.385361 | child | Hierarchy requires opt-in; below 0.8 |
| Login session expiry research | child | 0.209537 | null | Abstain: margin 0.004465 |
| Login session rollout | blocks | 0.629304 | blocks | Below 0.8 |
| Login session documentation | related | 0.293816 | related | Below 0.8 |
| Login session security epic | parent | 0.565559 | parent | Hierarchy requires opt-in; below 0.8 |
| Login session database migration | blocked_by | 0.537797 | null | Existing edge excluded |

No edge qualified at the unchanged 0.8 default. No item, history, schema or
settings bytes changed; no receipt was appended. The installed host separately
rejected an expired relationship receipt without adding a comment. The relation
judgments show substantial uncertainty, including a debatable `child` judgment
for the tests item. This is integration evidence and a concrete reason to retain
thresholds and review proposals, not a claim of relationship accuracy.

The initial verbose ontology prompt was rejected by the real local model:
2,549 tokens exceeded its 2,050-token per-prompt bound. That failure exited
nonzero with no mutation. Compact descriptions derived from the same SDK
ontology brought this acceptance within the model bound; no model setting,
threshold, timeout or release policy was relaxed. Large candidate sets or long
content may still exceed model context even below the 64 KiB transport ceiling.

### Independent behavioural revert proofs

Only `decideLinks` was mutated for each proof. Making its apply branch
unconditional failed the dry-run authoritative-file hash regression (exit 1).
Independently disabling existing-edge membership failed the real-tracker
existing-edge regression (exit 1). Tests import source directly, so rebuilding
dist was unnecessary. Source was restored byte-for-byte, then both focused tests
passed 2/2:

```sh
node --test --test-name-pattern='link dry-run changes no authoritative tracker bytes|link apply writes one SDK edge and one receipt' test/link.test.ts
```

The pm item comment records both failures, the restored source SHA-256 and the
passing run. No mutant is committed.

### Final delivery verification

After preserving the host's `exit_code` result contract in the shared batch
helper, the existing triage continuation regression and the new link batch
failure regressions pass 3/3. The two independent behavioural mutants were rerun
and each failed; byte-for-byte restoration passes 2/2. The final source SHA-256
recorded in the pm comment is
`99453c8138e88981aec8f0276d58900e2967f070eb0f9f31a63d5c219e27e0a7`.

Both `npm run release:check` and `bun run release:check` pass under a disposable
HOME with `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`. Each runs
**167/167 tests**, with zero failures, cancellations, skips or todos; all **12
authored source files** reach **100% statements, branches, functions and lines**.
Duplication is 0%, production audit reports zero vulnerabilities, package dry-run
includes this document, changelog is current and publication attestation passes.
Thresholds, dependency pins and release configuration remain unchanged.

The pm linked runner passes **4/4 commands**: focused tracker tests **14/14**, both
full gates above, and final packed real-host acceptance **1/1**. Project policy
disables automatic test-result tracking; sanitized evidence is appended as pm
comments without changing that policy. The runner uses tracker context for
source-workspace execution; its universal read-output controls do not apply to
`pm test`.

The final packed-host repeat against the same model digest used eight items,
six candidates and one decision request, reporting **67,033 ms**, **10,458 input /
7 output tokens**. Fresh disposable ids reorder tied candidates deterministically
within that tracker; these judgments differ from the earlier run and demonstrate
model/order sensitivity.

| Candidate | Top kind | Probability | Proposed kind | Policy result |
| --- | --- | ---: | --- | --- |
| Login session expiry tests | blocked_by | 0.359286 | null | Abstain: margin 0.034859 |
| Login session expiry research | blocked_by | 0.300705 | blocked_by | Below 0.8 |
| Login session documentation | child | 0.261796 | null | Abstain: margin 0.017087 |
| Login session rollout | blocks | 0.500356 | blocks | Below 0.8 |
| Login session database migration | blocked_by | 0.820882 | null | Existing edge excluded |
| Login session security epic | parent | 0.669761 | parent | Hierarchy requires opt-in; below 0.8 |

No new edge qualifies. All authoritative tracker hashes remain identical. The
installed host also produces a failed backlog row, failed count 1 and process
exit 1 for a nonexistent local model, with no authoritative writes. Its expired
receipt test still rejects the write. The pm item remains in progress for the
orchestrator; the implementation does not close it.
