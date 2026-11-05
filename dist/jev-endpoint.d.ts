import { TypeSafeClient } from "@typesafe-ai/sdk";
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
 * Coerce a settings value into a finite number inside `[low, high]`.
 *
 * @param value - Raw settings value of any shape.
 * @param fallback - Value returned when the input is missing or invalid.
 * @param low - Smallest accepted value.
 * @param high - Largest accepted value.
 * @returns The clamped number, or `fallback` for unusable input.
 */
export declare function numberSetting(value: unknown, fallback: number, low: number, high: number): number;
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
//# sourceMappingURL=jev-endpoint.d.ts.map