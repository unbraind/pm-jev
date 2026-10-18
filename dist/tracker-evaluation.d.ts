import type { ItemMetadata, PmSettings } from "@unbrained/pm-cli/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { EvaluationTask } from "./decision-calibration.ts";
/** Immutable committed public tracker snapshot projected through the host SDK. */
export interface TrackerCorpus {
    repository: string;
    commit: string;
    data_sha256: string;
    settings: PmSettings;
    items: (ItemMetadata & {
        body?: string;
    })[];
}
/** A labelled request; only state and questions cross the model boundary. */
export interface EvaluationExample {
    repository: string;
    commit: string;
    data_sha256: string;
    example_sha256: string;
    state: unknown;
    questions: Questions;
    labels: Record<string, string>;
}
/** Run bounded external inspection tools without a shell or credential-bearing output. */
export declare function inspectSource(command: string, args: string[], cwd: string, input?: Buffer): Buffer;
/** Verify a fleet clone's public identity before touching tracker contents; private repos are skipped. */
export declare function readPublicCorpus(from: string, inspect?: typeof inspectSource): Promise<TrackerCorpus | null>;
/** Remove routing fields and bound semantic text identically for evaluation and calibrated inference. */
export declare function semanticState(item: ItemMetadata & {
    body?: string;
}): import("./index.ts").TriageItemState;
/** Recover explicit known-duplicate targets, never infer truth from title similarity. */
export declare function duplicateTarget(item: ItemMetadata): string | undefined;
/** Build labels from tracker types/priorities, canonical edges and explicit duplicate resolutions. */
export declare function buildExamples(corpus: TrackerCorpus, task: EvaluationTask): {
    examples: EvaluationExample[];
    retrieval_misses: number;
};
/** Stable seeded hash sampling without replacement, balanced across repositories by round-robin. */
export declare function deterministicSample(examples: readonly EvaluationExample[], count: number, seed: string): EvaluationExample[];
//# sourceMappingURL=tracker-evaluation.d.ts.map