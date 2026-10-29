# Budgeted human labeling queues

```sh
pm jev label-queue --input examples/label-queue.json
pm jev label-queue --input examples/label-queue.json --json
```

The example selects two pending cases using three labeling units. Its third
case belongs to a held-out source and cannot enter the queue. Selection makes
zero inference calls and writes no item, label, receipt, journal or checkpoint.
The host renders compact TOON by default or JSON with `--json`.

```ts
import { selectLabelQueue, LabelQueueRefusal } from "pm-jev";
import type { LabelQueueInput } from "pm-jev";

function proposeLabeling(input: LabelQueueInput) {
  try { return selectLabelQueue(input); }
  catch (error) {
    if (error instanceof LabelQueueRefusal) return { code: error.code, remedy: error.remedy };
    throw error;
  }
}
```

The typed exports include `LabelQueueInput`, `LabelCase`, `LabelProvenance`,
`LabelCohort`, `LabelPolicy`, `LabelRatio`, `LabelQueueReport`,
`LabelCaseRejection`, `parseLabelQueueInput`, and `validateLabelQueueReportNumbers`.
`parseLabelQueueInput(raw)` returns `{ input, rejected, candidates }`: a detached,
canonical portable document, isolated case diagnostics, and the original count.
`selectLabelQueue` calls that same strict schema once. The command calls the same
selector and acquires no tracker client, model, settings or network capability.
No input path is interpreted as a source to open or fetch.

## Declared evidence

`pm-jev-label-queue/1` has exactly `version`, `policy`, `cohorts`, `cases`.
The shipped example defines every required field. There are no implicit policy
defaults, status-name heuristics, or ambient project/parent/session values.

- A cohort has `id`, `role` (`acquisition` or `held_out`), and `sources`.
  Each exact source identity occurs in one cohort only. Select exactly one
  acquisition cohort per invocation. Other cohorts remain separate, including
  other acquisition cohorts. Never rename a held-out source to bypass this rule.
- A case has `id`, `source`, `revision`, `cohort`, `task`, `bucket`, `state`,
  `uncertainty`, `cost`, `label`. Identity is the tuple `(source, id, task)`;
  repeated identities, including conflicting revisions, are all skipped. Supply
  an immutable source revision such as a tracker commit or a host revision token.
  Revisions remain exact opaque references; the selector does not verify them.
- Pending `state` is explicitly `unlabeled` or `abstained`; `decided` is omitted.
  These are case workflow states, not native tracker statuses. An adapter that
  derives them from tracker lifecycle must use its SDK status registry roles.
- `uncertainty` and `policy.min_uncertainty` are exact `{numerator, denominator}`
  count ratios in `[0,1]`. Declare how these were obtained before selection.
  This version ranks only declared ratios; it does not estimate uncertainty from
  confidence or fit a model. The minimum is inclusive. Exact rational comparisons
  decide eligibility and ranking; `uncertainty_display` is for display only.
- Labels are `{kind:"none"}` or `{kind:"human"|"inferred", value, actor, evidence}`.
  Only an explicit `human` declaration makes a case already labeled and omitted.
  Inferred labels remain inferred, with their original actor/evidence, and every
  selected reference says `ground_truth:false`. The selector does not verify an
  annotator's identity or turn declarations into certified ground truth.

Strings are exact and are never trimmed, case-folded or Unicode-normalized.
Integer zero is canonicalized to `0`, including a supplied JavaScript `-0`, so
producer documents retain identical values after JSON serialization.
Whitespace/CRLF in nonblank identities and provenance survives round trips.
Source alias equivalence and cross-source duplicate content require caller
governance; exact identity membership cannot establish their independence.

## Selection and measured omissions

`policy` declares `cohort`, `seed`, `budget`, `limit`,
`uncertainty:"declared_ratio_desc"`, `min_uncertainty`, `diversity`, and
`max_per_bucket`. Costs and budget use caller-defined integer labeling units.
Zero budget or zero limit produces a measured empty queue.

`diversity:"cap"` chooses greatest uncertainty first with a hard per-bucket cap.
`diversity:"balanced"` first prefers the bucket with the fewest selected cases,
then greatest uncertainty, subject to the same cap. Both choose only currently
affordable cases. Ties use ascending SHA-256 of JSON `[seed, caseIdentity]`, where
`caseIdentity` is the JSON string of `[source,id,task]`. Canonical ordinal identity
order resolves a theoretical hash collision. Source/case enumeration and JSON
layout do not affect the queue. This is deterministic greedy selection, not a
knapsack optimum or statistical sampling guarantee.

