# pm-cli 2026.11.14 option migration

GH-1665 (CHANGELOG 2026.11.8) applies CLI option spelling, coercion and declared
flag validation to direct callers. Boolean `expect` inputs therefore become
the accepted strings `true` and `false`. Gate tests cover both accepted boolean
values and retain separate invalid-spelling, null, threshold and no-inference
refusal cases. Evaluation tests supply required `from` when exercising invalid
tasks, and separately cover missing source and conflicting
spellings before inference or authoritative writes. Production code and
thresholds are unchanged.

## Upstream candidate: required-option refusal has no stable SDK code

Exact version: `@unbrained/pm-cli` **2026.11.14**. No upstream issue was filed.

```ts
import extension from "../index.ts";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

const harness = await createExtensionTestHarness(extension, {
  capabilities: ["commands", "schema", "hooks"],
});
try {
  await harness.runCommand({
    command: "jev eval", options: { task: "triage" },
  });
} finally { await harness.deactivate(); }
```

Observed: the host throws `PmCliError`, exit code 2, message
`Missing required option '--from' for extension command 'jev eval'.`, and
`error.code` is undefined. Expected: the correct before-dispatch refusal also
exposes a stable required-option code, as the documented `unknown_option` and
`extension_option_spelling_conflict` refusals do. Required-source validation
itself is correct; this candidate concerns its machine-readable diagnostic.
The package tests retain a message and exit-code matcher for this refusal and
assert the stable spelling-conflict code separately.

## Upstream candidate: unknown options bypass direct-call preflight

Exact version: `@unbrained/pm-cli` **2026.11.14**. With a minimal command declaring
one string flag `--known` and returning `{ ok: true }`, this harness call reaches
the handler and returns success:

```ts
const harness = await createExtensionTestHarness({
  activate(api) {
    api.registerCommand({
      name: "options-repro",
      flags: [{ long: "--known", value_type: "string" }],
      run() { return { ok: true }; },
    });
  },
}, { name: "options-repro", capabilities: ["commands", "schema"] });
try {
  await harness.runCommand({
    command: "options-repro", options: { unknown: true },
  });
} finally { await harness.deactivate(); }
```

Observed: `{ handled: true, result: { ok: true } }`. Expected for CLI parity:
`unknown_option`, exit 2, before handler invocation. The real CLI refuses
`pm options-repro --unknown` under the same declared flags. The public direct
normalizer declaration explicitly preserves undeclared keys, so this is a
contract-alignment candidate rather than a claimed undocumented implementation
change. No upstream issue was filed and no package-side flag allowlist was added.
