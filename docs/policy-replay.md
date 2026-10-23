# Inspect decision compatibility before adoption

`pm jev replay` compares proposals from frozen, minimized inputs with a selected
local policy or model. It does not apply changes, adopt a policy, infer missing
historical evidence, or read current tracker items. The existing `eval` and
`calibrate` commands measure labelled quality; replay measures compatibility.
`pm-rlm replay` reconstructs recursive execution from its separate call ledger.

```sh
# Reuse recorded answers: no network requests, even with hosted settings enabled.
pm jev replay --recording examples/policy-replay.json \
  --policy-version intake-v2 --min-probability 0.9 --json

# Explicitly recompute answers using an installed local decision model.
pm jev replay --recording recording.json --policy-version intake-v2 \
  --min-probability 0.9 --model tev1:4b --limit 5
```

The example has one paired choice: the old policy proposes `feature`, while the
candidate abstains. Expect `compared=1`, `agreement=0`, `disagreement=1`,
`old_abstentions=0`, `new_abstentions=1`, and `gaps=1`. The intentional incomplete
record makes `complete=false` and exits 2. A complete inspection exits 0 even
when proposals disagree; agreement is evidence for a human adoption decision.
Native host output supports compact TOON and JSON. `--limit` bounds detail rows
from 0 to 100 (default 20); totals cover every record, including omitted details.
A `recording_sha256` identifies the snapshotted JSON document, so consumers can
attribute results to the exact frozen inputs and original policy/model versions.
Treat that digest as potentially correlatable metadata for private recordings.
Details expose record indices and changed question names, never state or answers.

A `pm-jev-replay/1` recording contains a `records` array. Each complete record has
a distinct `id`, a minimized JSON object `state`, the exact typed `questions`, the
original raw `result` (model, answers and nullable token usage), and the original
`policy` (`version`, `min_probability`). Capture these at the decision boundary
before trimming or redacting anything needed for replay. Redacted or unavailable
fields should be omitted: missing `state`, `questions`, `result` or `policy`
become explicit gaps. A current item, a hash, or a redacted receipt alone cannot
recover the historical input. Keep recordings private unless every source field
is suitable for publication. Replay does not create or persist recordings itself.

Malformed supplied inputs refuse rather than being counted as historical gaps.
The parser snapshots JSON before asynchronous work. Limits are 4 MiB per file,
1000 records, 32 KiB per state, eight questions per record and 32 options per
choice/score question. Question names, choice labels and version identifiers are
bounded. Choice, score and noul answers use the package's existing validation.
Score proposals select the most probable rubric level, with stable label-order
ties. Noul selects true at 0.5 and uses the probability of the selected boolean.
Each policy abstains below its inclusive `min_probability` threshold.

Counts use successfully paired **questions**, including unchanged abstentions.
A null proposal equals another null proposal. A changed choice, rubric level,
boolean, or transition to/from abstention counts as disagreement. Missing inputs
and failed candidate decisions contribute no paired counts or abstention counts.
`compared = agreement + disagreement`; old/new abstentions each count within
that same denominator. `attempted`, `replayed` and `gaps` count records.
`latency_ms.total` measures all attempted decision processing, including failures;
`mean` divides by attempted records and is null for zero attempts. These are wall
clock measurements, not inference-only timing. Saved-score timing includes local
validation/processing. Empty recordings complete with zero comparisons.

The built-in Ollama adapter uses the existing Jev typed transport at numeric
loopback HTTP, with no credentials, redirects, retries, cloud-model selection,
or hosted-provider/environment overrides. `--deadline-ms` bounds each local
input from 1 to 300000 ms (default 120000, including model cold loading). CLI uses the default local Ollama
port; embedded callers may choose another numeric loopback origin. Preflight
requires an exact installed model tag, a decision capability, and a SHA-256 model
digest, and rejects remote model metadata. The receipt identifies the selected
model by digest; a response naming another model becomes a decision gap. Keep
model tags stable during inspection: this is a preflight version snapshot, not
a lock on the Ollama daemon or a guarantee of deterministic inference.

Typed `ReplayRefusal` codes are `invalid_recording`, `invalid_policy`, `local_only`
and `model_unavailable`. CLI returns exit 2 and a redacted `refusal` object with
`code`, `message`, and a concrete `remedy`. For an absent local model, start
Ollama, run `ollama pull tev1:4b`, and check that `/api/tags` advertises a local
`decision` model. Per-record transport/answer failures become `decision_failed`
gaps; earlier successful comparisons remain in the receipt.

```ts
import {
  parseReplayRecording, replayDecisions, createOllamaReplayAdapter,
} from 'pm-jev';
import type { ReplayAdapter, ReplayRecording, ReplayReport } from 'pm-jev';

const recording: ReplayRecording = parseReplayRecording(savedJson);
const policy = { version: 'intake-v2', min_probability: 0.9 };
const offline: ReplayReport = await replayDecisions(recording, policy);
const model: ReplayAdapter = await createOllamaReplayAdapter('tev1:4b');
const local = await replayDecisions(recording, policy, model, 5);
```

Embedded adapters are trusted local application code implementing the typed
`ReplayAdapter` contract; the caller owns their side effects. The default adapter
is recorded-score replay; the built-in Ollama adapter enforces the local network
boundary. Tests use a fixture adapter and real SDK-created scratch trackers.
Replay works in a plain tracker without Git. Public-source provenance validation
and package release tooling separately need Git and GitHub.

See [public tracker measurements](policy-replay-evidence.json). The acceptance
script verifies public repository visibility and published commit identity,
checks archived bytes against Git blobs, reads a complete tracker through the pm
SDK, records twelve minimized inputs, and replays both saved scores and local
`tev1:4b` answers. The copied tracker is read-only, has no Git repository, runs
with Git unavailable, and retains the same authoritative file hashes. Only
aggregate compatibility measurements are published; agreement does not establish
labelled accuracy or authorize adoption.
