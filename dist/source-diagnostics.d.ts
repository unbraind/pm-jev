/** Explicit recovery path for private trackers; never an automatic public-source fallback. */
export declare const LOCAL_SOURCE_GUIDANCE = "For private local evaluation, pass --local-unverified --from <tracker>.";
/** Remove credential material, endpoint details and local identities from one diagnostic line. */
export declare function redactedSourceLine(text: string): string;
/** Classify gh subprocess failures and retain only a redacted first stderr line. */
export declare function ghInspectionFailure(repository: string, code: string | undefined, status: number | null | undefined, stderr: string): Error;
//# sourceMappingURL=source-diagnostics.d.ts.map