# Counterfactual decision explanations

`pm jev explain` measures which explicit evidence fields change a typed proposal
when removed individually. The existing choice/score/noul questions and their
instructions, including caller-supplied exemplars, stay fixed for every comparison.
pm-context still owns evidence packing. No narrative rationale is generated.

```sh
pm jev explain my-item-1a2b --questions examples/explanation-questions.json \
  --fields tags,title,description --max-calls 4 --json
```

Remove `--json` for compact TOON. Both formats retain identical numbers and all
omissions; there is no hidden full-output mode. The command reads the item through
the host SDK, projects title/type/status/tags/description/body using the existing
bounded projection, and performs no item, settings, history or receipt writes.
SDK reads may populate disposable host runtime caches. Commands work in a plain
tracker without Git installed. The CLI reads one item snapshot; comparisons do
not reread changing tracker state.

The SDK exposes the same behavior for evidence already packed by another caller:

```ts
import { explainDecision, parseQuestionsDocument, resolveJevEndpoint } from "pm-jev";

const receipt = await explainDecision({
  endpoint: await resolveJevEndpoint(pmRoot, process.env),
  evidence: { title: "Fix login crash", tags: ["ui"] },
  fields: ["tags", "title"],
  questions: parseQuestionsDocument({
    defect: { type: "noul", instructions: "Does this describe broken behavior?" },
  }),
  maxCalls: 3,
});
```

`CounterfactualOptions`, `CounterfactualReceipt`, `ExplanationProposal` and
`FieldComparison` are exported types. Invalid input throws `CounterfactualRefusal`
with `code`, `message` and `remedy`. The CLI renders the refusal as
`{ok:false,exit_code:2,refusal:{code,message,remedy}}`. Endpoint privacy refusals
use `endpoint_refused`; malformed input uses `invalid_request`. Existing hosted
opt-in, runtime credentials, redirects and response validation still apply.

The call budget includes the baseline, failed requests and comparisons. It
defaults to 5 and accepts integers 1..17. SDK retries are disabled. Comparisons
run sequentially under one configured `jev.total_deadline_ms` deadline, with the
existing per-request timeout. Requested fields run in caller order; after the
budget is exhausted every remaining field has an explicit `call_limit` omission.
There are no automatic extra baseline or noise probes. One call permits only the
baseline and marks every field omitted.

The SDK accepts a JSON evidence object up to 32 KiB and 1..16 distinct, existing
top-level field names up to 64 characters. It snapshots evidence and questions
before inference. Removing a field deletes the key; it does not replace its
value with null or an empty string. Nested field removal is unsupported. Question
maps/files are limited to 16 KiB, eight questions, names/choice labels up to 64
characters, and 32 choice options or score levels. Question validation retains
the existing lower bounds. CLI fields are restricted to the six projected keys.

`baseline` and comparison `proposals` contain compact typed outcomes: a choice's
selected label, a score's highest-probability rubric level (ties choose the first
level), or `noul >= 0.5`. `changed` names only questions whose outcome changed;
`max_probability_delta` measures the largest absolute probability movement over
**all** labels. Thus an unchanged outcome can still have a nonzero probability
delta. These are raw typed proposals, before triage calibration, abstention or
apply policy; the receipt does not explain a prior triage/link/dedupe invocation.
Use the same evidence and questions to study that decision boundary explicitly.

Evidence digests are HMAC-SHA256 with a fresh random key per invocation. The key
is discarded and never returned. Digests bind exact serialized evidence within
one receipt and cannot be recomputed or correlated across runs. The question
SHA256 identifies the fixed normalized question catalog. Evidence text, complete
probability distributions, instructions and raw provider errors are absent from
receipts. Explicit field names, question names and choice labels remain visible;
choose public-safe names when publishing receipts.

On provider failure or deadline, completed comparisons survive and the failed
and remaining fields are omitted with `provider_failure` or `deadline`. Run
`pm jev doctor` and retry with a smaller field set or an appropriate configured
deadline. A changed reported model name stops comparisons with `model_changed`;
pin the model and retry. A tag can still change its underlying weights while
retaining its name; callers needing immutable model identity must pin the
provider revision. Failed calls make token totals unknown. `calls.succeeded`
counts validated responses, including one rejected for a changed model name.

`complete` requires a baseline and every requested comparison. CLI exit 0 means
the baseline exists, even when the comparison set is partial; check `complete`
and `omitted` before treating coverage as exhaustive. An unavailable baseline
returns a partial receipt with exit 2. No missing comparison is called stable.
Every receipt discloses single sampling, unmeasured model stochasticity,
unmeasured field interactions, the supplied evidence boundary and the fact that
sensitivity does not establish causation. An empty `changed` array is an observed
stable outcome for that comparison, not proof that the field is irrelevant.

Public validation is reproducible with `node test/counterfactual.acceptance.ts`
and three arguments: a public pm-lint clone, an empty non-git scratch directory,
and the report destination. Source visibility and committed provenance are
verified before copying; source Git/GitHub tools are then removed from PATH for
SDK/CLI decisions. Copied files are read-only and authoritative hashes must match
afterward. See `calibration/counterfactual-report-v1.json` for measured counts and
limitations; ordinary CI uses deterministic HTTP protocol fixtures and real
scratch trackers, never an inference service.
