import { TokenUsageTotals } from "./token-usage.ts";
import type { TokenUsage } from "./token-usage.ts";
// pm-jev — typed, local-first System One decisions for pm items.
//
// "Project management = context management": this package turns pm items into
// bounded decision state and asks Jev-style System One models typed
// choice/score/noul questions over it. Jev/tev1 are literal and weak at math,
// dates, counting and multi-hop reasoning (docs/typesafe.ai model-jaggedness
// notes), so every deterministic step — candidate ranking, threshold
// comparisons, id handling, exit codes, receipt formatting — stays in code.
// The model only judges.
//
// Decisions are PROPOSALS. Nothing here mutates a pm item unless the caller
// passes --apply, and even then only fields whose reported probability clears
// a configured threshold are written, each with a redacted receipt comment.
//
// The network boundary is the official `@typesafe-ai/sdk` TypeSafeClient
// pointed at either a local Ollama server (default, wire-compatible with the
// hosted Jev API) or TypeSafe's hosted API. The hosted provider is a privacy
// gate: it additionally requires TYPESAFE_API_KEY and an explicit
// `jev.allow_external=true` setting, and refuses loudly otherwise. Request
// bodies are never logged.

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { EntryType, Questions, ScoreCriteria, SystemOneResult, ChoiceResponse, ScoreResponse, NoulResponse } from "@typesafe-ai/sdk";
import { createHash } from "node:crypto";
import { EVALUATION_FLAGS, runEvaluationCommand } from "./evaluation-command.ts";
import { COST_POLICY_FLAGS, runCostPolicyCommand } from "./cost-policy-command.ts";
import { REPLAY_FLAGS, runReplayCommand } from "./replay-command.ts";
import { EXPLANATION_FLAGS, runExplanationCommand } from "./counterfactual-command.ts";
import { runPairDedupe, guardDedupeMutation } from "./dedupe.ts";
import { activeCalibration, calibratedAnswer, modelDigest, questionFingerprint, ranked, readOpaqueJevSettings } from "./decision-calibration.ts";
import type { ActiveCalibration, CalibrationUse } from "./decision-calibration.ts";
import {
  DEPENDENCY_KIND_VALUES,
  createPmCliExpectedError,
  isPmCliExpectedError,
  PmClient,
  readBooleanOption,
  readFileIfExists,
  readSettings,
  readStringOption,
  resolveItemTypeRegistry,
  resolveTypeName,
  scoreItemSimilarity,
  suppressHostOutput,
  writeStdout,
} from "@unbrained/pm-cli/sdk";
import { RelationshipGraph, resolveWorkspaceRelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import type { RelationshipKindDefinition, RelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import { defineCommand, defineExtension } from "@unbrained/pm-cli/sdk/authoring";
import type { BeforeMutationHookContext, BeforeMutationHookDecision, ExtensionApi, CommandHandlerContext, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import type { GetResult, ListResult, ItemMetadata, PmSettings } from "@unbrained/pm-cli/sdk";

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
export type { ReplayPolicy, ReplayRecord, ReplayRecording, ReplayAdapter, ReplayReport } from "./policy-replay.ts";

// ---------------------------------------------------------------------------
// Versioned question catalogs
// ---------------------------------------------------------------------------

/** Version of the triage question catalog; surfaced in every triage receipt. */
export const TRIAGE_CATALOG_VERSION = "pm-jev-triage/2";
/** Explicit non-mutating candidate, distinct from every registered type. */
export const KEEP_CURRENT_TYPE = "__keep_current__";
/** Minimum evidence for a new type, independent of a lower CLI apply threshold. */
export const TYPE_CHANGE_PROBABILITY = 0.8;
/** Empirical calibration cutoff; see calibration/type-report-v1.json. */
export const TYPE_MARGIN_THRESHOLD = 0.05136322250317049;

/** Version of the dedupe question catalog; surfaced in dedupe output. */
export const DEDUPE_CATALOG_VERSION = "pm-jev-dedupe/1";

/**
 * The pm priority rubric as score criteria, index-aligned with pm's 0..4
 * priority integers (0 = critical … 4 = minimal, per resolvePriority).
 *
 * The rubric is described to the model in plain language; the mapping back to
 * an integer is arithmetic done in code, never by the model.
 */
export const PRIORITY_RUBRIC: readonly [string, string, string, string, string] = [
  "critical: blocks all work, loses data, or breaks users entirely",
  "high: serious impact on users or the release, workaround exists",
  "medium: normal scheduled work with moderate impact",
  "low: minor impact, can wait for a convenient moment",
  "minimal: backlog item with no urgency",
];

/** Semantic fallback descriptions for host built-ins whose schema omits descriptions. */
const BUILTIN_TYPE_CRITERIA: ReadonlyMap<string, string> = new Map(Object.entries({
  Issue: "A defect, bug, crash, or broken existing behavior",
  Feature: "A request for a new capability or new user-facing behavior",
  Task: "A concrete implementation action that is not itself a defect or a new capability",
  Chore: "Routine maintenance, dependency updates, or housekeeping",
  Epic: "A large objective grouping multiple related features or tasks",
  Decision: "A choice requiring human judgment, approval, or direction",
  Event: "An occurrence scheduled at a particular time",
  Meeting: "A scheduled discussion between people",
  Milestone: "A significant project checkpoint or delivery outcome",
  Plan: "An ordered sequence of proposed work steps",
  Reminder: "A prompt to revisit something at a particular time",
}));

/** Default local Ollama base URL when neither settings nor env configure one. */
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
/** Default decision model served by a stock local Ollama install. */
const DEFAULT_OLLAMA_MODEL = "tev1:4b";
/** Default hosted TypeSafe base URL. */
const DEFAULT_TYPESAFE_BASE_URL = "https://api.typesafe.ai";
/** Default hosted model alias (calibrated thresholds must pin a resolved version). */
const DEFAULT_TYPESAFE_MODEL = "jev-latest";
/** API key placeholder Ollama accepts; the local server does not authenticate. */
const OLLAMA_API_KEY = "ollama";
/** Per-attempt HTTP timeout default, milliseconds. */
const DEFAULT_TIMEOUT_MS = 90_000;
/** Total deadline for one decision call including SDK retries, milliseconds. */
const DEFAULT_TOTAL_DEADLINE_MS = 240_000;
/** Default probability an answer must clear before --apply may write a field. */
const DEFAULT_MIN_CONFIDENCE = 0.8;
/** Default gate threshold for the noul exit gate. */
const DEFAULT_GATE_THRESHOLD = 0.5;
/** Default candidate cap for dedupe. */
const DEFAULT_DEDUPE_LIMIT = 8;
/** Hard cap on any single text field projected into decision state, characters. */
const STATE_TEXT_LIMIT = 4_000;
/** Smallest per-attempt timeout accepted from settings, milliseconds. */
const TIMEOUT_MS_MIN = 1_000;
/** Largest per-attempt timeout accepted from settings, milliseconds. */
const TIMEOUT_MS_MAX = 600_000;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

/** The `jev` settings block accepted inside pm's own `settings.json`. */
interface JevSettingsSection {
  /** Provider selection; defaults to the local ollama provider. */
  readonly provider?: unknown;
  /** Base URL override for the selected provider. */
  readonly base_url?: unknown;
  /** Model override for the selected provider. */
  readonly model?: unknown;
  /** Per-attempt timeout in milliseconds. */
  readonly timeout_ms?: unknown;
  /** Total deadline in milliseconds. */
  readonly total_deadline_ms?: unknown;
  /** Probability threshold --apply must clear. */
  readonly min_confidence?: unknown;
  /** Gate command threshold. */
  readonly gate_threshold?: unknown;
  /** Explicit opt-in required before any hosted (external) provider is used. */
  readonly allow_external?: unknown;
  /** Ollama-only model residency; forwarded through the official SDK request. */
  readonly keep_alive?: unknown;
}

/** Validate the Ollama wire value without interpreting it as a request timeout. */
function keepAliveSetting(value: unknown): number | string {
  if (value === undefined) return "5m";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+(\.\d+)?(ns|us|µs|ms|s|m|h)$/.test(value)) return value;
  throw createPmCliExpectedError("jev.keep_alive must be finite seconds or an Ollama duration such as 5m.", { context: { code: "jev_invalid_keep_alive" } });
}

/**
 * Read the `jev` section from pm's own `settings.json`.
 *
 * The typed `readSettings` projection intentionally strips package-private
 * sections, so this reads the raw settings document through the SDK's resolved
 * `getSettingsPath` — pm's settings file, not an ad-hoc config file. Anything
 * that is not a plain object yields an empty section; malformed values are
 * ignored by the individual accessors below rather than failing the command.
 *
 * @param pmRoot - Resolved pm tracker root (the `.agents/pm` directory).
 * @returns The raw `jev` settings section, or an empty object when absent.
 */
async function readJevSettingsSection(pmRoot: string): Promise<JevSettingsSection> {
  return await readOpaqueJevSettings(pmRoot) as JevSettingsSection;
}

/**
 * Coerce a settings value into a finite number inside `[low, high]`.
 *
 * @param value - Raw settings value of any shape.
 * @param fallback - Value returned when the input is missing or invalid.
 * @param low - Smallest accepted value.
 * @param high - Largest accepted value.
 * @returns The clamped number, or `fallback` for unusable input.
 */
function numberSetting(value: unknown, fallback: number, low: number, high: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(high, Math.max(low, parsed));
}

/**
 * Coerce a settings value into a probability in `(0, 1]`.
 *
 * @param value - Raw settings value of any shape.
 * @param fallback - Value returned when the input is missing or invalid.
 * @returns The clamped probability, or `fallback` for unusable input.
 */
function probabilitySetting(value: unknown, fallback: number): number {
  return numberSetting(value, fallback, 0, 1);
}

/**
 * Coerce a settings value into a trimmed nonempty string.
 *
 * @param value - Raw settings value of any shape.
 * @returns The trimmed string, or `undefined` for missing/non-string input.
 */
function stringSetting(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve the effective provider selection from settings and environment.
 *
 * @param section - The raw `jev` settings section.
 * @returns The selected provider name, validated.
 * @throws {PmCliExpectedError} The provider or URL is invalid, or a hosted
 *         credential destination is not explicitly trusted.
 */
function resolveProvider(section: JevSettingsSection): JevProvider {
  const raw = stringSetting(section.provider)?.toLowerCase();
  if (raw === "typesafe") return "typesafe";
  if (raw === undefined || raw === "ollama") return "ollama";
  throw createPmCliExpectedError(
    `Unsupported jev provider "${raw}". Supported providers: ollama (local, default), typesafe (hosted, requires explicit opt-in).`,
    { context: { code: "jev_provider_unsupported" } },
  );
}

/**
 * Read the local Ollama endpoint pm itself is configured with, through the
 * SDK's typed `readSettings` projection — never by parsing `settings.json`.
 *
 * `readSettings` is total by contract: an absent or malformed settings
 * document resolves to typed defaults whose `providers.ollama` values are
 * empty strings, and `stringSetting` treats blank values as "not configured",
 * so resolution falls through to the built-in defaults. Reads are local file
 * access only: resolving settings never spawns an external command.
 *
 * @param pmRoot - Resolved pm tracker root (the `.agents/pm` directory).
 * @returns The typed `providers.ollama` base URL and model when configured.
 */
async function readOllamaProviderSettings(pmRoot: string): Promise<{ readonly baseUrl?: string; readonly model?: string }> {
  const settings = await readSettings(pmRoot);
  const ollama = settings.providers.ollama;
  return { baseUrl: stringSetting(ollama.base_url), model: stringSetting(ollama.model) };
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
export async function resolveJevEndpoint(
  pmRoot: string,
  env: Record<string, string | undefined>,
): Promise<ResolvedJevEndpoint> {
  const section = await readJevSettingsSection(pmRoot);
  const provider = resolveProvider(section);

  const envBaseUrl = stringSetting(env.PM_JEV_BASE_URL);
  const envModel = stringSetting(env.PM_JEV_MODEL);
  const sectionBaseUrl = stringSetting(section.base_url);
  const sectionModel = stringSetting(section.model);
  const ollama = provider === "ollama" ? await readOllamaProviderSettings(pmRoot) : {};
  const baseUrl =
    envBaseUrl ??
    sectionBaseUrl ??
    ollama.baseUrl ??
    (provider === "typesafe" ? DEFAULT_TYPESAFE_BASE_URL : DEFAULT_OLLAMA_BASE_URL);
  const model =
    envModel ??
    sectionModel ??
    ollama.model ??
    (provider === "typesafe" ? DEFAULT_TYPESAFE_MODEL : DEFAULT_OLLAMA_MODEL);
  let url: URL;
  try { url = new URL(baseUrl); } catch {
    throw createPmCliExpectedError("jev base URL must be an absolute HTTP(S) URL.", { context: { code: "jev_invalid_url" } });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw createPmCliExpectedError("jev base URL must be HTTP(S) without credentials, query or fragment.", { context: { code: "jev_invalid_url" } });
  }
  if (provider === "typesafe" && (url.protocol !== "https:" ||
    (url.origin !== new URL(DEFAULT_TYPESAFE_BASE_URL).origin && envBaseUrl === undefined))) {
    throw createPmCliExpectedError(
      "Hosted TypeSafe credentials require HTTPS; configure a non-default origin with PM_JEV_BASE_URL.",
      { context: { code: "jev_untrusted_credential_host" } },
    );
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const hostedBlocked: HostedBlock | null = (provider === "typesafe" || !local) && section.allow_external !== true
    ? "missing_opt_in"
    : provider === "typesafe" && stringSetting(env.TYPESAFE_API_KEY) === undefined ? "missing_api_key" : null;
  const timeoutMs = numberSetting(section.timeout_ms, DEFAULT_TIMEOUT_MS, TIMEOUT_MS_MIN, TIMEOUT_MS_MAX);
  const totalDeadlineMs = numberSetting(
    section.total_deadline_ms,
    Math.max(DEFAULT_TOTAL_DEADLINE_MS, timeoutMs * 3),
    TIMEOUT_MS_MIN,
    3_600_000,
  );

  // Trim trailing slashes without a regex: `/\/+$/` backtracks polynomially on
  // long runs of "/" in caller-supplied configuration (CodeQL js/polynomial-redos).
  let trimmedBaseUrl = baseUrl;
  while (trimmedBaseUrl.endsWith("/")) trimmedBaseUrl = trimmedBaseUrl.slice(0, -1);
  return {
    hostedBlocked,
    config: {
      provider,
      baseUrl: trimmedBaseUrl,
      model,
      timeoutMs,
      totalDeadlineMs,
      minConfidence: probabilitySetting(section.min_confidence, DEFAULT_MIN_CONFIDENCE),
      gateThreshold: probabilitySetting(section.gate_threshold, DEFAULT_GATE_THRESHOLD),
      ...(provider === "ollama" ? { keepAlive: keepAliveSetting(section.keep_alive) } : {}),
    },
  };
}

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
export function createJevClient(resolved: ResolvedJevEndpoint, env: Record<string, string | undefined>, maxRetries = 2): TypeSafeClient {
  const config = requireCallableEndpoint(resolved);
  const apiKey = config.provider === "ollama" ? OLLAMA_API_KEY : stringSetting(env.TYPESAFE_API_KEY);
  return new TypeSafeClient({
    apiKey,
    baseURL: config.baseUrl,
    defaultModel: config.model,
    timeout: config.timeoutMs,
    retry: { maxRetries },
    logLevel: "off",
    // Local Ollama compatibility endpoints expect JSON, regardless of SDK compression defaults.
    compression: config.provider === "ollama" ? false : undefined,
    /** Refuse redirects so a local endpoint cannot forward private state externally. */
    fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
  });
}

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
export function requireCallableEndpoint(resolved: ResolvedJevEndpoint): JevConfig {
  if (resolved.hostedBlocked === null) return resolved.config;
  throw createPmCliExpectedError(
    resolved.hostedBlocked === "missing_opt_in"
      ? "Refusing to send pm item state to the hosted TypeSafe provider. External transfer is opt-in: set \"jev\": { \"provider\": \"typesafe\", \"allow_external\": true } in this tracker's settings.json, or use the default local ollama provider. See https://docs.typesafe.ai/legal/privacy-policy for the vendor data boundary."
      : "The hosted TypeSafe provider is opted in but no TYPESAFE_API_KEY is set in the environment. Refusing to run without credentials.",
    {
      context: {
        code: resolved.hostedBlocked === "missing_opt_in" ? "jev_external_not_allowed" : "jev_external_missing_key",
      },
    },
  );
}

// ---------------------------------------------------------------------------
// Decision boundary: state projection, validation, execution, error mapping
// ---------------------------------------------------------------------------

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
 * Truncate one text field to the projection limit.
 *
 * @param value - Raw text of any length (possibly undefined).
 * @returns The truncated text; empty when absent.
 */
function truncateStateText(value: string | undefined): string {
  if (value === undefined) return "";
  return value.length > STATE_TEXT_LIMIT ? `${value.slice(0, STATE_TEXT_LIMIT)}…[truncated]` : value;
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
export function projectItemState(item: ProjectableItem): ProjectedItemState {
  return {
    title: truncateStateText(item.title),
    type: truncateStateText(item.type),
    status: truncateStateText(item.status),
    tags: item.tags.slice(0, 32).map(/** Bound each retained tag before inference. */ tag => tag.slice(0, 128)),
    description: truncateStateText(item.description),
    body: truncateStateText(item.body),
  };
}

/** Minimal triage evidence; excludes routing outputs and redundant body text. */
export interface TriageItemState {
  readonly title: string;
  readonly description?: string;
  readonly body?: string;
  readonly tags?: readonly string[];
}

/** Remove a description repeated as the body or its leading paragraph. */
function distinctTriageBody(item: ProjectableItem): string | undefined {
  const body = item.body?.trim();
  const description = item.description?.trim();
  if (description && body?.startsWith(description)) {
    const rest = body.slice(description.length);
    if (rest.length === 0 || rest.startsWith("\n") || rest.startsWith("\r")) return rest.trim();
  }
  return body;
}

/** Project only triage evidence, bounding text and omitting a duplicated description. */
export function projectTriageState(item: ProjectableItem): TriageItemState {
  const description = truncateStateText(item.description);
  const body = truncateStateText(distinctTriageBody(item));
  return {
    title: truncateStateText(item.title),
    ...(description ? { description } : {}),
    ...(body ? { body } : {}),
    ...(item.tags.length ? { tags: item.tags.slice(0, 32).map(/** Bound each retained triage tag. */ tag => tag.slice(0, 128)) } : {}),
  };
}

/** Hash complete source evidence, excluding inferred type/priority and receipt metadata. */
export function triageSourceHash(item: ProjectableItem): string {
  return createHash("sha256").update(JSON.stringify([item.title, item.description ?? "", item.body ?? "", item.tags, item.status])).digest("hex");
}

/**
 * Assert a value is a finite probability in `[0, 1]`.
 *
 * @param value - Answer field of unknown shape.
 * @param label - Answer path used in the rejection message.
 * @throws {Error} The value is not a finite number within `[0, 1]`.
 */
function requireProbability(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`malformed answer: ${label} is not a probability in [0,1]`);
  }
}

/** Require a non-array record before inspecting an untrusted response field. */
function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`malformed response: ${label} must be an object`);
  return value as Record<string, unknown>;
}

/** Check exact probability keys and a normalized distribution within rounding tolerance. */
function requireDistribution(value: unknown, labels: readonly string[], label: string): void {
  const distribution = requireRecord(value, label);
  if (Object.keys(distribution).length !== labels.length || Object.keys(distribution).some(/** Reject options not offered by the catalog. */ key => !labels.includes(key))) {
    throw new Error(`malformed response: ${label} has unknown or missing options`);
  }
  let sum = 0;
  for (const key of labels) {
    requireProbability(distribution[key], `${label}.${key}`);
    sum += distribution[key] as number;
  }
  if (Math.abs(sum - 1) > 0.02) throw new Error(`malformed response: ${label} is not normalized`);
}

/** Validate every answer, probability, rubric, model and usage before any mutation. */
export function validateAnswers(questions: Questions, raw: unknown): asserts raw is SystemOneResult<Questions> {
  const result = requireRecord(raw, "result");
  if (typeof result.model !== "string" || result.model.trim().length === 0) throw new Error("malformed response: model is missing");
  const usage = requireRecord(result.usage, "usage");
  for (const key of ["input_tokens", "output_tokens"]) {
    if (usage[key] !== null && (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0)) throw new Error("malformed response: invalid usage");
  }
  const answers = requireRecord(result.answers, "answers");
  if (Object.keys(answers).some(/** Reject answers for questions that were never asked. */ name => !Object.hasOwn(questions, name))) throw new Error("malformed response: unexpected answer");
  for (const [name, question] of Object.entries(questions)) {
    // Own-key check: a missing "__proto__" answer must not resolve to Object.prototype.
    if (!Object.hasOwn(answers, name)) throw new Error(`malformed response: missing answer ${name}`);
    const entry = requireRecord(answers[name], name);
    if (entry.type !== question.type) throw new Error(`malformed answer: ${name}.type`);
    if (question.type === "noul") {
      requireProbability(entry.noul, `${name}.noul`);
      continue;
    }
    if (question.type === "box") throw new Error("Unsupported question type: box");
    requireProbability(entry.confidence, `${name}.confidence`);
    const labels = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map(/** Derive score level labels in code. */ (_, index) => String(index));
    requireDistribution(entry.probabilities, labels, `${name}.probabilities`);
    if (question.type === "choice") {
      if (typeof entry.choice !== "string" || !Object.hasOwn(question.criteria, entry.choice)) throw new Error(`malformed answer: ${name}.choice`);
    } else {
      if (typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < 0 || entry.score > labels.length - 1) throw new Error(`malformed answer: ${name}.score`);
      const legend = requireRecord(entry.legend, `${name}.legend`);
      if (JSON.stringify(labels.map(/** Compare the returned rubric in its original order. */ key => legend[key])) !== JSON.stringify(question.criteria) || Object.keys(legend).length !== labels.length) throw new Error(`malformed answer: ${name}.legend`);
    }
  }
}

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
export async function runDecision(
  client: TypeSafeClient,
  config: JevConfig,
  state: unknown,
  questions: Questions,
  signal?: AbortSignal,
): Promise<SystemOneResult<Questions>> {
  try {
    if (state === null || state === undefined) throw new Error("malformed response: decision state must be non-null");
    const request = { state: state as NonNullable<EntryType>, questions, model: config.model,
      ...(config.provider === "ollama" && config.keepAlive !== undefined ? { keep_alive: config.keepAlive } : {}) };
    const result = await client.systemOne(
      request,
      { signal: signal ?? AbortSignal.timeout(config.totalDeadlineMs) },
    );
    validateAnswers(questions, result);
    return result;
  } catch (error) {
    throw translateDecisionError(error, config);
  }
}

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
export function translateDecisionError(
  error: unknown,
  config: JevConfig,
): ReturnType<typeof createPmCliExpectedError> {
  if (isPmCliExpectedError(error)) return error;
  if (error instanceof APIUserAbortError || (error instanceof Error && error.name === "TimeoutError")) {
    return createPmCliExpectedError(
      `Decision call exceeded its total deadline of ${config.totalDeadlineMs}ms (model "${config.model}" at ${config.baseUrl}). Raise jev.total_deadline_ms in settings.json or reduce the batch.`,
      { context: { code: "jev_deadline_exceeded" }, },
    );
  }
  if (error instanceof APITimeoutError) {
    return createPmCliExpectedError(
      `Decision endpoint timed out after ${error.timeoutMs}ms per attempt (model "${config.model}" at ${config.baseUrl}). Raise jev.timeout_ms in settings.json.`,
      { context: { code: "jev_timeout" }, },
    );
  }
  if (error instanceof APIConnectionError) {
    return createPmCliExpectedError(
      `Decision endpoint is unreachable at ${config.baseUrl}. Start the ${config.provider === "ollama" ? "local Ollama server (ollama serve)" : "network path to the hosted TypeSafe API"} and retry.`,
      { context: { code: "jev_endpoint_unreachable" }, },
    );
  }
  if (error instanceof APIError) {
    const hint =
      error.status === 404 && config.provider === "ollama"
        ? ` The endpoint does not serve model "${config.model}"; pull it first: ollama pull ${config.model}.`
        : error.status === 429 || error.status >= 500
          ? " The provider is rate-limiting or overloaded; the SDK's bounded retries were exhausted under the total deadline. Retry later or lower the batch size."
          : "";
    const code =
      error.status === 404
        ? "jev_model_missing"
        : error.status === 422 || error.status === 400
          ? "jev_invalid_request"
          : error.status === 401 || error.status === 403
            ? "jev_auth_failed"
            : error.status === 429
              ? "jev_rate_limited"
              : "jev_server_error";
    return createPmCliExpectedError(
      `Decision endpoint returned HTTP ${error.status} for model "${config.model}" at ${config.baseUrl}.${hint}`,
      { context: { code }, },
    );
  }
  const message = error instanceof Error && /^malformed (answer|response):/.test(error.message) ? error.message : "unrecognized response or transport failure";
  return createPmCliExpectedError(`Decision call failed validation: ${message}`, {
    context: { code: "jev_malformed_answer" },
    
  });
}

// ---------------------------------------------------------------------------
// Caller-supplied question parsing (jev ask)
// ---------------------------------------------------------------------------

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
export function parseQuestionsDocument(raw: unknown): Questions {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw createPmCliExpectedError("Questions file must contain a JSON object of named questions.", {
      context: { code: "jev_questions_shape" },
    });
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) {
    throw createPmCliExpectedError("Questions file must define at least one question.", {
      context: { code: "jev_questions_empty" },
    });
  }
  const questions: Questions = Object.create(null) as Questions;
  for (const [name, value] of entries) {
    const question = requireQuestionRecord(name, value);
    const instructions = requireEntryType(name, question.instructions, "instructions");
    if (question.type === "choice") {
      const rawCriteria = requireCriteriaRecord(name, question.criteria);
      const criteria: Record<string, EntryType> = Object.create(null) as Record<string, EntryType>;
      for (const [label, description] of Object.entries(rawCriteria)) {
        criteria[label] = requireEntryType(name, description, `criteria.${label}`);
      }
      questions[name] = { type: "choice", instructions, criteria };
    } else if (question.type === "score") {
      const rubric = requireRubric(name, question.criteria).map(/** Validate each supplied rubric description. */ (level, index) =>
        requireEntryType(name, level, `criteria[${index}]`),
      );
      questions[name] = { type: "score", instructions, criteria: rubric as unknown as ScoreCriteria };
    } else {
      const criteria = requireNoulCriteria(name, question.criteria);
      // A bare noul key names its proposition; make that existing implicit instruction explicit for the SDK.
      const proposition = instructions ?? name;
      questions[name] = criteria === null ? { type: "noul", instructions: proposition } : { type: "noul", instructions: proposition, criteria };
    }
  }
  return questions;
}

/**
 * Narrow one question instructions or criterion value to the SDK entry type.
 *
 * Accepts text, a JSON object or array, or `null` (undescribed); `undefined`
 * is also accepted because instructions and criteria are optional fields.
 *
 * @param name - Question name used in diagnostics.
 * @param value - Raw instructions or criterion value of unknown shape.
 * @param field - Field path used in diagnostics.
 * @returns The value narrowed to the SDK `EntryType` union.
 * @throws {PmCliExpectedError} The value is a boolean, number, or other
 *         non-entry shape the endpoint would reject.
 */
function requireEntryType(name: string, value: unknown, field: string): EntryType {
  if (value === undefined || value === null || typeof value === "string") return value as EntryType;
  if (typeof value === "object") return value as EntryType;
  throw createPmCliExpectedError(
    `Question "${name}" field ${field} must be text, a JSON object or array, or null.`,
    { context: { code: "jev_question_entry_type" } },
  );
}

/**
 * Validate one question entry's base record and type discriminator.
 *
 * @param name - Question name used in diagnostics.
 * @param value - Raw question value of unknown shape.
 * @returns The question record with its `type` and `criteria` fields.
 * @throws {PmCliExpectedError} The entry is not a known question type.
 */
function requireQuestionRecord(
  name: string,
  value: unknown,
): { type: "choice" | "score" | "noul"; criteria: unknown; instructions: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw createPmCliExpectedError(`Question "${name}" must be an object.`, { context: { code: "jev_question_shape" } });
  }
  const record = value as Record<string, unknown>;
  if (record.type !== "choice" && record.type !== "score" && record.type !== "noul") {
    throw createPmCliExpectedError(
      `Question "${name}" has unsupported type ${JSON.stringify(record.type) ?? "undefined"}; supported: choice, score, noul.`,
      { context: { code: "jev_question_type" } },
    );
  }
  return { type: record.type, criteria: record.criteria, instructions: record.instructions };
}

