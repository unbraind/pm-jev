import type { TokenUsage } from "./token-usage.ts";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Questions, SystemOneResult, ChoiceResponse } from "@typesafe-ai/sdk";
import type { CalibrationUse } from "./decision-calibration.ts";
import { createPmCliExpectedError, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import { RelationshipGraph } from "@unbrained/pm-cli/sdk/graph";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata, PmSettings } from "@unbrained/pm-cli/sdk";
/** Re-export the structural expected-error predicate for package consumers. */
export { isPmCliExpectedError };
/** Re-export the structural expected-error factory for package consumers. */
export { createPmCliExpectedError };
/** Re-export the pm similarity score type used by the dedupe ranking contract. */
export type { ItemMetadata, PmSettings };
/** Re-export the SDK question-map and result contracts callers validate against. */
export type { Questions, SystemOneResult };
/** Fixed-score cost selection and proposal vetoes for SDK consumers. */
export { COST_POLICY_VERSION, CostPolicyRefusal, parseCostDataset, selectAbstentionPolicy, abstainWithPolicy } from "./cost-policy.ts";
/** Typed caller costs, evidence, receipts and refusal codes. */
export type { DecisionCosts, CostObservation, CostDataset, CostRefusalCode, AbstentionPolicy, CostMetrics, CostPoint, CostPolicyReport } from "./cost-policy.ts";
/** Bounded sensitivity comparisons over the existing typed decision interface. */
export { COUNTERFACTUAL_VERSION, CounterfactualRefusal, explainDecision } from "./counterfactual.ts";
/** Typed options, compact proposals and uncertainty-bearing explanation receipts. */
export type { CounterfactualOptions, CounterfactualReceipt, ExplanationProposal, FieldComparison } from "./counterfactual.ts";
/** Frozen-input compatibility inspection and loopback-only decision model adapter. */
export { REPLAY_VERSION, ReplayRefusal, parseReplayRecording, replayDecisions, createOllamaReplayAdapter } from "./policy-replay.ts";
/** Portable recording, policy, trusted adapter and compact comparison contracts. */
export type { ReplayPolicy, ReplayRecord, ReplayRecording, ReplayAdapter, ReplayReport, ReplayExecutionResult } from "./policy-replay.ts";
/** Version of the triage question catalog; surfaced in every triage receipt. */
export declare const TRIAGE_CATALOG_VERSION = "pm-jev-triage/2";
/** Explicit non-mutating candidate, distinct from every registered type. */
export declare const KEEP_CURRENT_TYPE = "__keep_current__";
/** Minimum evidence for a new type, independent of a lower CLI apply threshold. */
export declare const TYPE_CHANGE_PROBABILITY = 0.8;
/** Empirical calibration cutoff; see calibration/type-report-v1.json. */
export declare const TYPE_MARGIN_THRESHOLD = 0.05136322250317049;
/** Version of the dedupe question catalog; surfaced in dedupe output. */
export declare const DEDUPE_CATALOG_VERSION = "pm-jev-dedupe/1";
/**
 * The pm priority rubric as score criteria, index-aligned with pm's 0..4
 * priority integers (0 = critical … 4 = minimal, per resolvePriority).
 *
 * The rubric is described to the model in plain language; the mapping back to
 * an integer is arithmetic done in code, never by the model.
 */
