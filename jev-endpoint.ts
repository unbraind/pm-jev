import { TypeSafeClient } from "@typesafe-ai/sdk";
import { createPmCliExpectedError, readSettings } from "@unbrained/pm-cli/sdk";
import { readOpaqueJevSettings } from "./decision-calibration.ts";

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
export function numberSetting(value: unknown, fallback: number, low: number, high: number): number {
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
