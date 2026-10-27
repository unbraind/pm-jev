# Exact policy cutoffs

Count-derived policy decisions use the single comparator from `threshold.ts`,
also re-exported as `compareExact` from `exact.ts`. See the
[fit/apply domain, compatibility states and laws](threshold-domain.md). Fractions
retain integer numerators and denominators as BigInts, reduce intermediate
arithmetic, and compare by cross multiplication. There is no epsilon or rounded
percentage in a decision. Decimal thresholds are parsed as decimal rationals,
including scientific notation. Existing numeric SDK contracts interpret a
JavaScript number's canonical decimal spelling; the drift schema also accepts
decimal strings so a caller can retain digits beyond Number precision. Use
strings in drift JSON when the original decimal lexeme must be preserved.

`displayExact` and `displayRatio` convert to numbers at the report boundary.
They handle subnormal decimals without overflowing the denominator. Displayed
numbers never flow back into a count-derived qualification or policy ranking.
Reports remain JSON/TOON compatible; internal BigInts are not serialized.

## Cutoff audit

The audit searched every root TypeScript source for threshold, cutoff, target,
precision, recall, F1, margin and probability comparisons. This is the resulting
routing map:

| Source | Exact decision path |
| --- | --- |
| `calibration-drift.ts` | TV from integer category vectors, explicit-label rates and their difference, decimal thresholds, integer evidence minima |
| `calibration.ts` | Inclusive score cutoffs; empirical precision from correct/accepted counts; positive-gate precision from TP/positive counts |
| `type-calibration.ts` | Positive margin cutoff and empirical precision qualification from counts |
| `decision-calibration.ts` | Inclusive model-score cutoffs; Wilson qualification from correct/count and the exact score inequality |
| `dedupe-evaluation.ts` | Inclusive lexical/model cutoffs, minimum support, F1 maximization as `2TP/(2TP+FP+FN)` with strict improvement |
| `duplicate-quality.ts` | Score cutoffs, reduced-ratio frontier identity, precision/recall ordering, strict frontier dominance, empirical precision/support qualification |
| `cost-policy.ts` | Proposal cutoffs, exact count-weighted decimal costs, cost/error/coverage/strictness ordering; no epsilon ties |
| `dedupe.ts` | Exact Dice retrieval ordering and weighted lexical cutoff from token counts; inclusive positive and exclusive half-probability guards; exact decimal negative complements |
| `index.ts` | Triage/link margin, proposal/apply cutoffs, receipt policy reuse, gate outcomes and the declared priority tie tolerance |
| `policy-replay.ts`, `counterfactual.ts` | Existing model-score cutoffs and the inclusive half-probability decision |
| `evaluation-command.ts`, `exemplar-retrieval.ts` | Target-precision domain check; count-derived token/exemplar means and kNN vote displays |

Integer loop limits, array/file bounds and schema checks are not fractional
policy metrics. Package release coverage gates delegate to the existing Node,
c8 and fleet gate tooling; their thresholds have not been changed. The PM SDK
continues to own tracker state, status registries and its own similarity engine.

Provider probabilities and externally supplied lexical scores are declared
finite decimal inputs, not reconstructed counts. Model temperature scaling,
log loss, BM25 logarithms and embedding norms are real-valued approximations;
this change does not claim an exact rational logarithm or square root. Wilson
intervals remain approximate display diagnostics, but qualification no longer
compares their rounded lower bounds. It evaluates the score inequality with
exact count fractions and the declared decimal z value. At target one, a
nonzero z cannot qualify; empty evidence cannot qualify.

The existing type-calibration artifact was replayed from its unchanged saved
observations. Only two displayed margin-curve coordinates changed by one ULP;
its selected threshold, labels, model identity and decisions are unchanged.
The two historical duplicate receipts also re-render five F1 display values
from their unchanged TP/FP/FN counts. Their fitted cutoffs remain unchanged.
No inference calls were made to update these artifacts.

## Regression evidence

`node --test test/exact.test.ts` includes the two review cases: label errors
increase from 1/10 to 3/10 at inclusive cutoff 0.2, and binary TV increases from
0/10 to 1/10 at inclusive cutoff 0.1. Both recommend abstention/recalibration.

Seed `0x26ca1b` drives 6,000 cases with random category vectors, unequal sample
sizes, explicit error counts, decimal thresholds, and additional wide count
vectors whose cross products exceed Number.MAX_SAFE_INTEGER. Every case checks
the comparator, drift SDK verdict and empirical precision fitter against an
independent, unreduced BigInt reference. There are 1,500 exact-TV boundary cases;
each verifies inclusive and exclusive cutoff semantics. The suite also checks
Wilson qualification against an independently rearranged exact inequality,
long decimal thresholds, subnormal values, malformed inputs and disabled-policy
sentinels. The original 500 seeded replay/serialization sequences remain.
