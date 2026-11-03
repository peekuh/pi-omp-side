import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Host } from "./types.ts";

export function shellQuote(text: string): string {
  if (text.includes("\0")) throw new Error("Shell arguments cannot contain NUL bytes.");
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function validatePrompt(prompt: string): void {
  if (prompt.includes("\0")) throw new Error("The side prompt cannot contain NUL bytes.");
  if (Buffer.byteLength(prompt) > 64 * 1024) throw new Error("The side prompt exceeds 64 KiB.");
}

export interface ChildOptions {
  host: Host;
  sessionFile: string;
  sessionDir: string;
  model?: { provider: string; id: string };
  thinking?: string;
  tools: string[];
  prompt: string;
}

export function childArgs(options: ChildOptions): string[] {
  const args = [options.host === "pi" ? "--session" : "--resume", options.sessionFile, "--session-dir", options.sessionDir];
  if (options.model) args.push("--provider", options.model.provider, "--model", options.model.id);
  if (options.thinking) args.push("--thinking", options.thinking);
  if (options.tools.some(name => /[,\s]/.test(name))) throw new Error("An active tool name cannot be passed safely through --tools.");
  if (options.tools.length) args.push("--tools", options.tools.join(","));
  else args.push("--no-tools");
  if (options.prompt.trim()) {
    // Prevent leading @file, /command, or --flag from being reinterpreted by either host.
    args.push("--", `Side task:\n\n${options.prompt}`);
  }
  return args;
}

/** Keep credentials/config, but use the new pane's terminal and Herdr identities. */
export function childEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const excluded = new Set([
    "PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL",
    "PWD", "OLDPWD", "SHLVL", "_", "TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION",
    "WINDOWID", "WINDOW_ID", "KITTY_WINDOW_ID", "KONSOLE_DBUS_SESSION", "KONSOLE_DBUS_WINDOW",
    "KONSOLE_DBUS_SERVICE", "TMUX", "TMUX_PANE", "STY",
  ]);
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => {
    const [key, value] = entry;
    return value !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
      && !key.startsWith("HERDR_") && !key.startsWith("OMP_SESSION_") && !excluded.has(key);
  }));
}

/** Run the exact host runtime and entrypoint, not an unrelated pi/omp on PATH. */
export function runtimeCommand(host: Host, executable = process.execPath, script = process.argv[1]): string[] {
  return script && isAbsolute(script) ? [executable, script] : [host];
}

export function launchScript(command: string[], args: string[], env: Record<string, string>, launchDir: string): string {
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`).join("\n");
  const runtimeDir = isAbsolute(command[0]) ? dirname(command[0]) : undefined;
  return [
    "#!/bin/sh",
    exports,
    ...(runtimeDir ? [`PATH=${shellQuote(runtimeDir)}\${PATH:+:\"$PATH\"}; export PATH`] : []),
    // Read the whole command into the shell before removing the private launch file.
    `side_exec() { exec ${[...command, ...args].map(shellQuote).join(" ")}; }`,
    'rm -f -- "$0"',
    `rmdir -- ${shellQuote(launchDir)} 2>/dev/null || :`,
    "side_exec",
    "",
  ].join("\n");
}

export interface LaunchFile {
  file: string;
  directory: string;
}

export async function writeLaunchFile(command: string[], args: string[], env: NodeJS.ProcessEnv): Promise<LaunchFile> {
  const directory = await mkdtemp(join(tmpdir(), "pi-omp-side-"));
  const file = join(directory, "launch.sh");
  try {
    await writeFile(file, launchScript(command, args, childEnvironment(env), directory), { mode: 0o600, flag: "wx" });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return { file, directory };
}