export declare const PRIORITY_RUBRIC: readonly [string, string, string, string, string];
/** The two supported decision providers. */
export type JevProvider = "ollama" | "typesafe";
/** Fully resolved, call-ready provider endpoint configuration. */
export interface JevConfig {
    /** Which provider answers decisions. */
    readonly provider: JevProvider;
    /** HTTP base URL of the decision endpoint. */
    readonly baseUrl: string;
    /** Model name to send with every decision request. */
    readonly model: string;
    /** Per-attempt HTTP timeout in milliseconds (SDK `timeout`). */
    readonly timeoutMs: number;
    /** Total deadline for one decision call, retries included, in milliseconds. */
    readonly totalDeadlineMs: number;
    /** Probability threshold an answer must clear before --apply writes it. */
    readonly minConfidence: number;
    /** Probability threshold the gate command compares a noul against. */
    readonly gateThreshold: number;
    /** Ollama model residency after a request, in seconds or a duration string. */
    readonly keepAlive?: number | string;
}
/** Why a hosted (typesafe) provider is not callable; local callers see `null`. */
export type HostedBlock = "missing_opt_in" | "missing_api_key";
/** Endpoint resolution result: the config plus the hosted opt-in verdict. */
export interface ResolvedJevEndpoint {
    /** Provider endpoint configuration; always populated. */
    readonly config: JevConfig;
    /** Hosted privacy-gate verdict: `null` when calls may proceed. */
    readonly hostedBlocked: HostedBlock | null;
}
/**
 * Resolve the fully configured decision endpoint, without enforcing the hosted
 * privacy gate — so `jev doctor` can diagnose a refused configuration instead
 * of dying on it.
 *
 * Precedence: environment overrides win, then the `jev` settings section, then
 * pm's typed `providers.ollama` settings (local provider only), then built-in
 * defaults. Hosted TypeSafe resolution never consults `providers.ollama`: an
 * Ollama endpoint must not silently become a hosted credential destination.
 *
 * @param pmRoot - Resolved pm tracker root.
 * @param env - Environment to read `PM_JEV_BASE_URL`, `PM_JEV_MODEL` and
 *              `TYPESAFE_API_KEY` from.
 * @returns The endpoint configuration and the hosted opt-in verdict.
 * @throws {PmCliExpectedError} The provider or URL is invalid, or a hosted
 *         credential destination is not explicitly trusted.
 */
export declare function resolveJevEndpoint(pmRoot: string, env: Record<string, string | undefined>): Promise<ResolvedJevEndpoint>;
/**
 * Build a TypeSafeClient for the resolved endpoint.
 *
 * The client carries `logLevel: "off"` so request/response bodies are never
 * emitted even if a caller enables debug logging elsewhere: PM state is
 * private. Retries stay at the SDK's bounded defaults (two retries with
 * exponential backoff on 429/5xx), while the total deadline is enforced per
 * call through an abort signal in {@link runDecision}.
 *
 * @param resolved - Endpoint resolution from {@link resolveJevEndpoint}.
 * @param env - Environment to read `TYPESAFE_API_KEY` from for hosted calls.
 * @returns A configured client bound to the selected provider.
 */
export declare function createJevClient(resolved: ResolvedJevEndpoint, env: Record<string, string | undefined>, maxRetries?: number): TypeSafeClient;
/**
 * Enforce the hosted privacy gate: refuse external transfer unless the caller
 * explicitly opted in via `jev.allow_external=true` AND provided an API key.
 *
 * The refusal message never echoes item state; it only names the missing
 * pieces so an agent can fix configuration.
 *
 * @param resolved - Endpoint resolution from {@link resolveJevEndpoint}.
 * @returns The call-ready configuration.
 * @throws {PmCliExpectedError} The hosted provider is not opted in or has no key.
 */
export declare function requireCallableEndpoint(resolved: ResolvedJevEndpoint): JevConfig;
/** The narrow item view the projection consumes; satisfied by PmClient reads. */
export interface ProjectableItem {
    /** Stable item id. */
    readonly id: string;
    /** Item title. */
    readonly title: string;
    /** Item schema type name. */
    readonly type: string;
    /** Item lifecycle status. */
    readonly status: string;
    /** Current pm priority integer. */
    readonly priority?: number;
    /** Item tags. */
    readonly tags: readonly string[];
    /** Item description. */
    readonly description?: string;
    /** Item body text. */
    readonly body?: string;
}
/** The least-privilege item projection sent to the model. */
export interface ProjectedItemState {
    /** Item title, truncated. */
    readonly title: string;
    /** Item schema type name. */
    readonly type: string;
    /** Item lifecycle status. */
    readonly status: string;
    /** Item tags. */
    readonly tags: readonly string[];
    /** Truncated description. */
    readonly description: string;
    /** Truncated body. */
    readonly body: string;
}
/**
 * Project one pm item into least-privilege decision state.
 *
 * Only title, type, status, tags, description and body are exposed —
 * never comments, notes, history, authors, or filesystem paths. Text fields are
 * truncated to {@link STATE_TEXT_LIMIT} to bound tokens and keep the model off
 * "large irrelevant state", a documented Jev weakness.
 *
 * @param item - Metadata projection of a pm item (as returned by PmClient.get).
 * @returns The state object sent to the decision model.
 */
