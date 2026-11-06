/** Longest accepted reference: host (350) + namespace (80) + model (80) + tag (80) plus separators and an optional scheme. */
export declare const OLLAMA_NAME_MAX_LENGTH = 640;
/** Canonicalize valid native Ollama names with default host, namespace and tag, using ASCII case folding. */
export declare function ollamaModelName(name: unknown): string | undefined;
/** Resolve every equivalent native inventory row before pinning an immutable digest. */
export declare function resolveOllamaInventoryModel(model: string, inventory: unknown): {
    digest: string;
    matches: Record<string, unknown>[];
};
//# sourceMappingURL=ollama-model.d.ts.map