/**
 * Validate a choice question's criteria map.
 *
 * @param name - Question name used in diagnostics.
 * @param criteria - Raw criteria value of unknown shape.
 * @returns The criteria as a label→description map.
 * @throws {PmCliExpectedError} The criteria are not a nonempty plain object.
 */
function requireCriteriaRecord(name: string, criteria: unknown): Record<string, unknown> {
  if (typeof criteria !== "object" || criteria === null || Array.isArray(criteria)) {
    throw createPmCliExpectedError(`Choice question "${name}" needs a nonempty criteria object of option labels.`, {
      context: { code: "jev_choice_criteria" },
    });
  }
  const labels = Object.keys(criteria as Record<string, unknown>);
  if (labels.length === 0 || labels.length > 255) {
    throw createPmCliExpectedError(`Choice question "${name}" needs between 1 and 255 option labels.`, {
      context: { code: "jev_choice_criteria" },
    });
  }
  return criteria as Record<string, unknown>;
}

/**
 * Validate a score question's ordered rubric.
 *
 * @param name - Question name used in diagnostics.
 * @param criteria - Raw criteria value of unknown shape.
 * @returns The rubric as an array of level descriptions.
 * @throws {PmCliExpectedError} The rubric is not an array of at least two entries.
 */
function requireRubric(name: string, criteria: unknown): readonly unknown[] {
  if (!Array.isArray(criteria) || criteria.length < 2) {
    throw createPmCliExpectedError(`Score question "${name}" needs an ordered criteria rubric of at least 2 levels.`, {
      context: { code: "jev_score_criteria" },
    });
  }
  return criteria;
}

