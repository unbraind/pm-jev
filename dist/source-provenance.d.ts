/** Explicit private-source evidence; absence preserves the verified public receipt format. */
export interface LocalProvenance {
    /** Local evidence has not passed public origin, visibility or commit verification. */
    provenance?: "local-unverified";
}
/** Refuse private evidence at public corpus, artifact and fixture boundaries, including nested receipts. */
export declare function assertPublicProvenance(value: unknown): void;
//# sourceMappingURL=source-provenance.d.ts.map