export declare function projectItemState(item: ProjectableItem): ProjectedItemState;
/** Minimal triage evidence; excludes routing outputs and redundant body text. */
export interface TriageItemState {
    readonly title: string;
    readonly description?: string;
    readonly body?: string;
    readonly tags?: readonly string[];
}
/** Project only triage evidence, bounding text and omitting a duplicated description. */
export declare function projectTriageState(item: ProjectableItem): TriageItemState;
/** Hash complete source evidence, excluding inferred type/priority and receipt metadata. */
export declare function triageSourceHash(item: ProjectableItem): string;
/** Validate every answer, probability, rubric, model and usage before any mutation. */
export declare function validateAnswers(questions: Questions, raw: unknown): asserts raw is SystemOneResult<Questions>;
/**
 * Run one batched decision under the configured total deadline and validate
 * every answer shape.
 *
 * @param client - Client bound to the configured provider endpoint.
 * @param config - Call-ready configuration (model, deadline).
 * @param state - Projected decision state.
 * @param questions - Named typed questions, each evaluated independently.
 * @param signal - Optional shared run deadline; otherwise create a per-decision deadline.
 * @returns The validated response with resolved model and usage.
 * @throws {PmCliExpectedError} A mapped transport/validation failure.
 */
export declare function runDecision(client: TypeSafeClient, config: JevConfig, state: unknown, questions: Questions, signal?: AbortSignal): Promise<SystemOneResult<Questions>>;
/**
 * Map any decision-call failure onto a typed expected CLI error.
 *
 * Transport classes come from the SDK; malformed payloads surface as plain
 * `Error`s from {@link validateAnswers} and are wrapped with the answer path.
 * Messages carry remediation hints (including `ollama pull` for a missing
 * model) but never request bodies.
 *
 * @param error - Failure thrown by the client or the validator.
 * @param config - Configuration used for the failed call.
 * @returns A structured expected error for the host to render.
 */
export declare function translateDecisionError(error: unknown, config: JevConfig): ReturnType<typeof createPmCliExpectedError>;
/**
 * Parse and validate a caller-supplied question map for `jev ask`.
 *
 * Structural mirror of the SDK `Questions` contract: a nonempty object of
 * named questions where `choice` needs a nonempty criteria map, `score` needs
 * a rubric of 2–10 described levels, and `noul` accepts optional true/false
 * descriptions. Instructions may be text, JSON, or absent.
 *
 * @param raw - Parsed JSON from the questions file.
 * @returns The validated question map.
 * @throws {PmCliExpectedError} The document violates the Questions contract.
 */
