# Caller-cost abstention

`pm jev policy` selects a proposal filter using fixed labelled scores. No model
calls, retraining, label changes, settings writes or item mutations occur.
The SDK exports `selectAbstentionPolicy`, `parseCostDataset`, `abstainWithPolicy`
and their typed contracts from `pm-jev`.

```sh
pm jev policy --observations examples/cost-policy.json \
  --false-duplicate-cost 20 --wrong-type-cost 10 --missed-candidate-cost 1 --json
```

The [synthetic example](../examples/cost-policy.json) selects threshold `0.95`:
held-out coverage is 50%, cost is 1 across four examples (0.25 per example),
with zero false duplicates and zero wrong types. Costs `0.1, 0.1, 20` select
`0.8`, covering 100% at held-out cost 0.2. These are declared costs per event;
they need not sum to one. All three must be finite, nonnegative, at most one
million, and at least one must be positive.

The versioned JSON dataset contains at most 5000 rows in a file of at most 2 MiB.
Each row has a unique `id`, a nonempty `group`, `split` (`selection` or `heldout`),
`confidence` in [0,1], boolean `eligible`, and `task`:

| Task | Fixed labels | Withheld proposal |
| --- | --- | --- |
| `duplicate` | boolean `label`; the proposed decision is always positive | A true duplicate counts as one missed candidate; a negative costs zero |
| `type` | nonempty string `label` and fixed string `predicted` | Counts as one missed candidate |

An accepted incorrect type incurs only the wrong-type cost. A false duplicate
incurs only the false-duplicate cost. `eligible: false` represents an unavailable
candidate or an already vetoed proposal and is never overridden. Include
unretrieved positives with their original scores, or an explicit zero score when
unscored, so retrieval misses remain in denominators. Scores are opaque fixed
confidence values; the selector does not claim they are calibrated probabilities.

Declare provenance as `synthetic`, `public`, or `local-unverified`. This is caller
metadata, not automatic public-source verification. Preserve the local marker
for private evidence and keep private inputs and receipts out of public artifacts.
Receipts emit only hashes, costs, policies and aggregate measurements; they omit
ids, group names, labels, model prompts and input paths. Public publication still
requires source verification and review of aggregate disclosure.

Freeze groups before examining outcomes. Put entire repositories or connected
duplicate components in one split, and use independently labelled held-out groups.
The parser refuses any group shared across splits and requires both splits to be
nonempty. It cannot detect aliases or falsely declared group independence.
For mixed tasks, supply representative evidence for each task in both populations.

The curve contains 22 points: an explicit disable point (`threshold: null`) and
inclusive confidence cutoffs 0, 0.05, ..., 1. This fixed grid bounds work and output
and does not derive thresholds from validation scores. Select the lowest total
selection cost:

```text
false_duplicates * false_duplicate_cost
  + wrong_types * wrong_type_cost
  + missed_candidates * missed_candidate_cost
```

Costs within four relative machine epsilons are treated as rounding ties (for
example, `0.3` and `3 * 0.1`); there is no absolute tolerance floor for tiny costs.
Ties prefer fewer incorrect proposals, then more proposals, then the stricter
cutoff; a completely inactive tie prefers disable. Held-out cost and coverage
are descriptive diagnostics and never select a cutoff. Inspect the preselected
policy's held-out results; do not choose another point using the held-out curve.
Use a fresh held-out population after adapting costs to observed validation results.
Small or correlated samples cannot establish a production quality guarantee.
This feature has no precision qualification or automatic promotion path.

Default TOON and JSON return the same compact curve columns: threshold,
selection/held-out cost and coverage. `--full` adds every point's error and miss
counts; the selected point always includes those counts. Replaying identical
evidence and costs yields identical policies and hashes, regardless of row order.
Keep the dataset with the model/question/scoring configuration that produced it;
the receipt does not establish compatibility with a different model or corpus.

```ts
import { abstainWithPolicy, selectAbstentionPolicy } from "pm-jev";
import type { CostDataset } from "pm-jev";

/** Veto a previously checked proposal using a measured fixed-score policy. */
export function filterProposal(data: CostDataset, confidence: number,
  retrieved: boolean, mandatoryChecksPassed: boolean) {
  const report = selectAbstentionPolicy(data, {
    false_duplicate: 20, wrong_type: 10, missed_candidate: 1,
  });
  return abstainWithPolicy(report.policy, confidence, retrieved, mandatoryChecksPassed);
}
```

`proposal_only` means the filter passed, with `mutation_authority: none`.
It grants no ability to apply a type or create an edge. The existing live command
must still enforce its own measured thresholds, schema/model compatibility,
type margin, claims, freshness, mutation hooks and explicit `--apply` checks.
The selector does not install its threshold into existing command settings.
SDK callers must supply a real mandatory-check verdict; `false` always vetoes,
even with threshold zero and confidence one. A null threshold always abstains.

SDK failures throw `CostPolicyRefusal` with `code`, `message`, `remedy`. The CLI
returns `{ok:false, refusal:{code,message,remedy}}` and exit code 2. Codes are
`invalid_costs`, `invalid_dataset`, `split_overlap`, `insufficient_evidence`,
`input_unreadable` and SDK-only `invalid_policy`. Remedies describe the missing
evidence or correction without reflecting input data.

The command and SDK run in plain non-git trackers without git, GitHub, network
access or a model provider. Core owns stored decisions; pm-rl owns training and
promotion. Existing calibration owns probability/quality measurements; this layer
only chooses a caller-cost proposal filter over frozen scores.

## Public replay

[The receipt](../calibration/cost-policy-report-v1.json) replays #37's 156 fixed
duplicate scores (150 selection, 6 held-out), with no additional inference.
Three public commits were verified through GitHub and regular git archives,
copied into plain non-git directories and read completely through the SDK with
git absent from PATH. All 381 items, including two restored historical duplicates,
match the original data hashes. Seven sampled pair labels/retrieval flags were
reconstructed from those copies; authoritative tracker hashes stayed unchanged.

| False-duplicate / wrong-type / miss costs | Selected threshold | Selection cost / coverage | Held-out cost / coverage | Held-out false duplicates / misses |
| --- | --- | --- | --- | --- |
| 1 / 10 / 1 | 0.70 | 45 / 4.67% | 0 / 33.33% | 0 / 0 |
| 20 / 10 / 1 | 0.80 | 46 / 2.67% | 1 / 16.67% | 0 / 1 |
| 100 / 10 / 1 | 0.80 | 46 / 2.67% | 1 / 16.67% | 0 / 1 |

These confidence-only filters are additional vetoes; applying them to an existing
combined duplicate pipeline still requires its model and lexical gates.
The six held-out pairs include only two positives; controls are unrecorded
relationships, not independently adjudicated negatives. Shared items correlate
pairs. Type-cost behavior has synthetic coverage only. The public replay does
not certify a precision target or validate every historical source again.

Reproduce with an empty non-git scratch directory and the named public fleet clones:

```sh
node test/cost-policy.acceptance.ts <fleet> <empty-scratch> <report.json>
```