/**
 * Validate a noul question's optional outcome descriptions.
 *
 * @param name - Question name used in diagnostics.
 * @param criteria - Raw criteria value of unknown shape.
 * @returns The true/false descriptions when present, otherwise `null`.
 * @throws {PmCliExpectedError} The criteria are not a plain object or carry
 *         non-entry descriptions.
 */
function requireNoulCriteria(name: string, criteria: unknown): { true?: EntryType; false?: EntryType } | null {
  if (criteria === undefined || criteria === null) return null;
  if (typeof criteria !== "object" || Array.isArray(criteria)) {
    throw createPmCliExpectedError(`Noul question "${name}" criteria must be an object with optional true/false descriptions.`, {
      context: { code: "jev_noul_criteria" },
    });
  }
  const record = criteria as Record<string, unknown>;
  const narrowed: { true?: EntryType; false?: EntryType } = {};
  for (const outcome of ["true", "false"] as const) {
    const value = record[outcome];
    if (value !== undefined) narrowed[outcome] = requireEntryType(name, value, `criteria.${outcome}`);
  }
  return narrowed;
}

// ---------------------------------------------------------------------------
// Command plumbing
// ---------------------------------------------------------------------------

/** Tracker-bound workspace plus the call-ready decision boundary. */
interface DecisionWorkspace {
  /** Tracker-bound pm client using the invocation author and workspace. */
  readonly pm: PmClient;
  /** Resolved pm tracker root (`.agents/pm`), forwarded from the host context. */
  readonly pmRoot: string;
  /** Client bound to the configured decision endpoint. */
  readonly decision: TypeSafeClient;
  /** Call-ready endpoint configuration (privacy gate already passed). */
  readonly config: JevConfig;
  /** An explicit CLI confidence flag may raise the calibrated threshold. */
  readonly explicitConfidence: boolean;
  /** Verified saved calibration for this command task, when present. */
  readonly calibration?: ActiveCalibration;
}

/**
 * Resolve, privacy-gate, and construct the call-ready decision boundary for
 * one command invocation.
 *
 * @param ctx - Host command context with the resolved tracker root.
 * @returns The workspace handle used by command implementations.
 * @throws {PmCliExpectedError} Configuration is unusable or externally blocked.
 */
async function openDecisionBoundary(ctx: CommandHandlerContext, task?: "triage" | "link" | "dedupe"): Promise<DecisionWorkspace> {
  const resolved = await resolveJevEndpoint(ctx.pm_root, process.env);
  const config = requireCallableEndpoint(resolved);
  const decision = createJevClient(resolved, process.env);
  const pm = ctx.sdk?.client ?? new PmClient({ pmRoot: ctx.pm_root, cwd: ctx.source_workspace_root, author: ctx.global.author });
  return { pm, pmRoot: ctx.pm_root, decision, config, explicitConfidence: readStringOption(ctx.options, "minConfidence", ["min_confidence"]) !== undefined, calibration: task === undefined ? undefined : await activeCalibration(ctx.pm_root, task, config) };
}

/** Refuse applying a fit if a mutable local model tag changed after inference began. */
async function verifyCalibrationModel(boundary: DecisionWorkspace): Promise<void> {
  if (boundary.calibration !== undefined && await modelDigest(boundary.config.baseUrl, boundary.config.model, boundary.config.timeoutMs) !== boundary.calibration.record.model_digest) throw createPmCliExpectedError("Model digest changed during calibrated inference; retry with a fresh calibration");
}

/**
 * Read a bounded probability option with a default.
 *
 * @param options - Parsed command options (camel-cased flag keys).
 * @param key - Primary option key.
 * @param aliases - Alternative option keys accepted for the same flag.
 * @param fallback - Value returned when the option is absent or invalid.
 * @returns The clamped probability option value in `(0, 1]`.
 */
function probabilityOption(options: Record<string, unknown>, key: string, aliases: string[], fallback: number): number {
  const raw = readStringOption(options, key, aliases);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw createPmCliExpectedError(`--${key} must be a probability in [0,1].`);
  return parsed;
}

/**
 * Load a tracker item as a least-privilege projection.
 *
 * @param workspace - Tracker-bound workspace handle.
 * @param id - Item id positional argument.
 * @returns The item metadata projection for state and current values.
 * @throws {PmCliExpectedError} The item does not exist in this tracker.
 */
async function loadItem(workspace: DecisionWorkspace, id: string): Promise<ProjectableItem> {
  const result = (await workspace.pm.get(id, { fields: "id,title,type,status,priority,tags,description,body" })) as { item: ProjectableItem };
  return result.item;
}

/**
 * Project a validated decision for compact text output without mutating it.
 * Numbers are rounded to three decimals. Choices keep their top three options
 * in stable probability order plus the chosen option; scores keep every level.
 * Dedupe candidate details follow the same retained choice options.
 *
 * @param value - Full JSON-safe decision or nested receipt value.
 * @returns A compact copy with explicit omitted_options on each choice.
 */
function compactDecisionValue(value: unknown): unknown {
  if (typeof value === "number") return Math.round(value * 1000) / 1000;
  if (Array.isArray(value)) return value.map(/** Compact each array entry independently. */ entry => compactDecisionValue(entry));
  if (typeof value !== "object" || value === null) return value;
  const record = { ...value } as Record<string, unknown>;
  delete record.definitions;
  const selected = record.kind === "choice" ? record.selected_label ?? record.value : "duplicate_of" in record ? record.duplicate_of ?? "none" : undefined;
  if (typeof selected === "string") {
    const entries = Object.entries(record.probabilities as Record<string, number>);
    entries.sort(/** Keep equal-probability options in their original stable order. */ ([, left], [, right]) => right - left);
    const retained = entries.slice(0, 3);
    if (!retained.some(/** Keep the actual choice even when outside the top three. */ ([label]) => label === selected)) {
      retained.push([selected, (record.probabilities as Record<string, number>)[selected]]);
    }
    record.probabilities = Object.fromEntries(retained);
    record.omitted_options = entries.length - retained.length;
    if (Array.isArray(record.candidates)) {
      record.candidates = (record.candidates as DedupeCandidate[]).filter(/** Retain details only for visible candidate options. */ candidate => retained.some(/** Match a candidate to its option id. */ ([label]) => label === candidate.id));
    }
  }
  return Object.fromEntries(Object.entries(record).map(/** Compact fields while preserving strings, booleans and metadata. */ ([key, entry]) => [key, compactDecisionValue(entry)]));
}

/**
 * Run a decision with full precision, then select its host-facing presentation.
 * Host-owned JSON flags bypass compaction; --full preserves the text receipt.
 *
 * @param ctx - Parsed flags and host renderer preferences.
 * @param run - Decision handler whose authorization arithmetic stays untouched.
 * @returns Full or compact receipt for the host to render.
 */
async function decisionOutput(ctx: CommandHandlerContext, run: (ctx: CommandHandlerContext) => Promise<unknown>): Promise<unknown> {
  const result = await run(ctx);
  if (ctx.global.json === true || ctx.global.outputFormat === "json" ||
      (ctx.global.json === undefined && ctx.global.outputFormat === undefined && ctx.global.defaultOutputFormat === "json") ||
      readBooleanOption(ctx.options, "full") === true) return result;
  return compactDecisionValue(result);
}

