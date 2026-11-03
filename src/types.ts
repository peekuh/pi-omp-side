export type Host = "pi" | "omp";

export interface SessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  [key: string]: unknown;
}

export interface SessionHeader {
  type: "session";
  id: string;
  version?: number;
  cwd: string;
  [key: string]: unknown;
}

/** The read-only session surface shared by the two hosts. */
export interface SessionReader {
  getHeader(): SessionHeader | null;
  getSessionFile(): string | undefined;
  getSessionDir(): string;
  getBranch(): SessionEntry[];
  getSessionName?(): string | undefined;
  getArtifactsDir?(): string | null;
}

export interface SideContext {
  mode: string;
  hasUI: boolean;
  cwd: string;
  model?: { provider: string; id: string };
  sessionManager: SessionReader;
  ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
}

export interface SideAPI {
  registerCommand(name: string, command: {
    description: string;
    handler(args: string, context: SideContext): Promise<void>;
  }): void;
  getActiveTools(): string[];
  getThinkingLevel(): string | undefined;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Exec = (args: string[]) => Promise<ExecResult>;
