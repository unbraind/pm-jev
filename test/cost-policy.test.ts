import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { COST_POLICY_VERSION, CostPolicyRefusal, parseCostDataset, selectAbstentionPolicy, abstainWithPolicy } from "../index.ts";
import type { CostDataset, CostObservation, DecisionCosts, AbstentionPolicy, CostPolicyReport } from "../index.ts";
import { project, trackerSnapshot } from "./fixtures.ts";
import { runCostPolicyCommand } from "../cost-policy-command.ts";

const costs: DecisionCosts = { false_duplicate: 20, wrong_type: 10, missed_candidate: 1 };
/** Labelled scores contain retrieval misses, costly mistakes, correct types and negative duplicates. */
function dataset(): CostDataset {
  const rows: CostObservation[] = [
    { id: "d1", group: "selection-repo", split: "selection", task: "duplicate", label: true, confidence: 0.95, eligible: true },
    { id: "d2", group: "selection-repo", split: "selection", task: "duplicate", label: false, confidence: 0.8, eligible: true },
    { id: "d3", group: "selection-repo", split: "selection", task: "duplicate", label: true, confidence: 1, eligible: false },
    { id: "t1", group: "selection-repo", split: "selection", task: "type", label: "Issue", predicted: "Task", confidence: 0.8, eligible: true },
    { id: "t2", group: "selection-repo", split: "selection", task: "type", label: "Issue", predicted: "Issue", confidence: 0.95, eligible: true },
  ];
  return { version: COST_POLICY_VERSION, provenance: "synthetic", observations: [...rows, ...rows.map(row => ({ ...row, id: `h-${row.id}`, group: "heldout-repo", split: "heldout" as const }))] };
}
/** Assert stable refusal code and useful remedy for an untrusted boundary. */
function refuses(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof CostPolicyRefusal);
    assert.equal(error.code, code);
    assert.equal(error.name, "CostPolicyRefusal");
    assert.ok(error.remedy.length > 20);
    return true;
  });
}

test("cost selection charges mistakes and misses once, includes retrieval misses and responds to caller costs", () => {
  const data = dataset();
  const before = JSON.stringify(data);
  const report = selectAbstentionPolicy(data, costs);
  assert.equal(report.policy.threshold, 0.95);
  assert.equal(report.curve.length, 22);
  assert.deepEqual(report.selected.heldout, { count: 5, proposed: 2, false_duplicates: 0, wrong_types: 0, missed_candidates: 2, coverage: 0.4, cost: 2, cost_per_example: 0.4 });
  const all = report.curve.find(point => point.threshold === 0)!;
  assert.deepEqual(all.selection, { count: 5, proposed: 4, false_duplicates: 1, wrong_types: 1, missed_candidates: 1, coverage: 0.8, cost: 31, cost_per_example: 6.2 });
  assert.equal(report.curve[0].heldout.cost, 4);
  assert.equal(report.curve[0].threshold, null);
  const cheapMistakes = selectAbstentionPolicy(data, { false_duplicate: 0.1, wrong_type: 0.1, missed_candidate: 20 });
  assert.equal(cheapMistakes.policy.threshold, 0.8);
  assert.equal(cheapMistakes.selected.heldout.cost, 20.2);
  assert.equal(JSON.stringify(data), before, "labels, eligibility and scores remain immutable");
  assert.deepEqual(selectAbstentionPolicy({ ...data, observations: [...data.observations].reverse() }, { missed_candidate: 1, wrong_type: 10, false_duplicate: 20 }), report);
  const reordered = data.observations.map(row => Object.fromEntries(Object.entries(row).reverse()) as CostObservation);
  assert.deepEqual(selectAbstentionPolicy({ ...data, observations: reordered }, costs), report);
  const adversarial = { ...data, observations: data.observations.map(row => row.split === "selection" ? row : { ...row, confidence: 1, label: row.task === "duplicate" ? !row.label : "Other" } as CostObservation) };
  const changed = selectAbstentionPolicy(adversarial, costs);
  assert.deepEqual(changed.policy, report.policy, "held-out outcomes and scores cannot select or move thresholds");
  assert.notEqual(changed.evidence_sha256, report.evidence_sha256);
  assert.notDeepEqual(changed.selected.heldout, report.selected.heldout);
  for (const provenance of ["public", "local-unverified"] as const) assert.equal(selectAbstentionPolicy({ ...data, provenance }, costs).provenance, provenance);
});

