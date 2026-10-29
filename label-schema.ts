/** Portable, read-only human labeling queue document version. */
export const LABEL_QUEUE_VERSION = "pm-jev-label-queue/1";
/** Limits bound traversal, agent output, and exact integer cost arithmetic. */
export const LABEL_QUEUE_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024, cases: 5000, cohorts: 32, sources: 128, queue: 100, units: 1_000_000, ratio: 1_000_000_000 });
/** Count-derived uncertainty; no floating point decisions or implicit confidence conversion. */
export interface LabelRatio { readonly numerator: number; readonly denominator: number }
/** Provenance is caller-declared evidence, never verified or promoted by selection. */
export type LabelProvenance = { readonly kind: "none" }
  | { readonly kind: "human" | "inferred"; readonly value: string; readonly actor: string; readonly evidence: string };
/** A source belongs to exactly one cohort, even when it contains multiple tasks. */
export interface LabelCohort { readonly id: string; readonly role: "acquisition" | "held_out"; readonly sources: readonly string[] }
/** Minimized immutable case reference; no tracker body, status interpretation or prediction needed. */
export interface LabelCase {
  readonly id: string; readonly source: string; readonly revision: string; readonly cohort: string;
  readonly task: string; readonly bucket: string; readonly state: "unlabeled" | "abstained" | "decided";
  readonly uncertainty: LabelRatio; readonly cost: number; readonly label: LabelProvenance;
}
/** Explicit integer labeling units and selection order, independent of ambient session focus. */
export interface LabelPolicy {
  readonly cohort: string; readonly seed: string; readonly budget: number; readonly limit: number;
  readonly uncertainty: "declared_ratio_desc"; readonly min_uncertainty: LabelRatio;
  readonly diversity: "cap" | "balanced"; readonly max_per_bucket: number;
}
/** All inputs are portable declarations, not grants to fetch a source or change its labels. */
export interface LabelQueueInput {
  readonly version: typeof LABEL_QUEUE_VERSION; readonly policy: LabelPolicy;
  readonly cohorts: readonly LabelCohort[]; readonly cases: readonly LabelCase[];
}
/** Per-case failures are isolated; raw case content is never included in diagnostics. */
export interface LabelCaseRejection { readonly index: number; readonly code: "invalid_case" | "duplicate_case" }
/** The normalized portable document and counted omissions are separate from untrusted input. */
export interface ParsedLabelQueueInput { readonly input: LabelQueueInput; readonly rejected: readonly LabelCaseRejection[]; readonly candidates: number }
/** Stable agent-routing codes without rejected content or local paths. */
export type LabelQueueRefusalCode = "invalid_input" | "input_unreadable" | "cohort_conflict" | "invalid_report";
/** Boundary failures always include a concrete remedy and never repeat supplied values. */
export class LabelQueueRefusal extends Error {
  /** Stable machine-readable reason independent of the rejected source content. */
  readonly code: LabelQueueRefusalCode;
  /** Concrete next step suitable for compact agent output. */
  readonly remedy: string;
  /** Preserve a content-free error contract for SDK consumers and native CLI rendering. */
  constructor(code: LabelQueueRefusalCode, remedy: string) {
    super(`Label acquisition refused: ${code}.`);
    this.name = "LabelQueueRefusal"; this.code = code; this.remedy = remedy;
  }
}
/** One schema assertion shared by SDK input, portable producers and CLI documents. */
function requireInput(condition: unknown): asserts condition {
  if (!condition) throw new LabelQueueRefusal("invalid_input", "Use pm-jev-label-queue/1 with only documented fields, dense bounded arrays, exact ratios in [0,1], integer costs and explicit label provenance. See examples/label-queue.json.");
}
/** Reject non-plain records, inherited requirements and unknown fields before cloning. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  requireInput(value !== null && typeof value === "object" && !Array.isArray(value));
  requireInput(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  requireInput(Reflect.ownKeys(value).length === keys.length && keys.every(/** No prototype field can fulfill the contract. */ key => Object.hasOwn(value, key)));
  for (const key of keys) requireInput(Object.getOwnPropertyDescriptor(value, key)?.get === undefined);
  return value as Record<string, unknown>;
}
/** Snapshot validated own elements so inherited iteration cannot hide conflicts or cohort declarations. */
function dense(value: unknown, maximum: number): unknown[] {
  requireInput(Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1);
  const snapshot: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    requireInput(descriptor !== undefined && descriptor.get === undefined);
    snapshot.push(descriptor.value);
  }
  return snapshot;
}
/** Exact identities retain whitespace and Unicode from previously emitted valid documents. */
function text(value: unknown): string {
  requireInput(typeof value === "string" && value.length > 0 && value.length <= 96 && value.trim().length > 0);
  return value;
}
/** Labeling costs and bounds use safe integer arithmetic exclusively. */
function integer(value: unknown, minimum: number, maximum: number): number {
  requireInput(typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum);
  return value === 0 ? 0 : value;
}
/** Validate a declared count ratio without rounding or silently repairing its denominator. */
function ratio(value: unknown): LabelRatio {
  const row = record(value, ["numerator", "denominator"]);
  const denominator = integer(row.denominator, 1, LABEL_QUEUE_LIMITS.ratio);
  return { numerator: integer(row.numerator, 0, denominator), denominator };
}
/** Labels require explicit origin; an inferred value cannot fulfill the human label branch. */
function provenance(value: unknown): LabelProvenance {
  requireInput(value !== null && typeof value === "object");
  if (Object.getOwnPropertyDescriptor(value, "kind")?.value === "none") { record(value, ["kind"]); return { kind: "none" }; }
  const row = record(value, ["kind", "value", "actor", "evidence"]);
  requireInput(row.kind === "human" || row.kind === "inferred");
  return { kind: row.kind, value: text(row.value), actor: text(row.actor), evidence: text(row.evidence) };
}
/** Stable ordinal comparison avoids locale, input enumeration and platform dependencies. */
export function labelOrdinal(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
/** Stable composite identity excludes revision so duplicate revisions cannot buy extra queue slots. */
export function labelCaseKey(row: Pick<LabelCase, "source" | "id" | "task">): string { return JSON.stringify([row.source, row.id, row.task]); }
/** Read only bounded own data identities, even when the remaining payload is malformed. */
function caseIdentity(value: unknown): Pick<LabelCase, "source" | "id" | "task"> | null {
  try {
    requireInput(value !== null && (typeof value === "object" || typeof value === "function"));
    return { source: text(Object.getOwnPropertyDescriptor(value, "source")?.value),
      id: text(Object.getOwnPropertyDescriptor(value, "id")?.value), task: text(Object.getOwnPropertyDescriptor(value, "task")?.value) };
  } catch { return null; }
}
/** Parse once and construct a detached canonical snapshot through the sole strict boundary schema. */
export function parseLabelQueueInput(raw: unknown): ParsedLabelQueueInput {
  const doc = record(raw, ["version", "policy", "cohorts", "cases"]);
  requireInput(doc.version === LABEL_QUEUE_VERSION);
  const p = record(doc.policy, ["cohort", "seed", "budget", "limit", "uncertainty", "min_uncertainty", "diversity", "max_per_bucket"]);
  requireInput(p.uncertainty === "declared_ratio_desc" && (p.diversity === "cap" || p.diversity === "balanced"));
  const policy: LabelPolicy = { cohort: text(p.cohort), seed: text(p.seed), budget: integer(p.budget, 0, LABEL_QUEUE_LIMITS.units), limit: integer(p.limit, 0, LABEL_QUEUE_LIMITS.queue),
    uncertainty: p.uncertainty, min_uncertainty: ratio(p.min_uncertainty), diversity: p.diversity, max_per_bucket: integer(p.max_per_bucket, 1, LABEL_QUEUE_LIMITS.queue) };
  const sourceCohorts = new Map<string, string>(); const ids = new Set<string>();
  const cohorts = dense(doc.cohorts, LABEL_QUEUE_LIMITS.cohorts).map(/** Cohort membership is declared before inspecting any candidate labels. */ (value): LabelCohort => {
    const row = record(value, ["id", "role", "sources"]); const id = text(row.id);
    requireInput(!ids.has(id) && (row.role === "acquisition" || row.role === "held_out")); ids.add(id);
    const sources = dense(row.sources, LABEL_QUEUE_LIMITS.sources).map(text);
    requireInput(sources.length > 0);
    for (const source of sources) {
      if (sourceCohorts.has(source)) throw new LabelQueueRefusal("cohort_conflict", "Declare each source in exactly one cohort; keep held-out sources separate from acquisition sources, including aliases managed by the caller.");
      sourceCohorts.set(source, id);
    }
    return { id, role: row.role, sources: sources.sort(labelOrdinal) };
  }).sort(/** Canonical cohorts do not depend on object enumeration. */ (a, b) => labelOrdinal(a.id, b.id));
  requireInput(cohorts.some(/** A held-out cohort can never be the acquisition target. */ row => row.id === policy.cohort && row.role === "acquisition"));
  const rejected: LabelCaseRejection[] = []; const rows = dense(doc.cases, LABEL_QUEUE_LIMITS.cases);
  const keys = new Map<string, number>();
  const identified = rows.map(/** Multiplicity precedes payload validity, cohort eligibility and human-label filtering. */ value => {
    const identity = caseIdentity(value);
    const key = identity === null ? null : labelCaseKey(identity);
    if (key !== null) keys.set(key, (keys.get(key) ?? 0) + 1);
    return { value, identity, key };
  });
  const cases: LabelCase[] = [];
  for (const [index, { value, identity, key }] of identified.entries()) {
    if (key !== null && keys.get(key)! > 1) { rejected.push({ index, code: "duplicate_case" }); continue; }
    try {
      requireInput(identity !== null);
      const row = record(value, ["id", "source", "revision", "cohort", "task", "bucket", "state", "uncertainty", "cost", "label"]);
      const cohort = text(row.cohort);
      requireInput(sourceCohorts.get(identity.source) === cohort && (row.state === "unlabeled" || row.state === "abstained" || row.state === "decided"));
      cases.push({ id: identity.id, source: identity.source, revision: text(row.revision), cohort, task: identity.task, bucket: text(row.bucket), state: row.state,
        uncertainty: ratio(row.uncertainty), cost: integer(row.cost, 1, LABEL_QUEUE_LIMITS.units), label: provenance(row.label) });
    } catch { rejected.push({ index, code: "invalid_case" }); }
  }
  cases.sort(/** Canonical cases keep content digests stable across layout and row order. */ (a, b) => labelOrdinal(labelCaseKey(a), labelCaseKey(b)));
  const input: LabelQueueInput = { version: LABEL_QUEUE_VERSION, policy, cohorts, cases };
  requireInput(Buffer.byteLength(JSON.stringify(input)) <= LABEL_QUEUE_LIMITS.bytes);
  return { input, rejected: rejected.sort(/** Row diagnostics use original dense input positions. */ (a, b) => a.index - b.index), candidates: rows.length };
}