// ---------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------

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
  readonly needs_human: { readonly kind: "noul"; readonly probability: number };
  /** Probability the item contains secrets, personal data, or local paths. */
  readonly sensitive: { readonly kind: "noul"; readonly probability: number };
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
  readonly calibration?: { readonly type: CalibrationUse | null; readonly priority: CalibrationUse | null; readonly raw_type_probabilities: Record<string, number>; readonly raw_priority_probabilities: Record<string, number> };
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
export function buildTriageQuestions(settings: PmSettings): Questions {
  const registry = resolveItemTypeRegistry(settings);
  const criteria: Record<string, string> = {};
  for (const name of registry.types) {
    const definition = registry.by_type[name];
    criteria[name] = (definition.description || BUILTIN_TYPE_CRITERIA.get(name) || `Items classified as ${name}; registry folder: ${definition.folder}`).replace(/\s+/g, " ").trim();
  }
  criteria[KEEP_CURRENT_TYPE] = "Keep the current item type when evidence for reclassification is weak or ambiguous";
  return {
    type: {
      type: "choice",
      instructions: "Classify the actual work using the definitions. Wording about deciding how to fix a defect is still a defect. Choose keep-current unless evidence clearly supports another type.",
      criteria,
    },
    priority: {
      type: "score",
      instructions: "How urgent and impactful is this item for its users and the project?",
      criteria: PRIORITY_RUBRIC,
    },
    needs_human: {
      type: "noul",
      instructions: "Does this item need a human decision or input before work can proceed?",
      criteria: {
        true: "A human must decide, approve, or provide missing intent",
        false: "An agent can proceed with the information in the item",
      },
    },
    sensitive: {
      type: "noul",
      instructions:
        "Does this item contain secrets, credentials, personal data, or local filesystem paths that should not leave this machine?",
      criteria: {
        true: "Secrets, tokens, credentials, personal data, or local paths are present",
        false: "No sensitive material is present",
      },
    },
  };
}

/** Build label-hidden type/priority questions used by evaluation and calibrated triage. */
export function buildClassificationQuestions(settings: PmSettings): Questions {
  const questions = buildTriageQuestions(settings);
  const criteria = { ...(questions.type as { criteria: Record<string, string> }).criteria };
  delete criteria[KEEP_CURRENT_TYPE];
  return { type: { type: "choice", instructions: "Classify the actual work using the type definitions. Judge only the semantic evidence.", criteria }, priority: questions.priority };
}

/** Build the exact compact production relationship ontology for one candidate. */
export function buildLinkQuestion(candidate: string): Questions[string] {
  const kinds = linkKinds(resolveWorkspaceRelationshipKindRegistry());
  return { type: "choice", instructions: `Which relationship holds FROM source TO ${candidate}? Choose none without explicit evidence; shared topic alone is not a dependency.`,
    criteria: Object.fromEntries([...kinds.map(/** Describe direction using the actual SDK ontology. */ kind => [kind.kind, `${kind.kind}: ${[kind.direction, kind.precedence, kind.hierarchyDirection, kind.temporalOrder].filter(/** Omit inapplicable ontology attributes. */ value => value !== undefined).join("; ").replaceAll("_", " ")}`]), ["none", "No supported relationship is justified"]]) };
}

/** Build the shared duplicate-screening request without source routing labels. */
export function buildDedupeRequest(title: string, body: string, candidates: readonly DedupeCandidate[]) {
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) criteria[candidate.id] = `${truncateStateText(candidate.title)} (type ${candidate.type}, status ${candidate.status}, title similarity ${candidate.score})`;
  criteria.none = "The proposed item is not a duplicate of any candidate";
  const questions: Questions = { duplicate_of: { type: "choice", instructions: "A new pm item is about to be created. Does it duplicate one of the candidate items listed in the state? Choose the candidate id it duplicates, or none.", criteria } };
  return { state: { proposed: { title: truncateStateText(title), body: truncateStateText(body) }, candidates: candidates.map(/** Bound candidate text without changing deterministic ranks. */ candidate => ({ ...candidate, title: truncateStateText(candidate.title) })) }, questions };
}

/** Bind the non-mutating candidate to the current type without adding routing fields to evidence. */
export function withCurrentType(questions: Questions, current: string): Questions {
  const question = questions.type;
  if (question.type !== "choice") throw new Error("Triage type question must be a choice");
  return { ...questions, type: { ...question, criteria: { ...question.criteria,
    [KEEP_CURRENT_TYPE]: `Keep current type ${current}: ${String(question.criteria[current])}. Prefer this when evidence for changing type is weak.` } } };
}

/** Hash ordered effective definitions and the keep-current template independently of applied routing. */
function triageTypeQuestionHash(questions: Questions): string {
  return createHash("sha256").update(JSON.stringify({
    question: withCurrentType(questions, KEEP_CURRENT_TYPE).type,
    margin_threshold: TYPE_MARGIN_THRESHOLD,
    type_change_probability: TYPE_CHANGE_PROBABILITY,
  })).digest("hex");
}

/** Resolve a validated label distribution in code: ambiguity abstains, weak changes retain the current type. */
export function resolveTriageType(answer: ChoiceResponse, current: string, definitions: Record<string, string>, marginThreshold = TYPE_MARGIN_THRESHOLD, changeProbability = TYPE_CHANGE_PROBABILITY): TriageProposals["type"] {
  const ranked = Object.entries(answer.probabilities).sort(/** Preserve registry order for tied labels. */ ([, a], [, b]) => b - a);
  const [selected, top] = ranked[0];
  const margin = top - ranked[1][1];
  const abstained = margin < marginThreshold;
  const kept = !abstained && (selected === KEEP_CURRENT_TYPE || top < changeProbability);
  const label = kept ? KEEP_CURRENT_TYPE : selected;
  return { kind: "choice", value: abstained ? null : kept ? current : selected,
    selected_label: label, probability: answer.probabilities[kept ? current : selected] ?? 0, probabilities: answer.probabilities, confidence: answer.confidence,
    definitions, abstained, kept_current: kept, reason: abstained ? "top_two_margin_below_threshold" : kept ? "keep_current_under_weak_evidence" : null,
    margin, margin_threshold: marginThreshold };
}

/**
 * Round a probability to two decimals for receipt comments.
 *
 * @param value - Probability in `[0, 1]`.
 * @returns The probability rounded to two decimals.
 */
function roundProbability(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Compute the rubric level with the highest reported probability.
 *
 * Ties resolve deterministically toward the lowest such level. The validated
 * distribution is normalized and has a positive maximum; arithmetic stays in code.
 *
 * @param probabilities - Level probabilities keyed by rubric index.
 * @param rubricSize - Number of rubric levels.
 * @returns The winning rubric level index.
 */
function winningLevel(probabilities: Record<string, number>, rubricSize: number): number {
  let best = -1;
  let bestProbability = 0;
  for (let level = 0; level < rubricSize; level += 1) {
    const probability = probabilities[String(level)];
    if (probability > bestProbability + 1e-9) {
      bestProbability = probability;
      best = level;
    }
  }
  return best;
}

/**
 * Run the triage decision over one item and, when `--apply` is set, write the
 * fields whose probability clears the threshold, appending a receipt comment.
 *
 * @param ctx - Host command context (pm_root, options, global).
 * @returns The full triage receipt, including what was applied.
 * @throws {PmCliExpectedError} Configuration, transport, or validation failure.
 */
async function runTriageCommand(ctx: CommandHandlerContext): Promise<unknown> {
  const started = performance.now();
  const id = readStringOption(ctx.options, "item", ["id"]) ?? ctx.args[0];
  const open = readBooleanOption(ctx.options, "open") === true;
  if (ctx.args.length > 1 || (open && id !== undefined) ||
      (!open && ["type", "limit", "refresh"].some(/** Reject backlog-only options on a single item. */ key => ctx.options[key] !== undefined)) ||
      (open && readBooleanOption(ctx.options, "full") === true)) {
    throw createPmCliExpectedError("Use either jev triage <id> [--full] or jev triage --open [--type <t>] [--limit N] [--refresh].", { context: { code: "jev_triage_arguments" } });
  }
  if (!open && (id === undefined || id.trim().length === 0)) {
    throw createPmCliExpectedError("jev triage needs an item id or --open: pm jev triage <id> | --open", {
      context: { code: "jev_item_required" },
    });
  }
  const limit = batchLimit(ctx.options);
  const boundary = await openDecisionBoundary(ctx, "triage");
  const threshold = probabilityOption(ctx.options, "minConfidence", ["min_confidence"], boundary.config.minConfidence);
  const settings = await readSettings(boundary.pmRoot);
  const questions = buildTriageQuestions(settings);
  const classification = buildClassificationQuestions(settings);
  const apply = readBooleanOption(ctx.options, "apply") === true;
  const rawType = readStringOption(ctx.options, "type");
  const type = resolveTypeName(rawType, resolveItemTypeRegistry(settings));
  if (ctx.options.type !== undefined && type === undefined) throw createPmCliExpectedError("--type must name a configured item type.", { context: { code: "jev_triage_type" } });
  if (open) return runBacklogTriage(ctx, boundary, questions, classification, threshold, limit, started, type);
  const item = await loadTriageSource(boundary, (id as string).trim());
  return decideTriage(boundary, item, questions, classification, threshold, apply);
}

/** Require a positive bounded item count instead of silently repairing a CLI typo. */
function batchLimit(options: Record<string, unknown>): number {
  const raw = readStringOption(options, "limit");
  if (options.limit === undefined) return 20;
  if (raw === undefined) throw createPmCliExpectedError("--limit must be an integer from 1 to 1000.", { context: { code: "jev_triage_limit" } });
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw createPmCliExpectedError("--limit must be an integer from 1 to 1000.", { context: { code: "jev_triage_limit" } });
  }
  return value;
}

/** Complete inference source plus the host mutation coordinate and receipt comments. */
interface TriageSource extends ProjectableItem {
  readonly updated_at: string;
  readonly comments: readonly { readonly text: string }[];
}

/** Read unbounded source fields through the host, never truncating receipt or hash inputs. */
async function loadTriageSource(boundary: DecisionWorkspace, id: string): Promise<TriageSource> {
  const result = await boundary.pm.get(id, { fields: "id,title,type,status,priority,tags,description,body,updated_at,comments", outputBudget: "unbounded", outputLimit: "unbounded" }) as GetResult;
  return result.item as TriageSource;
}

/** Compare complete evidence and host coordinates before returning or persisting proposals. */
function sameTriageSource(left: TriageSource, right: ProjectableItem & { readonly updated_at: string }): boolean {
  return triageInputHash(left) === triageInputHash(right);
}

/** Hash the complete inference evidence and routing/update coordinates for lock-scoped validation. */
function triageInputHash(item: ProjectableItem & { readonly updated_at: string }): string {
  return createHash("sha256").update(JSON.stringify([triageSourceHash(item), item.updated_at, item.type, item.priority])).digest("hex");
}

/** Reject stale or expired inference inside the host lock before either artifact is persisted. */
function guardTriageMutation(ctx: BeforeMutationHookContext): BeforeMutationHookDecision | void {
  return guardProposalMutation(ctx, "triage", triageInputHash);
}

/** Verify receipt coordinates while the host owns the source item mutation lock. */
function guardProposalMutation(ctx: BeforeMutationHookContext, command: string, hash: (item: LinkSource) => string): BeforeMutationHookDecision | void {
  if (ctx.before === null || ctx.after === null) return;
  const added = (ctx.after.metadata.comments ?? []).slice((ctx.before.metadata.comments ?? []).length);
  for (const comment of added) {
    if (!comment.text.startsWith(`pm-jev ${command} receipt: model=`)) continue;
    const guard = /, input_sha256=([a-f0-9]{64}), deadline_ms=(\d+),/.exec(comment.text);
    if (guard === null) continue;
    if (guard[1] === hash({ ...ctx.before.metadata, body: ctx.before.body } as LinkSource) && Date.now() < Number(guard[2])) continue;
    return { allow: false, code: "jev_stale_inference", message: "Decision source changed or the run deadline expired.", remediation: `Retry ${command} against the current item.` };
  }
}

