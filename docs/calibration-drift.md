# Calibration drift sentries

`pm jev drift --cohorts cohorts.json [--json]` compares frozen operating
populations without inference, network requests, settings reads, or writes.
It works in a plain tracker with Git absent from `PATH`. The host owns command
registration, option parsing, TOON/JSON rendering and refusal exit codes.
The SDK exposes `checkCalibrationDrift(raw: unknown): DriftReport`,
`parseDriftInput`, `validateDriftReportNumbers`, `DriftRefusal` and the associated
TypeScript contracts from `pm-jev`.

Start with [the synthetic example](../examples/calibration-drift.json):

```sh
pm jev drift --cohorts examples/calibration-drift.json --json
```

```ts
import { checkCalibrationDrift } from "pm-jev";
const report = checkCalibrationDrift(JSON.parse(document));
// report.status is stable, drift, or insufficient_evidence.
// report.recommendation never grants authority to modify an item or policy.
```

## Freeze the evidence contract

The single strict input schema is `pm-jev-drift/1`. Unknown fields are refused at
every object level; arrays must be dense. File input is a regular JSON file up
to 8 MiB. SDK inputs obey the same structural limits. Both cohorts contain at
most 5,000 rows with unique ids within each cohort. Empty cohorts are valid and
report insufficient evidence. Categories and ids are nonempty strings of at
most 96 UTF-16 units with no leading or trailing whitespace. No normalization
is performed. Whitespace and CRLF around JSON have no semantic effect.

Each cohort has `identity: { model_digest, question_digest }`. Both are exact
lowercase SHA-256 digests. Use the frozen calibration receipt's model digest
and the matching `question_sha256`, or the SHA-256 of an ordered catalog bundle
when the cohort spans questions. Never use a mutable model tag as identity.
Different model or question digests are refused before comparison. Changing
question wording or registry criteria requires separate evidence. A digest
assertion is not independently verified model provenance by this offline tool.

Each observation has exactly `id`, `task`, `type`, `input_bucket`, `predicted`
and `label`. Supply the task and tracker-configured type at decision time.
`input_bucket` is a predeclared category such as `short`/`long`; freeze the
bucket definition and boundaries with the calibration cohort and use them
unchanged for current observations. Do not send raw input text. `predicted` is
the recorded prediction and `label` is a later explicit judgement in the same
label vocabulary, or `null` when unavailable. A judgement must correspond to
that row's exact recorded decision. Repeated observations are not independent
evidence. A native status, closure, proposal or model answer cannot substitute
for an explicit correctness label. The sentry never interprets status names or
reads status roles, and does not classify tracker lifecycle state.

The top-level `provenance` is `synthetic`, `public`, or `local-unverified`.
It is a caller assertion. Neither it nor an output digest grants permission to
publish private data. Output omits ids, categories, raw inputs and labels.
`identity` is echoed to bind recommendations to that model/question pair.
Threshold decimals are parsed into exact rational values. Count-derived rates,
rate differences and total variation are compared by BigInt cross multiplication;
only report displays use floating point. See [the package cutoff audit](exact-cutoffs.md).
Canonical field order and sorting rows by exact id make evidence hashes stable
across JSON layout, property order and row enumeration. Input objects are never
modified. `calibration_sha256` binds the frozen cohort; `evidence_sha256` also
binds current evidence, provenance and thresholds. No idempotency key is needed:
the sentry has no imports, exports, sync, journal or shared mutable state.
Replaying an older document recomputes that document's diagnostic only.

## Predeclare thresholds

`thresholds` has exactly four fields:

| Field | Domain | Meaning |
| --- | --- | --- |
| `population_tv` | decimal number/string in `(0,1]` | Inclusive categorical total-variation cutoff |
| `error_increase` | decimal number/string in `(0,1]` | Inclusive increase in explicit-label error rate |
| `min_population` | integer `[2,5000]` | Required observations in each cohort |
| `min_labels` | integer `[2,5000]` | Required explicit labels in each cohort |

For task, type and input category separately, TV is half the sum of absolute
frequency differences over the union of observed categories. Zero means an
unchanged distribution; one means disjoint categories. A population shift is
reported when **any** distance reaches `population_tv`, provided both cohorts
meet `min_population`. Smaller cohorts report insufficient evidence while
retaining descriptive distances. Empty denominators yield `null`.

The label diagnostic compares the aggregate fraction of recorded predictions
that disagree with explicit labels. Both cohorts must meet `min_labels`.
`error_increase` is current minus calibration error, in `[-1,1]`; negative means
improvement. Label counts and coverage are always reported. Sparse or missing
labels report `insufficient_evidence`, never a claim of stability.

Overall status is `drift` if either sufficient-evidence diagnostic trips;
otherwise it is `insufficient_evidence` if either lacks evidence, else `stable`.
A known population shift therefore remains drift even with missing labels.
Recommendations are respectively `abstain_and_recalibrate`,
`abstain_pending_evidence`, or `retain_policy_and_monitor`. These are advisory:
no threshold or existing mutation guard is changed. Successful diagnostics exit
0 in all three states. Invalid input/refusals exit 2 with `{ code, message,
remedy }`. Stable codes are `invalid_input`, `identity_mismatch`,
`input_unreadable`, and `invalid_output` (internal numeric invariant failure).
Every emitted count and rate is checked for its finite documented domain.
The report has constant field count and no per-observation detail.

These empirical cutoffs are operational heuristics, not significance tests,
confidence intervals, independence guarantees or an accuracy certificate.
Choose them before observing current data. The sentry cannot verify when a
threshold was declared or that labels are representative. Marginal distances
can miss a changed joint distribution; aggregate error can hide subgroup
regressions. Label selection bias, correlated rows and changed bucket definitions
require separate review. Changed populations call for fresh calibration;
this feature performs no model training, policy replay or pm-rl promotion.

## Evidence and reproduction

The focused suite tests unchanged cohorts, all three disjoint-category shifts,
explicit-label degradation, sparse labels, identity mismatch, strict boundary
fuzzing, output invariant fuzzing, and 500 seeded operation sequences (4,000
steps) with old-input replay, later judgements and CRLF/property-order variants.
There are no native import/export/sync paths or native state transformations in
this feature. The real non-git tracker test reads authoritative state back
through the SDK and compares it unchanged; the host parser runs with no Git in
`PATH`. Tests trap network access on the SDK/handler path.

```sh
npm run build
npm run build:test
node --test test/calibration-drift.test.ts
node test/calibration-drift.acceptance.ts <public-clone> <empty-scratch> <report>
```

[Public-copy evidence](calibration-drift-evidence.json) records certified complete
SDK reads of a verified public tracker archive, with unchanged authoritative
bytes and a second SDK state read. Source files are read-only in a non-git
scratch project. The unchanged population stays below the frozen cutoff; an
injected input-category control trips it. There are no explicit later labels
for those observations, so the label verdict remains insufficient evidence.
The frozen public model/question identity is a reference for this mechanics
check; these items were never inferred and are not a newly calibrated cohort.
Only aggregate counts and public provenance hashes are published.
