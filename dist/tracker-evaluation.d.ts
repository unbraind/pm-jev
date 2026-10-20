import type { ItemMetadata, PmSettings } from "@unbrained/pm-cli/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import type { TriageItemState } from "./index.ts";
import type { EvaluationTask } from "./decision-calibration.ts";
import type { ExemplarUnit } from "./exemplar-retrieval.ts";
import type { LocalProvenance } from "./source-provenance.ts";
/** Certified tracker projection; direct local sources carry an explicit unverified trust marker. */
export interface TrackerCorpus extends LocalProvenance {
    repository: string;
    commit: string;
    data_sha256: string;
    settings: PmSettings;
    items: (ItemMetadata & {
        body?: string;
    })[];
}
/** A labelled request; only state and questions cross the model boundary. */
export interface EvaluationExample extends LocalProvenance {
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
/** Read an explicitly opted-in local tracker directly; never discover repositories or launch external tools. */
export declare function readLocalCorpus(from: string): Promise<TrackerCorpus>;
/** Remove routing fields and bound semantic text identically for evaluation and calibrated inference. */
export declare function semanticState(item: ItemMetadata & {
    body?: string;
}): TriageItemState;
/** Recover explicit known-duplicate targets, never infer truth from title similarity. */
export declare function duplicateTarget(item: ItemMetadata): string | undefined;
/** Build labels from tracker types/priorities, canonical edges and explicit duplicate resolutions. */
export declare function buildExamples(corpus: TrackerCorpus, task: EvaluationTask): {
    examples: EvaluationExample[];
    retrieval_misses: number;
};
/** One labelled benchmark unit; structurally also a retrieval exemplar. */
export interface LabelledUnit extends ExemplarUnit {
    /** The content-hashed benchmark example built from this unit. */
    readonly example: EvaluationExample;
    /** The typed questions asked over this unit's state. */
    readonly questions: Questions;
    /** The state sent to the model for this unit. */
    readonly state: unknown;
    /** Ground-truth labels keyed by question channel. */
    readonly labels: Record<string, string>;
}
/** Construct labelled units with identical example hashes to the legacy builder. */
export declare function buildUnits(corpus: TrackerCorpus, task: EvaluationTask): {
    units: LabelledUnit[];
    retrieval_misses: number;
};
/** Stable seeded hash sampling without replacement, balanced across repositories by round-robin. */
export declare function deterministicSample<Row extends {
    example_sha256: string;
    repository: string;
}>(examples: readonly Row[], count: number, seed: string): Row[];
//# sourceMappingURL=tracker-evaluation.d.ts.map