/** Infer one item, authorize each field independently, and atomically append a stable receipt. */
async function decideTriage(boundary: DecisionWorkspace, item: TriageSource, questions: Questions, classification: Questions, threshold: number, apply: boolean, signal?: AbortSignal, deadline = Date.now() + boundary.config.totalDeadlineMs): Promise<TriageDecision> {
  const calibratedType = boundary.calibration?.record.channels.type?.question_sha256.includes(questionFingerprint("type", classification.type)) === true;
  const boundQuestions = calibratedType ? { ...questions, type: classification.type } : withCurrentType(questions, item.type);
  const typeQuestionHash = triageTypeQuestionHash(questions);
  const result = await runDecision(boundary.decision, boundary.config, projectTriageState(item), boundQuestions, signal);
  const rawType = result.answers.type as ChoiceResponse;
  const rawPriority = result.answers.priority as ScoreResponse;
  const typeFit = calibratedAnswer(boundary.calibration, "type", boundQuestions.type, rawType.probabilities, threshold, boundary.explicitConfidence ? threshold : 0);
  const priorityFit = calibratedAnswer(boundary.calibration, "priority", boundQuestions.priority, rawPriority.probabilities, threshold, boundary.explicitConfidence ? threshold : 0);
  const typeAnswer = { ...rawType, probabilities: typeFit.probabilities };
  const scoreAnswer = { ...rawPriority, probabilities: priorityFit.probabilities };
  const proposals: TriageProposals = {
    type: resolveTriageType(typeAnswer, item.type, (boundQuestions.type as { criteria: Record<string, string> }).criteria, TYPE_MARGIN_THRESHOLD, typeFit.calibration === null ? TYPE_CHANGE_PROBABILITY : 0),
    priority: {
      kind: "score",
      level: winningLevel(scoreAnswer.probabilities, PRIORITY_RUBRIC.length),
      score: scoreAnswer.score,
      probabilities: scoreAnswer.probabilities,
      confidence: scoreAnswer.confidence,
    },
    needs_human: { kind: "noul", probability: (result.answers.needs_human as NoulResponse).noul },
    sensitive: { kind: "noul", probability: (result.answers.sensitive as NoulResponse).noul },
  };
  const written: string[] = [];
  const changes: { type?: string; priority?: number } = {};
  if (proposals.type.value !== null && proposals.type.probability >= typeFit.threshold && proposals.type.value !== item.type) {
    changes.type = proposals.type.value;
    written.push(`type=${proposals.type.value}`);
  }
  const levelProbability = proposals.priority.probabilities[String(proposals.priority.level)];
  if (levelProbability >= priorityFit.threshold && proposals.priority.level !== item.priority) {
    changes.priority = proposals.priority.level;
    written.push(`priority=${proposals.priority.level}`);
  }
  await verifyCalibrationModel(boundary);
  if (!sameTriageSource(item, await loadTriageSource(boundary, item.id))) {
    throw createPmCliExpectedError("Item changed during triage; retry against the current source.", { context: { code: "jev_stale_inference" } });
  }
  signal?.throwIfAborted();
  const typeThresholdLabel = typeFit.calibration === null ? String(threshold) : String(typeFit.calibration.threshold ?? "unqualified");
  const priorityThresholdLabel = priorityFit.calibration === null ? String(threshold) : String(priorityFit.calibration.threshold ?? "unqualified");
  if (apply) {
    await boundary.pm.update(item.id, { ...changes, comment: [formatTriageReceipt(result.model, proposals, threshold, written, item, deadline, typeQuestionHash) + (boundary.calibration === undefined ? "" : ` calibration_sha256=${boundary.calibration.receipt_sha256}, type_threshold=${typeThresholdLabel}, priority_threshold=${priorityThresholdLabel}.`)], message: "pm-jev triage proposals and receipt" });
  }
  return {
    item: item.id,
    proposals,
    model: result.model,
    usage: result.usage,
    catalog_version: TRIAGE_CATALOG_VERSION,
    type_question_sha256: typeQuestionHash,
    ...(boundary.calibration === undefined ? {} : { calibration: { type: typeFit.calibration, priority: priorityFit.calibration, raw_type_probabilities: rawType.probabilities, raw_priority_probabilities: rawPriority.probabilities } }),
    applied: apply ? written : [],
  };
}

/**
 * Format the redacted triage receipt comment appended on --apply.
 *
 * The receipt carries the resolved model, catalog version, rounded
 * probabilities, the threshold, and which fields were written — never the item
 * state itself, so the comment stays safe for public trackers.
 *
 * @param model - Resolved model revision reported by the endpoint.
 * @param proposals - The validated proposals for this item.
 * @param threshold - Probability threshold used for this run.
 * @param written - Fields actually written by this run.
 * @param source - Full source evidence used for redacted content and revision hashes.
 * @param deadline - Absolute expiry checked by the host mutation guard before persistence.
 * @param typeQuestionHash - Stable effective type question and policy fingerprint.
 * @returns The single-line receipt comment text.
 */
function formatTriageReceipt(model: string, proposals: TriageProposals, threshold: number, written: readonly string[], source: TriageSource, deadline: number, typeQuestionHash: string): string {
  const parts = [
    `pm-jev triage receipt: model=${model}`,
    `catalog=${TRIAGE_CATALOG_VERSION}`,
    `source_sha256=${triageSourceHash(source)}`,
    `type_question_sha256=${typeQuestionHash}`,
    `expected_type=${JSON.stringify(written.includes(`type=${proposals.type.value}`) ? proposals.type.value : source.type)}`,
    `apply_threshold=${threshold}`,
    `input_sha256=${triageInputHash(source)}`,
    `deadline_ms=${deadline}`,
    `type=${proposals.type.value} p=${roundProbability(proposals.type.probability)}`,
    `abstained=${proposals.type.abstained} kept_current=${proposals.type.kept_current} reason=${proposals.type.reason}`,
    `margin=${roundProbability(proposals.type.margin)}`,
    `priority=${proposals.priority.level} p=${roundProbability(proposals.priority.probabilities[String(proposals.priority.level)])}`,
    `needs_human=${roundProbability(proposals.needs_human.probability)}`,
    `sensitive=${roundProbability(proposals.sensitive.probability)}`,
    `threshold=${roundProbability(threshold)}`,
  ];
  return `${parts.join(", ")}${written.length > 0 ? `, applied=[${written.join(", ")}]` : ", applied=none"}.`;
}

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

/** Select JSON lines using precisely the same host precedence as single-item output. */
function jsonDecisionOutput(ctx: CommandHandlerContext): boolean {
  return ctx.global.json === true || ctx.global.outputFormat === "json" ||
    (ctx.global.json === undefined && ctx.global.outputFormat === undefined && ctx.global.defaultOutputFormat === "json");
}

/** Emit one JSON line or TOON table row through the host's public output primitive. */
function streamTriageRow(ctx: CommandHandlerContext, row: object): void {
  if (ctx.global.quiet === true) return;
  if (jsonDecisionOutput(ctx)) { writeStdout(`${JSON.stringify(row)}\n`); return; }
  writeStdout(`  ${Object.values(row).map(/** Quote string cells and preserve primitive types in a TOON table. */ value => JSON.stringify(typeof value === "number" ? Math.round(value * 1000) / 1000 : Array.isArray(value) ? JSON.stringify(compactDecisionValue(value)) : value)).join(",")}\n`);
}

/** Emit a TOON table header once; row framing remains independent of response latency. */
function streamTriageHeader(ctx: CommandHandlerContext, name: string, count: number, keys: readonly string[]): void {
  if (ctx.global.quiet !== true && !jsonDecisionOutput(ctx)) writeStdout(`${name}[${count}]{${keys.join(",")}}:\n`);
}

/** Share one remaining invocation budget across model calls, retries and writes. */
function decisionDeadline(config: JevConfig, started: number): { deadline: number; signal: AbortSignal } {
  const remaining = Math.max(1, Math.ceil(config.totalDeadlineMs - (performance.now() - started)));
  return { deadline: Date.now() + remaining, signal: AbortSignal.timeout(remaining) };
}

/** Select strict source ids using host lifecycle roles and deterministic ordering. */
async function selectOpenSources(boundary: DecisionWorkspace, limit: number, type: string | undefined): Promise<ListResult> {
  return await boundary.pm.list({ lifecycleBucket: "open", type, limit: String(limit), fields: "id", strictRead: true, outputBudget: "unbounded", outputLimit: "unbounded" }) as ListResult;
}

/** Emit one terminal count receipt and prevent the host from rendering the stream twice. */
function finishBacklog(ctx: CommandHandlerContext, command: string, selected: ListResult, counts: { changed: number; would_change: number; skipped: number; failed: number }, started: number): unknown {
  const summary = { record_type: `pm-jev.${command}.summary`, selected: selected.items.length, ...counts,
    has_more: selected.has_more, elapsed_ms: Math.round(performance.now() - started), exit_code: counts.failed > 0 ? 1 : 0 };
  streamTriageHeader(ctx, "summary", 1, Object.keys(summary));
  streamTriageRow(ctx, summary);
  return { ...suppressHostOutput(summary), ...(summary.failed > 0 ? { exit_code: 1 } : {}) };
}

/** Reuse matching evidence/policy and post-run type only at equal or higher apply thresholds. */
function hasTriageReceipt(item: TriageSource, questions: Questions, threshold: number): boolean {
  const marker = `, catalog=${TRIAGE_CATALOG_VERSION}, source_sha256=${triageSourceHash(item)}, type_question_sha256=${triageTypeQuestionHash(questions)},`;
  return item.comments.some(/** Ignore stale evidence, externally changed types and lower requested thresholds. */ comment => {
    if (!comment.text.startsWith("pm-jev triage receipt: model=") || comment.text.includes(" calibration_sha256=") || !comment.text.includes(marker) ||
        !comment.text.includes(`, expected_type=${JSON.stringify(item.type)},`)) return false;
    const recorded = /, apply_threshold=([^,]*),/.exec(comment.text)?.[1].trim() ?? "";
    // Number(" ") is 0, so only a nonempty decimal literal counts as a recorded threshold.
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(recorded)) return false;
    const value = Number(recorded);
    return value >= 0 && value <= 1 && value <= threshold;
  });
}

/** Infer a bounded host-selected backlog with shared client, questions, and one abort deadline. */
async function runBacklogTriage(ctx: CommandHandlerContext, boundary: DecisionWorkspace, questions: Questions, classification: Questions, threshold: number, limit: number, started: number, type: string | undefined): Promise<unknown> {
  const { deadline, signal } = decisionDeadline(boundary.config, started);
  const selected = await selectOpenSources(boundary, limit, type);
  const counts = { changed: 0, would_change: 0, skipped: 0, failed: 0 };
  const empty = { type: null, type_probability: null, priority: null, priority_probability: null, needs_human: null, sensitive: null, reason: null, abstained: false };
  streamTriageHeader(ctx, "items", selected.items.length, ["item", "outcome", ...Object.keys(empty), ...(boundary.calibration === undefined ? [] : ["calibration"])]);
  for (const entry of selected.items) {
    const id = entry.id as string;
    let row: BacklogTriageRow;
    try {
      signal.throwIfAborted();
      const item = await loadTriageSource(boundary, id);
      signal.throwIfAborted();
      if (boundary.calibration === undefined && readBooleanOption(ctx.options, "refresh") !== true && hasTriageReceipt(item, questions, threshold)) {
        row = { item: id, outcome: "skipped", ...empty, reason: "prior_receipt" };
      } else {
        const apply = readBooleanOption(ctx.options, "apply") === true;
        const result = await decideTriage(boundary, item, questions, classification, threshold, apply, signal, deadline);
        const p = result.proposals;
        const fit = result.calibration;
        const typeThreshold = fit?.type === null || fit?.type === undefined ? threshold : fit.type.threshold ?? Infinity;
        const priorityThreshold = fit?.priority === null || fit?.priority === undefined ? threshold : fit.priority.threshold ?? Infinity;
        const wouldChange = (p.type.value !== null && p.type.probability >= typeThreshold && p.type.value !== item.type) ||
          (p.priority.probabilities[String(p.priority.level)] >= priorityThreshold && p.priority.level !== item.priority);
        row = { item: id, outcome: wouldChange ? apply ? "changed" : "would_change" : "skipped",
          type: p.type.value, type_probability: p.type.abstained ? null : p.type.probability, priority: p.priority.level,
          priority_probability: p.priority.probabilities[String(p.priority.level)], needs_human: p.needs_human.probability,
          sensitive: p.sensitive.probability, ...(result.calibration === undefined ? {} : { calibration: result.calibration }), reason: p.type.reason ?? (wouldChange ? null : "no_qualifying_change"), abstained: p.type.abstained };
      }
    } catch (error) {
      const mapped = translateDecisionError(error, boundary.config);
      const stale = mapped.code === "jev_stale_inference";
      row = { item: id, outcome: stale ? "skipped" : "failed", ...empty, reason: mapped.code ?? "jev_triage_failure" };
    }
    counts[row.outcome] += 1;
    streamTriageRow(ctx, row);
  }
  return finishBacklog(ctx, "triage", selected, counts, started);
}

