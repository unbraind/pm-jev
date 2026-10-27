# One domain for fitted and applied thresholds

`threshold.ts` owns the threshold representation and the single `compareThreshold`
comparison. `exact.ts` re-exports that same function as `compareExact` for SDK
compatibility; it is a compatibility re-export with no second implementation or dependency cycle. Fitting, previews,
metrics and application all reach the same comparison through those exports.

The domain is exact rational arithmetic over the canonical decimal spelling of
stored JavaScript probabilities. Decimal strings preserve every supplied digit.
Numerators and denominators are BigInts during arithmetic, and comparisons cross
multiply. The portable threshold carries integer strings:

```json
{"state":"enabled","numerator":"5999999999999999","denominator":"10000000000000000"}
```

`{ "state": "disabled" }` accepts no scores. Legacy `Infinity` and `null` are
converted to this state before cutoff arithmetic. The previously accepted
negative-infinity bound has an explicit `{ "state": "unbounded" }` representation
and retains its old ordering. Enabled integer strings are bounded to 2048
characters, with a positive denominator; malformed or extra fields are rejected.

`acceptsThreshold(value, cutoff)` is the inclusive policy predicate;
`acceptsThreshold(value, cutoff, true)` is exclusive. Both call the same
comparator. Disabled checks precede score arithmetic. `belowComplement` refuses
to establish negative evidence from a disabled channel; it never computes
`1 - Infinity`. Disabling one channel does not disable a supported peer.

## Fit/apply reapplication

`marginValue` derives the exact top-two margin from probabilities as stored and
is used by both fitting and application. Displayed margins are never fitting
inputs. The legacy numeric threshold API is preserved: `numericBoundary` chooses
a finite numeric decimal no greater than the exact observation, stepping to the
adjacent lower binary value when needed. Fitting counts rows with that same
boundary, including any rows grouped at that boundary. It does not count with an
exact observation then apply its rounded display.

For `{Feature: 0.8, Task: 0.20000000000000004}`, the exact decimal margin is
`0.59999999999999996`. The numeric boundary is `0.5999999999999999`. Four correct
rows fit to this boundary are all accepted when it is reapplied. An explicitly
requested `0.6` remains stricter and is not silently changed.

`deriveThreshold` and `fitTypeMargin` return both the compatible numeric/null
`threshold` and a portable tagged `cutoff`. Their curves count using their actual
numeric boundaries. `fitPairCutoff` is the typed pair fitting API. The released
`fitPairThreshold` and `fitDuplicateThreshold` wrappers still return numeric
cutoffs, including `Infinity` for unsupported policies. All forms are normalized
at the shared boundary before application, and `duplicateMetrics`/`pairMetrics`
accept the tagged form as well as the released scalar call forms. Explicit tagged
boundaries that cannot be represented by an identical legacy number remain
tagged: `legacyThreshold` refuses a lossy conversion rather than changing their
decisions. Fitted legacy boundaries are constructed to round-trip exactly.

One legacy overload has an intentionally different role:
`typeMetrics(rows, variant, null)` still requests the historical unfiltered
prompt baseline. To evaluate an unsupported fitted policy, pass `fit.cutoff`
(the explicit disabled state). This preserves the old baseline API without
confusing a baseline mode with a disabled policy.

JSON and TOON serialize integer strings and state tags without BigInt values or
nonfinite numbers. Existing finite numeric cutoffs also round-trip because their
canonical decimal value is the boundary used by both fitting and application.
The test suite directly pins the existing TOON codec for real encode/decode tests;
production dependencies and the pinned PM SDK are unchanged.

## Audit and laws

The previous [cutoff audit](exact-cutoffs.md) still applies. Every `compareExact`
policy call now delegates to `compareThreshold`. Exact margin derivation and
negative-complement handling are centralized here. Effective duplicate-policy
strictness selection also uses the shared comparator. Integer bounds and the
binary stepping primitive remain implementation checks, not fitted metrics.

`test/threshold-laws.test.ts` contains both review cases and:

- Seed `0x26f17a`: 2000 random calibration sets, including float-noise values,
  ties, zero, one and near-boundary probabilities. Numeric and tagged application
  reproduce fitting's row decisions and counts before/after JSON and TOON.
