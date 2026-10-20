import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertPublicProvenance } from "../source-provenance.ts";
import { main as verifyPackageArtifacts, verifyPublicArtifacts } from "../scripts/verify-public-provenance.ts";
import { main } from "../scripts/calibrate.ts";
import { publicInspection, syntheticCorpus } from "./evaluation-fixtures.ts";
import { readPublicCorpus } from "../tracker-evaluation.ts";

test("publication and committed-fixture gates reject nested local provenance and local source identities", async () => {
  const root = mkdtempSync(join(tmpdir(), "jev-artifact-guard-"));
  const previous = process.cwd();
  try {
    verifyPackageArtifacts();
    verifyPublicArtifacts(root);
    mkdirSync(join(root, "calibration/nested"), { recursive: true });
    mkdirSync(join(root, "test/fixtures"), { recursive: true });
    mkdirSync(join(root, ".agents/pm"), { recursive: true });
    writeFileSync(join(root, "calibration/README.md"), "Synthetic public artifacts");
    writeFileSync(join(root, "calibration/nested/public.json"), JSON.stringify({ public: [null, "verified"] }));
    writeFileSync(join(root, ".agents/pm/settings.json"), "{}");
    verifyPublicArtifacts(root);
    for (const path of ["calibration/nested/private.json", "test/fixtures/private.json", ".agents/pm/settings.json"]) {
      writeFileSync(join(root, path), JSON.stringify({ calibration: { provenance: "local-unverified" } }));
      assert.throws(() => verifyPublicArtifacts(root), /local-unverified.*committed fixture/);
      writeFileSync(join(root, path), "{}");
    }
    assert.throws(() => assertPublicProvenance({ data: [{ repository: "local-unverified/synthetic" }] }), /local-unverified/);
    process.chdir(root);
    writeFileSync("calibration/dataset-v1.json", JSON.stringify({ provenance: "local-unverified" }));
    writeFileSync("calibration/report.json", "previous public artifact");
    await assert.rejects(main(["run", "tev1:4b", "http://127.0.0.1:1", "calibration/report.json"]), /local-unverified.*published calibration artifact/);
    assert.equal(readFileSync("calibration/report.json", "utf8"), "previous public artifact");
  } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
});

test("committed public sources cannot smuggle a local calibration through project settings", async () => {
  const source = await syntheticCorpus();
  try {
    const settings = join(source.pmRoot, "settings.json");
    const current = JSON.parse(readFileSync(settings, "utf8"));
    writeFileSync(settings, JSON.stringify({ ...current, jev: { calibrations: { private: { provenance: "local-unverified" } } } }));
    source.commit();
    await assert.rejects(readPublicCorpus(source.pmRoot, publicInspection), /local-unverified.*public corpus/);
    rmSync(settings);
    source.commit();
    await assert.rejects(readPublicCorpus(source.pmRoot, publicInspection), /not initialized/);
  } finally { source.dispose(); }
});
