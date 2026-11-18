import { acceptsThreshold } from "./threshold.ts";
import type { DedupeDecision } from "./index.ts";
import type { TokenUsage } from "./token-usage.ts";

/** Proposed create input. The bound defaults to eight positive title matches. */
export interface PreCreateDraft {
  readonly title: string;
  readonly body?: string;
  readonly limit?: number;
}

/** Only a duplicate recommendation names a tracker item. */
export type PreCreateVerdict =
  | { decision: "duplicate"; duplicate_of: string }
  | { decision: "no_match"; reason: "no_title_candidates" | "model_none" }
  | { decision: "abstain"; reason: "below_threshold" | "candidate_limit" | "decision_unavailable" };

/** Content-free receipt. Unknown usage stays null on an inference failure. */
export type PreCreateReceipt = PreCreateVerdict & {
  readonly candidate_count: number;
  readonly has_more: boolean;
  readonly probability: number | null;
  readonly score_kind: "raw" | "calibrated" | null;
  readonly threshold: number | null;
  readonly model: string;
  readonly usage: TokenUsage | null;
};

/** Compact a detailed screen using the guard floor and any stricter compatible fit. */
export function preCreateReceipt(receipt: DedupeDecision, minimum: number, hasMore: boolean): PreCreateReceipt {
  const meta = { candidate_count: receipt.candidates.length, has_more: hasMore, model: receipt.model, usage: receipt.usage };
  if (meta.candidate_count === 0) return { ...meta, decision: "no_match", reason: "no_title_candidates", probability: null, threshold: null, score_kind: null };

  const fit = receipt.calibration;
  const threshold = fit?.threshold === null ? null : Math.max(0.8, minimum, fit?.threshold ?? 0);
  const { probability } = receipt;
  let verdict: PreCreateVerdict;
  if (!acceptsThreshold(probability, threshold)) verdict = { decision: "abstain", reason: "below_threshold" };
  else if (receipt.duplicate_of !== null) verdict = { decision: "duplicate", duplicate_of: receipt.duplicate_of };
  else if (hasMore) verdict = { decision: "abstain", reason: "candidate_limit" };
  else verdict = { decision: "no_match", reason: "model_none" };
  return { ...meta, probability, threshold, score_kind: fit === undefined ? "raw" : "calibrated", ...verdict };
}
