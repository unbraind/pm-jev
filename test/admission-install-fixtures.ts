import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { createRequire } from "node:module";

// Reuse tar from the pinned host, which owns archive installation, without adding a dependency.
const require = createRequire(import.meta.url);
const { extract } = createRequire(require.resolve("@unbrained/pm-cli/package.json"))("tar") as {
  extract(options: { file: string; cwd: string; strip: number }): Promise<void>;
};

/** Installation and filesystem boundaries for cross-platform entrypoint fixtures. */
interface NpmInstallation {
  /** Active Node executable, independent of package-manager PATH shims. */
  execPath: string;
  /** npm's invoking JavaScript entrypoint, when running under npm. */
  npmExecPath?: string;
  /** Select the installation's path syntax. */
  platform: NodeJS.Platform;
  /** Verify the candidate is an installed file, rather than a directory. */
  isFile: (file: string) => boolean;
}

/** Resolve npm's verified JavaScript entrypoint without consulting PATH or executing shims. */
export function npmInvocation(command: "npm" | "npx", args: string[], installation: NpmInstallation = {
  execPath: process.execPath, npmExecPath: process.env.npm_execpath, platform: process.platform,
  /** Verify an installed entrypoint before constructing its invocation. */
  isFile: file => existsSync(file) && statSync(file).isFile(),
}) {
  const path = installation.platform === "win32" ? win32 : posix;
  const filename = `${command}-cli.js`;
  const invokingCli = installation.npmExecPath;
  const bases = [
    ...(invokingCli && path.isAbsolute(invokingCli) && /^(npm|npx)-cli\.js$/.test(path.basename(invokingCli)) ? [path.dirname(invokingCli)] : []),
    path.join(path.dirname(installation.execPath), "node_modules/npm/bin"),
    path.resolve(path.dirname(installation.execPath), "../lib/node_modules/npm/bin"),
  ];
  for (const base of bases) {
    const cli = path.join(base, filename);
    if (installation.isFile(cli)) return { bin: installation.execPath, args: [cli, ...args] };
  }
  throw new Error(`Cannot locate the installed ${filename}; install npm alongside Node or run through npm with a valid npm_execpath`);
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
