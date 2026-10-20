/** Keep private local evidence out of package artifacts, project settings and committed JSON fixtures. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertPublicProvenance } from "../source-provenance.ts";
import { isMainInvocation } from "./main-invocation.ts";

/** Check the package's data destinations without discovering or invoking a git repository. */
export function verifyPublicArtifacts(root: string): void {
  const settings = join(root, ".agents/pm/settings.json");
  if (existsSync(settings)) assertPublicProvenance(JSON.parse(readFileSync(settings, "utf8")));
  for (const directory of ["calibration", "test/fixtures"]) {
    const target = join(root, directory);
    if (!existsSync(target)) continue;
    for (const entry of readdirSync(target, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json")) assertPublicProvenance(JSON.parse(readFileSync(join(entry.parentPath, entry.name), "utf8")));
    }
  }
}

/** Package scripts verify their own root, independent of the caller's directory. */
export function main(): void {
  verifyPublicArtifacts(resolve(import.meta.dirname, ".."));
}

await [/** Imports leave verification explicitly callable by tests. */ async (): Promise<void> => {}, main][Number(isMainInvocation(process.argv, import.meta.url))]();