export declare function parseQuestionsDocument(raw: unknown): Questions;
/** One model-produced proposal over a pm item. */
export interface TriageProposals {
    /** Proposed item type with the full probability distribution. */
    readonly type: {
        readonly kind: "choice";
        readonly value: string | null;
        readonly selected_label: string;
        /** Probability of the resolved type; on abstention, probability of the leading label. */
        readonly probability: number;
        readonly probabilities: Record<string, number>;
        readonly confidence: number;
        readonly definitions: Record<string, string>;
        readonly abstained: boolean;
        readonly kept_current: boolean;
        readonly reason: string | null;
        readonly margin: number;
        readonly margin_threshold: number;
    };
    /** Proposed priority with the level distribution over the 0..4 rubric. */
    readonly priority: {
        readonly kind: "score";
        readonly level: number;
        readonly score: number;
        readonly probabilities: Record<string, number>;
        readonly confidence: number;
    };
    /** Probability the item needs a human decision before work proceeds. */
    readonly needs_human: {
        readonly kind: "noul";
        readonly probability: number;
    };
    /** Probability the item contains secrets, personal data, or local paths. */
    readonly sensitive: {
        readonly kind: "noul";
        readonly probability: number;
    };
}
/** Full triage decision receipt returned by the triage command. */
export interface TriageDecision {
    /** The item id the decision was made over. */
    readonly item: string;
    /** Proposals per question; never applied without --apply and threshold. */
    readonly proposals: TriageProposals;
    /** Resolved model revision reported by the endpoint. */
    readonly model: string;
    /** Token usage reported by the endpoint. */
    readonly usage: TokenUsage;
    /** Versioned question catalog that produced the proposals. */
    readonly catalog_version: string;
    /** Stable identity of the effective type question and decision policy. */
    readonly type_question_sha256: string;
    /** Fields written when --apply was passed; empty otherwise. */
    readonly applied: readonly string[];
    /** Active calibration identity and channel qualification; omitted under the legacy policy. */
    readonly calibration?: {
        readonly type: CalibrationUse | null;
        readonly priority: CalibrationUse | null;
        readonly raw_type_probabilities: Record<string, number>;
        readonly raw_priority_probabilities: Record<string, number>;
    };
}
/**
 * Build the batched triage question catalog for one tracker.
 *
 * The choice criteria are the tracker's *actual* configured item types (read
 * from the SDK type registry, so custom types behave identically), each
 * described with the schema description when present.
 *
 * @param settings - Tracker settings from `readSettings`.
 * @returns The typed question map for the triage batch.
 */
export declare function buildTriageQuestions(settings: PmSettings): Questions;
/** Build label-hidden type/priority questions used by evaluation and calibrated triage. */
export declare function buildClassificationQuestions(settings: PmSettings): Questions;
/** Build the exact compact production relationship ontology for one candidate. */
export declare function buildLinkQuestion(candidate: string): Questions[string];
/** Build the shared duplicate-screening request without source routing labels. */
export declare function buildDedupeRequest(title: string, body: string, candidates: readonly DedupeCandidate[]): {
    state: {
        proposed: {
            title: string;
            body: string;
        };
        candidates: {
            title: string;
            id: string;
            type: string;
            status: string;
            score: number;
        }[];
    };
    questions: Questions;
};
/** Bind the non-mutating candidate to the current type without adding routing fields to evidence. */
export declare function withCurrentType(questions: Questions, current: string): Questions;
/** Resolve a validated label distribution in code: ambiguity abstains, weak changes retain the current type. */
export declare function resolveTriageType(answer: ChoiceResponse, current: string, definitions: Record<string, string>, marginThreshold?: number, changeProbability?: number): TriageProposals["type"];
/** One compact batch row, intentionally excluding source text and answer distributions. */
export interface BacklogTriageRow {
    readonly item: string;
    readonly outcome: "changed" | "would_change" | "skipped" | "failed";
    readonly type: string | null;
    /** Resolved type's label probability; null on abstention or receipt reuse. */
    readonly type_probability: number | null;
    readonly priority: number | null;
    readonly priority_probability: number | null;
    readonly needs_human: number | null;
    readonly sensitive: number | null;
    readonly reason: string | null;
    readonly abstained: boolean;
    /** Active channel fit and thresholds when calibration is in use. */
    readonly calibration?: TriageDecision["calibration"];
}
/** Constant-size terminal receipt retained by host hooks and embedding callers. */
export interface BacklogTriageSummary {
    readonly record_type: "pm-jev.triage.summary";
    readonly selected: number;
    readonly changed: number;
    readonly would_change: number;
    readonly skipped: number;
    readonly failed: number;
    readonly has_more: boolean;
    readonly elapsed_ms: number;
    readonly exit_code: number;
}
/** One code-ranked duplicate candidate for the model to confirm. */
export interface DedupeCandidate {
    /** Candidate item id. */
    readonly id: string;
    /** Candidate title. */
    readonly title: string;
    /** Candidate item type. */
    readonly type: string;
    /** Candidate lifecycle status. */
    readonly status: string;
    /** Deterministic title-similarity score in `[0, 1]`. */
    readonly score: number;
}
/** Dedupe decision receipt returned by the dedupe command. */
export interface DedupeDecision {
    /** The winning candidate id, or `null` when the model chose "none". */
    readonly duplicate_of: string | null;
    /** Probability assigned to the chosen option. */
    readonly probability: number;
    /** Full option distribution keyed by candidate id and "none". */
    readonly probabilities: Record<string, number>;
    /** Confidence reported for the choice. */
    readonly confidence: number;
    /** The code-ranked candidates the choice was made over. */
    readonly candidates: readonly DedupeCandidate[];
    /** Resolved model revision reported by the endpoint. */
    readonly model: string;
    /** Token usage reported by the endpoint. */
    readonly usage: TokenUsage;
    /** Versioned question catalog that produced the decision. */
    readonly catalog_version: string;
    /** Active calibration identity and channel qualification; omitted under the legacy policy. */
    readonly calibration?: CalibrationUse & {
        readonly raw_probability: number;
        readonly qualifies: boolean;
    };
}
/**
 * Rank tracker items against a proposed title deterministically, in code.
 *
 * The model never counts or compares candidates; it only picks among the ids
 * this function already ranked with the SDK's canonical title-similarity
 * signals (exact match, issue codes, token Jaccard).
 *
 * @param items - All tracker item metadata.
 * @param title - Title of the item about to be created.
 * @param limit - Maximum number of candidates to return.
 * @returns Candidates with a positive similarity score, sorted descending.
 */
