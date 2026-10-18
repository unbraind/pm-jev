import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildExamples, deterministicSample, duplicateTarget, inspectSource, readPublicCorpus, semanticState } from "../tracker-evaluation.ts";
import type { TrackerCorpus } from "../tracker-evaluation.ts";
import { publicInspection, syntheticCorpus } from "./evaluation-fixtures.ts";
import { trackerSnapshot } from "./fixtures.ts";

test("public snapshot reads are source-byte-identical and labels never enter triage evidence", async () => {
  const fixture = await syntheticCorpus();
  try {
    const before = trackerSnapshot(fixture.pmRoot);
    const corpus = await readPublicCorpus(fixture.pmRoot, publicInspection) as TrackerCorpus;
    assert.deepEqual(trackerSnapshot(fixture.pmRoot), before);
    assert.equal(corpus.items.length, 4);
    assert.equal(corpus.repository, "unbraind/pm-alpha");
    assert.equal(corpus.commit.length, 40);
    const first = buildExamples(corpus, "triage");
    assert.equal(first.examples.length, 4);
    assert.equal(first.examples[0].data_sha256.length, 64);
    assert.ok(first.examples.every(row => !JSON.stringify(row.state).includes('"priority"') && !JSON.stringify(row.state).includes('"type"')));
    assert.ok(first.examples.every(row => !JSON.stringify(row.questions).includes("__keep_current__")));
    const bug = corpus.items.find(row => row.id === "demo-bug")!;
    const modified = { ...corpus, items: [{ ...bug, type: "Task", priority: 4 as const }] };
    assert.deepEqual(buildExamples(modified, "triage").examples[0].state, semanticState(bug));
    assert.deepEqual(buildExamples(modified, "triage").examples[0].questions, first.examples[0].questions);
    await fixture.pm.update("demo-bug", { title: "Uncommitted edit must not leak" });
    const committed = await readPublicCorpus(fixture.pmRoot, publicInspection) as TrackerCorpus;
    assert.equal(committed.items.find(row => row.id === "demo-bug")!.title, bug.title);
    assert.equal(committed.data_sha256, corpus.data_sha256);
    const samples = deterministicSample(first.examples, 2, "fixed");
    assert.deepEqual(deterministicSample([...first.examples].reverse(), 2, "fixed"), samples);
    assert.equal(new Set(samples.map(row => row.example_sha256)).size, 2);
    assert.equal(deterministicSample([], 3, "fixed").length, 0);
    assert.equal(deterministicSample(first.examples, 20, "fixed").length, 4);
    const mixed = [...first.examples, { ...first.examples[0], repository: "public/second" }, { ...first.examples[1], repository: "public/third" }];
    assert.equal(deterministicSample(mixed, 1, "fixed").length, 1);
    assert.equal(deterministicSample(mixed, 20, "fixed").length, 6);
  } finally { fixture.dispose(); }
});

