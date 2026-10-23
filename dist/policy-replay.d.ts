import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
/** Version of the frozen-input compatibility contract. */
export declare const REPLAY_VERSION = "pm-jev-replay/1";
/** Redacted, actionable replay failure; input and transport text are never echoed. */
export declare class ReplayRefusal extends Error {
    /** Stable category suitable for programmatic recovery. */
    readonly code: "invalid_recording" | "invalid_policy" | "local_only" | "model_unavailable";
    /** Recovery guidance without source evidence or transport details. */
    readonly remedy: string;
    /** Construct a stable refusal with a recovery instruction. */
    constructor(code: ReplayRefusal["code"], remedy: string);
}
/** Versioned probability filter, inclusive at the threshold. */
export interface ReplayPolicy {
    readonly version: string;
    readonly min_probability: number;
}
/** Frozen minimized state, exact questions, raw validated answer and original policy. */
export interface ReplayRecord {
    readonly id: string;
    readonly state?: Readonly<Record<string, unknown>>;
    readonly questions?: Questions;
    readonly result?: SystemOneResult<Questions>;
    readonly policy?: ReplayPolicy;
}
/** Portable recordings; omitted inputs remain explicit gaps instead of being reconstructed. */
export interface ReplayRecording {
    readonly version: typeof REPLAY_VERSION;
    readonly records: readonly ReplayRecord[];
}
/** Trusted in-process adapter; only the built-in Ollama adapter makes local HTTP calls. */
export interface ReplayAdapter {
    readonly version: string;
    decide(record: Required<ReplayRecord>): Promise<SystemOneResult<Questions>>;
}
/** Compact totals over all questions, independently of the bounded detail rows. */
export interface ReplayReport {
    readonly version: typeof REPLAY_VERSION;
    readonly recording_sha256: string;
    readonly policy: ReplayPolicy;
    readonly adapter: string;
    readonly complete: boolean;
    readonly records: number;
    readonly attempted: number;
    readonly replayed: number;
    readonly gaps: number;
    readonly compared: number;
    readonly agreement: number;
    readonly disagreement: number;
    readonly old_abstentions: number;
    readonly new_abstentions: number;
    readonly latency_ms: {
        readonly total: number;
        readonly mean: number | null;
    };
    readonly details: readonly {
        readonly index: number;
        readonly gap?: string;
        readonly changed?: readonly string[];
    }[];
    readonly omitted_details: number;
}
/** Parse and snapshot bounded JSON data; missing fields are allowed, malformed fields refuse. */
export declare function parseReplayRecording(raw: unknown): ReplayRecording;
/** Replay saved scores locally or call a trusted local adapter, never read current tracker state. */
export declare function replayDecisions(recording: ReplayRecording, policy: ReplayPolicy, adapter?: ReplayAdapter, detailLimit?: number): Promise<ReplayReport>;
/** Bind only a loopback, non-cloud, installed Ollama decision model; ignore hosted settings/env. */
export declare function createOllamaReplayAdapter(model: string, baseUrl?: string, deadlineMs?: number): Promise<ReplayAdapter>;
//# sourceMappingURL=policy-replay.d.ts.map