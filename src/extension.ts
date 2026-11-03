import { rm } from "node:fs/promises";
import { parseSideArguments } from "./arguments.ts";
import { Herdr, herdrExec } from "./herdr.ts";
import { childArgs, runtimeCommand, shellQuote, validatePrompt, writeLaunchFile } from "./launch.ts";
import type { LaunchFile } from "./launch.ts";
import { captureSnapshot, removeSnapshot, saveSnapshot } from "./snapshot.ts";
import type { SavedSnapshot } from "./snapshot.ts";
import type { Host, SideAPI, SideContext } from "./types.ts";

export interface SideDependencies {
  environment?: NodeJS.ProcessEnv;
  command?: string[];
  herdr?: Herdr;
}

function notify(ctx: SideContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else process.stderr.write(`[pi-omp-side] ${text}\n`);
}

export async function runSide(api: SideAPI, host: Host, args: string, ctx: SideContext, dependencies: SideDependencies = {}): Promise<void> {
  let saved: SavedSnapshot | undefined;
  let launch: LaunchFile | undefined;
  let pane: string | undefined;
  let submissionAttempted = false;
  const env = { ...(dependencies.environment ?? process.env) };
  const herdr = dependencies.herdr ?? new Herdr(herdrExec(env.HERDR_BIN_PATH));
  try {
    if (ctx.mode !== "tui") throw new Error("/side requires interactive mode.");
    if (env.HERDR_ENV !== "1" || !env.HERDR_PANE_ID) throw new Error("/side must run inside a Herdr-managed pane.");
    if (process.platform === "win32") throw new Error("/side currently requires a POSIX shell (Linux, macOS, or WSL).");
    const { prompt, name } = parseSideArguments(args);
    validatePrompt(prompt);
    // Capture everything before yielding: the parent may keep streaming or switch sessions.
    const snapshot = captureSnapshot(ctx.sessionManager, ctx.cwd, host, prompt, name);
    const tools = [...api.getActiveTools()];
    const model = ctx.model ? { ...ctx.model } : undefined;
    const thinking = api.getThinkingLevel();
    const command = dependencies.command ?? runtimeCommand(host);
    const cwd = ctx.cwd;

    const caller = await herdr.caller();
    const direction = await herdr.direction(caller);
    saved = await saveSnapshot(snapshot);
    const argsForChild = childArgs({ host, sessionFile: saved.sessionFile, sessionDir: snapshot.sessionDir, model, thinking, tools, prompt });
    launch = await writeLaunchFile(command, argsForChild, env);
    pane = await herdr.split(caller, direction, cwd);
    await herdr.waitForShell(pane);
    // A timeout here is ambiguous: never retry or kill a possibly running child.
    submissionAttempted = true;
    await herdr.run(pane, `sh ${shellQuote(launch.file)}`);
    notify(ctx, `Started ${host} side session in ${pane}. Focus stays here. Session: ${snapshot.header.id}`);
    if (snapshot.omitted) notify(ctx, "The fork excludes the parent's unfinished tool step or streaming response.", "warning");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (submissionAttempted) {
      notify(ctx, `Could not confirm side-session launch: ${message}\nKept pane ${pane} and fork ${saved?.sessionFile}. Inspect the pane before retrying.`, "error");
      return;
    }
    if (pane) {
      try { await herdr.close(pane); }
      catch { notify(ctx, `Could not close the unused pane ${pane}; you can close it manually.`, "warning"); }
    }
    const cleanup = [];
    if (launch) cleanup.push(rm(launch.directory, { recursive: true, force: true }));
    if (saved) cleanup.push(removeSnapshot(saved));
    await Promise.allSettled(cleanup);
    notify(ctx, message, "error");
  }
}

export function registerSide(api: SideAPI, host: Host): void {
  api.registerCommand("side", {
    description: 'Fork into a background Herdr pane: /side [--name "Task label"] [prompt]',
    handler: (args, ctx) => runSide(api, host, args, ctx),
  });
}
