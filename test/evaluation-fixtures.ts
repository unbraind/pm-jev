import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PmClient } from "@unbrained/pm-cli/sdk";
import { withoutGit } from "./fixtures.ts";
import { inspectSource } from "../tracker-evaluation.ts";
/** Inspect real git and tar while substituting only GitHub visibility for synthetic repositories. */
export function publicInspection(command: string, args: string[], cwd: string, input?: Buffer): Buffer {
  return command === "gh" ? Buffer.from('{"visibility":"PUBLIC"}') : inspectSource(command, args, cwd, input);
}
/** Initialize a committed synthetic fleet clone through real SDK writes. */
export async function syntheticCorpus(name = "pm-alpha") {
  const base = mkdtempSync(join(tmpdir(), "jev-evaluation-"));
  const cwd = join(base, "fleet", name);
  mkdirSync(cwd, { recursive: true });
  const pmRoot = join(cwd, ".agents/pm");
  const pm = new PmClient({ cwd, pmRoot, noExtensions: true, author: "fixture" });
  await withoutGit(cwd, () => pm.init("demo", { defaults: true, agentGuidance: "skip" }));
  const rows = JSON.parse(readFileSync(new URL("./fixtures/evaluation.json", import.meta.url), "utf8")) as Record<string, string | string[]>[];
  for (const row of rows) await pm.create(row);
  const { GIT_DIR: _gitDir, GIT_WORK_TREE: _gitTree, GIT_INDEX_FILE: _gitIndex, PM_PATH: _pmPath, ...env } = process.env;
  const git = (...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  git("init");
  git("remote", "add", "origin", `https://github.com/unbraind/${name}.git`);
  const commit = () => { git("add", ".agents/pm"); git("-c", "user.name=unbrained", "-c", "user.email=1153461+unbraind@users.noreply.github.com", "commit", "-m", "Synthetic tracker snapshot"); };
  commit();
  return { cwd, pmRoot, pm, git, commit, dispose: () => rmSync(base, { recursive: true, force: true }) };
}