// ---------------------------------------------------------------------------
// Dedupe
// ---------------------------------------------------------------------------

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
  readonly calibration?: CalibrationUse & { readonly raw_probability: number; readonly qualifies: boolean };
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
export function rankDedupeCandidates(items: readonly ItemMetadata[], title: string, limit: number): DedupeCandidate[] {
  const scored: DedupeCandidate[] = [];
  for (const item of items) {
    const { score } = scoreItemSimilarity(title, item.title);
    if (score <= 0) continue;
    scored.push({ id: item.id, title: item.title, type: item.type, status: item.status, score });
  }
  scored.sort(/** Break equal rank ties by stable item id. */ (left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return scored.slice(0, limit);
}

/**
 * Screen a proposed item against the tracker for duplicates.
 *
 * Code ranks candidates first; when none are similar the model is skipped
 * entirely (`duplicate_of` is null). Otherwise one choice question over the
 * candidate ids plus "none" confirms or rejects the best matches. The command
 * exits 0 for every decision outcome; only operational failures surface as
 * errors, so an agent must never read a broken endpoint as "no duplicates".
 *
 * @param ctx - Host command context (pm_root, options, global).
 * @returns The dedupe receipt with `duplicate_of` or null.
 * @throws {PmCliExpectedError} Configuration, transport, or validation failure.
 */
async function runDedupeCommand(ctx: CommandHandlerContext): Promise<DedupeDecision> {
  if (["status", "type", "limitPairs", "limit_pairs", "minConfidence", "min_confidence", "apply", "close"].some(/** Refuse flags whose write semantics apply only to pair scanning. */ key => ctx.options[key] !== undefined)) throw createPmCliExpectedError("Tracker scan flags cannot be combined with --title; omit --title to scan existing pairs.");
  const title = readStringOption(ctx.options, "title");
  if (title === undefined || title.trim().length === 0) {
    throw createPmCliExpectedError('jev dedupe needs --title "<text>" for the item about to be created.', {
      context: { code: "jev_title_required" },
    });
  }
  const body = readStringOption(ctx.options, "body") ?? "";
  const limit = Math.trunc(numberSetting(readStringOption(ctx.options, "limit"), DEFAULT_DEDUPE_LIMIT, 1, 32));
  const boundary = await openDecisionBoundary(ctx, "dedupe");
  const candidates = rankDedupeCandidates((await boundary.pm.listAllComplete()).items, title, limit);
  if (candidates.length === 0) {
    return {
      duplicate_of: null,
      probability: 1,
      probabilities: { none: 1 },
      confidence: 1,
      candidates,
      model: boundary.config.model,
      usage: { input_tokens: 0, output_tokens: 0 },
      catalog_version: DEDUPE_CATALOG_VERSION,
    };
  }
  const request = buildDedupeRequest(title, body, candidates);
  const result = await runDecision(boundary.decision, boundary.config, request.state, request.questions);
  await verifyCalibrationModel(boundary);
  const answer = result.answers.duplicate_of as ChoiceResponse;
  const fit = calibratedAnswer(boundary.calibration, "duplicate_of", request.questions.duplicate_of, answer.probabilities, boundary.config.minConfidence);
  const selected = fit.calibration === null ? answer.choice : ranked(fit.probabilities)[0][0];
  return {
    duplicate_of: selected === "none" ? null : selected,
    probability: fit.probabilities[selected],
    probabilities: fit.probabilities,
    ...(fit.calibration === null ? {} : { calibration: { ...fit.calibration, raw_probability: answer.probabilities[selected], qualifies: selected !== "none" && fit.probabilities[selected] >= fit.threshold } }),
    confidence: answer.confidence,
    candidates,
    model: result.model,
    usage: result.usage,
    catalog_version: DEDUPE_CATALOG_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Relationship proposals
// ---------------------------------------------------------------------------

/** Versioned relationship question and authorization contract. */
export const LINK_CATALOG_VERSION = "pm-jev-link/1";

/** Complete local source needed for relationship revision checks, never sent verbatim. */
interface LinkSource extends TriageSource {
  readonly dependencies?: ItemMetadata["dependencies"];
  readonly parent?: string;
  readonly blocked_by?: string;
}

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
  readonly calibration?: { readonly receipt_sha256: string };
}

/** Read complete relationship coordinates through the host's unbounded projection. */
async function loadLinkSource(boundary: DecisionWorkspace, id: string): Promise<LinkSource> {
  return ((await boundary.pm.get(id, { full: true, outputBudget: "unbounded", outputLimit: "unbounded" })) as GetResult).item as LinkSource;
}

/** Include relationship coordinates in the item-lock guard as well as complete inference text. */
function linkInputHash(item: LinkSource): string {
  return createHash("sha256").update(JSON.stringify([triageInputHash(item), item.parent, item.blocked_by, item.dependencies])).digest("hex");
}

/** Validate newly appended relationship receipts under the host mutation lock. */
function guardLinkMutation(ctx: BeforeMutationHookContext): BeforeMutationHookDecision | void {
  return guardProposalMutation(ctx, "link", linkInputHash);
}

/** Reject invalid bounds; single-item limits rank candidates and backlog limits select sources. */
function linkLimit(options: Record<string, unknown>): number {
  if (options.limit === undefined) return 8;
  const raw = readStringOption(options, "limit");
  const value = Number(raw);
  if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > 50) {
    throw createPmCliExpectedError("--limit must be an integer from 1 to 50.", { context: { code: "jev_link_limit" } });
  }
  return value;
}

/** Derive only canonical kinds accepted by the host dependency mutation contract. */
function linkKinds(registry: RelationshipKindRegistry): readonly RelationshipKindDefinition[] {
  const supported = new Set(DEPENDENCY_KIND_VALUES.map(/** Normalize host compatibility aliases. */ kind => registry.require(kind).kind));
  return registry.list().filter(/** Do not invent labels the host cannot persist. */ definition => supported.has(definition.kind));
}

/** Find canonical existing edges including reverse inverse kinds, symmetric edges and scalar parents. */
export function existingLinkKinds(graph: RelationshipGraph, source: string, target: string): Set<string> {
  const kinds = new Set<string>();
  for (const edge of graph.incidentEdges(source)) {
    if (edge.source === source && edge.target === target) kinds.add(edge.kind);
    if (edge.target === source && edge.source === target) {
      const definition = graph.registry().require(edge.kind);
      if (definition.direction === "undirected") kinds.add(edge.kind);
      else if (definition.inverse !== undefined) kinds.add(definition.inverse);
    }
  }
  return kinds;
}

/** Match the calibrated pairwise evaluation context while preserving legacy batch inference when no fit exists. */
async function inferLinkCandidates(boundary: DecisionWorkspace, source: LinkSource, targets: readonly LinkSource[], state: unknown, questions: Questions, signal: AbortSignal): Promise<SystemOneResult<Questions>> {
  const fit = boundary.calibration?.record.channels.candidate_0;
  if (fit === undefined || !fit.question_sha256.includes(questionFingerprint("candidate_0", buildLinkQuestion("candidate_0")))) return runDecision(boundary.decision, boundary.config, state, questions, signal);
  const answers: Record<string, SystemOneResult<Questions>["answers"][string]> = {};
  const usage = new TokenUsageTotals();
  let model = boundary.config.model;
  for (const [index, target] of targets.entries()) {
    const result = await runDecision(boundary.decision, boundary.config,
      { source: projectTriageState(source), candidates: { candidate_0: projectTriageState(target) } }, { candidate_0: buildLinkQuestion("candidate_0") }, signal);
    answers[`candidate_${index}`] = result.answers.candidate_0;
    usage.add(result.usage);
    model = result.model;
  }
  return { answers, usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens }, model };
}

/** Ask one typed question per ranked candidate in a single request, then authorize in code. */
async function decideLinks(boundary: DecisionWorkspace, id: string, limit: number, threshold: number, apply: boolean, allowParent: boolean, signal: AbortSignal, deadline: number): Promise<LinkDecision> {
  signal.throwIfAborted();
  const source = await loadLinkSource(boundary, id);
  const corpus = (await boundary.pm.listAllComplete({ includeBody: true })).items;
  const candidates = rankDedupeCandidates(corpus.filter(/** Never rank the source itself. */ item => item.id !== source.id), source.title, limit);
  const registry = resolveWorkspaceRelationshipKindRegistry();
  const graph = RelationshipGraph.fromItems(corpus, registry);
  const questions: Questions = {};
  const targets: LinkSource[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const target = corpus.find(/** Use the same certified snapshot for inference and existing-edge checks. */ item => item.id === candidate.id) as LinkSource;
    targets.push(target);
    questions[`candidate_${index}`] = buildLinkQuestion(`candidate_${index}`);
  }
  const state = { source: projectTriageState(source), candidates: Object.fromEntries(targets.map(/** Send only bounded content, without ids or tracker annotations. */ (target, index) => [`candidate_${index}`, projectTriageState(target)])) };
  if (Buffer.byteLength(JSON.stringify({ model: boundary.config.model, state, questions, keep_alive: boundary.config.keepAlive })) > 64 * 1024) {
    throw createPmCliExpectedError("Relationship request exceeds 64 KiB; reduce --limit.", { context: { code: "jev_link_state_limit" } });
  }
  const result = candidates.length === 0 ? { model: boundary.config.model, answers: {}, usage: { input_tokens: 0, output_tokens: 0 } } :
    await inferLinkCandidates(boundary, source, targets, state, questions, signal);
  const proposals = candidates.map(/** Rank probabilities rather than trusting the model's chosen label or confidence. */ (candidate, index): LinkProposal => {
    const answer = result.answers[`candidate_${index}`] as ChoiceResponse;
    const fit = calibratedAnswer(boundary.calibration, `candidate_${index}`, questions[`candidate_${index}`], answer.probabilities, threshold, boundary.explicitConfidence ? threshold : 0);
    const ordered = ranked(fit.probabilities);
    const [selected, probability] = ordered[0];
    const margin = probability - ordered[1][1];
    const abstained = margin < TYPE_MARGIN_THRESHOLD;
    const existing = existingLinkKinds(graph, source.id, candidate.id).has(selected);
    const parentRefused = registry.resolve(selected)?.hierarchy === true && !allowParent;
    return { candidate: candidate.id, score: candidate.score, kind: abstained || existing || selected === "none" ? null : selected, selected_kind: selected,
      probability, probabilities: fit.probabilities, abstained, existing, margin,
      ...(fit.calibration === null ? {} : { calibration: fit.calibration, raw_probability: ranked(answer.probabilities)[0][1] }),
      reason: abstained ? "top_two_margin_below_threshold" : existing ? "existing_edge" : parentRefused ? "parent_requires_allow_parent" : selected === "none" ? "none" : null };
  });
  await verifyCalibrationModel(boundary);
  const qualifying = proposals.filter(/** Only new, unambiguous, permitted edges can clear the apply threshold. */ proposal => proposal.kind !== null && proposal.probability >= (proposal.calibration === undefined ? threshold : proposal.calibration.threshold ?? Infinity) && proposal.reason === null)
    .map(/** Use the exact host --dep spelling. */ proposal => `id=${proposal.candidate},kind=${proposal.kind}`);
  for (const item of [source, ...targets]) {
    if (linkInputHash(item) !== linkInputHash(await loadLinkSource(boundary, item.id))) {
      throw createPmCliExpectedError("Relationship evidence changed; retry against current items.", { context: { code: "jev_stale_inference" } });
    }
  }
  signal.throwIfAborted();
  if (apply) {
    const receipt = `pm-jev link receipt: model=${result.model}, catalog=${LINK_CATALOG_VERSION}, input_sha256=${linkInputHash(source)}, deadline_ms=${deadline}, threshold=${threshold},${boundary.calibration === undefined ? "" : ` calibration_sha256=${boundary.calibration.receipt_sha256},`} proposals=${JSON.stringify(proposals.map(/** Round all label probabilities without copying private item content. */ proposal => ({ candidate: proposal.candidate, kind: proposal.kind, probabilities: Object.fromEntries(Object.entries(proposal.probabilities).map(/** Round receipt probabilities to two decimals. */ ([kind, probability]) => [kind, roundProbability(probability)])), reason: proposal.reason })))}, applied=${JSON.stringify(qualifying)}.`;
    await boundary.pm.update(source.id, { dep: qualifying, comment: [receipt], message: "pm-jev relationship proposals and receipt" });
  }
  return { item: source.id, outcome: proposals.some(/** Count only actual proposed edges. */ proposal => proposal.kind !== null) ? "proposals" : "none", proposals,
    applied: apply ? qualifying : [], qualifying, ...(boundary.calibration === undefined ? {} : { calibration: { receipt_sha256: boundary.calibration.receipt_sha256 } }), model: result.model, catalog_version: LINK_CATALOG_VERSION, usage: result.usage };
}

/** Dispatch single-item or streamed bounded backlog relationship proposals with one total deadline. */
async function runLinkCommand(ctx: CommandHandlerContext): Promise<unknown> {
  const started = performance.now();
  const open = readBooleanOption(ctx.options, "open") === true;
  const id = ctx.args[0];
  if (ctx.args.length > 1 || (open ? id !== undefined || readBooleanOption(ctx.options, "full") === true : id === undefined || id.trim() === "")) {
    throw createPmCliExpectedError("Use jev link <id> [--limit N] or jev link --open [--limit N].", { context: { code: "jev_link_arguments" } });
  }
  const limit = linkLimit(ctx.options);
  const boundary = await openDecisionBoundary(ctx, "link");
  const threshold = probabilityOption(ctx.options, "minConfidence", ["min_confidence"], boundary.config.minConfidence);
  const apply = readBooleanOption(ctx.options, "apply") === true;
  const allowParent = readBooleanOption(ctx.options, "allowParent", ["allow_parent"]) === true;
  const { deadline, signal } = decisionDeadline(boundary.config, started);
  if (!open) return decideLinks(boundary, (id as string).trim(), limit, threshold, apply, allowParent, signal, deadline);
  const selected = await selectOpenSources(boundary, limit, undefined);
  const counts = { changed: 0, would_change: 0, skipped: 0, failed: 0 };
  streamTriageHeader(ctx, "items", selected.items.length, ["item", "outcome", "edges", "reason", "proposals"]);
  for (const entry of selected.items) {
    const item = entry.id as string;
    let row: { item: string; outcome: keyof typeof counts; edges: number; reason: string | null; proposals: object[] };
    try {
      const result = await decideLinks(boundary, item, 8, threshold, apply, allowParent, signal, deadline);
      row = { item, outcome: result.qualifying.length > 0 ? apply ? "changed" : "would_change" : "skipped", edges: result.qualifying.length, reason: null,
        proposals: result.proposals.map(/** Stream each policy outcome without source text or complete distributions. */ proposal => ({ candidate: proposal.candidate, kind: proposal.kind, probability: proposal.probability, abstained: proposal.abstained, existing: proposal.existing, reason: proposal.reason, ...(proposal.calibration === undefined ? {} : { calibration: proposal.calibration }) })) };
    } catch (error) {
      const mapped = translateDecisionError(error, boundary.config);
      row = { item, outcome: mapped.code === "jev_stale_inference" ? "skipped" : "failed", edges: 0, reason: mapped.code ?? "jev_link_failure", proposals: [] };
    }
    counts[row.outcome]++;
    streamTriageRow(ctx, row);
  }
  return finishBacklog(ctx, "link", selected, counts, started);
}

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

/** Answer for one caller-defined question, shape-checked by question type. */
export type AskAnswer =
  | { readonly kind: "noul"; readonly probability: number }
  | { readonly kind: "choice"; readonly value: string; readonly probabilities: Record<string, number>; readonly confidence: number }
  | { readonly kind: "score"; readonly score: number; readonly probabilities: Record<string, number>; readonly confidence: number };

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

/**
 * Run caller-defined typed questions against one item's projected state.
 *
 * The question file is validated against the SDK `Questions` contract before
 * any network call, and every returned answer is shape-checked against its
 * question definition afterwards.
 *
 * @param ctx - Host command context (pm_root, options, global).
 * @returns The typed answers with model and usage metadata.
 * @throws {PmCliExpectedError} Configuration, question-file, transport, or
 *         validation failure.
 */
async function runAskCommand(ctx: CommandHandlerContext): Promise<AskDecision> {
  const id = readStringOption(ctx.options, "item", ["id"]) ?? ctx.args[0];
  if (id === undefined || id.trim().length === 0) {
    throw createPmCliExpectedError("jev ask needs an item id: pm jev ask <id> --questions <file.json>", {
      context: { code: "jev_item_required" },
    });
  }
  const path = readStringOption(ctx.options, "questions", ["questionsFile", "file"]);
  if (path === undefined || path.trim().length === 0) {
    throw createPmCliExpectedError("jev ask needs --questions <file.json> with the typed question map to run.", {
      context: { code: "jev_questions_required" },
    });
  }
  const raw = await readQuestionsFile(path.trim());
  const questions = parseQuestionsDocument(raw);
  const boundary = await openDecisionBoundary(ctx);
  const item = await loadItem(boundary, id.trim());
  const result = await runDecision(boundary.decision, boundary.config, projectItemState(item), questions);
  // Null prototype: question names are caller-defined, so "__proto__" must stay an ordinary key.
  const answers: Record<string, AskAnswer> = Object.create(null) as Record<string, AskAnswer>;
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "noul") {
      answers[name] = { kind: "noul", probability: (result.answers[name] as NoulResponse).noul };
    } else if (question.type === "choice") {
      const answer = result.answers[name] as ChoiceResponse;
      answers[name] = { kind: "choice", value: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence };
    } else {
      const answer = result.answers[name] as ScoreResponse;
      answers[name] = { kind: "score", score: answer.score, probabilities: answer.probabilities, confidence: answer.confidence };
    }
  }
  return { item: item.id, answers, model: result.model, usage: result.usage };
}

