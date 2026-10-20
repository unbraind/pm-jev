import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createPmCliExpectedError, getSettingsPath, listAllComplete, readFileIfExists, readSettings } from "@unbrained/pm-cli/sdk";
import { certifyCompleteListResult } from "@unbrained/pm-cli/sdk/runtime";
import { RelationshipGraph, resolveWorkspaceRelationshipKindRegistry } from "@unbrained/pm-cli/sdk/graph";
import { buildClassificationQuestions, buildLinkQuestion, buildDedupeRequest, projectTriageState, rankDedupeCandidates, existingLinkKinds } from "./index.js";
import { evidenceHash } from "./decision-calibration.js";
import { ghInspectionFailure, LOCAL_SOURCE_GUIDANCE, sourceFailureDetail } from "./source-diagnostics.js";
import { assertPublicProvenance } from "./source-provenance.js";
/** Run bounded external inspection tools without a shell or credential-bearing output. */
export function inspectSource(command, args, cwd, input) {
    try {
        return execFileSync(command, args, { cwd, input, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] });
    }
    catch (error) {
        const failure = error;
        if (command !== "gh")
            throw createPmCliExpectedError(`Public tracker inspection failed. ${sourceFailureDetail([command, ...args].join(" "), failure.code, failure.status, failure.stderr?.toString() ?? "")}. ${LOCAL_SOURCE_GUIDANCE}`);
        throw ghInspectionFailure(args[2] ?? "requested repository", failure.code, failure.status, failure.stderr?.toString() ?? "");
    }
}
/** Verify a fleet clone's public identity before touching tracker contents; private repos are skipped. */
export async function readPublicCorpus(from, inspect = inspectSource) {
    const root = await realpath(from);
    const repo = resolve(root, "../..");
    const name = basename(repo);
    if (basename(root) !== "pm" || basename(dirname(root)) !== ".agents" || basename(dirname(repo)) !== "fleet" ||
        !/^pm-[a-z0-9-]+$/.test(name) || ["pm-cli", "pm-cli-companion"].includes(name))
        throw createPmCliExpectedError(`Sources must be public package trackers in fleet clones. ${LOCAL_SOURCE_GUIDANCE} Its results cannot enter public corpora or artifacts.`);
    const origin = inspect("git", ["remote", "get-url", "origin"], repo).toString().trim();
    if (![`https://github.com/unbraind/${name}.git`, `https://github.com/unbraind/${name}`, `git@github.com:unbraind/${name}.git`].includes(origin))
        throw createPmCliExpectedError(`Source origin must match its public fleet repository. ${LOCAL_SOURCE_GUIDANCE}`);
    const repository = `unbraind/${name}`;
    const visibility = JSON.parse(inspect("gh", ["repo", "view", repository, "--json", "visibility"], repo).toString());
    if (visibility.visibility === "PRIVATE")
        return null;
    if (visibility.visibility !== "PUBLIC")
        throw createPmCliExpectedError(`Source public visibility could not be verified. ${LOCAL_SOURCE_GUIDANCE}`);
    const commit = inspect("git", ["rev-parse", "HEAD"], repo).toString().trim();
    const tree = inspect("git", ["ls-tree", "-r", commit, "--", ".agents/pm"], repo).toString();
    if (!tree || tree.split("\n").some(/** Refuse links before extracting an untrusted tree. */ /** Refuse links before extracting an untrusted tree. */ line => /^(120000|160000) /.test(line)))
        throw new Error("Tracker snapshot must contain regular committed files only");
    const archive = inspect("git", ["archive", "--format=tar", commit, ".agents/pm"], repo);
    const scratch = await mkdtemp(join(tmpdir(), "jev-corpus-"));
    try {
        inspect("tar", ["-xf", "-", "-C", scratch], repo, archive);
        const pmRoot = join(scratch, ".agents/pm");
        assertPublicProvenance(JSON.parse((await readFileIfExists(getSettingsPath(pmRoot))) ?? "{}"));
        const result = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot, cwd: scratch, noExtensions: true }));
        return { repository, commit, data_sha256: evidenceHash(archive.toString("base64")), settings: await readSettings(pmRoot), items: result.items };
    }
    finally {
        await rm(scratch, { recursive: true, force: true });
    }
}
/** Read an explicitly opted-in local tracker directly; never discover repositories or launch external tools. */
export async function readLocalCorpus(from) {
    const pmRoot = await realpath(from);
    const result = certifyCompleteListResult(await listAllComplete({ includeBody: true }, { pmRoot, cwd: pmRoot, noExtensions: true }));
    const settings = await readSettings(pmRoot);
    const items = result.items.sort(/** Stabilize evidence independently of filesystem enumeration. */ (a, b) => a.id.localeCompare(b.id));
    return { provenance: "local-unverified", repository: `local-unverified/${evidenceHash(pmRoot)}`, commit: "unverified",
        data_sha256: evidenceHash({ settings, items }), settings, items };
}
/** Remove routing fields and bound semantic text identically for evaluation and calibrated inference. */
export function semanticState(item) {
    return projectTriageState(item);
}
/** Recover explicit known-duplicate targets, never infer truth from title similarity. */
export function duplicateTarget(item) {
    const fields = item;
    const explicit = fields.duplicate_of ?? item.type_options?.duplicate_of ?? item.type_options?.duplicateOf;
    if (explicit)
        return explicit;
    if (item.status !== "closed" && item.status !== "canceled")
        return undefined;
    return /\bduplicate(?:\s+of|_of|:)\s*[`"']?([a-z0-9]+(?:-[a-z0-9]+)+)/i.exec(`${item.close_reason ?? ""} ${item.resolution ?? ""}`)?.[1];
}
/** Build a content-hashed labelled decision without sending labels or source metadata. */
function example(corpus, state, questions, labels) {
    return { provenance: corpus.provenance, repository: corpus.repository, commit: corpus.commit, data_sha256: corpus.data_sha256,
        example_sha256: evidenceHash([corpus.repository, corpus.commit, state, questions, labels]), state, questions, labels };
}
/** Build labels from tracker types/priorities, canonical edges and explicit duplicate resolutions. */
export function buildExamples(corpus, task) {
    const built = buildUnits(corpus, task);
    return { examples: built.units.map(/** The hashed benchmark example of each labelled unit. */ /** The hashed benchmark example of each labelled unit. */ unit => unit.example), retrieval_misses: built.retrieval_misses };
}
/** Primary and supporting exemplar text of one projected triage state. */
function triageText(state) {
    return { title: state.title, body: [state.description, state.body].filter(/** Keep only the semantic text the model itself sees. */ Boolean).join("\n") };
}
/** Primary and supporting exemplar text of one projected source/candidate pair. */
function pairText(source, candidate) {
    return { title: `${source.title} → ${candidate.title}`,
        body: [source.description, source.body, candidate.description, candidate.body].filter(/** Keep only the semantic text the model itself sees. */ Boolean).join("\n") };
}
/** Construct labelled units with identical example hashes to the legacy builder. */
export function buildUnits(corpus, task) {
    const items = [...corpus.items].sort(/** Make SDK enumeration order irrelevant. */ (a, b) => a.id.localeCompare(b.id));
    if (task === "triage") {
        const questions = buildClassificationQuestions(corpus.settings);
        return { units: items.map(/** Ground truth is excluded from the semantic state and question wording. */ /** Ground truth is excluded from the semantic state and question wording. */ item => {
                const state = semanticState(item);
                const labels = { type: item.type, priority: String(item.priority) };
                const exampleRow = example(corpus, state, questions, labels);
                const text = triageText(state);
                return { example: exampleRow, example_sha256: exampleRow.example_sha256, questions, state, labels,
                    ids: [item.id], created_at: item.created_at, title: text.title, body: text.body };
            }), retrieval_misses: 0 };
    }
    if (task === "link") {
        const graph = RelationshipGraph.fromItems(items, resolveWorkspaceRelationshipKindRegistry());
        const question = buildLinkQuestion("candidate_0");
        const criteria = question.criteria;
        const units = [];
        const positives = [];
        const negatives = [];
        /** Construct one labelled source/candidate pair unit with its hashed example. */
        const pair = (source, target, kind) => {
            const sourceState = semanticState(source);
            const candidateState = semanticState(target);
            const labels = { candidate_0: kind };
            const exampleRow = example(corpus, { source: sourceState, candidates: { candidate_0: candidateState } }, { candidate_0: question }, labels);
            const text = pairText(sourceState, candidateState);
            return { example: exampleRow, example_sha256: exampleRow.example_sha256, questions: { candidate_0: question }, state: exampleRow.state, labels,
                ids: [source.id, target.id], created_at: source.created_at < target.created_at ? target.created_at : source.created_at, title: text.title, body: text.body };
        };
        for (const source of items) {
            const connected = new Set(graph.incidentEdges(source.id).flatMap(/** Enumerate only existing neighbors rather than every item pair. */ /** Enumerate only existing neighbors rather than every item pair. */ edge => [edge.source, edge.target]));
            const targets = items.filter(/** Existing edges provide positive labels. */ /** Existing edges provide positive labels. */ target => target.id !== source.id && connected.has(target.id));
            const negative = items.filter(/** Use a deterministic sampled non-edge per source. */ /** Use a deterministic sampled non-edge per source. */ target => target.id !== source.id && !connected.has(target.id))
                .sort(/** Hash pair identities to avoid relying on alphabetical adjacency. */ (a, b) => evidenceHash([source.id, a.id]).localeCompare(evidenceHash([source.id, b.id])))[0];
            if (negative !== undefined)
                targets.push(negative);
            for (const target of targets) {
                const kinds = [...existingLinkKinds(graph, source.id, target.id)].filter(/** Retain only ontology kinds the production command can propose. */ /** Retain only ontology kinds the production command can propose. */ kind => kind in criteria).sort();
                // Multi-labelled pairs cannot be honestly evaluated as one categorical choice.
                if (kinds.length > 1)
                    continue;
                // Unsupported kinds and reverse edges without an inverse are still connected pairs.
                if (kinds.length === 0 && connected.has(target.id))
                    continue;
                const unit = pair(source, target, kinds[0] ?? "none");
                if (kinds.length === 1)
                    positives.push(unit);
                else
                    negatives.push(unit);
            }
        }
        const sampled = deterministicSample(negatives.map(/** Wrap each unit so sampling identity stays byte-identical without copying. */ /** Wrap each unit so sampling identity stays byte-identical without copying. */ unit => ({ example_sha256: unit.example.example_sha256, repository: unit.example.repository, unit })), Math.max(positives.length, 1), "non-edges-v1")
            .map(/** Unwrap the sampled units, preserving object identity. */ /** Unwrap the sampled units, preserving object identity. */ wrapper => wrapper.unit);
        return { units: [...positives, ...sampled], retrieval_misses: 0 };
    }
    const units = [];
    let retrieval_misses = 0;
    for (const item of items) {
        const target = duplicateTarget(item);
        // Only explicitly labelled duplicate items supply dedupe ground truth.
        if (target === undefined)
            continue;
        const candidates = rankDedupeCandidates(items.filter(/** Simulate screening before the duplicate existed, excluding ambiguous sibling labels. */ /** Simulate screening before the duplicate existed, excluding ambiguous sibling labels. */ candidate => candidate.id !== item.id && (candidate.id === target || duplicateTarget(candidate) !== target)), item.title, 8);
        if (!candidates.some(/** Report retrieval failure separately rather than fabricating a negative label. */ /** Report retrieval failure separately rather than fabricating a negative label. */ candidate => candidate.id === target)) {
            retrieval_misses++;
            continue;
        }
        const request = buildDedupeRequest(item.title, item.body ?? item.description, candidates);
        const labels = { duplicate_of: target };
        const positive = example(corpus, request.state, request.questions, labels);
        units.push({ example: positive, example_sha256: positive.example_sha256, questions: request.questions, state: request.state, labels,
            ids: [item.id], created_at: item.created_at, title: item.title, body: [item.description, item.body].filter(/** Keep the semantic text the model itself sees. */ Boolean).join("\n") });
        const remaining = items.filter(/** Remove the known duplicate group to create an explicit missing-target control. */ /** Remove the known duplicate group to create an explicit missing-target control. */ candidate => candidate.id !== item.id && candidate.id !== target && duplicateTarget(candidate) !== target);
        const negativeCandidates = rankDedupeCandidates(remaining, item.title, 8);
        if (negativeCandidates.length > 0) {
            const negative = buildDedupeRequest(item.title, item.body ?? item.description, negativeCandidates);
            const negativeExample = example(corpus, negative.state, negative.questions, { duplicate_of: "none" });
            units.push({ example: negativeExample, example_sha256: negativeExample.example_sha256, questions: negative.questions, state: negative.state, labels: { duplicate_of: "none" },
                ids: [item.id], created_at: item.created_at, title: item.title, body: [item.description, item.body].filter(/** Keep the semantic text the model itself sees. */ Boolean).join("\n") });
        }
    }
    return { units, retrieval_misses };
}
/** Stable seeded hash sampling without replacement, balanced across repositories by round-robin. */
export function deterministicSample(examples, count, seed) {
    const groups = new Map();
    for (const row of [...examples].sort(/** Seed affects example selection but never depends on input ordering. */ (a, b) => evidenceHash([seed, a.example_sha256]).localeCompare(evidenceHash([seed, b.example_sha256])))) {
        const group = groups.get(row.repository) ?? [];
        group.push(row);
        groups.set(row.repository, group);
    }
    const repositories = [...groups.keys()].sort();
    const sampled = [];
    for (let offset = 0; sampled.length < Math.min(count, examples.length); offset++) {
        for (const repository of repositories) {
            const row = groups.get(repository)[offset];
            if (row !== undefined && sampled.length < count)
                sampled.push(row);
        }
    }
    return sampled;
}
//# sourceMappingURL=tracker-evaluation.js.map