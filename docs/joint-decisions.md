# Joint decision constraint witnesses

`pm jev validate --batch examples/joint-decisions.json --json` checks a selected
batch before a caller applies anything. The example's two individually valid
classifications conflict with the caller's exclusive rule. The report exits 1
and identifies both unchanged answers:

```json
{
  "constraints": ["classification"],
  "code": "exclusive",
  "witness": [
    {"question": "is_bug", "answer": "yes", "expected": "yes"},
    {"question": "is_feature", "answer": "yes", "expected": "yes"}
  ]
}
```

The caller must explicitly revise proposals or constraints and validate again.
The validator never picks a replacement winner, changes confidence, rounds a
score, asks a model, writes a receipt, or mutates tracker state. `jev ask` and
`runDecision` still validate individual answer shapes. This command adds caller
semantics between answers. Existing triage/link commands do not automatically
consume these constraints.

## SDK

```ts
import { validateJointDecisions, JointRefusal } from "pm-jev";
import type { JointInput } from "pm-jev";

async function preflight(batch: JointInput) {
  try {
    const report = await validateJointDecisions(batch);
    if (!report.ok) return report.violations;
    return report;
  } catch (error) {
    if (error instanceof JointRefusal) return { code: error.code, remedy: error.remedy };
    throw error;
  }
}
```

The public exports include `JointInput`, `JointPredicate`, `JointConstraint`,
`JointContext`, `JointReport`, `JointViolation`, `JointRefusal`, `parseJointInput`
and `validateJointReportNumbers`. Both entry points call the same strict parser
and validator. Producer question normalization comes from
`parseQuestionsDocument`; raw results use the same `validateAnswers` as inference.
The validator snapshots its input before any asynchronous host read.
The declared host floor is pm-cli 2026.10.25, matching the verified public graph
integrity surface; the development SDK pin remains unchanged.

## Document and predicate semantics

`pm-jev-joint/1` contains exactly `version`, `questions`, `result`, `constraints`.
`questions` is the existing named choice/score/noul catalog. `result` is its raw
System One response: `model`, `answers`, `usage`. Use the model's recorded selected
`choice` and raw `score`, even if their distributions have another highest
probability. `usage.input_tokens` and `output_tokens` may be null.

Every constraint has a distinct `id` and one of these shapes:

| Kind | Fields beyond id/kind | Semantics |
| --- | --- | --- |
| `exclusive` | `answers: [predicate, ...]` | At most one predicate may match. The first two matching answers form a deterministic minimal witness. Each predicate must name a different question. |
| `requires` | `if: predicate, then: predicate` | A matching trigger requires a matching consequence. A failure shows both actual answers. |
| `relationship` | `when: predicate, source, target, relationship` | A match conditionally proposes adding that native relationship. All selected additions are checked together against the current SDK snapshot. |

A choice predicate is `{ "question": "name", "value": "exact label" }`.
A score predicate uses the exact raw finite numeric score, including fractions,
within `0..rubric.length-1`; it does not choose the highest probability level.
A noul predicate is `{ "question": "name", "value": true, "threshold": 0.8 }`.
Its outcome is `noul >= threshold`, using the shared exact inclusive comparator.
The explicit threshold is required for either boolean outcome; no threshold is
inferred from configuration. Names and labels retain their exact spelling.

## Host relationships

The CLI uses the host-injected SDK client. SDK callers supply `{ client,
registry? }` as the second argument when selected relationship constraints are
present. An unselected relationship declaration does not acquire a tracker or
validate its endpoint existence. A selected declaration without a client refuses
with `host_required`. The optional registry is a host `RelationshipKindRegistry`;
the default is the active workspace registry, including extension kinds.

The same registry is passed explicitly to both existing and proposed graph
execution analysis as well as edge, hierarchy and cardinality validation.
Custom ordering directions, aliases and associative kinds therefore keep their
declared meaning throughout preflight, including when the tracker already
contains custom edges. The native CLI uses host-contributed kinds in JSON and
TOON just as SDK callers use `JointContext.registry`.

Complete reads are certified through the SDK. The host graph normalizes endpoint
whitespace, kind casing and aliases. The host's edge policy, hierarchy integrity,
non-hierarchy cardinality and execution graph analysis validate the prospective
batch. New structural defects are checked for every lifecycle state, without
interpreting status names or treating terminal items as a bypass. Existing
ordering components remain readable. Existing edges are checked against current
state on every call. A graph failure shows every selected relationship trigger
and its constraint id; this witness is bounded and need not be minimal.

This is a read-only snapshot preflight. A passing report grants no apply
authority, reservation or revision guarantee. A subsequent writer must re-read
expected revisions and revalidate inside its host transaction or lock. This
feature adds no import/export/sync, journal, idempotency or shared lease path.

## Bounds, output and refusals

Inputs are regular JSON files up to 256 KiB, 1..32 questions, 1..32 constraints,
up to 32 options/rubric levels per question, names up to 128 characters and text
values up to 8,192 characters. Nested JSON has at most 12 levels, 256 entries per
object/array, dense arrays and finite numbers. Unknown document, question,
answer, predicate and constraint fields are refused. Optional undefined object
fields from the typed question producer are accepted; JSON omits those fields.

Reports contain bounded counts and witnesses, without full probability maps,
question instructions or tracker text. Every emitted numeric domain is checked
before return. Default output is compact TOON; `--json` uses the host JSON
renderer. CLI exit 0 means compatible, exit 1 means semantic conflicts, exit 2
means a typed refusal with a remedy (`invalid_input`, `input_unreadable`,
`host_required`, `host_read_failed`, `invalid_report`). Invalid input is validated
before SDK reads. A malformed batch is refused as a unit so an agent cannot
mistake a partial check for an apply gate; it never invalidates stored items.

## Without git

SDK validation and `jev validate` work in plain trackers with no Git executable.
Neither path invokes Git. No inference server or credentials are needed.

## Verification

`node --test --test-concurrency=2 test/joint-decisions.test.ts` covers semantic
witnesses, strict refusal and allow corpora, producer agreement, fractional
scores, inclusive noul boundaries, host graph conflicts, native CLI JSON/TOON,
and a seeded model with 500 sequences (4,000 random operations). Replays,
whitespace/CRLF document variants and SDK read-back prove input and tracker state
preservation without a handwritten normalization oracle. The model also seeds
native parent/blocker/dependency fields, generates conditional relationship
proposals, replays them, remaps custom statuses and changes ambient session focus.

`test/joint-decisions.acceptance.ts` checks a verified committed public tracker
copy, made read-only in a non-git scratch project. Its aggregate evidence is
recorded in `docs/joint-decisions-evidence.json`. The injected incompatible
classifications measure validation mechanics, not model prediction accuracy.

`node --test --test-concurrency=1 test/joint-install.acceptance.ts` packs one
archive and checks those exact bytes with npm global, Bun global, project-local,
npx and bunx host invocations. It needs public registry access and both runtimes.

`node --test --test-concurrency=2 test/joint-registry.test.ts` exercises 500
seeded custom-registry and proposal permutations, stored custom edges, aliases,
both ordering directions and associative cycles on real non-git trackers.
Packed acceptance additionally checks stored host-contributed custom kinds in
both output formats and the SDK override under Node and Bun. Full coverage-gate
test runs use at most two workers without changing coverage thresholds.