export declare function rankDedupeCandidates(items: readonly ItemMetadata[], title: string, limit: number): DedupeCandidate[];
/** Versioned relationship question and authorization contract. */
export declare const LINK_CATALOG_VERSION = "pm-jev-link/1";
/** One ranked relationship judgment; an existing or ambiguous edge has no proposal. */
export interface LinkProposal {
    readonly candidate: string;
    readonly score: number;
    readonly kind: string | null;
    readonly selected_kind: string;
    readonly probability: number;
    readonly probabilities: Record<string, number>;
    readonly abstained: boolean;
    readonly reason: string | null;
    readonly existing: boolean;
    readonly margin: number;
    /** Exact threshold and calibration evidence when a compatible saved fit exists. */
    readonly calibration?: CalibrationUse;
    /** Uncalibrated winner probability retained for comparison. */
    readonly raw_probability?: number;
}
/** One item decision with redacted evidence and the exact authorized edge additions. */
export interface LinkDecision {
    readonly item: string;
    readonly outcome: "none" | "proposals";
    readonly proposals: readonly LinkProposal[];
    readonly applied: readonly string[];
    readonly qualifying: readonly string[];
    readonly model: string;
    readonly catalog_version: string;
    readonly usage: SystemOneResult<Questions>["usage"];
    /** Active calibration identity and channel qualification; omitted under the legacy policy. */
    readonly calibration?: {
        readonly receipt_sha256: string;
    };
}
/** Find canonical existing edges including reverse inverse kinds, symmetric edges and scalar parents. */
export declare function existingLinkKinds(graph: RelationshipGraph, source: string, target: string): Set<string>;
/** Answer for one caller-defined question, shape-checked by question type. */
export type AskAnswer = {
    readonly kind: "noul";
    readonly probability: number;
} | {
    readonly kind: "choice";
    readonly value: string;
    readonly probabilities: Record<string, number>;
    readonly confidence: number;
} | {
    readonly kind: "score";
    readonly score: number;
    readonly probabilities: Record<string, number>;
    readonly confidence: number;
};
/** Ask command receipt: typed answers plus endpoint metadata. */
export interface AskDecision {
    /** The item id the questions were run against. */
    readonly item: string;
    /** Answers keyed by question name, in the file's order. */
    readonly answers: Record<string, AskAnswer>;
    /** Resolved model revision reported by the endpoint. */
    readonly model: string;
    /** Token usage reported by the endpoint. */
    readonly usage: TokenUsage;
}
/** Gate command receipt: the calibrated verdict agents and CI branch on. */
export interface GateDecision {
    /** Host-owned process status for a negative verdict; omitted for a positive verdict. */
    readonly exit_code?: 1;
    /** The proposition that was evaluated. */
    readonly proposition: string;
    /** Probability the model assigns to the proposition being true. */
    readonly probability: number;
    /** Threshold the probability was compared against. */
    readonly threshold: number;
    /** Whether the proposition holds (`probability >= threshold`, inclusive). */
    readonly holds: boolean;
    /** Expected proposition outcome; defaults to true, false for safety gates. */
    readonly expected: boolean;
    /** Whether the proposition outcome matches the expectation. */
    readonly ok: boolean;
    /** Which state source the proposition was evaluated over. */
    readonly source: "text" | "item";
    /** Resolved model revision reported by the endpoint. */
    readonly model: string;
    /** Token usage reported by the endpoint. */
    readonly usage: TokenUsage;
}
/** One decision model advertised by the configured endpoint. */
export interface DecisionModel {
    /** Model name as the endpoint reports it. */
    readonly name: string;
    /** Whether the endpoint reports the `decision` capability for this model. */
    readonly decision: boolean;
}
/** Model inventory resolved from the configured endpoint. */
export interface DecisionModelInventory {
    /** Which discovery surface produced the list. */
    readonly source: "sdk" | "ollama-tags";
    /** Endpoint the inventory was read from. */
    readonly base_url: string;
    /** Every model the endpoint serves, with the decision capability marked. */
    readonly models: readonly DecisionModel[];
}
/**
 * List the decision models served by the configured endpoint.
 *
 * The SDK's `models.list()` is the canonical surface, but the local Ollama
 * server answers `/v1/models` with the OpenAI shape rather than TypeSafe's, so
 * the call fails there by design; for the ollama provider the inventory then
 * falls back to Ollama's own `/api/tags`, filtered on the `decision`
 * capability. The hosted provider has no fallback: a listing failure is the
 * diagnostic.
 *
 * @param resolved - Endpoint resolution from {@link resolveJevEndpoint}.
 * @param env - Environment to read `TYPESAFE_API_KEY` from for hosted calls.
 * @returns The model inventory with the discovery source named.
 * @throws {PmCliExpectedError} The endpoint cannot be listed or the hosted
 *         privacy gate refuses.
 */