test("selection deterministically prefers fewer errors, then coverage, then stricter boundaries, with explicit disable", () => {
  const data = dataset();
  const base = data.observations[0];
  assert.equal(base.task, "duplicate");
  if (base.task !== "duplicate") throw new Error("Expected duplicate fixture");
  const rows: CostObservation[] = [
    { ...base, id: "s1", confidence: 0.8, label: true },
    { ...base, id: "s2", confidence: 0.8, label: false },
    { ...base, id: "h1", group: "heldout", split: "heldout", confidence: 0.8, label: true },
  ];
  const sample = { ...data, observations: rows };
  assert.equal(selectAbstentionPolicy(sample, { false_duplicate: 1, wrong_type: 1, missed_candidate: 1 }).policy.threshold, null, "equal cost prefers no false proposals");
  assert.equal(selectAbstentionPolicy({ ...sample, observations: rows.filter(row => row.id !== "s2") }, costs).policy.threshold, 0.8);
  assert.equal(selectAbstentionPolicy(sample, { false_duplicate: 0, wrong_type: 1, missed_candidate: 0 }).policy.threshold, null, "zero-cost mistakes still lose the error-count tie");
  assert.equal(selectAbstentionPolicy({ ...sample, observations: rows.map(row => ({ ...row, eligible: false })) }, costs).policy.threshold, null);
  assert.equal(selectAbstentionPolicy({ ...sample, observations: rows.map(row => ({ ...row, task: "duplicate", label: true, confidence: 1 })) }, costs).policy.threshold, 1);
  assert.equal(selectAbstentionPolicy({ ...sample, observations: rows.map(row => ({ ...row, task: "duplicate", label: true, confidence: 0 })) }, costs).policy.threshold, 0);
});

test("untrusted dataset refuses malformed values and cross-split group leakage before selection", () => {
  for (const raw of [null, undefined, {}, { ...dataset(), version: "old" }, { ...dataset(), provenance: "private" }, { ...dataset(), observations: null }, { ...dataset(), observations: Array(5001).fill(null) }]) refuses(() => parseCostDataset(raw), "invalid_dataset");
  const base = dataset().observations[0];
  const invalidRows = [null, { ...base, id: 1 }, { ...base, id: "" }, { ...base, id: "x".repeat(257) }, { ...base, group: 1 }, { ...base, group: "" }, { ...base, group: "x".repeat(257) },
    { ...base, split: "training" }, { ...base, confidence: "0.9" }, { ...base, confidence: NaN }, { ...base, confidence: -1 }, { ...base, confidence: 1.1 }, { ...base, eligible: 1 }, { ...base, task: "link" }, { ...base, label: "true" },
    ...[null, "", "x".repeat(257)].flatMap(value => [{ ...base, task: "type", label: value, predicted: "Task" }, { ...base, task: "type", label: "Issue", predicted: value }])];
  for (const row of invalidRows) refuses(() => parseCostDataset({ ...dataset(), observations: [row] }), "invalid_dataset");
  refuses(() => parseCostDataset({ ...dataset(), observations: [base, base] }), "invalid_dataset");
  refuses(() => parseCostDataset({ ...dataset(), observations: [] }), "insufficient_evidence");
  refuses(() => parseCostDataset({ ...dataset(), observations: [base] }), "insufficient_evidence");
  refuses(() => parseCostDataset({ ...dataset(), observations: [base, { ...base, id: "h", split: "heldout" }] }), "split_overlap");
  for (const value of [undefined, NaN, Infinity, -1, 1000001, "1"]) for (const key of Object.keys(costs)) {
    refuses(() => selectAbstentionPolicy(dataset(), { ...costs, [key]: value } as DecisionCosts), "invalid_costs");
  }
  refuses(() => selectAbstentionPolicy(dataset(), null as unknown as DecisionCosts), "invalid_costs");
  refuses(() => selectAbstentionPolicy(dataset(), { false_duplicate: 0, wrong_type: 0, missed_candidate: 0 }), "invalid_costs");
  assert.equal(selectAbstentionPolicy(dataset(), { ...costs, false_duplicate: 1e6 }).ok, true);
});