/**
 * Read and parse the questions file for `jev ask`.
 *
 * @param path - Filesystem path to a JSON document.
 * @returns The parsed JSON value.
 * @throws {PmCliExpectedError} The file is missing or not valid JSON.
 */
async function readQuestionsFile(path: string): Promise<unknown> {
  const text = await readFileIfExists(path);
  if (text === null) {
    throw createPmCliExpectedError(`Questions file "${path}" does not exist.`, {
      context: { code: "jev_questions_unreadable" },
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw createPmCliExpectedError(`Questions file "${path}" is not valid JSON.`, {
      context: { code: "jev_questions_unreadable" },
      
    });
  }
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

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

/**
 * Evaluate one yes/no proposition and return a gate verdict for CI/agents.
 *
 * The proposition holds when its full-precision probability meets the inclusive
 * threshold. Exit 0 means that outcome matches --expect (true by default); exit
 * 1 means it differs. Display rounding never changes this comparison.
 *
 * @param ctx - Host command context (pm_root, options, global).
 * @returns The gate receipt with a host-owned exit code 1 when ok is false.
 * @throws {PmCliExpectedError} Invalid options or configuration/transport failure.
 */
async function runGateCommand(ctx: CommandHandlerContext): Promise<GateDecision> {
  const proposition = readStringOption(ctx.options, "noul", ["proposition"]);
  if (proposition === undefined || proposition.trim().length === 0) {
    throw createPmCliExpectedError('jev gate needs --noul "<proposition>" describing the yes/no condition to gate on.', {
      context: { code: "jev_proposition_required" },
    });
  }
  const text = readStringOption(ctx.options, "text");
  const itemId = readStringOption(ctx.options, "item", ["id"]);
  if ((text === undefined) === (itemId === undefined)) {
    throw createPmCliExpectedError('jev gate needs exactly one state source: --text "<text>" or --item <id>.', {
      context: { code: "jev_gate_state_required" },
    });
  }
  const rawExpected = ctx.options.expect;
  if (rawExpected !== undefined && rawExpected !== "true" && rawExpected !== "false") {
    throw createPmCliExpectedError("--expect must be true or false.");
  }
  const expected = rawExpected !== "false";
  const boundary = await openDecisionBoundary(ctx);
  const threshold = probabilityOption(ctx.options, "threshold", [], boundary.config.gateThreshold);
  const state: unknown = text !== undefined ? truncateStateText(text) : projectItemState(await loadItem(boundary, (itemId as string).trim()));
  const result = await runDecision(boundary.decision, boundary.config, state, {
    proposition: { type: "noul", instructions: proposition },
  });
  const probability = (result.answers.proposition as NoulResponse).noul;
  const decision: GateDecision = {
    proposition,
    probability,
    threshold,
    holds: probability >= threshold,
    expected,
    ok: (probability >= threshold) === expected,
    source: text !== undefined ? "text" : "item",
    model: result.model,
    usage: result.usage,
  };
  return decision.ok ? decision : { ...decision, exit_code: 1 };
}

// ---------------------------------------------------------------------------
// Models and doctor
// ---------------------------------------------------------------------------

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
 * Parse an Ollama `/api/tags` payload into a decision-model inventory.
 *
 * @param payload - Parsed JSON body of `/api/tags`.
 * @returns Models with the `decision` capability flag set from the payload.
 * @throws {PmCliExpectedError} The payload is not an Ollama tags document.
 */
function parseOllamaTags(payload: unknown): DecisionModel[] {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { models?: unknown }).models)) {
    throw createPmCliExpectedError("Ollama /api/tags response has no models array.", {
      context: { code: "jev_models_shape" },
    });
  }
  const models: DecisionModel[] = [];
  for (const raw of (payload as { models: unknown[] }).models) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as { name?: unknown; capabilities?: unknown };
    if (typeof entry.name !== "string") continue;
    const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities : [];
    if (capabilities.includes("decision")) models.push({ name: entry.name, decision: true });
  }
  return models;
}

/**
 * Read the Ollama `/api/tags` inventory for one endpoint.
 *
 * @param config - Call-ready endpoint configuration.
 * @returns The decision-flagged model inventory from Ollama's native surface.
 * @throws {PmCliExpectedError} The endpoint is unreachable or serves an
 *         unrecognized payload.
 */
