import { createPmCliExpectedError } from "@unbrained/pm-cli/sdk";

/** Explicit private-source evidence; absence preserves the verified public receipt format. */
export interface LocalProvenance {
  /** Local evidence has not passed public origin, visibility or commit verification. */
  provenance?: "local-unverified";
}

/** Refuse private evidence at public corpus, artifact and fixture boundaries, including nested receipts. */
export function assertPublicProvenance(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  if (record.provenance === "local-unverified" || (typeof record.repository === "string" && record.repository.startsWith("local-unverified/"))) {
    throw createPmCliExpectedError("local-unverified evidence cannot enter a public corpus, published calibration artifact or committed fixture. Keep it private; rerun without --local-unverified using verified public sources before publication or commit.");
  }
  for (const entry of Object.values(record)) assertPublicProvenance(entry);
}
