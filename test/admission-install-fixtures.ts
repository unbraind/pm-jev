import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { createRequire } from "node:module";

// Reuse tar from the pinned host, which owns archive installation, without adding a dependency.
const require = createRequire(import.meta.url);
const { extract } = createRequire(require.resolve("@unbrained/pm-cli/package.json"))("tar") as {
  extract(options: { file: string; cwd: string; strip: number }): Promise<void>;
};

/** Resolve npm's JavaScript entry point so Windows never needs to execute a .cmd shim. */
export function npmInvocation(command: "npm" | "npx", args: string[], searchPath = process.env.PATH ?? "") {
  const filename = `${command}-cli.js`;
  for (const directory of searchPath.split(delimiter)) {
    for (const base of [join(directory, "node_modules/npm/bin"), resolve(directory, "../lib/node_modules/npm/bin")]) {
      const cli = join(base, filename);
      if (existsSync(cli)) return { bin: process.execPath, args: [cli, ...args] };
    }
    const executable = join(directory, command);
    if (existsSync(executable)) {
      const cli = realpathSync(executable);
      if (cli.endsWith(filename)) return { bin: process.execPath, args: [cli, ...args] };
    }
  }
  throw new Error(`Cannot locate the installed ${command} JavaScript entry point`);
}

/** Unpack the tested artifact alongside the already-installed lockfile dependencies, without a resolver or network. */
export async function unpackOfflineConsumer(root: string, local: string, archive: string): Promise<void> {
  const modules = join(local, "node_modules");
  const target = join(modules, "pm-jev");
  mkdirSync(target, { recursive: true });
  await extract({ file: archive, cwd: target, strip: 1 });
  for (const entry of readdirSync(join(root, "node_modules"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "pm-jev") symlinkSync(join(root, "node_modules", entry.name), join(modules, entry.name), "junction");
  }
}
