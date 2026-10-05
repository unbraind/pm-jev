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
import {
  createPmCliExpectedError,
  getSettingsPath,
  isPmCliExpectedError,
  PmClient,
  readBooleanOption,
  readFileIfExists,
  readSettings,
  readStringOption,
  resolveItemTypeRegistry,
  scoreItemSimilarity,
} from "@unbrained/pm-cli/sdk";
import { defineCommand, defineExtension } from "@unbrained/pm-cli/sdk/authoring";
import type { CommandHandlerContext, ExtensionApi, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import type { ItemMetadata, PmSettings } from "@unbrained/pm-cli/sdk";

/** Re-export the structural expected-error predicate for package consumers. */
export { isPmCliExpectedError };
/** Re-export the structural expected-error factory for package consumers. */
export { createPmCliExpectedError };
/** Re-export the pm similarity score type used by the dedupe ranking contract. */
export type { ItemMetadata, PmSettings };
/** Re-export the SDK question-map and result contracts callers validate against. */
export type { Questions, SystemOneResult };

// ---------------------------------------------------------------------------
// Versioned question catalogs
// ---------------------------------------------------------------------------

/** Version of the triage question catalog; surfaced in every triage receipt. */
export const TRIAGE_CATALOG_VERSION = "pm-jev-triage/1";
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
const BUILTIN_TYPE_CRITERIA: Readonly<Record<string, string>> = {
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
};

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
  const raw = await readFileIfExists(getSettingsPath(pmRoot));
  if (raw === null) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const jev = (parsed as { jev?: unknown }).jev;
  if (typeof jev !== "object" || jev === null) return {};
  return jev as JevSettingsSection;
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
 * @throws {PmCliExpectedError} The `jev.provider` setting names an unknown provider.
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
 * Resolve the fully configured decision endpoint, without enforcing the hosted
 * privacy gate — so `jev doctor` can diagnose a refused configuration instead
 * of dying on it.
 *
 * Precedence: environment overrides win, then the `jev` settings section, then
 * pm's typed `providers.ollama` settings, then built-in defaults.
 *
 * @param pmRoot - Resolved pm tracker root.
 * @param env - Environment to read `PM_JEV_BASE_URL`, `PM_JEV_MODEL` and
 *              `TYPESAFE_API_KEY` from.
 * @returns The endpoint configuration and the hosted opt-in verdict.
 * @throws {PmCliExpectedError} The `jev.provider` setting names an unknown provider.
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
  const baseUrl =
    envBaseUrl ??
    sectionBaseUrl ??
    (provider === "typesafe" ? DEFAULT_TYPESAFE_BASE_URL : DEFAULT_OLLAMA_BASE_URL);
  const model =
    envModel ??
    sectionModel ??
    (provider === "typesafe" ? DEFAULT_TYPESAFE_MODEL : DEFAULT_OLLAMA_MODEL);
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw createPmCliExpectedError("jev base URL must be HTTP(S) without credentials, query or fragment.", { context: { code: "jev_invalid_url" } });
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
export function createJevClient(resolved: ResolvedJevEndpoint, env: Record<string, string | undefined>): TypeSafeClient {
  const config = requireCallableEndpoint(resolved);
  const apiKey = config.provider === "ollama" ? OLLAMA_API_KEY : stringSetting(env.TYPESAFE_API_KEY);
  return new TypeSafeClient({
    apiKey,
    baseURL: config.baseUrl,
    defaultModel: config.model,
    timeout: config.timeoutMs,
    retry: { maxRetries: 2 },
    logLevel: "off",
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
    if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0) throw new Error("malformed response: invalid usage");
  }
  const answers = requireRecord(result.answers, "answers");
  if (Object.keys(answers).some(/** Reject answers for questions that were never asked. */ name => !Object.hasOwn(questions, name))) throw new Error("malformed response: unexpected answer");
  for (const [name, question] of Object.entries(questions)) {
    const entry = requireRecord(answers[name], name);
    if (entry.type !== question.type) throw new Error(`malformed answer: ${name}.type`);
    if (question.type === "noul") {
      requireProbability(entry.noul, `${name}.noul`);
      continue;
    }
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
 * @returns The validated response with resolved model and usage.
 * @throws {PmCliExpectedError} A mapped transport/validation failure.
 */
export async function runDecision(
  client: TypeSafeClient,
  config: JevConfig,
  state: unknown,
  questions: Questions,
): Promise<SystemOneResult<Questions>> {
  try {
    const result = await client.systemOne(
      { state: state as EntryType, questions, model: config.model },
      { signal: AbortSignal.timeout(config.totalDeadlineMs) },
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
      questions[name] = criteria === null ? { type: "noul", instructions } : { type: "noul", instructions, criteria };
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
}

/**
 * Resolve, privacy-gate, and construct the call-ready decision boundary for
 * one command invocation.
 *
 * @param ctx - Host command context with the resolved tracker root.
 * @returns The workspace handle used by command implementations.
 * @throws {PmCliExpectedError} Configuration is unusable or externally blocked.
 */
async function openDecisionBoundary(ctx: CommandHandlerContext): Promise<DecisionWorkspace> {
  const resolved = await resolveJevEndpoint(ctx.pm_root, process.env);
  const config = requireCallableEndpoint(resolved);
  const decision = createJevClient(resolved, process.env);
  const pm = new PmClient({ pmRoot: ctx.pm_root, cwd: ctx.source_workspace_root, author: ctx.global.author });
  return { pm, pmRoot: ctx.pm_root, decision, config };
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
  const selected = record.kind === "choice" ? record.value : "duplicate_of" in record ? record.duplicate_of ?? "none" : undefined;
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
    readonly value: string;
    readonly probabilities: Record<string, number>;
    readonly confidence: number;
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
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  /** Versioned question catalog that produced the proposals. */
  readonly catalog_version: string;
  /** Fields written when --apply was passed; empty otherwise. */
  readonly applied: readonly string[];
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
    criteria[name] = registry.by_type[name].description || BUILTIN_TYPE_CRITERIA[name] || `Item type "${name}" in this project's schema`;
  }
  return {
    type: {
      type: "choice",
      instructions: "Which kind of work is this item? Choose the item type that best matches it.",
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
async function runTriageCommand(ctx: CommandHandlerContext): Promise<TriageDecision> {
  const id = readStringOption(ctx.options, "item", ["id"]) ?? ctx.args[0];
  if (id === undefined || id.trim().length === 0) {
    throw createPmCliExpectedError("jev triage needs an item id: pm jev triage <id>", {
      context: { code: "jev_item_required" },
    });
  }
  const boundary = await openDecisionBoundary(ctx);
  const settings = await readSettings(boundary.pmRoot);
  const questions = buildTriageQuestions(settings);
  const item = await loadItem(boundary, id.trim());
  const result = await runDecision(boundary.decision, boundary.config, projectItemState(item), questions);
  const typeAnswer = result.answers.type as ChoiceResponse;
  const scoreAnswer = result.answers.priority as ScoreResponse;
  const proposals: TriageProposals = {
    type: {
      kind: "choice",
      value: typeAnswer.choice,
      probabilities: typeAnswer.probabilities,
      confidence: typeAnswer.confidence,
    },
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
  const threshold = probabilityOption(ctx.options, "minConfidence", ["min_confidence"], boundary.config.minConfidence);
  const written: string[] = [];
  const changes: { type?: string; priority?: number } = {};
  if (readBooleanOption(ctx.options, "apply") === true) {
    if ((proposals.type.probabilities[proposals.type.value]) >= threshold && proposals.type.value !== item.type) {
      changes.type = proposals.type.value;
      written.push(`type=${proposals.type.value}`);
    }
    const levelProbability = proposals.priority.probabilities[String(proposals.priority.level)];
    if (levelProbability >= threshold && proposals.priority.level !== item.priority) {
      changes.priority = proposals.priority.level;
      written.push(`priority=${proposals.priority.level}`);
    }
    await boundary.pm.update(item.id, { ...changes, comment: [formatTriageReceipt(result.model, proposals, threshold, written)], message: "pm-jev triage proposals and receipt" });
  }
  return {
    item: item.id,
    proposals,
    model: result.model,
    usage: result.usage,
    catalog_version: TRIAGE_CATALOG_VERSION,
    applied: written,
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
 * @returns The single-line receipt comment text.
 */
function formatTriageReceipt(model: string, proposals: TriageProposals, threshold: number, written: readonly string[]): string {
  const parts = [
    `pm-jev triage receipt: model=${model}`,
    `catalog=${TRIAGE_CATALOG_VERSION}`,
    `type=${proposals.type.value} p=${roundProbability(proposals.type.probabilities[proposals.type.value])}`,
    `priority=${proposals.priority.level} p=${roundProbability(proposals.priority.probabilities[String(proposals.priority.level)])}`,
    `needs_human=${roundProbability(proposals.needs_human.probability)}`,
    `sensitive=${roundProbability(proposals.sensitive.probability)}`,
    `threshold=${roundProbability(threshold)}`,
  ];
  return `${parts.join(", ")}${written.length > 0 ? `, applied=[${written.join(", ")}]` : ", applied=none"}.`;
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
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
  /** Versioned question catalog that produced the decision. */
  readonly catalog_version: string;
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
  const title = readStringOption(ctx.options, "title");
  if (title === undefined || title.trim().length === 0) {
    throw createPmCliExpectedError('jev dedupe needs --title "<text>" for the item about to be created.', {
      context: { code: "jev_title_required" },
    });
  }
  const body = readStringOption(ctx.options, "body") ?? "";
  const limit = Math.trunc(numberSetting(readStringOption(ctx.options, "limit"), DEFAULT_DEDUPE_LIMIT, 1, 32));
  const boundary = await openDecisionBoundary(ctx);
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
  const criteria: Record<string, string> = {};
  for (const candidate of candidates) {
    criteria[candidate.id] = `${truncateStateText(candidate.title)} (type ${candidate.type}, status ${candidate.status}, title similarity ${candidate.score})`;
  }
  criteria.none = "The proposed item is not a duplicate of any candidate";
  const result = await runDecision(
    boundary.decision,
    boundary.config,
    { proposed: { title: truncateStateText(title), body: truncateStateText(body) }, candidates: candidates.map(/** Bound candidate text without changing deterministic ranks. */ candidate => ({ ...candidate, title: truncateStateText(candidate.title) })) },
    {
      duplicate_of: {
        type: "choice",
        instructions:
          "A new pm item is about to be created. Does it duplicate one of the candidate items listed in the state? Choose the candidate id it duplicates, or none.",
        criteria,
      },
    },
  );
  const answer = result.answers.duplicate_of as ChoiceResponse;
  return {
    duplicate_of: answer.choice === "none" ? null : answer.choice,
    probability: answer.probabilities[answer.choice],
    probabilities: answer.probabilities,
    confidence: answer.confidence,
    candidates,
    model: result.model,
    usage: result.usage,
    catalog_version: DEDUPE_CATALOG_VERSION,
  };
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
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
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
  const answers: Record<string, AskAnswer> = {};
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
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
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
  const state: unknown = text !== undefined ? truncateStateText(text) : projectItemState(await loadItem(boundary, (itemId as string).trim()));
  const result = await runDecision(boundary.decision, boundary.config, state, {
    proposition: { type: "noul", instructions: proposition },
  });
  const threshold = probabilityOption(ctx.options, "threshold", [], boundary.config.gateThreshold);
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
  { long: "--title", value_name: "text", value_type: "string", description: "Title of the item about to be created (required)" },
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
  api.registerCommand(
    defineCommand({
      name: "jev triage",
      description: "Propose item type, priority, needs_human and sensitive flags with one batched System One decision",
      intent: "Route and rank a pm item with typed, probabilistic proposals before any human or agent edits it",
      arguments: [{ name: "id", required: true, description: "Item id to triage" }],
      flags: TRIAGE_FLAGS,
      failure_hints: [
        "Start the local Ollama server and pull the model: ollama pull tev1:4b",
        "Check the endpoint with: pm jev doctor",
      ],
      examples: ["pm jev triage my-item-1a2b", "pm jev triage my-item-1a2b --apply --min-confidence 0.9"],
      /** Dispatch the registered command with the host-resolved tracker and flags. */
      run: (ctx: CommandHandlerContext) => decisionOutput(ctx, runTriageCommand),
    }),
  );
  api.registerCommand(
    defineCommand({
      name: "jev dedupe",
      description: "Screen a proposed item title for duplicates before pm create, with one model-confirmed choice",
      intent: "Let agents run this before pm create to avoid filing duplicate work",
      flags: DEDUPE_FLAGS,
      failure_hints: ["Ranking is deterministic in code; only the confirmation needs the decision endpoint (pm jev doctor)"],
      examples: ['pm jev dedupe --title "Fix login crash"', 'pm jev dedupe --title "Fix login crash" --body "Steps: ..." --limit 12'],
      /** Dispatch the registered command with the host-resolved tracker and flags. */
      run: (ctx: CommandHandlerContext) => decisionOutput(ctx, runDedupeCommand),
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
    registerCommands(api);
  },
});