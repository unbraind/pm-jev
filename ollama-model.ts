/** Resolve an Ollama inventory/configuration name without treating registry ports as tags. */
export function ollamaModelName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  return /:[^/]*$/.test(name) ? name : `${name}:latest`;
}