async function readOllamaTagsInventory(config: JevConfig, signal: AbortSignal): Promise<DecisionModelInventory> {
  const response = await fetch(`${config.baseUrl}/api/tags`, { signal, redirect: "error" });
  if (!response.ok) {
    throw createPmCliExpectedError(
      `Could not list models at ${config.baseUrl}: /api/tags answered HTTP ${response.status}.`,
      { context: { code: "jev_models_unavailable" } },
    );
  }
  return { source: "ollama-tags", base_url: config.baseUrl, models: parseOllamaTags(await response.json()) };
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
export async function listDecisionModels(
  resolved: ResolvedJevEndpoint,
  env: Record<string, string | undefined>,
): Promise<DecisionModelInventory> {
  const config = requireCallableEndpoint(resolved);
  const client = createJevClient(resolved, env);
  const signal = AbortSignal.timeout(config.totalDeadlineMs);
  try {
    const cards = await client.models.list({ signal });
    return { source: "sdk", base_url: config.baseUrl, models: cards.map(/** Convert the decision provider card to the public inventory. */ (card) => ({ name: card.name, decision: true })) };
  } catch (sdkError) {
    if (config.provider !== "ollama") throw translateDecisionError(sdkError, config);
    try { return await readOllamaTagsInventory(config, signal); }
    catch (error) { throw translateDecisionError(error, config); }
  }
}

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

/**
 * Diagnose the pm-jev configuration without sending any item state.
 *
 * Unlike the decision commands, doctor runs against a refused hosted
 * configuration too, reporting exactly which privacy-gate piece is missing
 * instead of dying on it. The model-inventory check reuses the same discovery
 * surface the `models` command uses.
 *
 * @param ctx - Host command context (pm_root, options, global).
 * @returns The aggregate doctor report.
 */
async function runDoctorCommand(ctx: CommandHandlerContext): Promise<DoctorReport> {
  const resolved = await resolveJevEndpoint(ctx.pm_root, process.env);
  const { config } = resolved;
  const checks: DoctorCheck[] = [
    {
      name: "provider",
      ok: true,
      detail: `provider=${config.provider} base_url=${config.baseUrl} model=${config.model}`,
    },
    {
      name: "hosted_opt_in",
      ok: resolved.hostedBlocked === null,
      detail:
        resolved.hostedBlocked === null
          ? "local provider or explicit hosted opt-in present"
          : resolved.hostedBlocked === "missing_opt_in"
            ? "hosted provider refused: jev.allow_external=true is not set in settings.json"
            : "hosted provider refused: TYPESAFE_API_KEY is not set",
    },
    {
      name: "thresholds",
      ok: true,
      detail: `min_confidence=${config.minConfidence} gate_threshold=${config.gateThreshold} timeout_ms=${config.timeoutMs} total_deadline_ms=${config.totalDeadlineMs}`,
    },
  ];
  if (resolved.hostedBlocked === null) {
    try {
      const inventory = await listDecisionModels(resolved, process.env);
      const decisionCapable = inventory.models.filter(/** Count only models advertising decision support. */ (model) => model.decision).length;
      const served = inventory.models.some(/** Verify the configured model appears in the inventory. */ (model) => model.name === config.model);
      checks.push(
        {
          name: "endpoint",
          ok: true,
          detail: `reachable via ${inventory.source} with ${inventory.models.length} model(s), ${decisionCapable} decision-capable`,
        },
        {
          name: "model",
          ok: served,
          detail: served
            ? `model "${config.model}" is served by the endpoint`
            : `model "${config.model}" is NOT served by the endpoint${config.provider === "ollama" ? `; pull it with: ollama pull ${config.model}` : ""}`,
        },
      );
    } catch (error) {
      checks.push({
        name: "endpoint",
        ok: false,
        detail: `model listing failed: ${translateDecisionError(error, config).message}`,
      });
    }
  }
  return { status: checks.every(/** Aggregate the diagnostic checks without sending state. */ (check) => check.ok) ? "ok" : "degraded", checks, config };
}

/**
 * List the decision models at the configured endpoint for humans and agents.
 *
 * @param ctx - Host command context (pm_root, options, global).
 * @returns The model inventory with discovery source and capability flags.
 * @throws {PmCliExpectedError} The endpoint cannot be reached or listed.
 */
async function runModelsCommand(ctx: CommandHandlerContext): Promise<DecisionModelInventory> {
  return listDecisionModels(await resolveJevEndpoint(ctx.pm_root, process.env), process.env);
}

// ---------------------------------------------------------------------------
// Flag and command definitions
// ---------------------------------------------------------------------------

/** Shared text-output escape hatch; --full is not reserved by the pinned host. */
const FULL_FLAG: FlagDefinition = {
  long: "--full",
  value_type: "boolean",
  description: "Show full precision and all choice options (JSON is always full)",
};

/** Flags for the triage command. */
const TRIAGE_FLAGS: FlagDefinition[] = [
  FULL_FLAG,
  { long: "--open", value_type: "boolean", description: "Stream a bounded backlog selected with the host's open lifecycle semantics" },
  { long: "--type", value_name: "t", value_type: "string", description: "Host item type filter (requires --open)" },
  { long: "--limit", value_name: "N", value_type: "string", description: "Backlog item bound (default 20, maximum 1000; requires --open)" },
  { long: "--refresh", value_type: "boolean", description: "Re-evaluate items with matching source receipts (requires --open)" },
  {
    long: "--apply",
    value_type: "boolean",
    description: "Apply type/priority proposals whose probability clears --min-confidence, and append a receipt comment",
  },
  {
    long: "--min-confidence",
    value_name: "p",
    value_type: "string",
    description: "Probability threshold for --apply (default: jev.min_confidence setting, else 0.8)",
  },
];

/** Flags for the dedupe command. */
const DEDUPE_FLAGS: FlagDefinition[] = [
  FULL_FLAG,
  { long: "--status", value_name: "open|all", value_type: "string", description: "Scan existing items (default open); --title selects pre-create screening" },
  { long: "--type", value_name: "t", value_type: "string", description: "Scan only this item type" },
  { long: "--limit-pairs", value_name: "N", value_type: "string", description: "Maximum sequential pair decisions (default 20, maximum 200)" },
  { long: "--min-confidence", value_name: "p", value_type: "string", description: "Raise the train-calibrated duplicate cutoff; insufficient evidence stays unsure" },
  { long: "--apply", value_type: "boolean", description: "Add calibrated duplicate links with a receipt; never close items" },
  { long: "--close", value_type: "boolean", description: "Removed: duplicate proposals are links-only; use --apply" },
  { long: "--title", value_name: "text", value_type: "string", description: "Pre-create screening: title of the item about to be created; omit to scan existing pairs" },
  { long: "--body", value_name: "text", value_type: "string", description: "Optional proposed body text for context" },
  { long: "--limit", value_name: "n", value_type: "string", description: "Maximum candidates ranked into the choice (default 8, max 32)" },
];

/** Flags for the ask command. */
const ASK_FLAGS: FlagDefinition[] = [
  FULL_FLAG,
  {
    long: "--questions",
    value_name: "file",
    value_type: "string",
    description: "JSON file with the typed question map to run (required)",
  },
];

/** Flags for the gate command. */
const GATE_FLAGS: FlagDefinition[] = [
  FULL_FLAG,
  { long: "--noul", value_name: "proposition", value_type: "string", description: "Yes/no proposition to gate on (required)" },
  { long: "--text", value_name: "text", value_type: "string", description: "Free text to evaluate the proposition over" },
  { long: "--item", value_name: "id", value_type: "string", description: "Item id whose projected state the proposition is evaluated over" },
  { long: "--expect", value_name: "true|false", value_type: "string", description: "Expected proposition outcome; exit 0 when holds matches (default true; use false for secrets/private data)" },
  {
    long: "--threshold",
    value_name: "p",
    value_type: "string",
    description: "Inclusive threshold for holds (default: jev.gate_threshold setting, else 0.5)",
  },
];

/**
 * Register every pm-jev command on the extension API.
 *
 * Command paths are namespaced under `jev` (`pm jev triage <id>` etc.) and each
 * handler returns a plain JSON-safe receipt the host renders in TOON or JSON
 * per its own `--json` global flag.
 *
 * @param api - Activation API surface provided by the host.
 */
function registerCommands(api: ExtensionApi): void {
  api.registerCommand(defineCommand({
    name: "jev replay",
    description: "Compare frozen decision proposals against a selected local policy or model before adoption",
    flags: REPLAY_FLAGS,
    examples: ["pm jev replay --recording recording.json --policy-version candidate-v2 --min-probability 0.8 --json"],
    /** Delegate compact TOON/JSON rendering and refusal exit codes to the host. */
    run: (ctx: CommandHandlerContext) => runReplayCommand(ctx),
  }));
  api.registerCommand(defineCommand({
    name: "jev explain",
    description: "Measure typed decision sensitivity by bounded explicit field removals with opaque evidence receipts",
    arguments: [{ name: "id", required: true, description: "Item to read without mutation" }],
    flags: EXPLANATION_FLAGS,
    examples: ["pm jev explain my-item-1a2b --questions questions.json --fields title,description --max-calls 3 --json"],
    /** The host owns TOON/JSON output and refusal exit codes. */
    run: (ctx: CommandHandlerContext) => runExplanationCommand(ctx),
  }));
  api.registerCommand(defineCommand({
    name: "jev policy",
    description: "Select a measured abstention filter from caller costs and fixed labelled scores without retraining",
    flags: COST_POLICY_FLAGS,
    examples: ["pm jev policy --observations scores.json --false-duplicate-cost 20 --wrong-type-cost 10 --missed-candidate-cost 1 --json"],
    /** Preserve the typed refusal and compact receipt in either host format. */
    run: (ctx: CommandHandlerContext) => runCostPolicyCommand(ctx),
  }));
  for (const calibrate of [false, true]) api.registerCommand(defineCommand({
    name: calibrate ? "jev calibrate" : "jev eval",
    description: calibrate ? "Fit local probabilities on public calibration repositories and validate on held-out repositories" : "Measure local typed decisions against committed public tracker labels",
    arguments: [{ name: "sources", variadic: true, required: false, description: "Additional tracker roots; verified public snapshots by default" }],
    flags: [...EVALUATION_FLAGS, ...(calibrate ? [{ long: "--target-precision", value_name: "p", value_type: "string" as const, description: "Required one-sided 95% precision lower bound (default 0.9)" }] : [])],
    /** Keep full precision for reliability evidence in both host output formats. */
    run: (ctx: CommandHandlerContext) => runEvaluationCommand(ctx, calibrate),
  }));
  api.registerCommand(defineCommand({
    name: "jev link",
    description: "Propose typed relationship edges between ranked pm items",
    arguments: [{ name: "id", required: false, description: "Source item; omit with --open" }],
    flags: [FULL_FLAG, ...TRIAGE_FLAGS.filter(/** Reuse host-compatible apply flags. */ flag => ["--open", "--apply", "--min-confidence"].includes(flag.long as string)),
      { long: "--limit", value_name: "N", value_type: "string", description: "Candidate bound (backlog source bound with --open), default 8, maximum 50" },
      { long: "--allow-parent", value_type: "boolean", description: "Permit proposed hierarchy edges on apply" }],
    examples: ["pm jev link my-item-1a2b", "pm jev link --open --limit 10", "pm jev link my-item-1a2b --apply"],
    /** Stream backlog rows or render a single decision using host output precedence. */
    run: (ctx: CommandHandlerContext) => readBooleanOption(ctx.options, "open") === true ? runLinkCommand(ctx) : decisionOutput(ctx, runLinkCommand),
  }));

  api.registerCommand(
    defineCommand({
      name: "jev triage",
      description: "Propose item type, priority, needs_human and sensitive flags with one batched System One decision",
      intent: "Route and rank a pm item with typed, probabilistic proposals before any human or agent edits it",
      arguments: [{ name: "id", required: false, description: "Item id to triage; omit with --open" }],
      flags: TRIAGE_FLAGS,
      failure_hints: [
        "Start the local Ollama server and pull the model: ollama pull tev1:4b",
        "Check the endpoint with: pm jev doctor",
      ],
      examples: ["pm jev triage my-item-1a2b", "pm jev triage my-item-1a2b --apply --min-confidence 0.9", "pm jev triage --open --limit 10"],
      /** Dispatch the registered command with the host-resolved tracker and flags. */
      run: (ctx: CommandHandlerContext) => readBooleanOption(ctx.options, "open") === true ? runTriageCommand(ctx) : decisionOutput(ctx, runTriageCommand),
    }),
  );
  api.registerCommand(
    defineCommand({
      name: "jev dedupe",
      description: "Propose calibrated duplicate pairs with abstention, or screen a title before creation; links only, never closes items",
      intent: "Verify duplicate work in a bounded tracker scan or screen a title before creation",
      flags: DEDUPE_FLAGS,
      failure_hints: ["Ranking is deterministic in code; only the confirmation needs the decision endpoint (pm jev doctor)"],
      examples: ['pm jev dedupe --title "Fix login crash"', 'pm jev dedupe --title "Fix login crash" --body "Steps: ..." --limit 12', 'pm jev dedupe --limit-pairs 20'],
      /** Dispatch the registered command with the host-resolved tracker and flags. */
      run: (ctx: CommandHandlerContext) => ctx.options.title === undefined ? runPairDedupe(ctx) : decisionOutput(ctx, runDedupeCommand),
    }),
  );
  api.registerCommand(
    defineCommand({
      name: "jev ask",
      description: "Run caller-defined typed choice/score/noul questions against one item's projected state",
      intent: "Ad-hoc typed decisions over a pm item without leaving the tracker",
      arguments: [{ name: "id", required: true, description: "Item id to ask about" }],
      flags: ASK_FLAGS,
      failure_hints: ["The questions file must be a JSON object of named choice/score/noul questions"],
      examples: ["pm jev ask my-item-1a2b --questions questions.json"],
      /** Dispatch the registered command with the host-resolved tracker and flags. */
      run: (ctx: CommandHandlerContext) => decisionOutput(ctx, runAskCommand),
    }),
  );
  api.registerCommand(
    defineCommand({
      name: "jev gate",
      description: "Exit 0/1 from a calibrated noul proposition over text or an item, for agents and CI",
      intent: "Deterministic CI/agent gating on a probabilistic yes/no decision",
      flags: GATE_FLAGS,
      failure_hints: ["Exit code 1 means holds differs from --expect; inspect holds, expected and ok"],
      examples: [
        'pm jev gate --noul "contains private data" --text "..." --expect false',
        'pm jev gate --noul "needs human review" --item my-item-1a2b --threshold 0.7',
      ],
      /** Dispatch the registered command with the host-resolved tracker and flags. */
      run: (ctx: CommandHandlerContext) => decisionOutput(ctx, runGateCommand),
    }),
  );
  api.registerCommand(
    defineCommand({
      name: "jev models",
      description: "List the decision models served by the configured endpoint",
      intent: "Discover which local or hosted decision models are available",
      examples: ["pm jev models"],
      /** Dispatch the registered command with the host-resolved tracker and flags. */
      run: (ctx: CommandHandlerContext) => runModelsCommand(ctx),
    }),
  );
  api.registerCommand(
    defineCommand({
      name: "jev doctor",
      description: "Check pm-jev configuration, privacy opt-in, endpoint reachability, and model availability",
      intent: "Diagnose why decisions fail without sending any item state",
      examples: ["pm jev doctor"],
      /** Dispatch the registered command with the host-resolved tracker and flags. */
      run: (ctx: CommandHandlerContext) => runDoctorCommand(ctx),
    }),
  );
}

// The extension identity. The version string is release-managed: the daily
// release workflow rewrites the first `version: "..."` literal in this file.
/** Public pm extension activation entry and release-managed identity. */
export default defineExtension({
  name: "pm-jev",
  version: "2026.10.5",
  description: "Typed, local-first System One decisions for pm items (Jev-style models via @typesafe-ai/sdk)",
  /** Register the versioned decision commands with the pm host. */
  activate(api: ExtensionApi): void {
    api.hooks.beforeMutation(guardTriageMutation);
    api.hooks.beforeMutation(guardLinkMutation);
    api.hooks.beforeMutation(guardDedupeMutation);
    registerCommands(api);
  },
});
