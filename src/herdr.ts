import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Exec } from "./types.ts";

const execFileAsync = promisify(execFile);

export function herdrExec(binary = process.env.HERDR_BIN_PATH || "herdr"): Exec {
  return async args => {
    try {
      const result = await execFileAsync(binary, args, { encoding: "utf8", timeout: 10_000, maxBuffer: 512 * 1024 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as NodeJS.ErrnoException & { code?: string | number; stdout?: string; stderr?: string };
      // Don't expose the launch command or environment through an execFile error message.
      return { code: typeof result.code === "number" ? result.code : 1, stdout: result.stdout ?? "", stderr: result.stderr || `herdr failed (${result.code ?? "timeout"}).` };
    }
  };
}

interface Envelope {
  result?: Record<string, unknown>;
  error?: { message?: string; code?: string };
}

export function resultOf(stdout: string): Record<string, unknown> {
  const envelope = JSON.parse(stdout) as Envelope;
  if (envelope.error) throw new Error(envelope.error.message || envelope.error.code || "Herdr request failed.");
  if (!envelope.result || typeof envelope.result !== "object") throw new Error("Herdr returned no result.");
  return envelope.result;
}

function paneId(value: unknown): string {
  const id = (value as { pane_id?: unknown } | undefined)?.pane_id;
  if (typeof id !== "string" || !id || id.startsWith("-")) throw new Error("Herdr returned no valid pane ID.");
  return id;
}

export class Herdr {
  private readonly exec: Exec;

  constructor(exec: Exec) {
    this.exec = exec;
  }

  private async request(args: string[]): Promise<string> {
    const result = await this.exec(args);
    if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "Herdr request failed.");
    return result.stdout;
  }

  async caller(): Promise<string> {
    return paneId(resultOf(await this.request(["pane", "current", "--current"])).pane);
  }

  async direction(caller: string): Promise<"right" | "down"> {
    const layout = resultOf(await this.request(["pane", "layout", "--pane", caller])).layout as {
      panes?: Array<{ pane_id: string; rect?: { width: number; height: number } }>;
    } | undefined;
    const rect = layout?.panes?.find(pane => pane.pane_id === caller)?.rect;
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) throw new Error("Cannot determine the calling pane's size.");
    return rect.width >= rect.height * 2 ? "right" : "down";
  }

  async split(caller: string, direction: "right" | "down", cwd: string): Promise<string> {
    const result = resultOf(await this.request(["pane", "split", "--pane", caller, "--direction", direction, "--cwd", cwd, "--no-focus"]));
    return paneId(result.pane);
  }

  async waitForShell(pane: string, timeout = 5_000): Promise<void> {
    const deadline = Date.now() + timeout;
    do {
      const result = resultOf(await this.request(["pane", "process-info", "--pane", pane]));
      const info = result.process_info as { shell_pid?: number; foreground_processes?: Array<{ pid: number }> } | undefined;
      if (info?.shell_pid && info.foreground_processes?.length && info.foreground_processes.every(process => process.pid === info.shell_pid)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`New pane ${pane} did not reach an available shell prompt.`);
  }

  async rename(pane: string, title: string): Promise<void> {
    await this.request(["pane", "rename", pane, title]);
  }

  async run(pane: string, command: string): Promise<void> {
    await this.request(["pane", "run", pane, command]);
  }

  async close(pane: string): Promise<void> {
    await this.request(["pane", "close", pane]);
  }
}