export declare function listDecisionModels(resolved: ResolvedJevEndpoint, env: Record<string, string | undefined>): Promise<DecisionModelInventory>;
/** One named health check in the doctor receipt. */
export interface DoctorCheck {
    /** Stable check name. */
    readonly name: string;
    /** Whether the check passed. */
    readonly ok: boolean;
    /** Human-readable outcome detail; never contains item state or secrets. */
    readonly detail: string;
}
/** Doctor receipt: configuration, privacy, endpoint, and model health. */
export interface DoctorReport {
    /** Aggregate status: "ok" when every check passed, "degraded" otherwise. */
    readonly status: "ok" | "degraded";
    /** Every check executed, in deterministic order. */
    readonly checks: readonly DoctorCheck[];
    /** The resolved endpoint configuration (secrets never included). */
    readonly config: JevConfig;
}
/** Public pm extension activation entry and release-managed identity. */
declare const _default: {
    name: string;
    version: string;
    description: string;
    /** Register the versioned decision commands with the pm host. */
    activate(api: ExtensionApi): void;
};
export default _default;
/** Durable interrupted-run accounting and typed private receipt contracts. */
export { ReceiptRefusal, ReceiptRun, withReceipt, reportPriorReceipt } from "./partial-receipt.ts";
/** Portable accounting types for SDK evaluation and replay consumers. */
export type { PartialReceipt, ReceiptFailure, ReceiptOptions, InterruptionReason } from "./partial-receipt.ts";
/** Run typed evaluation with the host SDK and durable private interruption receipts. */
export { runEvaluationCommand } from "./evaluation-command.ts";
/** Evaluator result contract for callers that inspect interrupted receipts. */
export type { EvaluationResult } from "./evaluation-command.ts";
//# sourceMappingURL=index.d.ts.map