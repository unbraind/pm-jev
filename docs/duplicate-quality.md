# Precision-first duplicate proposals

Duplicate proposals cost work when wrong. Pair scans therefore require both a
semantic lexical score and a local model probability to clear frozen cutoffs.
Pairs below the lexical cutoff skip model inference and return `decision: abstain`,
`probability: 0`, `reason: unsure_below_lexical_cutoff`. The zero is an unscored
sentinel, not a measured probability. Pairs at or above the lexical cutoff still
ask the model and return `reason: unsure_below_calibrated_confidence` when its
score is insufficient. Model probabilities are raw model output; the
precision constraint calibrates a decision threshold, not a probability estimate.
Models without an enabled measured duplicate policy skip inference and return
`decision: abstain`, `probability: 0`, `reason: unsure_uncalibrated_model` for
every candidate, including explicitly opted-in hosted scans. The zero is a
sentinel for an unscored pair, not a measured model probability. Null cutoffs
disable inference too; known calibration entries retain their digest checks.

The [public receipt](../calibration/duplicate-quality-report-v3.json) records 156
pairs from 30 public snapshots: 52 positive pairs (35 in the historical report),
including three recovered deleted records and closure-component siblings. Train
contains 50 positives and 100 controls; held-out contains only two positives and
four controls, from two positive-source repositories.

| Held-out arm | TP / FP / FN | Precision | Recall | Abstention |
|---|---|---|---|---|
| Lexical-only | 0 / 0 / 2 | undefined (no proposals) | 0% | 100% |
| Model-only | 1 / 0 / 1 | 100% (1/1) | 50% (1/2) | 83.3% (5/6) |
| Combined | 1 / 0 / 1 | 100% (1/1) | 50% (1/2) | 83.3% (5/6) |

The combined train point is 6 TP, 0 FP, 44 FN: 100% observed precision, 12%
recall and 96% abstention. Its frozen raw-score cutoffs are model
`0.7412531715646369` and lexical `0.6989304812834224`. Model-only selects the
same model cutoff. An inherited raw 0.8 floor unnecessarily limited train recall
to 8%; removing that restriction and searching the full **train-only** score range
finds the 12% point. This recalibration uses the unchanged one-shot observations;
no model request was rerun and no held-out score selects a cutoff.

After adding independent bounded exact-title retrieval, replay verified the
original data hashes for all four positive-source repositories, including the
three recovered deleted records. Rebuilding their complete candidate graphs and
hard-control selection reproduces all 156 pair identities, retrieval flags,
lexical scores and model-input hashes. Train-only refitting and every held-out
arm/frontier metric remain unchanged, with zero additional model calls. The
receipt's `retrieval_replay` records this check and the source hash.

The held-out point estimate clears the 80% precision target, but one correct
proposal is weak evidence: its descriptive 95% Wilson precision interval is
20.7%–100%. The 95% recall interval is 9.5%–90.5%. The compact frontier in the
receipt retains nondominated train precision/recall points and an explicit disable
point; their held-out scores are descriptive only. Follow-up `pm-jev-xgo9` owns
independent public annotation and additional positive-source repositories.
The historical v2 split, question catalog and model digest differ, so its 50%
precision / 37.5% recall is not a controlled before/after comparison.

Candidates combine title, description/body trigrams, tags and linked file/doc
paths. A separate title channel preserves short titles despite unrelated long
bodies. Bounded exact normalized-title groups supply independent candidates even
when common title trigrams are removed as stopgrams and no other signal overlaps.
The semantic score used by the lexical and combined arms weights token
Dice overlap: title 0.65, distinct description/body 0.30, tags/files 0.05. These
weights were fixed before inference. Generic shared tags alone cannot qualify a
pair as a duplicate. The production semantic projection and model question catalog
are the same ones used by the benchmark. New scans ask only the typed `same_work`
question; they do not spend a second inference on auxiliary related-work proposals.