`counts` reports original `candidates`, valid pending `eligible` after filters,
`selected`, and `omitted`. Every input case contributes once to either the queue
or one omission count. Precedence is `invalid`, `held_out`, `other_cohort`,
`human_labeled`, `not_pending`, `below_uncertainty`. After greedy selection,
remaining eligible cases are counted by `diversity`, then `budget`, then `limit`.
Their counts reflect the final remaining budget and bucket occupancy.

Malformed individual cases and all duplicate identities are skipped alone.
Multiplicity is counted before payload validation or eligibility filtering:
every record with bounded own data fields `(source,id,task)` participates, even
if its cost, revision, label, cohort or other payload fields are invalid. All
copies of a repeated identity receive `duplicate_case`. For example, a pending
copy plus a human-labeled copy with `cost:0` quarantines both; the pending copy
cannot re-enter selection because its conflicting copy failed validation.
Inherited, accessor, missing or invalid identity fields cannot identify another
case and yield only `invalid_case`; getters are never evaluated to guess identity.
The schema snapshots array elements from their own data descriptors before
iteration. Inherited array methods cannot filter cases or cohort/source
declarations out of the input seen by validation.
`rejected` includes up to ten input positions with `invalid_case` or
`duplicate_case`; `rejected_omitted` counts further diagnostics. Remedy: correct
that case against the example schema, or supply exactly one revision for its
identity, then rerun. Invalid documents, policy or cohort declarations refuse
the document before any effect. Legacy native items are never validated or
rewritten; only this new portable input contract is validated.

`input_sha256` binds the canonical validated projection, original candidate
count and rejection diagnostics. It is an evidence digest, not an idempotency
key, authentication proof, or freshness certificate. Valid portable documents
can be exported with `JSON.stringify(parsed.input)` and replayed through the
same selector; a cleaned export deliberately excludes rejected records.

## Bounds, refusals and later labeling

Inputs are regular JSON files of at most 4 MiB; there are at most 5,000 cases,
32 cohorts, 128 sources per cohort, and 100 selected cases. Strings contain
1..96 characters and must not be blank. Arrays are dense with no extra fields;
records have only the documented own fields. Integers are finite: costs 1..1,000,000,
budget 0..1,000,000, queue limit 0..100, per-bucket cap 1..100, ratio denominator
1..1,000,000,000 and numerator 0..denominator. The SDK enforces the same canonical
document size bound. Every emitted number and count/budget conservation law is
checked before `ok:true`.

CLI exit 0 means selection completed, even if empty or some records were omitted.
Exit 2 includes a content-free code and remedy: `invalid_input`,
`input_unreadable`, `cohort_conflict`, or `invalid_report`. There is no apply flag.
The queue contains only bounded case references and declared provenance; it
does not copy tracker bodies or probability distributions.

Budget and rank are local to this invocation. The queue provides no reservation,
claim, label ingestion, import/sync, or shared acquisition budget. Retrying or
two concurrent callers can select the same case. To label later, retrieve the
current target through the SDK, compare its monotonic revision with the declared
expected revision, and obtain explicit human judgment with provenance. Re-read
immediately before each write and refuse on change. An ordinary writer can still
interleave between that check and write; `commitWorkspaceTransaction` serializes
other transactions only (upstream pm-cli #1620). This selector makes no lock or
write-isolation claim and never replays a frozen mutation plan.

Existing evaluation ground truth supplies data, exemplar retrieval supplies
decision context, and pm-rl owns training/promotion. This workflow schedules
human review without expanding a benchmark or introducing a training backend.

## Without git and validation

SDK selection and `jev label-queue` work in plain trackers without Git on `PATH`.
The feature invokes no Git subprocess and needs no provider credentials.

`node --test --test-concurrency=2 test/label-queue.test.ts` covers the shipped
producer, allow/refusal corpora, malformed records, exact boundaries, extreme
values, output bounds, CLI JSON/TOON, and 500 seeded operation sequences (3,000
operations) against an independent cross-product reference model. Replayed older
documents and whitespace/CRLF variants retain the same decisions. Real non-git
SDK trackers retain their native fields, parent/blocker/dependency relationships,
custom status registries and ambient focus, checked by SDK readback.
The same 500 sequences also inject malformed duplicate identities and replay
CRLF/JSON variants, preserving unrelated survivors and SDK-read native state.
An adversarial corpus corrupts every non-identity case field and reverses record
order. It runs through the SDK, host-injected command, JSON/TOON CLI and all five
packed install modes, including packed SDK consumers under Node and Bun.

`test/label-queue.acceptance.ts` measures selection on a verified public fleet
tracker archived into a read-only non-git scratch project. Aggregate results in
[label-queue-evidence.json](label-queue-evidence.json) distinguish declared test
annotations from native data. No inference quality or live freshness claim is
made. `node --test --test-concurrency=1 test/joint-install.acceptance.ts` checks
one archive through project-local, npm global,
Bun global, npx and bunx invocations and the typed SDK under Node and Bun.
