/** Explicit recovery path for private trackers; never an automatic public-source fallback. */
export declare const LOCAL_SOURCE_GUIDANCE = "For private local evaluation, pass --local-unverified --from <tracker>.";
/** Remove credential material, endpoint details and local identities from one diagnostic line. */
export declare function redactedSourceLine(text: string): string;
/** Redact a tool invocation and distinguish launch errors, runtime limits, signals and command exits. */
export declare function sourceFailureDetail(command: string, code: string | undefined, status: number | null | undefined, stderr: string, signal?: string | null): string;
/** Classify gh subprocess failures and retain only a redacted first stderr line. */
export declare function ghInspectionFailure(repository: string, code: string | undefined, status: number | null | undefined, stderr: string, signal?: string | null): Error;
//# sourceMappingURL=source-diagnostics.d.ts.map