import { acceptsThreshold } from "./threshold.js";
/** Compact a detailed screen using the guard floor and any stricter compatible fit. */
export function preCreateReceipt(receipt, minimum, hasMore) {
    const meta = { candidate_count: receipt.candidates.length, has_more: hasMore, model: receipt.model, usage: receipt.usage };
    if (meta.candidate_count === 0)
        return { ...meta, decision: "no_match", reason: "no_title_candidates", probability: null, threshold: null, score_kind: null };
    const fit = receipt.calibration;
    const threshold = fit?.threshold === null ? null : Math.max(0.8, minimum, fit?.threshold ?? 0);
    const { probability } = receipt;
    let verdict;
    if (!acceptsThreshold(probability, threshold))
        verdict = { decision: "abstain", reason: "below_threshold" };
    else if (receipt.duplicate_of !== null)
        verdict = { decision: "duplicate", duplicate_of: receipt.duplicate_of };
    else if (hasMore)
        verdict = { decision: "abstain", reason: "candidate_limit" };
    else
        verdict = { decision: "no_match", reason: "model_none" };
    return { ...meta, probability, threshold, score_kind: fit === undefined ? "raw" : "calibrated", ...verdict };
}
//# sourceMappingURL=pre-create-policy.js.map