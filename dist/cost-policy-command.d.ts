import type { CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
/** Fixed-score policy selection never invokes a provider, git or a mutation SDK. */
export declare const COST_POLICY_FLAGS: FlagDefinition[];
/** Return bounded TOON/JSON receipts and typed refusals; no tracker state or settings are written. */
export declare function runCostPolicyCommand(ctx: CommandHandlerContext): Promise<import("./cost-policy.ts").CostPolicyReport | {
    ok: true;
    version: typeof import("./cost-policy.ts").COST_POLICY_VERSION;
    provenance: import("./cost-policy.ts").CostDataset["provenance"];
    evidence_sha256: string;
    costs: import("./cost-policy.ts").DecisionCosts;
    policy: import("./cost-policy.ts").AbstentionPolicy;
    policy_sha256: string;
    selected: import("./cost-policy.ts").CostPoint;
    curve: {
        threshold: number | null;
        selection_cost: number;
        selection_coverage: number;
        heldout_cost: number;
        heldout_coverage: number;
    }[];
    exit_code?: undefined;
    refusal?: undefined;
} | {
    ok: boolean;
    exit_code: number;
    refusal: {
        code: import("./cost-policy.ts").CostRefusalCode;
        message: string;
        remedy: string;
    };
}>;
//# sourceMappingURL=cost-policy-command.d.ts.map