test("policy filter cannot weaken mandatory mutation checks, retrieval eligibility or disabled cutoffs", () => {
  const policy = selectAbstentionPolicy(dataset(), costs).policy;
  assert.deepEqual(abstainWithPolicy(policy, 1, true, false), { propose: false, reason: "mandatory_checks_failed" });
  assert.deepEqual(abstainWithPolicy(policy, 1, false, true), { propose: false, reason: "ineligible" });
  assert.deepEqual(abstainWithPolicy(policy, 0.94, true, true), { propose: false, reason: "abstained" });
  assert.deepEqual(abstainWithPolicy(policy, 0.95, true, true), { propose: true, reason: "proposal_only" });
  assert.equal(abstainWithPolicy({ ...policy, threshold: null }, 1, true, true).propose, false);
  for (const raw of [null, { ...policy, version: "old" }, { ...policy, mutation_authority: "write" }, ...[undefined, "0.9", NaN, Infinity, -1, 2].map(threshold => ({ ...policy, threshold }))]) refuses(() => abstainWithPolicy(raw as AbstentionPolicy, 1, true, true), "invalid_policy");
  for (const confidence of [NaN, -1, 2]) refuses(() => abstainWithPolicy(policy, confidence, true, true), "invalid_policy");
  refuses(() => abstainWithPolicy(policy, 1, undefined as unknown as boolean, true), "invalid_policy");
  refuses(() => abstainWithPolicy(policy, 1, true, undefined as unknown as boolean), "invalid_policy");
});

test("public fixed-score receipt reproduces all cost curves without refitting models or labels", () => {
  const frozen = JSON.parse(readFileSync(new URL("../calibration/duplicate-quality-report-v3.json", import.meta.url), "utf8")) as {
    samples: { pair_id: string; repository: string; split: string; label: boolean; retrieved: boolean }[];
    observations: { pair_id: string; probability: number }[];
  };
  const saved = JSON.parse(readFileSync(new URL("../calibration/cost-policy-report-v1.json", import.meta.url), "utf8")) as { results: CostPolicyReport[] };
  const observations: CostObservation[] = [];
  for (const [index, sample] of frozen.samples.entries()) {
    assert.equal(frozen.observations[index].pair_id, sample.pair_id);
    observations.push({ task: "duplicate", id: sample.pair_id, group: sample.repository, label: sample.label,
      eligible: sample.retrieved, confidence: frozen.observations[index].probability, split: sample.split === "train" ? "selection" : "heldout" });
  }
  for (const result of saved.results) assert.deepEqual(selectAbstentionPolicy({ version: COST_POLICY_VERSION, provenance: "public", observations }, result.costs), result);
  const synthetic = parseCostDataset(JSON.parse(readFileSync(new URL("../examples/cost-policy.json", import.meta.url), "utf8")));
  const report = selectAbstentionPolicy(synthetic, costs);
  assert.equal(report.policy.threshold, 0.95);
  assert.equal(report.selected.heldout.cost, 1);
  assert.equal(report.selected.heldout.coverage, 0.5);
});

