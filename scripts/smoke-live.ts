// Opt-in integration test: creates and closes two sibling panes.
// No model requests by default; --prompt verifies one real response per host.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSide } from "../src/extension.ts";
import { herdrExec, resultOf } from "../src/herdr.ts";
import type { Host, SideAPI, SideContext } from "../src/types.ts";

if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) throw new Error("Run this test inside Herdr.");
const exec = herdrExec();
const run = promisify(execFile);
async function binary(name: string): Promise<string> {
  return (await run("which", [name], { encoding: "utf8" })).stdout.trim();
}
async function focus(): Promise<string> {
  const result = await exec(["workspace", "list"]);
  assert.equal(result.code, 0);
  const workspaces = resultOf(result.stdout).workspaces as Array<{ focused: boolean; workspace_id: string; active_tab_id: string }>;
  const workspace = workspaces.find(workspace => workspace.focused)!;
  const layoutResult = await exec(["pane", "list", "--workspace", workspace.workspace_id]);
  const panes = resultOf(layoutResult.stdout).panes as Array<{ pane_id: string; focused: boolean }>;
  return JSON.stringify([workspace.workspace_id, workspace.active_tab_id, panes.filter(pane => pane.focused).map(pane => pane.pane_id)]);
}

const prompt = process.argv.includes("--prompt") ? "Reply exactly SIDE_SMOKE_OK. Do not call tools." : "";
const selectedHost = process.argv.find(arg => arg.startsWith("--host="))?.slice("--host=".length);
if (selectedHost !== undefined && selectedHost !== "pi" && selectedHost !== "omp") throw new Error("--host must be pi or omp.");
const hosts: Host[] = selectedHost ? [selectedHost] : ["pi", "omp"];
for (const host of hosts) {
  const route = process.env[`SIDE_${host.toUpperCase()}_MODEL`];
  if (prompt && !route?.includes("/")) throw new Error(`Set SIDE_${host.toUpperCase()}_MODEL=provider/model for --prompt.`);
  const slash = route?.indexOf("/") ?? -1;
  const model = route ? { provider: route.slice(0, slash), id: route.slice(slash + 1) } : undefined;
  const directory = await mkdtemp(join(tmpdir(), `side-live-${host}-`));
  let pane: string | undefined;
  const focusedBefore = await focus();
  try {
    const header = { type: "session" as const, version: 3, id: `smoke-parent-${host}`, cwd: process.cwd(), timestamp: new Date().toISOString() };
    const branch = [
      { type: "message", id: "user", parentId: null, message: { role: "user", content: "A disposable side-session smoke test.", timestamp: Date.now() } },
      { type: "message", id: "assistant", parentId: "user", message: { role: "assistant", content: [{ type: "text", text: "Ready for the smoke test." }], api: "openai-responses", provider: "openai", model: "gpt-5.5", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
    ];
    const parentFile = join(directory, "parent.jsonl");
    const parentContent = `${[header, ...branch].map(value => JSON.stringify(value)).join("\n")}\n`;
    await writeFile(parentFile, parentContent, { mode: 0o600 });
    const context: SideContext = {
      mode: "tui", hasUI: true, cwd: process.cwd(), model, ui: { notify: message => console.log(host, message) },
      sessionManager: { getHeader: () => header, getSessionFile: () => parentFile, getSessionDir: () => directory, getBranch: () => branch, getSessionName: () => "Side smoke" },
    };
    const api: SideAPI = { registerCommand: () => {}, getActiveTools: () => [], getThinkingLevel: () => undefined };
    const hostExecutable = await binary(host);
    const runtime = host === "pi" ? process.execPath : await binary("bun");
    const { Herdr } = await import("../src/herdr.ts");
    const herdr = new Herdr(async args => {
      const result = await exec(args);
      if (args[1] === "split" && result.code === 0) pane = (resultOf(result.stdout).pane as { pane_id: string }).pane_id;
      return result;
    });
    await runSide(api, host, `--name "Named fork" ${prompt}`, context, { command: [runtime, await realpath(hostExecutable)], herdr });
    assert.ok(pane, "child pane was created");
    let detected = false;
    const childName = (await readdir(directory)).find(name => name.endsWith(".jsonl") && name !== "parent.jsonl")!;
    const deadline = Date.now() + (prompt ? 300_000 : 30_000);
    while (Date.now() < deadline) {
      const result = await exec(["agent", "get", pane]);
      if (result.code === 0) {
        const agent = resultOf(result.stdout).agent as { agent: string; agent_status: string };
        if (agent.agent === host && ["idle", "done"].includes(agent.agent_status)) {
          if (prompt) {
            const entries = (await readFile(join(directory, childName), "utf8")).split("\n").flatMap(line => {
              try { return [JSON.parse(line)]; } catch { return []; }
            });
            const answer = entries.some(entry => entry.message?.role === "assistant" && Array.isArray(entry.message.content) && entry.message.content.some((block: { text?: string }) => block.text?.includes("SIDE_SMOKE_OK")));
            if (!answer) { await new Promise(resolve => setTimeout(resolve, 400)); continue; }
            assert.ok(entries.some(entry => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(prompt)), "delegated prompt is in the child's history");
          }
          detected = true;
          break;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (!detected) console.error((await exec(["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "20"])).stdout);
    assert.ok(detected, `${host} reaches its interactive idle state`);
    const childEntries = (await readFile(join(directory, childName), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const expectedTitle = `Side smoke ↳ Named fork · ${childEntries[0].id.slice(0, 4)}`;
    const titleEntry = childEntries.findLast(entry => entry.type === (host === "pi" ? "session_info" : "title_change"));
    assert.equal(host === "pi" ? titleEntry?.name : titleEntry?.title, expectedTitle, "child retains its explicit session name");
    const paneResult = await exec(["pane", "get", pane]);
    assert.equal(paneResult.code, 0);
    const paneInfo = resultOf(paneResult.stdout).pane as Record<string, unknown>;
    assert.ok(Object.values(paneInfo).includes(expectedTitle), "Herdr pane has the matching label");
    assert.equal(await focus(), focusedBefore, "keyboard focus did not move");
    assert.equal(await readFile(parentFile, "utf8"), parentContent, "parent file remains unchanged");
    console.log(`${host}: PASS — real child ${prompt ? "answered the delegated prompt" : "is idle"}; session and pane names match; parent file and focus unchanged.`);
  } finally {
    if (pane) await exec(["pane", "close", pane]);
    await rm(directory, { recursive: true, force: true });
  }
}