test("link labels respect inverse and undirected edges; dedupe labels require explicit duplicate ground truth", async () => {
  const fixture = await syntheticCorpus();
  try {
    const corpus = await readPublicCorpus(fixture.pmRoot, publicInspection) as TrackerCorpus;
    const links = buildExamples(corpus, "link").examples;
    assert.ok(links.some(row => row.labels.candidate_0 === "blocks"));
    assert.ok(links.some(row => row.labels.candidate_0 === "blocked_by"));
    assert.ok(links.some(row => row.labels.candidate_0 === "none"));
    assert.ok(!JSON.stringify(links.map(row => row.state)).includes('"deps"'));
    const dedupe = buildExamples(corpus, "dedupe");
    assert.equal(dedupe.examples.length, 2);
    assert.deepEqual(dedupe.examples.map(row => row.labels.duplicate_of).sort(), ["demo-bug", "none"]);
    assert.equal(dedupe.retrieval_misses, 0);
    const withoutBody = { ...corpus, items: corpus.items.map(row => ({ ...row, body: undefined })) };
    assert.equal(buildExamples(withoutBody, "dedupe").examples.length, 2);
    const copy = corpus.items.find(row => row.id === "demo-copy")!;
    assert.equal(duplicateTarget(copy), "demo-bug");
    assert.equal(duplicateTarget({ ...copy, duplicate_of: "demo-task" }), "demo-task");
    assert.equal(duplicateTarget({ ...copy, status: "open", close_reason: "duplicate of demo-bug" }), undefined);
    assert.equal(duplicateTarget({ ...copy, close_reason: undefined, resolution: "duplicate_of demo-bug" }), "demo-bug");
    assert.equal(duplicateTarget({ ...copy, type_options: { duplicate_of: "demo-task" } }), "demo-task");
    assert.equal(duplicateTarget({ ...copy, type_options: { duplicateOf: "demo-task" } }), "demo-task");
    assert.equal(duplicateTarget({ ...copy, status: "canceled", close_reason: "nothing" }), undefined);
    const absent = { ...corpus, items: corpus.items.filter(row => row.id !== "demo-bug") };
    assert.equal(buildExamples(absent, "dedupe").retrieval_misses, 1);
    const onlyCopy = { ...corpus, items: [copy, corpus.items.find(row => row.id === "demo-bug")!] };
    assert.equal(buildExamples(onlyCopy, "dedupe").examples.length, 1);
    await fixture.pm.update("demo-task", { dep: ["id=demo-bug,kind=related"] }); fixture.commit();
    const multiple = buildExamples(await readPublicCorpus(fixture.pmRoot, publicInspection) as TrackerCorpus, "link").examples;
    assert.ok(!multiple.some(row => JSON.stringify(row.state).includes("Migrate the database") && row.labels.candidate_0 !== "none"));
    assert.ok(buildExamples({ ...corpus, items: [] }, "link").examples.length === 0);
    assert.equal(buildExamples({ ...corpus, items: [copy] }, "link").examples.length, 0);
  } finally { fixture.dispose(); }
});

test("visibility and source guards refuse forbidden inputs before SDK tracker reads", async () => {
  const fixture = await syntheticCorpus();
  try {
    const privateInspect: typeof publicInspection = (command, args, cwd, input) => command === "gh" ? Buffer.from('{"visibility":"PRIVATE"}') : publicInspection(command, args, cwd, input);
    assert.equal(await readPublicCorpus(fixture.pmRoot, privateInspect), null);
    const unknown: typeof publicInspection = (command, args, cwd, input) => command === "gh" ? Buffer.from('{}') : publicInspection(command, args, cwd, input);
    await assert.rejects(readPublicCorpus(fixture.pmRoot, unknown), /visibility/);
    await assert.rejects(readPublicCorpus(fixture.cwd), /public package trackers/);
    for (const path of [join(fixture.cwd, "other", "pm"), join(dirname(fixture.cwd), "pm-cli", ".agents", "pm"), join(dirname(fixture.cwd), "pm-cli-companion", ".agents", "pm"), join(dirname(fixture.cwd), "other", ".agents", "pm"), join(fixture.cwd, "elsewhere", "pm-sub", ".agents", "pm")]) {
      mkdirSync(path, { recursive: true });
      await assert.rejects(readPublicCorpus(path, publicInspection), /public package trackers/);
    }
    fixture.git("remote", "set-url", "origin", "https://github.com/private/pm-alpha.git");
    await assert.rejects(readPublicCorpus(fixture.pmRoot, publicInspection), /origin/);
    fixture.git("remote", "set-url", "origin", "https://github.com/unbraind/pm-alpha.git");
    const symlinkInspector: typeof publicInspection = (command, args, cwd, input) => args[0] === "ls-tree" ? Buffer.from("120000 blob synthetic\t.agents/pm/alias") : publicInspection(command, args, cwd, input);
    await assert.rejects(readPublicCorpus(fixture.pmRoot, symlinkInspector), /regular committed/);
    const emptyInspector: typeof publicInspection = (command, args, cwd, input) => args[0] === "ls-tree" ? Buffer.from("") : publicInspection(command, args, cwd, input);
    await assert.rejects(readPublicCorpus(fixture.pmRoot, emptyInspector), /regular committed/);
    assert.throws(() => inspectSource("git", ["not-a-git-command"], fixture.cwd), /inspection failed/);
  } finally { fixture.dispose(); }
});
