import type { LabelCase, LabelQueueInput } from "../index.ts";

/** Every non-identity field can be invalid without erasing a copy's identity or explicit human judgment. */
export function malformedLabelCopies(original: LabelCase): Record<string, unknown>[] {
  const human = { kind: "human", value: "explicit-review", actor: "reviewer", evidence: "review-1" };
  const copies: Record<string, unknown>[] = [];
  for (const field of Object.keys(original).filter(key => !["source", "id", "task"].includes(key))) {
    const missing: Record<string, unknown> = { ...original, label: human }; delete missing[field]; copies.push(missing);
    for (const value of [null, false, 0, -1, "", "foreign", {}, [], { unexpected: true }]) copies.push({ ...original, label: human, [field]: value });
  }
  copies.push({ ...original, label: human, extra: true });
  return copies;
}

/** One bounded portable transport corpus exercises all payload corruption classes plus an unrelated survivor. */
export function duplicateLabelDocument(input: LabelQueueInput) {
  const cases: unknown[] = [];
  for (const [index, bad] of malformedLabelCopies(input.cases[0]).entries()) {
    const id = `duplicate-${index}`;
    cases.push({ ...input.cases[0], id }, { ...bad, id });
  }
  cases.push(input.cases[1]);
  return { ...input, cases };
}
