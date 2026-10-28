import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { RelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import { decode } from "@toon-format/toon";
import { parse } from "@babel/parser";
import { isCallExpression, isIdentifier, isImportDeclaration, isImportSpecifier, isObjectExpression, isObjectMethod, isObjectProperty, isStringLiteral, traverseFast } from "@babel/types";
import { validateJointDecisions } from "../index.ts";
import type { JointReport } from "../index.ts";
import { project, trackerSnapshot, withoutGit } from "./fixtures.ts";
import { installBuiltExtension, runBuiltCommand } from "./replay-fixtures.ts";
import { REGISTRY_DEFINITIONS, installRegistryFixture, registryBatch } from "./joint-registry-fixtures.ts";

test("registry propagation: every production graph consumer uses host registry acquisition and explicit analysis options", () => {
  const root = new URL("../", import.meta.url);
  for (const directory of ["", "scripts/"]) for (const name of readdirSync(new URL(directory, root))) {
    if (!name.endsWith(".ts")) continue;
    const file = parse(readFileSync(new URL(directory + name, root), "utf8"), { sourceType: "module", plugins: ["typescript"] });
    const analyzers = new Set<string>();
    for (const statement of file.program.body) {
      if (!isImportDeclaration(statement)) continue;
      for (const element of statement.specifiers) {
        if (!isImportSpecifier(element)) continue;
        const imported = isIdentifier(element.imported) ? element.imported.name : element.imported.value;
        if (imported === "resolveWorkspaceRelationshipKindRegistry") assert.equal(statement.source.value, "@unbrained/pm-cli/sdk", `${directory}${name}: acquire active host registrations from the aggregate SDK`);
        if (imported === "analyzeRelationshipExecution") analyzers.add(element.local.name);
      }
    }
    /** Guard all execution-analysis calls, including future commands and aliased imports. */
    traverseFast(file, node => {
      if (isCallExpression(node) && isIdentifier(node.callee) && analyzers.has(node.callee.name)) {
        const options = node.arguments[1];
        assert.ok(isObjectExpression(options) && options.properties.some(property => (isObjectProperty(property) || isObjectMethod(property)) && ((isIdentifier(property.key) && property.key.name === "registry") || (isStringLiteral(property.key) && property.key.value === "registry"))), `${directory}${name}: execution analysis must explicitly retain its graph registry`);
      }
    });
  }
});

test("registry propagation: 500 seeded registry and batch permutations retain exact semantics with no Git or mutations", async () => {
  const f = await project();
  try { await withoutGit(f.cwd, async () => {
    const nodes: string[] = [];
    for (const title of ["First", "Second", "Third"]) nodes.push((await f.pm.create({ type: "Task", title, parent: "none", blockedBy: "none", goal: "none", objective: "none" })).item.id);
    const native = (await f.pm.listAllComplete({ includeBody: true })).items, bytes = trackerSnapshot(f.pmRoot);
    let seed = 0x65a17;
    /** Reproduce random registry names and orderings without sharing implementation logic. */
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let operation = 0; operation < 500; operation++) {
      const name = `custom_${random()}`, alias = `alias_${random()}`;
      const kind = random() % 3;
      const registry = new RelationshipKindRegistry().register({ ...REGISTRY_DEFINITIONS[kind], kind: name, aliases: [alias] });
      const reverse = (random() >>> 16) % 2 === 0;
      const edges = [{ source: nodes[0], target: nodes[1], kind: alias.toUpperCase() }];
      if (reverse) edges.push({ source: nodes[1], target: nodes[0], kind: name });
      const input = registryBatch(edges), original = JSON.stringify(input);
      const report = await validateJointDecisions(input, { client: f.pm, registry });
      assert.equal(report.ok, !reverse || kind === 2, `registry seed 0x65a17 operation ${operation}`);
      assert.deepEqual(report.violations.map(row => row.code), report.ok ? [] : ["relationship_ordering"]);
      assert.equal(report.mutations, 0); assert.equal(JSON.stringify(input), original);
      assert.deepEqual(await validateJointDecisions(JSON.parse(JSON.stringify(input)), { client: f.pm, registry }), report);
    }
    assert.deepEqual((await f.pm.listAllComplete({ includeBody: true })).items, native);
    assert.deepEqual(trackerSnapshot(f.pmRoot), bytes);
  }); } finally { f.dispose(); }
});

test("registry propagation: stored custom edges and host-contributed JSON/TOON use the same registry before and after", async () => {
  const f = await project();
  try {
    installRegistryFixture(f.pmRoot);
    const client = new PmClient({ cwd: f.cwd, pmRoot: f.pmRoot, author: "fixture" });
    const a = (await client.create({ type: "Task", title: "First", parent: "none", blockedBy: "none", goal: "none", objective: "none" })).item.id;
    const b = (await client.create({ type: "Task", title: "Second", parent: "none", blockedBy: "none", goal: "none", objective: "none" })).item.id;
    await client.update(a, { dep: [`id=${b},kind=fixture_precedes`], parent: "none", blockedBy: "none", goal: "none", objective: "none" });
    const registry = new RelationshipKindRegistry();
    for (const definition of REGISTRY_DEFINITIONS) registry.register(definition);
    const before = (await client.listAllComplete({ includeBody: true })).items;
    assert.equal(before.find(item => item.id === a)?.dependencies?.[0].kind, "fixture_precedes");
    await withoutGit(f.cwd, async () => {
      assert.equal((await validateJointDecisions(registryBatch([{ source: a, target: b, kind: "fixture_before_alias" }]), { client, registry })).ok, true);
      assert.equal((await validateJointDecisions(registryBatch([{ source: b, target: a, kind: "fixture_precedes" }]), { client, registry })).violations[0].code, "relationship_ordering");
      assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, before);
    });
    installBuiltExtension(f.pmRoot);
    const bytes = trackerSnapshot(f.pmRoot), file = join(f.cwd, "registry-batch.json");
    for (const [kind, ok] of [["fixture_precedes", false], ["fixture_after_alias", true], ["fixture_associates", true]] as const) {
      const input = registryBatch([{ source: b, target: a, kind }]); writeFileSync(file, JSON.stringify(input));
      const expected = await validateJointDecisions(input, { client, registry }); assert.equal(expected.ok, ok);
      for (const json of [true, false]) {
        const result = await runBuiltCommand(f, [...(json ? ["--json"] : []), "jev", "validate", "--batch", file]).catch(error => error as { code: number; stdout: string });
        const report = (json ? JSON.parse(result.stdout) : decode(result.stdout)) as JointReport;
        assert.equal(report.ok, expected.ok); assert.equal(report.mutations, 0);
        assert.equal(report.constraints, expected.constraints); assert.equal(report.relationship_additions, expected.relationship_additions);
        // The host's compact TOON renderer omits empty collections on successful reports.
        assert.deepEqual(report.violations ?? [], expected.violations);
        if (json) assert.deepEqual(report, expected);
      }
    }
    assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, before);
    assert.deepEqual(trackerSnapshot(f.pmRoot), bytes);
  } finally { f.dispose(); }
});
