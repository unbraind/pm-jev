import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PmClient, resolveImplicitPmRoot } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";
import type { Questions } from "@typesafe-ai/sdk";

/** Create an isolated real tracker through the host CLI and bind the real harness. */
export async function project() {
  const cwd = mkdtempSync(join(tmpdir(), "jev-test-"));
  execFileSync(resolve("node_modules/.bin/pm"), ["--no-extensions", "init", "--defaults", "--prefix", "synthetic", "--agent-guidance", "skip"], { cwd, env: { ...process.env, PM_PATH: "", PM_AUTHOR: "fixture" }, stdio: "pipe" });
  const pmRoot = resolveImplicitPmRoot(cwd);
  const pm = new PmClient({ cwd, pmRoot, noExtensions: true, author: "fixture" });
  const harness = await createExtensionTestHarness(extension, { capabilities: ["commands", "schema"] });
  return { cwd, pmRoot, pm, harness, dispose: () => rmSync(cwd, { recursive: true, force: true }) };
}

/** Start a real loopback HTTP boundary with replaceable deterministic responses. */
export async function endpoint() {
  const requests: { path: string; body: unknown }[] = [];
  let reply = (request: IncomingMessage, response: ServerResponse, body: unknown): void => {
    if (request.url === "/v1/models") { response.end(JSON.stringify({ models: [{ name: "tev1:4b" }] })); return; }
    if (request.url === "/api/tags") { response.end(JSON.stringify({ models: [{ name: "tev1:4b", capabilities: ["decision"] }] })); return; }
    response.end(JSON.stringify(answers((body as { questions: Questions }).questions)));
  };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += String(chunk);
    const body: unknown = raw ? JSON.parse(raw) : null;
    requests.push({ path: request.url ?? "", body });
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
  const entries: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questions)) {
    if (question.type === "noul") { entries[name] = { type: "noul", noul: 0.9 }; continue; }
    const labels = question.type === "choice" ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const selected = labels.includes("Issue") ? "Issue" : labels[0];
    const probabilities = Object.fromEntries(labels.map(label => [label, label === selected ? 1 : 0]));
    entries[name] = question.type === "choice" ? { type: "choice", choice: selected, probabilities, confidence: 0.9 } : { type: "score", score: 0, probabilities, confidence: 0.9, legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])) };
  }
  return { model: "tev1:4b", answers: entries, usage: { input_tokens: 50, output_tokens: 4 } };
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
