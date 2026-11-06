/** Canonicalize valid native Ollama names with default host, namespace and tag, using ASCII case folding. */
export function ollamaModelName(name) {
    if (typeof name !== "string")
        return undefined;
    const tagged = /:[^/]*$/.test(name);
    const tag = tagged ? name.slice(name.lastIndexOf(":") + 1) : "latest";
    const parts = (tagged ? name.slice(0, name.lastIndexOf(":")) : name).split("/");
    const model = parts.pop();
    const namespace = parts.pop() ?? "library";
    const host = parts.length === 0 ? "registry.ollama.ai" : parts.join("/").replace(/^.*?:\/\//s, "");
    if (!/^[a-z0-9_][a-z0-9_.:-]{0,349}$/i.test(host) || !/^[a-z0-9_][a-z0-9_-]{0,79}$/i.test(namespace) ||
        !/^[a-z0-9_][a-z0-9_.-]{0,79}$/i.test(model) || !/^[a-z0-9_][a-z0-9_.-]{0,79}$/i.test(tag))
        return undefined;
    return `${host}/${namespace}/${model}:${tag}`.toLowerCase();
}
//# sourceMappingURL=ollama-model.js.map