- Seed `0x26d15a`: 1000 unsupported policies exercise the released fit/metrics call
  forms and tagged disabled-state round trips without throwing.
- Seed `0x26c07f`: 500 pair, quality and cost fits preserve decisions and metrics
  after JSON/TOON round trips.

The existing 6000 exact count-vector cases and 500 replay/serialization sequences
remain. Frozen synthetic/type reports are regenerated only from their unchanged
saved observations to include cutoff state and coherent numeric curve boundaries.
No model inference or label changes are involved; the selected shipped type
margin remains unchanged.

## Raw producers are part of the fitting contract

Use `qualityObservation(pair, probability, label, retrieved)` to collect quality
calibration evidence. It computes the real title, distinct description/body,
tag and file overlaps, applies the exact decimal weights, and stores the lexical
score as a portable exact ratio. `qualityFrontier` and `fitQualityPolicy` retain
that observed ratio as the boundary. The command uses `qualityLexicalAccepts`
to recompute the same ratio and call `acceptsThreshold`; neither side converts
the ratio through a display number. The collection harness also uses this path.

```ts
const train = pairs.map(pair => qualityObservation(pair, 0.9, true, true));
const policy = fitQualityPolicy(train, "combined");
const accepted = pairs.filter(pair => qualityLexicalAccepts(pair, policy.lexical));
```

For `alpha` / `alpha beta` with empty descriptions and tags, the lexical score is
exactly `13/30`. Its numeric display is `0.43333333333333335`, which is strictly
above the ratio. Three correct raw pairs fit the exact tagged `13/30` boundary
and reapply with three true positives. Passing a rounded display number back as
an explicit cutoff instead requests that stricter decimal cutoff.

Historical scalar `QualityObservation.lexical` and numeric `QualityPolicy.lexical`
values remain accepted as literal decimal values for receipt replay. A saved
scalar cannot recover an original nondecimal ratio. New raw-pair fits must use
the exact observation factory; `duplicateSimilarity` is a display/legacy view.
Previously published receipts and frozen numeric production settings are not
silently reinterpreted or refitted without their original raw evidence.

`test/producer-reapplication.test.ts` goes through actual producers from raw
items, labels and probability distributions, then fits and reapplies each policy
before/after JSON and TOON serialization. Its inventory is also recorded on
pm item `pm-jev-t1h1`:

- Seed `0x27e2e1`: 500 raw lexical populations, every quality frontier point and
  fitted policy across all three arms, plus regenerated raw candidate retrieval
  and exact retrieval benchmark cutoffs. Empty evidence, bodies, tags,
  file links, Unicode and punctuation are included.
- Seed `0x27e2e2`: 1000 raw distributions exercise duplicate and related pair
  fits, type margins, Noul chosen-label confidence and gates, and mixed
  duplicate/type cost policies. Both enabled and disabled results occur.
- Seed `0x27e2e3`: 100 raw channel populations pass through actual temperature
  fitting/scaling and `calibratedAnswer`, with fitting/application counts checked
  on both repository splits and supported/unsupported fits.

The registered command fixed case uses a real SDK tracker outside git and a
loopback scripted model response. The earlier noisy margin, Infinity disabled
metrics, and inclusive drift review cases remain fixed raw-input regressions.
Drift thresholds and link margins are predeclared rather than fitted. Replay,
BM25/embedding retrieval and integer safety limits have no learned cutoff;
their existing raw-input tests remain alongside these fitting laws. Historical
scalar fitting unit tests remain separate from the raw-producer laws.

Candidate retrieval also retains a portable `score_cutoff` beside its numeric
`score` display. The corpus label builders preserve that exact channel score;
new lexical benchmark observations pass it as `lexical_score` to `fitPairCutoff`
and `pairMetrics`. Both fitting and application prefer that coordinate, so a
nondecimal retrieval ratio is never reconstructed from the rounded display.
Scalar-only historical observations retain their original literal-decimal
replay semantics. Use the typed fitter for these nondecimal exact boundaries;
the legacy numeric wrapper cannot represent an arbitrary rational losslessly.
