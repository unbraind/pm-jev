import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { parse } from "@babel/parser";
import * as api from "../index.ts";
import { parseQuestionsDocument } from "../questions-document.ts";
import { resolveJevEndpoint, requireCallableEndpoint, createJevClient } from "../jev-endpoint.ts";

const root = resolve(import.meta.dirname, "..");

/** Inspect emitted value edges, so erased type imports cannot create false cycles. */
function assertIndependentGraph(entry: string): void {
  const visited = new Set<string>();
  /** Follow every local import and re-export, retaining the active path for cycle diagnostics. */
  function visit(file: string, ancestors: readonly string[]): void {
    assert.ok(!ancestors.includes(file), `Value import cycle: ${[...ancestors, file].join(" -> ")}`);
    assert.notEqual(file, resolve(root, "dist/index.js"), "Admission values must not depend on the package entrypoint");
    if (visited.has(file)) return;
    const ast = parse(readFileSync(file, "utf8"), { sourceType: "module" });
    for (const node of ast.program.body) {
      if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && node.source?.value.startsWith(".")) {
        visit(resolve(dirname(file), node.source.value), [...ancestors, file]);
      }
    }
    visited.add(file);
  }
  visit(resolve(root, "dist", entry), []);
}

test("admission schema has an acyclic value graph independent of the package entrypoint", () => {
  assertIndependentGraph("admission-schema.js");
});

test("admission command has an acyclic value graph independent of the package entrypoint", () => {
  assertIndependentGraph("admission-command.js");
});

test("parser and endpoint extraction preserves the full public runtime and declaration export surface", () => {
  const expected = JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures/public-export-surface.json"), "utf8")) as { runtime: string[]; declarations: string[] };
  assert.deepEqual(Object.keys(api).sort(), expected.runtime);
  assert.equal(api.parseQuestionsDocument, parseQuestionsDocument);
  assert.equal(api.resolveJevEndpoint, resolveJevEndpoint);
  assert.equal(api.requireCallableEndpoint, requireCallableEndpoint);
  assert.equal(api.createJevClient, createJevClient);
  const ast = parse(readFileSync(resolve(root, "dist/index.d.ts"), "utf8"), { sourceType: "module", plugins: ["typescript"] });
  const declarations: string[] = [];
  for (const node of ast.program.body) {
    if (node.type === "ExportDefaultDeclaration") declarations.push("default");
    if (node.type !== "ExportNamedDeclaration") continue;
    const declaration = node.declaration;
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        assert.equal(item.id.type, "Identifier");
        if (item.id.type === "Identifier") declarations.push(item.id.name);
      }
    } else if (declaration && "id" in declaration && declaration.id?.type === "Identifier") declarations.push(declaration.id.name);
    for (const specifier of node.specifiers) {
      if (specifier.type === "ExportSpecifier") declarations.push(specifier.exported.type === "Identifier" ? specifier.exported.name : specifier.exported.value);
    }
  }
  assert.deepEqual(declarations.sort(), expected.declarations);
});
