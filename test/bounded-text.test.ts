import assert from "node:assert/strict";
import test from "node:test";
import { boundedText } from "../bounded-text.ts";
import { ADMISSION_VERSION, AdmissionRefusal, parseAdmissionInput } from "../admission-schema.ts";
import { createJevClient, projectItemState, projectTriageState, resolveJevEndpoint, runDecision } from "../index.ts";
import type { ProjectableItem } from "../index.ts";
import { pairState } from "../dedupe.ts";
import { exemplarContext } from "../exemplar-retrieval.ts";
import { redactedSourceLine } from "../source-diagnostics.ts";
import { scenario, withoutGit } from "./fixtures.ts";

const questions = { keep: { type: "noul" as const } };
const marker = "…[truncated]";

/** UTF-8 round trips preserve well-formed strings and expose every lone surrogate. */
function assertWellFormed(value: string): void {
  assert.equal(Buffer.from(value, "utf8").toString("utf8"), value);
}

/** Independently accumulate complete code points up to a UTF-16 budget. */
function prefixOracle(value: string, limit: number): string {
  let result = "";
  for (const point of value) {
    if (result.length + point.length > limit) break;
    result += point;
  }
  return result;
}

/** Build synthetic item evidence without depending on tracker field normalization. */
function item(text: string, tag: string) {
  return { id: "synthetic", title: text, type: text, status: text, description: text, body: `b${text}`, tags: [tag] };
}

test("bounded text retains whole astral characters at, before and across each bound", () => {
  for (const limit of [0, 1, 2, 128, 320, 500, 1600, 4000]) {
    for (const point of ["😀", "𝄞", "\u{10ffff}"]) {
      for (const offset of [-2, -1, 0, 1]) {
        const value = `${"a".repeat(Math.max(0, limit + offset))}${point}z`;
        const result = boundedText(value, limit);
        assert.equal(result, prefixOracle(value, limit));
        assertWellFormed(result); assert.ok(result.length <= limit);
      }
    }
  }
  assert.equal(boundedText("", 0), "");
  assert.equal(boundedText("😀", 20), "😀");
  // Truncation must not silently repair malformed source data and bypass admission.
  for (const value of ["\ud800", "\ud800x", "\udc00", "x\udc00"]) {
    assert.equal(boundedText(value, 128), value);
    assert.throws(() => parseAdmissionInput({ version: ADMISSION_VERSION, state: boundedText(value, 128), questions }), AdmissionRefusal);
  }
});

test("item and triage projection preserve astral text and tags at admission boundaries", () => {
  for (const point of ["😀", "𝄞", "\u{10ffff}"]) {
    for (const offset of [-2, -1, 0, 1]) {
      const text = `${"a".repeat(4000 + offset)}${point}`;
      const tag = `${"t".repeat(128 + offset)}${point}`;
      const source = item(text, tag);
      const projected = projectItemState(source);
      const triage = projectTriageState(source);
      for (const [key, value] of Object.entries(projected)) {
        if (key === "tags") continue;
        const raw = source[key as "title" | "type" | "status" | "description" | "body"];
        assert.equal(value, prefixOracle(raw, 4000) + (raw.length > 4000 ? marker : ""));
        assertWellFormed((value as string));
        assert.ok((value as string).length <= 4000 + marker.length);
      }
      assert.deepEqual(triage, { title: projected.title, description: projected.description, body: projected.body, tags: projected.tags });
      assert.deepEqual(projected.tags, [prefixOracle(tag, 128)]);
      assertWellFormed(projected.tags[0]); assert.ok(projected.tags[0].length <= 128);
      for (const state of [projected, triage]) parseAdmissionInput({ version: ADMISSION_VERSION, state, questions });
    }
  }
});

