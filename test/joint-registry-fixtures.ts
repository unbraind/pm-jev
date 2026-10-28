import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RelationshipKindDefinition } from "@unbrained/pm-cli/sdk/graph";
import type { JointInput } from "../joint-schema.ts";

/** Host-contributed semantics cover ordering in both directions and undirected association. */
export const REGISTRY_DEFINITIONS: readonly RelationshipKindDefinition[] = [
  { kind: "fixture_precedes", aliases: ["fixture_before_alias"], compatibilityVersion: 1, direction: "directed", ordering: true, precedence: "source_before_target", hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", allowSelf: false },
  { kind: "fixture_follows", aliases: ["fixture_after_alias"], compatibilityVersion: 1, direction: "directed", ordering: true, precedence: "target_before_source", hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", allowSelf: false },
  { kind: "fixture_associates", compatibilityVersion: 1, direction: "undirected", ordering: false, hierarchy: false, outgoing: "many", incoming: "many", lifecycle: "persistent", allowSelf: false },
];

/** Install a real host schema extension; no SDK calls or registries are mocked. */
export function installRegistryFixture(pmRoot: string): void {
  const directory = join(pmRoot, "extensions", "joint-registry-fixture");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ name: "joint-registry-fixture", version: "1.0.0", entry: "./index.js", capabilities: ["schema"] }));
  writeFileSync(join(directory, "index.js"), `export default { name: "joint-registry-fixture", activate(api) { api.registerRelationshipKinds(${JSON.stringify(REGISTRY_DEFINITIONS)}); } };\n`);
}

/** Reuse the shipped producer document while selecting explicit conditional graph additions. */
export function registryBatch(edges: readonly { source: string; target: string; kind: string }[]): JointInput {
  const example = JSON.parse(readFileSync(new URL("../examples/joint-decisions.json", import.meta.url), "utf8")) as JointInput;
  return { ...example, constraints: edges.map(/** One declaration per selected edge; keep raw answers intact. */ (edge, index) => ({ id: `edge_${index}`, kind: "relationship", when: { question: "is_bug", value: "yes" }, source: edge.source, target: edge.target, relationship: edge.kind })) };
}
