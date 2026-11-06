import { AdmissionRefusal } from "./admission-schema.js";
/** Longest accepted reference: host (350) + namespace (80) + model (80) + tag (80) plus separators and an optional scheme. */
export const OLLAMA_NAME_MAX_LENGTH = 640;
/** Canonicalize valid native Ollama names with default host, namespace and tag, using ASCII case folding. */
export function ollamaModelName(name) {
    if (typeof name !== "string" || name.length > OLLAMA_NAME_MAX_LENGTH)
        return undefined;
    // Linear scans: a tag is the text after the last ':' that follows the last '/', so registry ports never count as tags.
    const colon = name.lastIndexOf(":");
    const tagged = colon > name.lastIndexOf("/");
    const tag = tagged ? name.slice(colon + 1) : "latest";
    const parts = (tagged ? name.slice(0, colon) : name).split("/");
    const model = parts.pop();
    const namespace = parts.pop() ?? "library";
    const host = parts.length === 0 ? "registry.ollama.ai" : parts.join("/").replace(/^.*?:\/\//s, "");
    if (!/^[a-z0-9_][a-z0-9_.:-]{0,349}$/i.test(host) || !/^[a-z0-9_][a-z0-9_-]{0,79}$/i.test(namespace) ||
        !/^[a-z0-9_][a-z0-9_.-]{0,79}$/i.test(model) || !/^[a-z0-9_][a-z0-9_.-]{0,79}$/i.test(tag))
        return undefined;
    return `${host}/${namespace}/${model}:${tag}`.toLowerCase();
}
/** Resolve every equivalent native inventory row before pinning an immutable digest. */
export function resolveOllamaInventoryModel(model, inventory) {
    const name = ollamaModelName(model);
    if (name === undefined || !Array.isArray(inventory))
        throw new AdmissionRefusal("unsupported_model", "Use a valid installed native model reference and a complete /api/tags inventory; no inference was submitted.");
    const matches = inventory.filter(/** Ignore foreign rows and normalize both reference operands. */ (row) => typeof row === "object" && row !== null && !Array.isArray(row) && ollamaModelName(row.name) === name);
    const digests = new Set(matches.map(/** Keep invalid identities so conflicts cannot be silently ignored. */ /** Keep invalid identities so conflicts cannot be silently ignored. */ row => row.digest));
    if (digests.size > 1)
        throw new AdmissionRefusal("ambiguous_model", "Resolve conflicting installed aliases in the native inventory, then retry with the installed model name; no inference was submitted.");
    const digest = matches[0]?.digest;
    if (typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest))
        throw new AdmissionRefusal("unsupported_model", "Select an installed native model with a verified sha256 digest; no inference was submitted.");
    return { digest, matches };
}
//# sourceMappingURL=ollama-model.js.map