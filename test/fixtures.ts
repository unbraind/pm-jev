import { zstdDecompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createExtensionCommandSdk, PmClient, resolveImplicitPmRoot } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import type { Questions } from "@typesafe-ai/sdk";

/** Run a plain-tracker regression with no git executable or enclosing repository discovery. */
export async function withoutGit<T>(cwd: string, run: () => Promise<T>): Promise<T> {
  const settings = { PATH: "", GIT_CEILING_DIRECTORIES: path.dirname(cwd) };
  const previous = Object.keys(settings).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, settings);
  try { return await run(); }
  finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Create an isolated real tracker through the host SDK and bind its actual client to the harness. */
export async function project() {
  const cwd = mkdtempSync(join(tmpdir(), "jev-test-"));
  const pmRoot = resolveImplicitPmRoot(cwd);
  const pm = new PmClient({ cwd, pmRoot, noExtensions: true, author: "fixture" });
  await pm.init("synthetic", { defaults: true, agentGuidance: "skip" });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema", "hooks"] });
  const bound = { ...harness,
    /** Supply the real scratch client through the public host SDK factory. */
    runCommand: (options: Parameters<typeof harness.runCommand>[0]) => harness.runCommand({ ...options, sdk: createExtensionCommandSdk(pmRoot, pm, "fixture", options.command) }),
  };
  return { cwd, pmRoot, pm, harness: bound, dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** Start a real loopback HTTP boundary with replaceable deterministic responses. */
export async function endpoint() {
  const requests: { path: string; body: unknown; contentEncoding: string | undefined }[] = [];
  let reply = (request: IncomingMessage, response: ServerResponse, body: unknown): void => {
    if (request.url === "/v1/models") { response.end(JSON.stringify({ models: [{ name: "tev1:4b" }] })); return; }
    if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "tev1:4b", capabilities: ["decision"] }] })); return; }
    response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const raw = (request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8");
    const body: unknown = raw ? JSON.parse(raw) : null;
    requests.push({ path: request.url ?? "", body, contentEncoding: request.headers["content-encoding"] });
    response.setHeader("Content-Type", "application/json");
    reply(request, response, body);
  });
  await new Promise<void>(resolveListen => { server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing server address");
  return { url: `http://127.0.0.1:${address.port}`, requests, setReply: (handler: typeof reply) => { reply = handler; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolveClose => { server.close(() => resolveClose()); }); } };
}

/** Produce a normalized response for the actual supplied question schema. */
export function answers(questions: Questions) {
  const entries: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "noul") { entries[name] = { type: "noul", noul: 0.9 }; continue; }
    if (question.type === "box") throw new Error("Unsupported fixture question: box");
    const labels = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const selected = labels.includes("Issue") ? "Issue" : labels[0];
    const probabilities = Object.fromEntries(labels.map(label => [label, label === selected ? 1 : 0]));
    entries[name] = question.type === "choice" ? { type: "choice", choice: selected, probabilities, confidence: 0.9 } : { type: "score", score: 0, probabilities, confidence: 0.9, legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])) };
  }
  return { model: "tev1:4b", answers: entries, usage: { input_tokens: 50 as number | null, output_tokens: 4 as number | null } };
}

/** Run a scenario with scoped endpoint environment and deterministic cleanup. */
export async function scenario(run: (fixture: Awaited<ReturnType<typeof project>>, server: Awaited<ReturnType<typeof endpoint>>) => Promise<void>): Promise<void> {
  const fixture = await project();
  const server = await endpoint();
  const previous = process.env.PM_JEV_BASE_URL;
  process.env.PM_JEV_BASE_URL = server.url;
  try { await run(fixture, server); }
  finally { if (previous === undefined) delete process.env.PM_JEV_BASE_URL; else process.env.PM_JEV_BASE_URL = previous; await server.close(); fixture.dispose(); }
}

/** Route a synthetic HTTPS origin to the loopback server; this is no TLS acceptance claim. */
export function hostedFixture(server: Awaited<ReturnType<typeof endpoint>>): () => void {
  const previousUrl = process.env.PM_JEV_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.PM_JEV_BASE_URL = "https://synthetic.example";
  globalThis.fetch = (input, init) => {
    const url = String(input).replace("https://synthetic.example", server.url);
    return previousFetch(url, init);
  };
  return () => {
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.PM_JEV_BASE_URL;
    else process.env.PM_JEV_BASE_URL = previousUrl;
  };
}

/** Return a normalized triage distribution with unspecified registry labels set to zero. */
export function typeAnswers(questions: Questions, weights: Record<string, number>) {
  const question = questions.type;
  if (question.type !== "choice") throw new Error("Expected triage choice");
  const result = answers(questions);
  result.answers.type = { type: "choice", choice: Object.keys(weights)[0], confidence: 1,
    probabilities: Object.fromEntries(Object.keys(question.criteria).map(label => [label, weights[label] ?? 0])) };
  return result;
}

/** Hash every authoritative tracker artifact; the host owns disposable runtime caches and usage ledgers. */
export function trackerSnapshot(root: string, paths: Pick<typeof path, "relative" | "sep"> = path): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name);
    const relativePath = paths.relative(root, path);
    if (!entry.isFile() || relativePath.split(paths.sep)[0] === "runtime") continue;
    entries[relativePath] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }
  return entries;
}
