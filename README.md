# pm-jev

Typed, local-first System One decisions for [pm-cli](https://github.com/unbraind/pm-cli)
items, using the official [TypeSafe JavaScript SDK](https://docs.typesafe.ai/sdk/javascript).
This is the v0 development slice; it has not been published. Companion specification:
`pm-cli-website-flnt`. Project management is context management: supply relevant item
state, ask independent typed questions, and keep authorization and arithmetic in code.

The default provider is local Ollama with `tev1:4b`. Jev is TypeSafe's System One
model, not a coding or text-generation model. Code handles candidate ranking, priority
mapping, probability thresholds, retries, deadlines and pm history. TypeSafe's RLCD
training is separate from the pm-rl evaluation work.

## Install and check

Requirements: Node 22.18 or newer, pm-cli 2026.10.5 or newer, and Ollama with a
decision-capable model and the `/v1/systemone` API. Bun is also supported.

From a built local checkout, install into a scratch or existing pm project:

```sh
npm install
npm run build
npm pack --ignore-scripts
# In the destination pm project, install the archive directly:
pm install ./pm-jev-2026.10.5.tgz
pm jev doctor
pm --json jev models
```

Pull the default model if needed:

```sh
ollama pull tev1:4b
```

pm-jev exports a library and a pm extension, with no standalone executable. npm and
Bun consumers can import `pm-jev`; commands run through the host executable with
`npx --no-install pm jev …` or `bunx --no-install pm jev …` when pm is installed.
Use `bunx --bun --no-install pm jev …` to force a native Bun host run; bare
`bunx` may follow pm's Node shebang.
The host installs and activates the packed extension, including its dependencies.
For a library consumer, use `npm install ./pm-jev-2026.10.5.tgz` or
`bun add ./pm-jev-2026.10.5.tgz` with a compatible pm host installed in that project.
Use the host-owned `--json` global flag; pm-jev declares no competing JSON flag.
Default text/TOON decisions round probabilities, confidence and scores to three decimals.
Choices show the top three options plus the chosen option when needed, with
`omitted_options` counting hidden options; dedupe candidate details follow that selection.
Use `--full` on triage, dedupe, ask or gate for full precision and every option.
`--json` and `--output-format json` always retain full precision and every option.
Receipt comments continue to round probabilities to two decimals.
Runtime tracker paths come from the host and SDK, including custom pm storage roots.

## Commands

| Command | Result and side effects |
| --- | --- |
| `pm jev triage <id>` | One batch proposing type, priority, needs_human and sensitive; no writes. |
| `pm jev triage <id> --apply --min-confidence 0.8` | Apply qualifying type/priority changes and append a receipt comment. |
| `pm jev triage --open --type Issue --limit 20` | Stream compact proposals for a bounded open backlog; no writes. |
| `pm --json jev triage --open --apply --min-confidence 0.8 --refresh` | Emit JSON lines, apply qualifying changes, and refresh matching receipts. |
| `pm jev link <id> --limit 8` | Rank candidates and batch typed relationship proposals; no item or history writes. |
| `pm jev link <id> --apply --min-confidence 0.8` | Add qualifying new SDK edges and one receipt; hierarchy requires `--allow-parent`. |
| `pm jev link --open --limit 20` | Stream a bounded open backlog with changed/would_change/skipped/failed counts. |
| `pm jev dedupe --title "Fix login crash" --body "Details" --limit 8` | Rank all tracker items in code, then choose a candidate id or `none`. |
| `pm jev dedupe --status open --type Issue --limit-pairs 20` | Verify bounded existing pairs with a typed same-work proposition and an abstain band. |
| `pm jev dedupe --apply --close --min-confidence 0.95` | Link qualifying newer duplicates and optionally close them; never delete. |
| `pm jev ask <id> --questions questions.json` | Validate and answer caller-defined choice, score and noul questions. |
| `pm jev gate --noul "The text contains credentials or private data." --text "Synthetic text" --threshold 0.5 --expect false` | Exit 0 when the proposition does not hold; exit 1 when credentials/private data are detected. |
| `pm jev gate --noul "Does this item need human input?" --item <id>` | Evaluate the minimal item projection instead of text. |
| `pm jev models` | List decision models and the discovery source. |
| `pm jev doctor` | Diagnose configuration, privacy opt-in, reachability and model availability without sending item state. |

Gate output uses `holds` for `probability >= threshold` (equality counts as true),
`expected` for `--expect true|false` (default `true`), and `ok` for `holds === expected`.
The comparison uses full precision before display rounding; exit status is `ok ? 0 : 1`.
The former `passed` field has been removed. Operational errors remain errors.

| `holds` | `expected` | `ok` | Exit |
| --- | --- | --- | --- |
| true | true (default) | true | 0 |
| false | true (default) | false | 1 |
| true | false (secret/private-data gate) | false | 1 |
| false | false (secret/private-data gate) | true | 0 |

Triage projects title, description, distinct body and nonempty tags. It omits
current type/priority/status from model input and avoids repeating description as body.
Ask retains title, type, description, body, tags and status. Text
fields and free gate text are bounded to 4,000 characters; tags to 32 entries of
128 characters. Comments, history,
authors, linked files and paths from tracker metadata are excluded. A path or secret
written inside title/body still belongs to that content: the `sensitive` answer is
a proposal, not a sanitizer or an authorization rule.

Triage reads the project's actual configured item types through the pm SDK. Each
candidate has a one-line registry description; built-ins fall back to canonical
semantics and undescribed custom types retain their name and registry folder metadata.
An explicit keep-current candidate includes the current type and its definition in
the question, while routing fields remain excluded from the evidence state.
A new type needs at least 0.8 top-label probability even if the apply flag is lower.
Close top-two labels abstain before this keep-current rule: the proposal value is
null with `abstained: true` and an explicit reason. The measured margin cutoff and
its held-out trade-off are documented in [type calibration](docs/threshold-calibration.md).
Default TOON retains compact probabilities and the policy outcome; `--full` and
JSON include every probability and the definitions used. The priority rubric is index-aligned with pm:
0 critical, 1 high, 2 medium, 3 low, 4 minimal. The highest-probability priority level
wins, with ties going to the lowest index. Probability is distinct from the model's
reported confidence. `--apply` compares each proposed field's probability to the
threshold, updates only qualifying changed type/priority fields through the SDK,
and records resolved model, catalog version, rounded probabilities and applied fields.
A receipt is also appended when no field qualifies. Qualifying fields and the receipt
are submitted together in one SDK update, preserving the host mutation and history contract.
Inference source is re-read before returning proposals; an item-lock mutation guard
also refuses stale writes. Batch receipts hash full title/description/body/tags/status,
including text beyond truncation, while excluding inferred type/priority and annotations.
The hash therefore remains valid after applied routing writes. A matching current-catalog
receipt skips inference unless `--refresh`; dry runs never append receipts.

Backlog selection uses the host's role-derived open lifecycle bucket, type normalization,
ordering and strict reads. `--limit` defaults to 20 and accepts integers from 1 to 1000.
One total deadline covers the invocation, with a shared abort signal across requests
and retries. One client and question catalog are reused; Ollama model residency is
kept warm through `keep_alive`. Each selected item produces one compact TOON table row
or one JSON line, followed by changed/would_change/skipped/failed counts. Counts are
items, not fields; unchanged or low-probability proposals are skipped. Stale inference
is skipped without a receipt; operational failures count as failed and exit 1.
`--type`, `--limit`, `--refresh` require `--open`; an id and `--open` are incompatible,
and `--full` is single-item only. See [batch contracts and limits](docs/batch-triage.md).

Dedupe uses a complete, fail-closed SDK read, deterministic title similarity, stable
id tie-breaking and a bounded candidate list. Run it before `pm create`. Both duplicate
and no-duplicate decisions exit 0; operational failures remain errors so agents do not
interpret an unavailable model as permission to create a duplicate. With no candidates,
code returns `none` without inference (zero usage and the configured model name).

Link resolves supported canonical dependency kinds through the host SDK, adds `none`,
and reuses dedupe ranking plus the type-calibration margin abstention rule.
Existing edges, including inverse and symmetric representations, never become
proposals. Single-item `--limit` bounds candidates (default 8, maximum 50); with
`--open` it bounds source items and each source ranks up to 8 candidates.
The bounded projection follows triage privacy rules. A request above 64 KiB fails
before transfer; reduce the candidate limit. Dry-run preserves authoritative tracker
files; host SDK reads can populate disposable runtime caches and context-usage records.
See [relationship proposals](docs/link-proposals.md) for the contract and local acceptance.

A questions file is a nonempty JSON object following the SDK `Questions` contract:

```json
{
  "route": {
    "type": "choice",
    "instructions": "Is this broken behavior or a new capability?",
    "criteria": { "bug": "Existing behavior is broken", "feature": "New capability" }
  },
  "impact": {
    "type": "score",
    "instructions": "How severe is the impact?",
    "criteria": ["minor", "major", "critical"]
  },
  "blocked": { "type": "noul", "instructions": "Are users unable to proceed?" }
}
```

Instructions and criterion descriptions may be text, JSON objects/arrays, or null;
instructions may be omitted. Choice needs 1–255 labels; score needs at least two levels. Noul optionally accepts
`criteria.true` and `criteria.false`; absent/null noul criteria are omitted on the wire
because Ollama rejects explicit `criteria: null`. Every response is checked for known
question names, answer types, exact option keys, finite probabilities, normalized
distributions (2% rounding tolerance), score range, matching legend, model and usage.
Malformed output is rejected before any item update.

## Existing-item duplicate scans

Without `--title`, `pm jev dedupe` reads complete metadata and bodies through the
SDK's certified `listAllComplete({includeBody:true})` contract. This preserves full
read semantics even on hosts where `list --all` returns brief rows. `--status open`
(the default) selects nonterminal states; `--status all` includes terminal items.
`--type` is case-insensitive. Pre-create `--title` screening remains available and
rejects scan-only flags.

Candidate generation uses Unicode-normalized title, description and body character
trigrams with Dice overlap, an inverted index, and eight neighbors per item. In
large trackers it removes trigrams occurring in more than max(64, 2% of items)
documents before scoring. These corpus-frequency stopgrams keep common boilerplate
from dominating work; a normalized-text fallback preserves identical semantic
groups, including punctuation variants, even when all their trigrams are common.
The global score order is stable; `--limit-pairs` defaults to
20 and accepts 1–200. No lexical issue-code heuristic promotes UTF-8 to a near-exact
match. Model input is limited to each title's first 320 characters and 1600
characters of distinct description/body; closure labels, ids and annotations are
excluded. This truncation can hide useful evidence and is recorded as a limitation.

Each pair asks the same typed `same_work` noul question through the existing client,
validation, retries and deadlines. Calls run sequentially under one invocation
deadline. Output rows contain `{a,b,probability,decision,reason}`, newer item first,
with creation-time ties broken by id. At cutoff t, p≥t proposes a duplicate,
p≤1−t proposes distinct work, and the middle band abstains. An exact 0.5 always
abstains. Explanations name the deterministic rule; they are not model rationales.
The real-label dev split fits cutoffs 0.8340513300400778 for `tev1:0.8b` and
0.8 for `tev1:4b`. The effective cutoff is the greater of its
operating point and the requested/configured min-confidence. Other models retain
the existing 0.8 floor without a measured pair calibration. Measured local models
must match their recorded digest both before and after inference; both digest
reads share the invocation deadline, including in preview. These cutoffs
maximize dev F1 subject to the floor, at least three positive predictions and one
true positive; they are not a high-precision qualification.

`--apply` writes only duplicate verdicts, through the SDK, with a `related` edge and
a directed canonical-id receipt comment: the pinned SDK has no `duplicate-of`
mutation kind. Closing additionally requires `--close`; the reason is exactly
`duplicate of <canonical-id>`. An operational inference failure happens before any
write. Evidence is re-read before apply and the source receipt is checked under the
item lock. A canonical item and a modified source are protected from becoming
duplicate chains within that batch. The SDK records link/comment updates and
closure as separate history events. The link guard retains its exact post-link
revision for the live close attempt; the close lock checks that revision and the
receipt deadline even though closure adds no comment. A changed item, expired
deadline or historical receipt receives `jev_stale_inference` for that directed
duplicate closure; the item stays open
and its prior link and receipt remain. Retry the scan to obtain fresh evidence; a later ordinary closure remains available.
There is no cross-item transaction or rollback promise. The canonical target is
rechecked before the update but is not locked
together with the source. Repeated invocations can append another receipt.

### Real duplicate-label measurement (2026-10-19)

[Versioned receipt](calibration/dedupe-report-v1.json) contains public repository
identities, source commits, complete SDK corpus hashes, pair ids/hashes, raw
probabilities, retrieval misses, timings and metric replay data. Sources were
verified with `gh repo view --json visibility`, copied with `cp -a` to disposable
directories, and read through the SDK without extensions. There were 29 available
verified public trackers, including the public upstream pm-cli tracker. The
estimated larger fleet/label counts were not reproduced: 35 terminal closures had
an explicit, resolvable duplicate target (31 historical consolidation receipts and
four standard closures). These are real tracker labels, not model-generated truth.

The deterministic label builder in `dedupe-evaluation.ts` assigns entire resolved
duplicate groups to dev or held out using SHA-256 of seed `dedupe-20261019`, public
repository and canonical id. Controls require both sides in one split, come from
the same repositories and are the candidate generator's highest-scoring pairs
outside known duplicate groups. Identical semantic projections are excluded as
ambiguous controls. There are 81 dev pairs (27 positives/54 controls) and **24
held-out pairs (8 positives/16 controls)**; item ids do not cross splits. Eight
positive pairs miss top-eight retrieval, including one held-out positive; these
count as false negatives rather than disappearing from the denominator.
Retrieval is measured before the invocation's global pair cap; a smaller scan cap
can omit additional pairs.

Threshold selection maximizes dev F1 over observed cutoffs, with ties choosing the
lower cutoff. Models retain the existing 0.8 probability floor and require three
positive predictions including one true positive. The lexical cutoff is 0 (accept
every retrieved pair); model cutoffs are 0.8340513300400778 and 0.8 respectively.
This fits operating points, not probability calibration or a precision guarantee.

| Arm | Precision, 95% Wilson CI | Recall, 95% Wilson CI | F1, Wilson envelope | Abstain, 95% Wilson CI | Mean latency/pair | Recorded arm wall |
| --- | --- | --- | --- | --- | --- | --- |
| Lexical only | 30.4% [15.6, 50.9] | 87.5% [52.9, 97.8] | 45.2% [21.8, 69.5] | 0% [0, 13.8] | 0.062 s | 6.5 s |
| tev1:0.8b | 46.2% [23.2, 70.9] | 75.0% [40.9, 92.9] | 57.1% [26.6, 82.5] | 41.7% [24.5, 61.2] | 0.893 s | 94.8 s |
| tev1:4b | 62.5% [30.6, 86.3] | 62.5% [30.6, 86.3] | 62.5% [27.2, 88.1] | 16.7% [6.7, 35.9] | 5.572 s | 589.6 s |

The F1 envelope propagates Bonferroni 97.5% Wilson precision/recall bounds through
their harmonic mean. It is an approximate conservative envelope, not an exact
binomial interval for F1. Pairs share items and are correlated; these intervals do
not establish independent population guarantees. Controls are closed-world
non-edges, not independently adjudicated negatives; missing duplicate links can
inflate false positives. The small split, historical closures, concentrated source
repositories, shared templates, bounded prompt evidence and one local run limit
transfer. Model point estimates improve F1 here, with lower recall and wide,
overlapping uncertainty. The 4b dev F1 was only 14.8%; its better held-out result
does not establish stable generalization. These numbers do not justify unattended
deduplication.

Inference was niced and sequential. Each model arm used **107 calls**, below 200:
105 scored pairs, one excluded identical-text control and one replacement inference
repeated after a postprocessing assertion aborted before persistence. That attempt
is counted; its probability/latency was not retained. Final replacement observations
are persisted before validation. Mean model latency uses the 105 retained scored
observations. Recorded arm wall includes the initial run and final replacement;
the unretained attempt has no separate duration. Total elapsed wall from the first
inference receipt through final publication, including postprocessing and repeats,
was **810.5 s**. The initial exploratory 95%-precision constraint selected no small
model cutoff; the receipt explicitly records the change to dev-F1 selection.

To reproduce, verify the public sources listed in the receipt, copy each tracker
to scratch, obtain certified complete SDK items with `includeBody: true`, and feed
`{repository,commit,items}` records to `labelledPairs(corpora,30)`. The builder
recreates the split and controls; for each row run `runDecision` with `pairState`
and `PAIR_QUESTIONS` from `dedupe.ts`, using the existing local client. Verify model
digests before/after, keep calls sequential and fit only dev observations with
`fitDuplicateThreshold`. `duplicateMetrics` scores held-out observations, including
retrieval misses. Persist `pair_id: "repository:a:b"` on every serialized sample
and scored model observation before writing evaluation progress or the final report.
The receipt's pair ids were added from its existing sample order without rerunning
inference: the same evaluation script produced observations in that order, and
this alignment is trusted for the backfill. Replay verifies every stored id against
the sample's repository and item ids before splitting; regressions reject cross-split
swaps even when thresholds and all metrics remain unchanged.
The committed artifact replays without inference:

```sh
node --test test/dedupe-evaluation.test.ts
```

Delivery checks: `npm run release:check` and `bun run release:check` both pass
232/232 tests with disposable HOME and global/system Git configuration disabled.
All four measured coverage dimensions are 100%, and duplication is zero at the
unchanged thresholds. The pm-linked release selection passes 2/2 commands. The
focused tracker/replay suite passes 23/23 tests; the separate artifact receipt
suite passes 5/5. Independently disabling the positive cutoff
changes tracker bytes below threshold and fails the apply regression; forcing
closure without the close flag fails with `closed` versus `open`. Restored source
passes. The packed CLI's 20-row public pm-github-copy dogfood leaves authoritative
tracker bytes unchanged; its first ten verdicts are included in the PR.
A fresh `git clone --no-local` of the review candidate passes strict
health with required merge drivers and all four commit-identity tests, using the
pinned installed dependencies and isolated HOME/Git configuration. The delivery
receipt includes the configured-confidence regression and append-only tracker
evidence; measured calibration artifacts retain their original bytes. Pair scans
clamp a shared confidence setting below 0.5 while retaining the calibrated safety
floor; explicitly supplied pair confidence flags must still be between 0.5 and 1.

## How good are the decisions?

`pm jev eval` measures local decisions against the labels in committed public
fleet trackers. `pm jev calibrate` fits one temperature per task/model/question
channel on calibration repositories, then validates on different repositories.
Triage hides both the stored type and priority, including the keep-current hint;
only title, description and distinct body text enter inference. Types use the
tracker's actual definitions. Link labels come from SDK-canonical dependency
edges and their inverse directions, plus deterministic sampled non-edges.
Unrecorded relationships are **closed-world controls**, so their labels can be
incomplete. Multi-kind pairs are excluded from this categorical benchmark.
Dedupe uses explicit `duplicate_of`, type-option links or duplicate closure
resolutions with a target; missing-target controls remove that known duplicate
group. Retrieval failures are counted and prevent dedupe qualification.

The evaluator verifies public visibility with `gh repo view`, archives the exact
commit, and performs certified complete SDK reads in disposable snapshots.
Original trackers are never written. Receipts contain public repository names,
commit and tracker digests, example/question hashes and validated distributions;
they omit tracker text and local paths. Private repositories are skipped. Sources
must be `unbraind/pm-*` clones in a directory named `fleet`; the host CLI and
companion trackers are refused. Hosted data and external model endpoints are
outside this command's boundary.

Use at least two repositories with relevant ground truth. Run from the project
that should receive the calibration; every `--from` is a read-only source:

```sh
nice -n 15 pm jev eval --task triage \
  --from fleet/pm-alpha/.agents/pm --from fleet/pm-beta/.agents/pm \
  --model tev1:4b --sample 40 --seed 20261018 --retrieval lexical --json
nice -n 15 pm jev calibrate --task link \
  --from fleet/pm-alpha/.agents/pm --from fleet/pm-beta/.agents/pm \
  --model tev1:4b --sample 100 --seed 20261018 --target-precision 0.9
```

### Same-tracker exemplars

`--retrieval lexical|embedding` turns on retrieval-augmented evaluation for
triage and link tasks: for every sampled target the evaluator retrieves k
labelled exemplars (`--exemplars`, default 4, maximum 8) from the target's own
tracker, composes each exemplar's title/body excerpt plus its label into typed
prompt context under a token budget (`--exemplar-tokens`, default 1200, a
four-characters-per-token estimate including JSON array overhead), and asks the same validated
questions with and without that context. The effective budget is clamped to
the prompt headroom left by the base request, because the local System One
endpoint refuses prompts above 2050 tokens and never truncates input; targets
whose base request leaves no headroom reuse the plain-model answer and are
counted. Headroom uses the larger of the base request estimate and observed
plain-request input usage, with a tokenizer safety reserve. Malformed responses
are still rejected before anything is measured. Exemplars never include the target item,
any item created after it, or any item in the current evaluation sample, and
they come only from the target's own repository, so calibration and validation
repositories never share context. Lexical ranking is deterministic in-process
BM25 over title and body with stable item-id tie-breaks. `--retrieval embedding`
uses the local `qwen3-embedding:0.6b` model when it is installed (one batched
request per repository); a missing model or failed batch falls back to lexical
and the report records the fallback.

An exemplar run reports four arms for every channel: the majority class of the
target's eligible same-tracker pool, a kNN vote over the retrieved exemplars
(no model), the model without exemplars (exactly the legacy prompt), and the
model with exemplars. kNN uses uniform vote shares; equal shares follow question
schema order, with integer-like labels (including priorities) ordered numerically
ascending. All four carry accuracy, per-class precision/recall,
ten-bin ECE and the decile coverage/precision curve. Retrieval coverage,
reused baseline calls (targets with an empty eligible pool or whose first ranked
exemplar cannot fit the clamped budget get the plain-model answer for the exemplar
arm) and mean retrieved count are reported, and every
exemplar observation records retrieved ids/digests, the ids/digests that actually
fit the prompt, the effective budget, and a hash of the exact truncated context.
Receipts contain no exemplar text. Baseline accuracy and reliability use the
answered population; `abstained` exposes targets without eligible evidence.
Exemplars apply to `pm jev eval` and `pm jev calibrate`
only; the production triage/link/dedupe commands are unchanged.

The exemplar setting is part of the calibrated channel identity: `pm jev
calibrate --retrieval …` persists its receipt under a task/model/exemplar
settings key, so an exemplar-fit receipt never authorizes exemplar-free
production decisions, legacy receipts keep their historical task/model keys,
and both can coexist. Autonomous action still requires the unchanged one-sided
95% precision lower bound at the target; nothing about exemplars loosens it.

Repeat `--from` or supply additional tracker roots after its first value. Output
is TOON by default and full-precision JSON with `--json`. Sampling is seeded,
without replacement and balanced across repositories; changing the data commit
changes its identity. Evaluation defaults to 40 sampled examples and calibration
to 100; the hard cap is 150 examples per invocation. Exemplar runs can make two
requests per example (plain and augmented); requests are serial and evaluator
retries are disabled. Keep a shared
budget across invocations. Reports include accuracy, per-class precision/recall,
ten equal-width reliability bins, expected calibration error (ECE), NLL,
coverage/precision at decile thresholds, actual request latency and token totals.
A batched triage request yields two labelled observations; tokens are counted
once per request in the report totals.

Temperature scaling applies `softmax(log(p) / T)` with zero mass preserved,
minimizing calibration NLL on a fixed log-spaced grid from 0.05 to 20. It preserves
the winning label. This small-data choice follows
[Guo et al.](https://proceedings.mlr.press/v70/guo17a.html); isotonic fitting would
add flexibility without enough independent evidence here. A seed partitions
whole repositories, never individual items. Reproduce an older receipt with source
clones checked out at its recorded commits. The lowest candidate threshold whose
**one-sided 95% Wilson precision lower bound** reaches the target is frozen on
calibration data, then must pass that bound on held-out data. Confident `none`
answers cannot establish proposal precision. Sparse evidence leaves the threshold
`null`; no lower target is substituted. These bounds describe this benchmark,
not a guarantee for future projects or correlated items.

Calibration receipts are merged through the SDK's audited settings lock into
`jev.calibrations`, keyed by task and exact model tag, preserving other settings.
They pin the installed model digest and compatible question definitions. Matching
triage/link/dedupe decisions show calibrated probabilities, thresholds and a
receipt hash, alongside raw probability evidence. Unqualified channels authorize
no calibrated changes; a CLI threshold cannot bypass that refusal. An explicit
`--min-confidence` can raise a qualified threshold, but cannot lower it. Changed model
digests or question definitions use the legacy policy. With no matching receipt,
the existing 0.8 default, keep-current rule and margin abstention remain in force.
Calibrated triage removes the keep-current hint, retains margin abstention and
uses each channel's fitted threshold. Calibrated links evaluate one source/target
pair at a time to match the benchmark context; legacy links retain batching.
Calibrated backlog triage revisits receipts so a previous policy cannot hide a
new decision. Calibration never enables `--apply` by itself.

Measured 2026-10-18 on six verified public repositories (`pm-jev`, `pm-csv`,
`pm-graph`, `pm-vcs`, `pm-presets`, `pm-starter`). The machine-readable receipt
is [calibration/public-report-v1.json](calibration/public-report-v1.json).

| Task / model | Held-out n | Accuracy (raw = calibrated) | Raw ECE | Calibrated ECE | Raw 0.8 → calibrated gate |
|---|---:|---:|---:|---:|---:|
| Triage type / tev1:4b | 30 | 40.0% | 0.191 | 0.215 | 3 → 0 |
| Triage priority / tev1:4b | 30 | 53.3% | 0.133 | 0.118 | 0 → 0 |
| Link kind / tev1:4b | 21 | 47.6% | 0.096 | 0.151 | 0 → 0 |
| Triage type / tev1:0.8b | 21 | 4.8% | 0.519 | 0.093 | 0 → 0 |
| Triage priority / tev1:0.8b | 21 | 33.3% | 0.380 | 0.112 | 5 → 0 |

No channel qualifies at target precision 0.9: every saved threshold is null, so
zero proposals are authorized by calibration. These models are not good enough
for automated application under this policy on the measured workload. Type and
link calibration worsen held-out ECE; the smaller model's improved ECE comes from
reducing confidence, not improving its very low accuracy. Link and small-model
folds contain 19 calibration and 21 validation decisions, too few to establish
the requested uncertainty bound even with perfect accepted predictions. Their
reliability numbers are exploratory. The 4b triage folds contain 30 items each.

Gate counts are held-out confidence decisions before current-value, existing-edge,
hierarchy and margin guards; they compare the same benchmark prompt at raw 0.8
with the qualified calibrated policy. Source trackers were never modified.
Across all observed cases, raw 0.8 counts are retained separately in the receipt.
On the identical 40 triage examples, raw type accuracy is 50.0% for 4b versus
12.5% for 0.8b; raw priority accuracy is 60.0% versus 30.0%.

| Run | Successful requests | Mean request latency | Input / output tokens |
|---|---:|---:|---:|
| triage / tev1:4b | 60 | 15.34 s | 67758 / 180 |
| link / tev1:4b | 40 | 8.96 s | 23247 / 40 |
| triage / tev1:0.8b | 40 | 44.82 s | 45530 / 120 |

The niced serial run made 140 successful requests and one timed-out model-load
attempt: **141 of the 150-call budget**. The failed attempt was counted from the
service access log before restarting its cohort. Latency reflects runtime
placement and shared workload, not a general model speed ranking. The receipt
records all source commits, data/model digests, full distributions and class
metrics. No known duplicate targets were present in these six live source
trackers; dedupe ground-truth and calibration paths are covered by the committed
synthetic fixture. Partial failure receipts remain tracked in pm-jev-w1zj.


### Four-arm retrieval comparison (2026-10-19)

Fresh local Ollama runs on the same six historical source commits and the exact
first 40 seeded examples per task (seed 20261018), verified by archive digests
and example hashes. Retrieval used the fixed defaults k=4 and a requested
1200-token estimate budget; neither was tuned on evaluation outcomes. The
legacy table above uses held-out subsets; this comparison uses all 40 targets.
Full-precision distributions, per-class precision/recall, ECE bins, coverage
curves, model/data digests and calibration receipts are in
[calibration/exemplar-report-v1.json](calibration/exemplar-report-v1.json).

| Task | Arm | Answered | Accuracy (correct / answered) | ECE | Empirical coverage@90% |
|---|---|---:|---:|---:|---:|
| Triage type | Majority class | 40/40 | 35.0% (14/40) | 0.650000 | 0.0% |
| Triage type | kNN vote | 40/40 | 45.0% (18/40) | 0.164583 | 0.0% |
| Triage type | Model without exemplars | 40/40 | 50.0% (20/40) | 0.128936 | 5.0% |
| Triage type | Model with exemplars | 40/40 | 47.5% (19/40) | 0.253181 | 0.0% |
| Triage priority | Majority class | 40/40 | 57.5% (23/40) | 0.425000 | 0.0% |
| Triage priority | kNN vote | 40/40 | 55.0% (22/40) | 0.162500 | 0.0% |
| Triage priority | Model without exemplars | 40/40 | 60.0% (24/40) | 0.125581 | 10.0% |
| Triage priority | Model with exemplars | 40/40 | 42.5% (17/40) | 0.249607 | 5.0% |
| Link kind | Majority class | 34/40 | 35.3% (12/34) | 0.647059 | 0.0% |
| Link kind | kNN vote | 34/40 | 29.4% (10/34) | 0.588235 | 0.0% |
| Link kind | Model without exemplars | 40/40 | 40.0% (16/40) | 0.109593 | 10.0% |
| Link kind | Model with exemplars | 40/40 | 32.5% (13/40) | 0.154636 | 5.0% |

Exemplars **did not help**: all three accuracies fell and all three ECEs worsened.
kNN alone beats the exemplar model on priority (55.0% versus 42.5%), although
the plain model is stronger still (60.0%). The link baselines abstain on six
targets without eligible context; their accuracy and ECE are conditional on the
34 answered targets. Empirical coverage@90% is the greatest coverage over all
40 targets at the reported fixed decile thresholds with observed precision at
least 0.9. It is descriptive, and does not establish autonomous qualification.

Every fitted model channel remains unqualified: all six plain/exemplar
thresholds are null under the unchanged one-sided 95% precision lower bound of
0.9. These 40-example repository splits have 19 calibration and 21 validation
decisions per channel; even perfect folds this small cannot establish that
bound. The comparison is exploratory and enables no autonomous actions.

The complete cohorts made **153 successful model requests** (79 triage and 74
link), with seven validated plain answers reused when no budgeted exemplar
context was available. Triage clamped all 40 requested budgets; link clamped
35. The receipt distinguishes retrieved exemplars from the units actually sent.
The same link example that previously failed with an excessive 9,152-byte
request now succeeds with a 406-token estimate budget, two context exemplars
and 1,589 observed input tokens; its before/after hashes and statuses are
recorded without text. Earlier incomplete cohorts are excluded: one link run
had 52 successful model calls and one prompt-length refusal, and the earlier
triage call total is unavailable (pm-jev-w1zj). The 153 count covers only the two
complete resumed cohorts.

To repeat the comparison on these public trackers, keep their recorded commits
and run each task serially:

```sh
for task in triage link; do
  nice -n 15 pm jev eval --task "$task" \
    --from fleet/pm-jev/.agents/pm --from fleet/pm-csv/.agents/pm \
    --from fleet/pm-graph/.agents/pm --from fleet/pm-vcs/.agents/pm \
    --from fleet/pm-presets/.agents/pm --from fleet/pm-starter/.agents/pm \
    --model tev1:4b --sample 40 --seed 20261018 \
    --retrieval lexical --exemplars 4 --exemplar-tokens 1200 --json
done
```

## Configuration and privacy

Configuration belongs in the project's pm-owned settings document, resolved with
`getSettingsPath(pmRoot)` from the SDK. Add a `jev` section while preserving other
settings. There is no separate pm-jev configuration file or credential store.

```json
{
  "jev": {
    "provider": "ollama",
    "base_url": "http://localhost:11434",
    "model": "tev1:4b",
    "timeout_ms": 90000,
    "total_deadline_ms": 270000,
    "min_confidence": 0.8,
    "gate_threshold": 0.5,
    "keep_alive": "5m",
    "allow_external": false
  }
}
```

`PM_JEV_BASE_URL` and `PM_JEV_MODEL` override those settings. Without a `jev` override,
pm-jev falls back to the tracker's typed `providers.ollama` settings (`base_url`,
`model`), read through the pm SDK's `readSettings` projection — never by parsing
the settings file — and finally to its own decision-model defaults. So the full
precedence is: environment overrides, then the `jev` section, then
`providers.ollama`, then the built-in local defaults. The `providers.ollama`
fallback feeds the local provider only; hosted TypeSafe resolution ignores it, so
an Ollama endpoint can never silently become a hosted credential destination.
A non-loopback URL taken from `providers.ollama` still requires the explicit
`jev.allow_external` opt-in, exactly like any other URL source.
The per-attempt timeout is bounded to 1–600 seconds; total deadline to 1–3,600 seconds.
The default total deadline is at least 240 seconds and three per-attempt timeouts
(270 seconds with the default timeout). Settings thresholds are bounded to [0,1].
CLI probability flags outside that range fail. Dedupe defaults to 8 candidates, capped
at 32; invalid limits fall back to the default.
Ollama `keep_alive` accepts finite seconds (including zero or negative values), or
a duration such as `5m`; the default is `5m`. It is omitted for hosted TypeSafe calls.

Hosted configuration uses `provider: "typesafe"`, default base URL
`https://api.typesafe.ai`, default model `jev-latest`, runtime `TYPESAFE_API_KEY`, and
literal boolean `jev.allow_external: true`. Both the key and explicit opt-in are
required. Hosted credential destinations must use HTTPS. A custom HTTPS origin
(including a different port) must be supplied through `PM_JEV_BASE_URL`; tracker
settings alone cannot authorize it. A string `"true"` does not opt in.
Any non-loopback URL also requires opt-in,
even if the provider is named `ollama`; redirects are rejected. Credentials, query
strings and fragments are refused in the base URL. Request bodies are never logged,
and provider error bodies are omitted from public diagnostics.

External opt-in transfers the supplied projection to the configured endpoint; the
`sensitive` question cannot undo that transfer. Review the vendor's retention and
processing terms independently before opting in. Hosted live acceptance has not run
and is deferred until an API key and owner approval are available. This work sends no
requests to the hosted TypeSafe API.

The official SDK owns decision HTTP, timeout and retry behavior. pm-jev permits at most
two retries after the initial attempt for SDK retryable failures, including 429/529,
under an abort-enforced total deadline. The SDK's model listing is tried first. Local
Ollama 0.35.1 returns an incompatible OpenAI-shaped `/v1/models` payload, so discovery
falls back to `/api/tags` filtered on the `decision` capability. Discovery shares one
total deadline across both surfaces. Missing local models suggest `ollama pull`.

## Library

```ts
import { resolvePmRoot } from "@unbrained/pm-cli/sdk";
import {
  createJevClient,
  parseQuestionsDocument,
  projectItemState,
  requireCallableEndpoint,
  resolveJevEndpoint,
  runDecision,
} from "pm-jev";

const pmRoot = resolvePmRoot(process.cwd());
const resolved = await resolveJevEndpoint(pmRoot, process.env);
const config = requireCallableEndpoint(resolved);
const client = createJevClient(resolved, process.env);
const questions = parseQuestionsDocument({
  broken: { type: "noul", instructions: "Does the item describe broken behavior?" },
});
const state = projectItemState({
  id: "synthetic-example", title: "Login crashes", type: "Issue",
  status: "open", tags: [], description: "An unhandled exception closes login",
});
const result = await runDecision(client, config, state, questions);
```

`runDecision` accepts an already-configured official SDK client. Library callers are
responsible for using the gated client factory, projecting their state and authorizing
any subsequent actions. Library inference itself never mutates a tracker.

## Verification and release boundary

```sh
npm test
npm run coverage
npm run typecheck
npm run lint
npm run duplication
npm run docstring
pm health --strict-exit --json
npm run test:live
npm run test:install
npm run release:check
```

Unit/integration tests use `node:test`, a real in-process HTTP server, the official
TypeSafe client, the SDK's `createExtensionTestHarness`, and real disposable trackers
initialized by `pm init`. Coverage inventories every source file, including scripts,
and enforces 100% statements, branches, functions and lines with no source exemptions.
The docstring gate uses both the fleet analyzer and a full TypeScript syntax tree to
check every function, callback and export. CI checks Node 22/26, lint, duplication,
coverage, pm health, package contents, production dependencies, changelog and publication
attestation, plus Bun dependency installation. CodeQL and Dependabot workflows are included.

`test:live` calls the real local tev1 model for triage, dedupe, mixed ask, positive gate
and secret/clean safety gates using synthetic data. `test:install` installs packed artifacts with
npm and Bun, installs a local directory extracted from the packed artifact with `pm install` into a scratch project,
then runs real triage through npx/bunx and checks a negative CLI gate's JSON/exit status.
Both need local Ollama and run separately from CI, whose runners have no Ollama model.
See [the v0 validation receipt](docs/v0-validation.md) for measured evidence.

The daily release workflow generates CHANGELOG.md and release notes with pm-changelog.
Generation and drift checks include closed and in-progress implementations;
tracker closure remains the orchestrator's verification step.
Scheduled and manual release runs are disabled in code by default. After approving the
first publish and configuring npm trusted publishing, the owner enables releases by
setting the repository variable `PM_JEV_RELEASE_ENABLED` to `true`. The main-branch
gate remains required. Dependency installation, builds, checks and packing run with
`contents: read` and no persisted checkout credentials. The publishing job downloads
the verified tarball, runs no repository scripts or package dependency installation,
and uses npm OIDC. Git credentials are provided only to push steps; protected release
metadata must land on main with the verified tree before publishing. A second release
on the same Vienna calendar day is refused.

This package has bounded synthetic and public-tracker evidence; the measurements above define its calibration scope.
The [vendor's model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
include literal interpretation, adversarial state, option-order effects, and weak math,
dates/counting and multi-hop reasoning. Gate thresholds need workload-specific evaluation;
false positives and false negatives remain possible. Rust/OpenAPI parity and hosted
acceptance remain deferred tracker issues.
The opt-in [synthetic calibration harness](docs/threshold-calibration.md) generates
versioned noul and type-classification corpora and measures local Ollama reliability curves with
`npm run calibration`; tests require no Ollama. Its model-specific recommendations
are advisory and do not change the provisional defaults automatically.
