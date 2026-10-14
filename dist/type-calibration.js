import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient, readSettings, resolveImplicitPmRoot, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";
import { buildTriageQuestions, createJevClient, KEEP_CURRENT_TYPE, projectTriageState, resolveTriageType, runDecision, TRIAGE_CATALOG_VERSION, TYPE_CHANGE_PROBABILITY, withCurrentType } from "./index.js";
import { deriveThreshold, localConfig, localModel } from "./calibration.js";
/** Redistributable, hand-labelled type examples; indices 0–2 fit, 3–5 evaluate. */
const EXAMPLES = {
    Issue: ["Login crashes after the update; previously it worked.", "Decide how to fix checkout: it charges customers twice instead of once.", "Export returns an exception instead of the requested file.", "Choose a repair for search: existing results disappear after sorting.", "The save button loses entered text, a regression from yesterday.", "Notifications stopped arriving although delivery previously worked."],
    Feature: ["Add a CSV export capability that does not exist yet.", "Allow customers to subscribe to alerts for the first time.", "Introduce dark mode as a new user-facing capability.", "Support a new payment method alongside the existing ones.", "Add offline access, which the product has never supported.", "Provide a new dashboard to compare monthly sales."],
    Task: ["Implement the approved wire protocol adapter as one concrete action.", "Write tests for the already specified sorting algorithm.", "Translate the approved button labels into Spanish.", "Configure the worker to use the agreed queue as an implementation step.", "Implement the parser described in the accepted specification.", "Verify the approved migration on a synthetic fixture."],
    Chore: ["Update development dependencies as routine maintenance.", "Remove unused imports during regular housekeeping.", "Refresh the dependency lockfile during maintenance.", "Reformat source files to match the existing style guide.", "Rotate the synthetic build cache as scheduled housekeeping.", "Update stale documentation links during routine maintenance."],
    Epic: ["Deliver the billing overhaul, grouping invoicing, refunds and subscription features.", "Modernize authentication across several features and teams.", "Build the reporting programme spanning dashboards, exports and alerts.", "Coordinate the accessibility initiative across navigation, forms and media.", "Deliver the international expansion objective through multiple localization features.", "Complete the platform modernization grouping database, API and deployment work."],
    Decision: ["Choose PostgreSQL or SQLite for the new service; both meet requirements.", "Approve or reject the proposed retention policy before implementation.", "Select one of two design directions; human judgment is required.", "Decide whether to fund option A or option B; no behavior is broken.", "Agree on the product launch date before scheduling implementation.", "Choose the licensing policy for a new component; record human approval."],
    Knowledge: ["Reference note: the queue preserves FIFO ordering within a partition; no work is requested.", "Documented finding: the tokenizer separates punctuation; keep this as reference knowledge.", "Reference explanation of the published retry protocol; no implementation action.", "Research finding: synthetic tests reveal an ordering invariant; retain the observation.", "Record how the checksum algorithm works for future reference.", "Reference glossary explaining the meaning of a delivery receipt."],
    Run: ["Execution record: the synthetic build completed successfully with all checks passing.", "Execution record: benchmark invocation finished; elapsed time was recorded.", "Completed test invocation receipt with counts and outcome, not future work.", "Execution record: a scheduled synthetic validation completed with two failures.", "Completed calibration invocation receipt with model digest and measured scores.", "Record of a finished deployment rehearsal with its outcome and evidence."],
};
/** Generate the fixed eight-type corpus without using any tracker content. */
export function typeDataset() {
    const types = Object.keys(EXAMPLES);
    return { version: "pm-jev-type-classification/1", customTypes: [
            { name: "Knowledge", folder: "knowledge", description: "Reference knowledge, explanations or research findings; no action is requested" },
            { name: "Run", folder: "runs", description: "A record of a completed execution with its outcome and evidence" },
        ], samples: types.flatMap(/** Generate six disjoint cases for each label. */ (expected, typeIndex) => EXAMPLES[expected].map(/** Make two deliberately misrouted cases per type. */ (text, i) => ({
            id: `${expected.toLowerCase()}-${i}`, expected, current: i % 3 === 2 ? types[(typeIndex + 1) % types.length] : expected,
            split: i < 3 ? "calibration" : "evaluation", text,
        }))) };
}
/** Count selective precision by predicted type and abstentions by ground-truth type. */
export function typeMetrics(rows, variant, marginThreshold) {
    const decisions = rows.map(/** Retain the baseline choice or apply the production policy. */ /** Retain the baseline choice or apply the production policy. */ row => ({ row, value: marginThreshold === null ? variant === "after" && row.after.choice === KEEP_CURRENT_TYPE ? row.current : row[variant].choice : resolveTriageType(row[variant], row.current, {}, marginThreshold).value }));
    const accepted = decisions.filter(/** Exclude explicit margin abstentions. */ /** Exclude explicit margin abstentions. */ entry => entry.value !== null);
    const correct = accepted.filter(/** Score against the hand-labelled semantic type. */ /** Score against the hand-labelled semantic type. */ entry => entry.value === entry.row.expected).length;
    return { count: rows.length, accepted: accepted.length, correct, precision: accepted.length ? correct / accepted.length : null,
        abstentionRate: rows.length ? 1 - accepted.length / rows.length : 0,
        perType: Object.fromEntries(Object.keys(EXAMPLES).map(/** Precision denominator is predictions, abstention denominator is labelled examples. */ /** Precision denominator is predictions, abstention denominator is labelled examples. */ type => {
            const predictions = accepted.filter(/** Select predictions of this type. */ /** Select predictions of this type. */ entry => entry.value === type);
            const labelled = decisions.filter(/** Select the ground-truth type. */ /** Select the ground-truth type. */ entry => entry.row.expected === type);
            return [type, { support: labelled.length, predicted: predictions.length,
                    precision: predictions.length ? predictions.filter(/** Count true positives for this label. */ /** Count true positives for this label. */ entry => entry.row.expected === type).length / predictions.length : null,
                    abstentionRate: labelled.length ? labelled.filter(/** Count labelled items receiving no type proposal. */ /** Count labelled items receiving no type proposal. */ entry => entry.value === null).length / labelled.length : 0 }];
        })) };
}
/** Fit only calibration rows, using the margin and the production keep-current rule. */
export function fitTypeMargin(rows, targetPrecision = 0.95) {
    const fit = deriveThreshold(rows.filter(/** Freeze the threshold before looking at evaluation labels. */ /** Freeze the threshold before looking at evaluation labels. */ row => row.split === "calibration").map(/** Map margins to the existing empirical cutoff fitter. */ /** Map margins to the existing empirical cutoff fitter. */ row => {
        const decision = resolveTriageType(row.after, row.current, {}, 0);
        return { confidence: decision.margin, correct: decision.value === row.expected };
    }), targetPrecision, 4);
    // A positive observed cutoff enforces tie abstention without an invented epsilon.
    return { ...fit, threshold: fit.curve.find(/** Pick the lowest supported positive margin reaching the empirical target. */ /** Pick the lowest supported positive margin reaching the empirical target. */ point => point.threshold > 0 && point.accepted >= fit.minAccepted && Number(point.precision) >= targetPrecision)?.threshold ?? null };
}
/** Measure old and new prompts on real scratch items with all built-ins and two registered custom types. */
export async function calibrateTypes(baseUrl, model, targetPrecision = 0.95) {
    const config = localConfig(baseUrl, model);
    const digest = await localModel(config);
    const client = createJevClient({ config, hostedBlocked: null }, {});
    const dataset = typeDataset();
    const scratch = mkdtempSync(join(tmpdir(), "jev-type-calibration-"));
    const pmRoot = resolveImplicitPmRoot(scratch);
    const pm = new PmClient({ cwd: scratch, pmRoot, noExtensions: true, author: "calibration" });
    const observations = [];
    const started = Date.now();
    let inputTokens = 0, outputTokens = 0;
    const resolvedModels = new Set();
    try {
        await pm.init("synthetic", { defaults: true, agentGuidance: "skip" });
        for (const definition of dataset.customTypes)
            await pm.schemaAddType(definition.name, definition);
        const settings = await readSettings(pmRoot);
        const questions = buildTriageQuestions(settings);
        const definitions = questions.type.criteria;
        const registry = resolveItemTypeRegistry(settings);
        const oldCriteria = Object.fromEntries(registry.types.map(/** Reproduce catalog v1 exactly, including semantic built-in fallbacks. */ /** Reproduce catalog v1 exactly, including semantic built-in fallbacks. */ name => [name, definitions[name]]));
        for (const sample of dataset.samples) {
            const created = await pm.create({ type: sample.current, title: sample.text, priority: 2 });
            const state = projectTriageState(created.item);
            const before = await runDecision(client, config, state, { ...questions, type: { type: "choice", instructions: "Which kind of work is this item? Choose the item type that best matches it.", criteria: oldCriteria } });
            const after = await runDecision(client, config, state, withCurrentType(questions, sample.current));
            observations.push({ ...sample, before: before.answers.type, after: after.answers.type });
            for (const result of [before, after]) {
                inputTokens += result.usage.input_tokens;
                outputTokens += result.usage.output_tokens;
                resolvedModels.add(result.model);
            }
        }
        if (await localModel(config) !== digest)
            throw new Error("Local model changed during type calibration");
        const fit = fitTypeMargin(observations, targetPrecision);
        if (fit.threshold === null)
            throw new Error("No type margin meets the declared empirical precision target");
        const evaluation = observations.filter(/** Evaluate only disjoint held-out examples. */ /** Evaluate only disjoint held-out examples. */ row => row.split === "evaluation");
        return { schemaVersion: "pm-jev-type-report/1", catalogVersion: TRIAGE_CATALOG_VERSION,
            policy: { keepCurrentLabel: KEEP_CURRENT_TYPE, typeChangeProbability: TYPE_CHANGE_PROBABILITY, marginComparison: "strictly below" }, family: "type_classification", dataset,
            datasetSha256: createHash("sha256").update(JSON.stringify(dataset)).digest("hex"), model, modelDigest: digest,
            resolvedModels: [...resolvedModels], recordedAt: new Date().toISOString(), durationMs: Date.now() - started,
            usage: { inputTokens, outputTokens }, registeredTypes: registry.types, definitions, fit,
            before: typeMetrics(evaluation, "before", null), newPrompt: typeMetrics(evaluation, "after", null),
            after: typeMetrics(evaluation, "after", fit.threshold), observations };
    }
    finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}
//# sourceMappingURL=type-calibration.js.map