test("seeded astral fuzz preserves projection bounds and well-formed admission state", () => {
  let seed = 0x92c0ffee;
  /** Reproducible unsigned random integer independent of the implementation. */
  function random(): number { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }
  for (let sample = 0; sample < 128; sample++) {
    let value = sample % 2 ? "a" : "";
    while (value.length < 4100) value += random() % 3 ? String.fromCodePoint(0x10000 + random() % 0x100000) : "a";
    for (const limit of [128, 320, 500, 1600, 4000, random() % 4101]) {
      const output = boundedText(value, limit);
      assert.equal(output, prefixOracle(value, limit));
      assertWellFormed(output); assert.ok(output.length <= limit);
    }
    for (const project of [projectItemState, projectTriageState]) {
      const state = project(item(value, value));
      for (const [key, entry] of Object.entries(state)) {
        if (typeof entry === "string") {
          assertWellFormed(entry); assert.ok(entry.length <= 4000 + marker.length);
          const raw = item(value, value)[key as "title" | "type" | "status" | "description" | "body"];
          assert.equal(entry, prefixOracle(raw, 4000) + marker);
        } else {
          assert.deepEqual(entry, [prefixOracle(value, 128)]);
          assertWellFormed(entry[0]); assert.ok(entry[0].length <= 128);
        }
      }
      parseAdmissionInput({ version: ADMISSION_VERSION, state, questions });
    }
  }
});

test("real no-git tracker text and tags reach local decisions without surrogate refusal", async () => {
  await scenario(async (fixture, server) => {
    await withoutGit(fixture.cwd, async () => {
      const { config } = await resolveJevEndpoint(fixture.pmRoot, { PM_JEV_BASE_URL: server.url });
      const client = createJevClient({ config, hostedBlocked: null }, {});
      for (const offset of [-2, -1, 0, 1]) {
        const text = `${"a".repeat(4000 + offset)}😀z`;
        const tag = `${"t".repeat(128 + offset)}😀z`;
        const created = await fixture.pm.create({ type: "Task", title: `Synthetic astral boundary ${offset}`, description: text, body: text, tags: tag });
        const source = (await fixture.pm.get(created.item.id, { full: true })).item as ProjectableItem;
        for (const project of [projectItemState, projectTriageState]) {
          const state = project(source);
          const result = await runDecision(client, config, state, questions);
          assert.equal(result.admission?.ok, true);
          assert.equal(state.description, prefixOracle(text, 4000) + marker);
          assert.deepEqual(state.tags, [prefixOracle(tag, 128)]);
          assert.deepEqual((server.requests.at(-1)?.body as { state: unknown }).state, state);
        }
      }
      assert.equal(server.requests.length, 8);
    });
  });
});

test("pair evidence keeps complete characters at both prompt bounds", async () => {
  await scenario(async fixture => {
    const created = await fixture.pm.create({ type: "Task", title: "Synthetic pair", description: "" });
    const base = { ...created.item, title: `${"a".repeat(319)}😀`, description: `${"b".repeat(1599)}𝄞` };
    const state = pairState({ a: base, b: base, score: 1 });
    for (const side of Object.values(state)) {
      assert.equal(side.title, "a".repeat(319)); assert.equal(side.text, "b".repeat(1599));
      assertWellFormed(side.title); assertWellFormed(side.text);
      assert.ok(side.title.length <= 320); assert.ok(side.text.length <= 1600);
    }
    parseAdmissionInput({ version: ADMISSION_VERSION, state, questions });
  });
});

test("exemplar packing keeps astral characters whole on initial and halved cuts", () => {
  const unit = { ids: ["synthetic"], created_at: "2026-01-01", title: "", body: "", labels: {}, example_sha256: "synthetic" };
  // Budget 15 leaves 22 body units initially. UTF-8 inflation halves that to 11.
  for (const body of [`${"a".repeat(21)}😀${"z".repeat(200)}`, `${"a".repeat(10)}😀${"漢".repeat(200)}`]) {
    const entries = exemplarContext([{ ...unit, body }], 15);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].body, "a".repeat(body.includes("漢") ? 10 : 21) + marker);
    assertWellFormed(entries[0].body); assert.ok(Buffer.byteLength(JSON.stringify(entries)) <= 60);
    parseAdmissionInput({ version: ADMISSION_VERSION, state: entries, questions });
  }
});

test("diagnostic text respects the 500-unit bound without splitting an astral character", () => {
  for (const prefix of [498, 499, 500]) {
    const value = `${"a".repeat(prefix)}😀extra`;
    const output = redactedSourceLine(value);
    assert.equal(output, prefixOracle(value, 500));
    assertWellFormed(output); assert.ok(output.length <= 500);
  }
});