The public corpus reader checks source origins, public visibility, public commit
reachability and regular committed archives, then performs certified complete SDK
reads. Source trackers are never changed. The expanded label builder reads explicit
terminal duplicate closures and reconstructs explicitly deleted duplicates from
public append-only history. It builds equivalence components, including sibling
pairs; reciprocal duplicate closures count once. Missing targets and self-links
are excluded. Controls are the hardest production candidates from positive-source
repositories whose members are in different components and have different semantic
projections. Such controls are unrecorded duplicate relationships, **not**
independently adjudicated negatives.

Whole repositories are assigned before inference using SHA-256 over
`["duplicate-quality-20261021", repository]`: first hex digit below `8` is train,
otherwise held-out. Positive sampling uses the historical deterministic pair hash,
capped at 50 per split, plus two hard controls per positive. All retrieval misses
stay in recall denominators. The benchmark evaluates the complete eight-neighbor
candidate graph (at most eight times the item count), rather than one default
20-pair production invocation. A smaller production pair limit can reduce recall
further. Sibling pairs and repeated items are correlated;
adding them increases pair coverage, not the number of independent duplicate groups.

Each arm uses the same labelled population. Lexical-only requires candidate
retrieval and its semantic score; model-only scores all labels, including retrieval
misses; combined requires retrieval and both channels. Every withheld proposal,
including a retrieval miss, counts toward the abstention rate. No arm predicts
negative work as a confident distinct verdict.

Cutoffs search the full observed **train-only** raw-score range. Raw model scores
are not calibrated precision. Choose the
highest train recall subject to empirical precision at least 0.8 and at least three
proposals. Break ties by precision, then stricter model and lexical cutoffs. If no
point qualifies, both cutoffs are null and every row abstains. The compact precision/recall frontier reports
held-out results for nondominated cutoffs generated on train; those results never select or
change a deployed cutoff. Wilson intervals describe the counts; they do not remove
shared-item correlation or certify generalization to new repositories.

The committed report records provenance, repository assignments, pair identities,
input hashes, raw observations, cutoffs and replayable metrics without tracker
text. The historical v1/v2 reports remain unchanged; they have different labels
and splits and are not directly comparable quality estimates.

Run a fresh collection and one-shot inference separately:

```sh
node test/duplicate-quality.acceptance.ts collect <fleet-directory> <empty-scratch-directory> <report-file>
node test/duplicate-quality.acceptance.ts infer <fleet-directory> <scratch-directory> <report-file>
```

Inference refuses an existing `inference` directory. A failed run retains its
samples/start/checkpoints as evidence; start another invocation with a fresh
collection. There are no automatic retries or partial-run resumptions. Raw public
tracker text remains in scratch; do not commit it.

Proposals add only links and receipts. They never merge, close or delete items.
The default uses the fitted cutoff directly; an explicitly configured
`jev.min_confidence` or `--min-confidence` only tightens the calibrated model cutoff. Models
without a measured policy abstain. Model digest drift refuses the run before any
links are written. Pair scans work on real plain-directory trackers with Git
absent from PATH; collecting committed public sources separately requires Git
and authenticated public GitHub inspection.

## Validation

Validation requires both `npm run release:check` and `bun run release:check`
under disposable HOME and disabled global/system Git configuration. Coverage
thresholds remain 100% for statements, lines, functions and branches across
runtime/script sources; the duplication threshold remains zero. The gates also
check declaration documentation, production audit, public provenance, package dry
run, changelog and publish attestation. The PR body records the current run counts.

Independent exhaustive train-only search checks 20,700 combined cutoff points,
150 model-only points and 138 lexical-only points and selects the same policies
as the compact frontier. Behavioral reverts of title-only retrieval, close refusal
and the precision-first fitting objective fail their fixed regressions; restored
sources pass. Real SDK plain-directory tests use an empty executable PATH and a
Git ceiling. Historical receipt replay remains unchanged.

New calibration collection retains lexical scores as exact tagged ratios using
`qualityObservation`; production recomputes them with `qualityLexicalAccepts`.
Use these SDK functions when fitting from raw pairs. `duplicateSimilarity`
remains the numeric display view; a rounded score is insufficient to reconstruct
its original boundary. See [the shared threshold domain](threshold-domain.md#raw-producers-are-part-of-the-fitting-contract)
for the `13/30` example, compatibility rules and end-to-end laws.
