import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { RelationshipGraph, assertRelationshipEdgeAllowed, assertHierarchyMutationAllowed, assertNonHierarchyCardinalityMutationAllowed, analyzeRelationshipExecution, resolveWorkspaceRelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import { acceptsThreshold } from "./threshold.js";
import { JOINT_VERSION, JOINT_LIMITS, parseJointInput, JointRefusal } from "./joint-schema.js";
/** Retain the selected model answer exactly, including fractional scores and noul probabilities. */
function observed(input, p) {
    const a = input.result.answers[p.question];
    if (a.type === "choice")
        return a.choice;
    if (a.type === "score")
        return a.score;
    return a.noul;
}
/** Noul predicates require their own inclusive exact cutoff; no hidden decision defaults. */
function matches(input, p) {
    const answer = observed(input, p);
    return typeof p.value === "boolean" ? acceptsThreshold(answer, p.threshold) === p.value : answer === p.value;
}
/** Report raw observations rather than rewriting answers to satisfy constraints. */
function witness(input, p) {
    return { question: p.question, answer: observed(input, p), expected: p.value, ...(p.threshold === undefined ? {} : { threshold: p.threshold }) };
}
/** Check prospective additions through the same public host integrity primitives used by mutations. */
function graphConflict(items, additions, registry) {
    const nodes = items.map(/** Explicit identifiers are resolved by the host graph normalizer. */ /** Explicit identifiers are resolved by the host graph normalizer. */ item => item.id);
    let edges;
    try {
        for (const edge of additions)
            assertRelationshipEdgeAllowed(edge.source, edge.target, edge.kind, registry);
        edges = new RelationshipGraph(nodes, additions, registry).edges();
    }
    catch {
        return "relationship_edge";
    }
    const after = items.map(/** Preserve every native field while adding only declared relationships in memory. */ /** Preserve every native field while adding only declared relationships in memory. */ item => ({ ...item, dependencies: [...(item.dependencies ?? []), ...edges.filter(/** Match host-normalized source ids. */ /** Match host-normalized source ids. */ edge => edge.source === item.id).map(/** Use canonical host kinds and endpoints. */ /** Use canonical host kinds and endpoints. */ edge => ({ id: edge.target, kind: edge.kind }))] }));
    try {
        // Semantic preflight checks structural integrity for every lifecycle state, without classifying statuses.
        for (const source of new Set(edges.map(/** Check each changed holder against the same complete batch. */ /** Check each changed holder against the same complete batch. */ edge => edge.source)))
            assertHierarchyMutationAllowed(items, after, source, /** Integrity is required regardless of lifecycle role. */ () => false, registry);
    }
    catch {
        return "relationship_hierarchy";
    }
    try {
        assertNonHierarchyCardinalityMutationAllowed(items, after, registry);
    }
    catch {
        return "relationship_cardinality";
    }
    const beforeCycles = new Set(analyzeRelationshipExecution(RelationshipGraph.fromItems(items, registry)).cycles.map(/** Existing graph debt remains readable. */ /** Existing graph debt remains readable. */ cycle => JSON.stringify(cycle)));
    const newCycles = analyzeRelationshipExecution(RelationshipGraph.fromItems(after, registry)).cycles;
    return newCycles.some(/** Reject only introduced ordering components. */ /** Reject only introduced ordering components. */ cycle => !beforeCycles.has(JSON.stringify(cycle))) ? "relationship_ordering" : null;
}
/** Check every emitted numeric domain even when a future producer changes report construction. */
export function validateJointReportNumbers(report) {
    const counts = [[report.questions, 1, JOINT_LIMITS.questions], [report.constraints, 1, JOINT_LIMITS.constraints], [report.relationship_additions, 0, JOINT_LIMITS.constraints], [report.mutations, 0, 0], [report.inference_calls, 0, 0], [report.exit_code ?? 1, 1, 1]];
    const validCounts = counts.every(/** Counts are bounded safe integers. */ ([n, low, high]) => Number.isSafeInteger(n) && n >= low && n <= high);
    const validAnswers = report.violations.every(/** Witness displays stay within the declared question and cutoff domains. */ /** Witness displays stay within the declared question and cutoff domains. */ violation => violation.witness.every(/** Non-numeric selections retain their exact strings or booleans. */ /** Non-numeric selections retain their exact strings or booleans. */ row => {
        const values = [[row.answer, 31], [row.expected, 31], [row.threshold, 1]];
        return values.every(/** Every numeric output must be finite and in range. */ ([value, high]) => typeof value !== "number" || (Number.isFinite(value) && value >= 0 && value <= high));
    }));
    if (!validCounts || !validAnswers)
        throw new JointRefusal("invalid_report", "Discard this report and report a package defect; no mutation has occurred. Retry with the supported question and constraint bounds.");
}
/** Validate one immutable selected batch; no model calls, apply, journal, imports or tracker writes. */
export async function validateJointDecisions(raw, context) {
    const input = parseJointInput(raw);
    const violations = [];
    const relationships = [];
    for (const c of input.constraints) {
        if (c.kind === "relationship") {
            if (matches(input, c.when))
                relationships.push(c);
            continue;
        }
        const conflict = c.kind === "exclusive" ? c.answers.filter(/** Inspect actual selected values, never confidence or a replacement winner. */ /** Inspect actual selected values, never confidence or a replacement winner. */ p => matches(input, p)).slice(0, 2) : [c.if, c.then];
        if (c.kind === "exclusive" ? conflict.length === 2 : matches(input, c.if) && !matches(input, c.then)) {
            violations.push({ constraints: [c.id], code: c.kind, witness: conflict.map(/** Include both the trigger and the incompatible observed consequence. */ /** Include both the trigger and the incompatible observed consequence. */ p => witness(input, p)), remedy: "Revise the proposals or the declared constraint explicitly, then validate the whole batch again before apply." });
        }
    }
    if (relationships.length > 0) {
        if (!context)
            throw new JointRefusal("host_required", "Supply a tracker-bound SDK client to validate selected relationship additions; the CLI uses the current tracker.");
        let items;
        try {
            items = certifyCompleteListResult(await context.client.listAllComplete()).items;
        }
        catch {
            throw new JointRefusal("host_read_failed", "Restore a complete SDK read of the target tracker and retry; no relationship validation or writes were performed.");
        }
        const registry = context.registry ?? resolveWorkspaceRelationshipKindRegistry();
        const code = graphConflict(items, relationships.map(/** Add all selected edges together so cross-answer cycles and cardinality conflicts are visible. */ /** Add all selected edges together so cross-answer cycles and cardinality conflicts are visible. */ c => ({ source: c.source, target: c.target, kind: c.relationship })), registry);
        if (code !== null)
            violations.push({ constraints: relationships.map(/** Associate the host refusal with every selected relationship declaration. */ /** Associate the host refusal with every selected relationship declaration. */ c => c.id), code, witness: relationships.map(/** Keep the unchanged triggering answers in the graph witness. */ /** Keep the unchanged triggering answers in the graph witness. */ c => witness(input, c.when)), remedy: "Inspect these relationship declarations against the current host graph; revise missing endpoints, kinds, hierarchy, cardinality or ordering, then revalidate before apply." });
    }
    const report = { version: JOINT_VERSION, ok: violations.length === 0, ...(violations.length === 0 ? {} : { exit_code: 1 }), questions: Object.keys(input.questions).length, constraints: input.constraints.length, relationship_additions: relationships.length, violations, mutations: 0, inference_calls: 0, mutation_authority: "none" };
    validateJointReportNumbers(report);
    return report;
}
//# sourceMappingURL=joint-decisions.js.map