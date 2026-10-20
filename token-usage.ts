import type { SystemOneResult, Questions } from "@typesafe-ai/sdk";

/** Endpoint usage retains null when a token count was not reported. */
export type TokenUsage = SystemOneResult<Questions>["usage"];

/** Aggregate actual calls without presenting incomplete token sums as totals. */
export class TokenUsageTotals {
  /** Complete input total, or null if any call omitted input usage. */
  inputTokens: number | null = 0;
  /** Complete output total, or null if any call omitted output usage. */
  outputTokens: number | null = 0;
  /** Actual calls missing at least one token count. */
  unknownCalls = 0;
  /** Actual calls missing input usage. */
  unknownInputCalls = 0;
  /** Actual calls missing output usage. */
  unknownOutputCalls = 0;

  /** Count each call once, propagating unknown values independently per dimension. */
  add(usage: TokenUsage): void {
    if (usage.input_tokens === null || usage.output_tokens === null) this.unknownCalls++;
    if (usage.input_tokens === null) this.unknownInputCalls++;
    if (usage.output_tokens === null) this.unknownOutputCalls++;
    this.inputTokens = this.inputTokens === null || usage.input_tokens === null ? null : this.inputTokens + usage.input_tokens;
    this.outputTokens = this.outputTokens === null || usage.output_tokens === null ? null : this.outputTokens + usage.output_tokens;
  }
}
