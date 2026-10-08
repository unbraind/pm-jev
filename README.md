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
mkdir pm-jev.local
tar -xzf pm-jev-2026.10.5.tgz --strip-components=1 -C pm-jev.local
# In the destination pm project, install dependencies and then the local extension:
npm install --ignore-scripts ../pm-jev/pm-jev-2026.10.5.tgz
pm install ../pm-jev/pm-jev.local
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
A full development checkout with many dependency files can exceed the host's 10,000-entry
local-source scan cap. The extracted local package directory avoids that cap while
using the same shipped entry and dependencies. The host copies the extension; npm/Bun
installs its dependencies in the destination project. Use the host-owned `--json` global flag; pm-jev declares no competing JSON flag.
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
| `pm jev dedupe --title "Fix login crash" --body "Details" --limit 8` | Rank all tracker items in code, then choose a candidate id or `none`. |
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

Triage and ask project only title, type, description, body, tags and status. Text
fields and free gate text are bounded to 4,000 characters; tags to 32 entries of
128 characters. Comments, history,
authors, linked files and paths from tracker metadata are excluded. A path or secret
written inside title/body still belongs to that content: the `sensitive` answer is
a proposal, not a sanitizer or an authorization rule.

Triage reads the project's actual configured item types through the pm SDK, including
custom types and their descriptions. Built-ins with no schema description get semantic
catalog descriptions; other undescribed custom types use their configured names. The priority rubric is index-aligned with pm:
0 critical, 1 high, 2 medium, 3 low, 4 minimal. The highest-probability priority level
wins, with ties going to the lowest index. Probability is distinct from the model's
reported confidence. `--apply` compares each proposed field's probability to the
threshold, updates only qualifying changed type/priority fields through the SDK,
and records resolved model, catalog version, rounded probabilities and applied fields.
A receipt is also appended when no field qualifies. Qualifying fields and the receipt
are submitted together in one SDK update, preserving the host mutation and history contract.

Dedupe uses a complete, fail-closed SDK read, deterministic title similarity, stable
id tie-breaking and a bounded candidate list. Run it before `pm create`. Both duplicate
and no-duplicate decisions exit 0; operational failures remain errors so agents do not
interpret an unavailable model as permission to create a duplicate. With no candidates,
code returns `none` without inference (zero usage and the configured model name).

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
    "allow_external": false
  }
}
```

`PM_JEV_BASE_URL` and `PM_JEV_MODEL` override those settings. Without a `jev` override,
pm-jev uses its own decision-model defaults rather than pm's general chat-model settings.
The per-attempt timeout is bounded to 1–600 seconds; total deadline to 1–3,600 seconds.
The default total deadline is at least 240 seconds and three per-attempt timeouts
(270 seconds with the default timeout). Settings thresholds are bounded to [0,1].
CLI probability flags outside that range fail. Dedupe defaults to 8 candidates, capped
at 32; invalid limits fall back to the default.

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

This v0 has bounded synthetic plausibility evidence, not production calibration.
The [vendor's model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
include literal interpretation, adversarial state, option-order effects, and weak math,
dates/counting and multi-hop reasoning. Gate thresholds need workload-specific evaluation;
false positives and false negatives remain possible. Rust/OpenAPI parity, hosted acceptance,
and production threshold calibration remain deferred tracker issues.
The opt-in [synthetic calibration harness](docs/threshold-calibration.md) generates
a versioned four-family corpus and measures local Ollama reliability curves with
`npm run calibration`; tests require no Ollama. Its model-specific recommendations
are advisory and do not change the provisional defaults automatically.
