import type { SystemOneResult, Questions } from "@typesafe-ai/sdk";
/** Endpoint usage retains null when a token count was not reported. */
export type TokenUsage = SystemOneResult<Questions>["usage"];
/** Aggregate actual calls without presenting incomplete token sums as totals. */
export declare class TokenUsageTotals {
    /** Complete input total, or null if any call omitted input usage. */
    inputTokens: number | null;
    /** Complete output total, or null if any call omitted output usage. */
    outputTokens: number | null;
    /** Actual calls missing at least one token count. */
    unknownCalls: number;
    /** Actual calls missing input usage. */
    unknownInputCalls: number;
    /** Actual calls missing output usage. */
    unknownOutputCalls: number;
    /** Count each call once, propagating unknown values independently per dimension. */
    add(usage: TokenUsage): void;
}
//# sourceMappingURL=token-usage.d.ts.map