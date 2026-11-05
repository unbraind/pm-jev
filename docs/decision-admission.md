# Tokenizer-bound decision admission

Every local `runDecision` call preflights all complete, independently scored
question prompts before invoking the official TypeSafe SDK. `pm jev admit`
performs the same check without inference or tracker mutations:

Run these commands from the project directory after [installing and registering
pm-jev](../README.md#install-and-check). The batch path points into the installed
package; no repository checkout or copied example is needed. Configure a local
Ollama endpoint with the supported model as described below.

```sh
npx --no-install pm jev admit --batch node_modules/pm-jev/examples/decision-admission.json --json
npx --no-install pm jev admit --batch node_modules/pm-jev/examples/decision-admission.json
bunx --bun --no-install pm jev admit --batch node_modules/pm-jev/examples/decision-admission.json --json
bunx --bun --no-install pm jev admit --batch node_modules/pm-jev/examples/decision-admission.json
```

The batch is `{ "version": "pm-jev-admission/1", "state": ..., "questions": ... }`.
The CLI uses the existing endpoint settings and privacy opt-in. SDK consumers
can call `admitDecision(config, state, questions)` or
`admitDecisionBatch(config, document)`; both return detached `state`, `questions`,
a digest-addressed `model` and a content-free `receipt`. `runDecision` returns
that receipt as `result.admission` for local calls. Hosted calls retain the
existing opt-in and SDK behavior; this local admission contract does not certify
hosted prompt fit.

Admission resolves the configured alias once through `/api/tags`, then reads
`/api/show` and submits inference using `sha256:<full digest>`. An alias change
between any of these steps cannot redirect an admitted request. Untagged names
resolve to `:latest`, including names containing a registry port. Validated profiles
(tokenizer, context, vocabulary hash and labels) use a process-local eight-entry
LRU keyed by endpoint and full digest. Aliases are resolved on every admission;
a changed digest loads a new profile. Refusals are never cached. No alias-keyed
cache, persisted admission journal, settings write or model download is used.
Older endpoints that cannot inspect or submit a digest refuse; they never fall
back to the alias.

The initial supported profile is Tev1's published `systemone` template
SHA-256 `f2a33c8e30f70f59657efe8353810d61a86500d6f9e2c07d038c960d8a269135`,
with the `qwen35` GPT-2 byte BPE vocabulary/merges advertised by that digest,
no automatic BOS/EOS, and an explicit model `num_ctx` parameter. Other names
are supported only when their metadata satisfies this exact profile; a decision
capability flag alone does not qualify a model. Unknown templates, tokenizers,
missing limits and incomplete metadata refuse with `unsupported_model` or
`metadata_unavailable` and a remedy. Native metadata responses are bounded at
32 MiB. The tokenizer runs in process using the pinned, pure JavaScript
`@huggingface/tokenizers` dependency; no external tokenizer executable,
Hugging Face download or git is needed.

The declared decision context is `num_ctx`, bounded by the model architecture's
maximum. One token is reserved for scoring. Every question includes the full
state, instruction, all choice options or score levels, and system/chat template.
Admission compares each prompt with that usable context, rather than summing
independently scored questions. `max_prompt_tokens`, `limiting_question_index`
(zero-based input order), and `minimum_prompt_tokens_to_remove` identify the
limiting prompt and the exact smallest token-count reduction required:
`max(0, max_prompt_tokens + 1 - context_tokens)`. This is a token deficit, not a
claim about the shortest removable character substring: BPE merges make text
edits non-monotonic. Revise state explicitly or select a supported model with a
larger digest-bound context, then check all questions again. No question or
option is silently removed, shortened or rewritten. Receipts contain hashes/counts
only, never state or question text.

### Refusals and caller recovery

Direct `admitDecision` / `admitDecisionBatch` calls throw `AdmissionRefusal` with
`code` and `remedy` for invalid inputs, unsupported profiles and metadata
failures. `validateAdmissionReceipt` also throws it for an invalid report.
`runDecision` instead translates any such refusal into the host's expected
`PmCliError`: inspect `context.code` and `context.required` (the original remedy),
not `instanceof AdmissionRefusal`. These errors have exit code 2 and no admission
receipt. The `jev admit` CLI returns exit 2 with
`{ ok: false, exit_code: 2, inference_calls: 0, mutations: 0, refusal: { code, remedy } }`.

The table covers every declared `AdmissionRefusalCode`; the regression test
checks the code set, actual host mapping, exit, receipt absence and remedy text.
The remedy column quotes an actionable part of the corresponding runtime remedy.

| Direct refusal code | Host `context.code` | Exit | Admission receipt | Remedy |
| --- | --- | --- | --- | --- |
| `invalid_input` | `jev_admission_invalid_input` | 2 | none | Use dense arrays, safe integer numbers, well-formed strings and documented fields only. |
| `unsupported_model` | `jev_admission_unsupported_model` | 2 | none | Pull a supported model or add a verified profile; no inference was submitted. |
| `metadata_unavailable` | `jev_admission_metadata_unavailable` | 2 | none | Restore native Ollama /api/tags and digest-addressed /api/show access, then retry. |
| `invalid_report` | `jev_admission_invalid_report` | 2 | none | Discard this receipt and report a package defect; no inference was submitted. |
| `option_limit_exceeded` | `jev_admission_option_limit_exceeded` | 2 | none | Explicitly select a supported model with more labels or revise the question, dedupe candidate limit, or type registry before retrying; no options were dropped and no inference was submitted. |
| `context_exceeded` | `jev_admission_context_exceeded` | 2 | none | Reserved code, not emitted by current admission; a supplied refusal preserves its remedy in context.required. |

Prompt overflow is a **negative receipt**, not an `AdmissionRefusal` with
`context_exceeded`. Direct admission returns `receipt.ok: false`; `jev admit`
returns that receipt with exit 1 and a `remedy`. `runDecision` throws the host's
expected error `jev_context_exceeded` with exit 2 and the same receipt in
`context.details.admission`. Reduce the limiting prompt by at least
`minimum_prompt_tokens_to_remove` tokens or explicitly select a larger supported
digest-bound context, then preflight every question again. Every refusal and
overflow happens before inference or tracker mutation.

The existing dedupe request producer renders its fractional retrieval score as
display text in model state. Candidate identity, order, numeric ranking and public
decision output stay intact; the producer now emits the same documented numeric
domain that admission accepts.

The single input schema bounds the full document at 64 KiB, depth 12 and 16,384
JSON nodes, with 1..64 questions, 1..255 choice options and 2..10 score levels.
Native Tev1 labels are the single-token codes among `A..Z`, then `AA..ZZ`,
in that order, capped at 255. A model with fewer labels refuses an oversized
question with `option_limit_exceeded` before inference: explicitly select a
model with more labels or revise the question, dedupe limit, or type registry.
The existing dedupe limit (32 candidates plus `none`), registry-driven triage,
and 255-option question parser retain their domains; nothing is silently dropped.
State and structured descriptions use dense JSON arrays, well-formed Unicode,
and safe integer numbers; fractional/nonfinite numbers, sparse arrays, cycles,
unknown question/document fields and non-JSON objects refuse before network
access. This initial numeric domain avoids differing JavaScript/native floating
point JSON rendering. Existing tracker data remains readable; only a new
inference/admission request must satisfy this profile. Text, whitespace, CRLF,
Unicode and option order are preserved. Blank instruction/option fallback uses the
native six ASCII whitespace characters; non-breaking spaces and byte-order marks
remain literal text, matching the pinned template rather than JavaScript trim(). Question normalization reuses the
existing `parseQuestionsDocument` producer; all emitted numeric domains are
validated before returning a receipt.

There are no import/export/sync paths, retries that apply saved plans, tracker
creates/updates, idempotency keys, claims, leases or status interpretations in
admission. Tracker state and relationship semantics remain owned by the pm SDK.
The seeded regression reads current state back through that SDK after 500
sequences of native edits and older-state replays, and confirms admission never
changes the state or typed options. The public-tracker acceptance artifact is
`docs/decision-admission-evidence.json`.

The protocol and profile are grounded in [Ollama model
resolution](https://github.com/ollama/ollama/blob/main/server/model_resolver.go),
[Ollama's decision endpoint](https://github.com/ollama/ollama/blob/main/server/routes.go),
[Tev1's model](https://ollama.com/library/tev1), and
[llama.cpp's tokenizer](https://github.com/ggml-org/llama.cpp/blob/master/src/llama-vocab.cpp).

The duplicate-screening candidate state encodes similarity scores as strings.
The `duplicate_of` calibration fingerprint includes `candidate-score-string/1`;
fits from the older numeric-score prompt remain readable but do not apply to
this prompt. A refit with the current request builder is required to use fitted
temperatures and thresholds after this encoding change, or after a change to the
model digest, fixed question semantics, exemplar setting, or candidate count
that leaves no compatible calibration identity. Refitting is optional when
using the uncalibrated fallback policy, or when a compatible fit already exists;
changing candidate identities or scores alone does not require a refit because
they remain exchangeable evidence within this encoding.

A refit covers only candidate counts represented in the calibration split.
`tracker-evaluation.ts` supplies at most eight candidates (plus `none`), so
requests with more than eight candidates still use uncalibrated probabilities
under these fits. Even for a matching count, a fitted threshold may remain
unqualified (`null`) if calibration or held-out precision evidence is
insufficient; refitting does not guarantee authorization of calibrated changes.
