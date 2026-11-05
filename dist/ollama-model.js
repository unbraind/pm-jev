/** Resolve an Ollama inventory/configuration name without treating registry ports as tags. */
export function ollamaModelName(name) {
    if (typeof name !== "string")
        return undefined;
    return /:[^/]*$/.test(name) ? name : `${name}:latest`;
}
//# sourceMappingURL=ollama-model.js.map