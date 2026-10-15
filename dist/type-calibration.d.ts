import type { ChoiceResponse } from "@typesafe-ai/sdk";
/** One labelled sample with controlled correct or misrouted current type. */
export interface TypeSample {
    readonly id: string;
    readonly expected: string;
    readonly current: string;
    readonly split: "calibration" | "evaluation";
    readonly text: string;
}
/** Full normalized answers support replay without another model invocation. */
export interface TypeObservation extends TypeSample {
    readonly before: ChoiceResponse;
    readonly after: ChoiceResponse;
}
/** Generate the fixed eight-type corpus without using any tracker content. */
export declare function typeDataset(): {
    version: string;
    customTypes: {
        name: string;
        folder: string;
        description: string;
    }[];
    samples: TypeSample[];
};
/** Count selective precision by predicted type and abstentions by ground-truth type. */
export declare function typeMetrics(rows: readonly TypeObservation[], variant: "before" | "after", marginThreshold: number | null): {
    count: number;
    accepted: number;
    correct: number;
    precision: number | null;
    abstentionRate: number;
    perType: {
        [k: string]: {
            support: number;
            predicted: number;
            precision: number | null;
            abstentionRate: number;
        };
    };
};
/** Fit only calibration rows, using the margin and the production keep-current rule. */
export declare function fitTypeMargin(rows: readonly TypeObservation[], targetPrecision?: number): {
    targetPrecision: number;
    minAccepted: number;
    curve: readonly import("./calibration.ts").ReliabilityPoint[];
    threshold: number | null;
};
/** Measure old and new prompts on real scratch items with all built-ins and two registered custom types. */
export declare function calibrateTypes(baseUrl: string, model: string, targetPrecision?: number): Promise<{
    schemaVersion: string;
    catalogVersion: string;
    policy: {
        keepCurrentLabel: string;
        typeChangeProbability: number;
        marginComparison: string;
    };
    family: string;
    dataset: {
        version: string;
        customTypes: {
            name: string;
            folder: string;
            description: string;
        }[];
        samples: TypeSample[];
    };
    datasetSha256: string;
    model: string;
    modelDigest: string;
    resolvedModels: string[];
    recordedAt: string;
    durationMs: number;
    usage: {
        inputTokens: number;
        outputTokens: number;
    };
    registeredTypes: string[];
    definitions: Record<string, string>;
    fit: {
        targetPrecision: number;
        minAccepted: number;
        curve: readonly import("./calibration.ts").ReliabilityPoint[];
        threshold: number | null;
    };
    before: {
        count: number;
        accepted: number;
        correct: number;
        precision: number | null;
        abstentionRate: number;
        perType: {
            [k: string]: {
                support: number;
                predicted: number;
                precision: number | null;
                abstentionRate: number;
            };
        };
    };
    newPrompt: {
        count: number;
        accepted: number;
        correct: number;
        precision: number | null;
        abstentionRate: number;
        perType: {
            [k: string]: {
                support: number;
                predicted: number;
                precision: number | null;
                abstentionRate: number;
            };
        };
    };
    after: {
        count: number;
        accepted: number;
        correct: number;
        precision: number | null;
        abstentionRate: number;
        perType: {
            [k: string]: {
                support: number;
                predicted: number;
                precision: number | null;
                abstentionRate: number;
            };
        };
    };
    observations: TypeObservation[];
}>;
//# sourceMappingURL=type-calibration.d.ts.map