test("registered policy CLI reads real plain tracker inputs with no git or provider and emits compact JSON/TOON with typed refusals", async () => {
  const fixture = await project();
  const scratch = mkdtempSync(join(tmpdir(), "jev-policy-"));
  const file = join(scratch, "scores.json");
  const previousPath = process.env.PATH;
  const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    const item = await fixture.pm.create({ type: "Issue", title: "Synthetic labelled issue" });
    assert.equal(item.item.type, "Issue");
    const before = trackerSnapshot(fixture.pmRoot);
    writeFileSync(file, JSON.stringify(dataset()));
    process.env.PATH = scratch;
    process.env.GIT_CEILING_DIRECTORIES = dirname(fixture.cwd);
    const invoke = (options: Record<string, unknown>, json = true) => fixture.harness.runCommand({ command: "jev policy", pmRoot: fixture.pmRoot, global: { json }, options });
    const options = { observations: file, falseDuplicateCost: "20", wrongTypeCost: "10", missedCandidateCost: "1" };
    const unexpected = Object.defineProperty({}, "observations", { get() { throw new Error("unexpected boundary failure"); } });
    await assert.rejects(runCostPolicyCommand({ command: "jev policy", pm_root: fixture.pmRoot, source_workspace_root: fixture.cwd, args: [], global: { json: true }, options: unexpected }), /unexpected boundary failure/);
    for (const json of [true, false]) {
      const result = await invoke(options, json);
      const report = result.result as CostPolicyReport;
      assert.equal(report.ok, true);
      assert.equal(report.policy.threshold, 0.95);
      assert.equal(report.curve.length, 22);
      assert.ok(JSON.stringify(result.result).length < 5000);
      assert.ok(!JSON.stringify(result.result).includes(scratch));
      assert.equal("selection" in report.curve[0], false);
    }
    const full = await invoke({ ...options, full: true });
    assert.deepEqual(full.result, selectAbstentionPolicy(dataset(), costs));
    for (const spelling of ["snake", "hyphen"]) {
      const keys = spelling === "snake" ? ["false_duplicate_cost", "wrong_type_cost", "missed_candidate_cost"] : ["false-duplicate-cost", "wrong-type-cost", "missed-candidate-cost"];
      const aliased = await invoke({ observations: file, [keys[0]]: "20", [keys[1]]: "10", [keys[2]]: "1" });
      assert.equal((aliased.result as CostPolicyReport).policy.threshold, 0.95);
    }
    for (const overrides of [{ observations: undefined }, { observations: "" }, { observations: scratch }, { observations: join(scratch, "missing") }, { falseDuplicateCost: " " }, { falseDuplicateCost: undefined }, { wrongTypeCost: undefined }, { missedCandidateCost: undefined }]) {
      const result = await invoke({ ...options, ...overrides });
      const refusal = result.result as { ok: boolean; refusal: { code: string; remedy: string } };
      assert.equal(refusal.ok, false);
      assert.equal(result.exitCode, 2);
      assert.ok(refusal.refusal.remedy.length > 20);
    }
    for (const invalid of ["not json", JSON.stringify({}), " ".repeat(2 * 1024 * 1024 + 1)]) {
      writeFileSync(file, invalid);
      const result = await invoke(options);
      assert.equal(result.exitCode, 2);
      assert.equal((result.result as { ok: boolean }).ok, false);
    }
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    fixture.dispose(); rmSync(scratch, { recursive: true, force: true });
  }
});

test("built extension runs through the real host parser and preserves refusal exit codes without git", async () => {
  const fixture = await project();
  try {
    const directory = join(fixture.pmRoot, "extensions", "pm-jev");
    mkdirSync(directory, { recursive: true });
    cpSync(new URL("../dist", import.meta.url), join(directory, "dist"), { recursive: true });
    cpSync(new URL("../manifest.json", import.meta.url), join(directory, "manifest.json"));
    writeFileSync(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    symlinkSync(resolve("node_modules"), join(directory, "node_modules"));
    const before = trackerSnapshot(fixture.pmRoot);
    const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
    const base = [cli, "--pm-path", fixture.pmRoot, "jev", "policy", "--observations", resolve("examples/cost-policy.json"), "--false-duplicate-cost", "20", "--wrong-type-cost", "10", "--missed-candidate-cost", "1"];
    const env = { ...process.env, PATH: "", PM_PATH: fixture.pmRoot, PM_GLOBAL_PATH: join(fixture.cwd, "global"), GIT_CEILING_DIRECTORIES: dirname(fixture.cwd) };
    const json = spawnSync(process.execPath, [...base, "--json"], { cwd: fixture.cwd, env, encoding: "utf8", timeout: 60000 });
    assert.equal(json.status, 0, json.stderr);
    assert.equal((JSON.parse(json.stdout) as CostPolicyReport).policy.threshold, 0.95);
    const toon = spawnSync(process.execPath, base, { cwd: fixture.cwd, env, encoding: "utf8", timeout: 60000 });
    assert.equal(toon.status, 0, toon.stderr);
    assert.match(toon.stdout, /threshold: 0.95/);
    assert.match(toon.stdout, /heldout_cost/);
    const invalid = [...base];
    invalid[invalid.indexOf("--false-duplicate-cost") + 1] = "-1";
    const refused = spawnSync(process.execPath, [...invalid, "--json"], { cwd: fixture.cwd, env, encoding: "utf8", timeout: 60000 });
    assert.equal(refused.status, 2, refused.stderr);
    assert.equal((JSON.parse(refused.stdout) as { refusal: { code: string } }).refusal.code, "invalid_costs");
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
  } finally { fixture.dispose(); }
});
