import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Host, SessionEntry, SessionHeader, SessionReader } from "./types.ts";

interface Message {
  role?: string;
  toolCallId?: string;
  stopReason?: string;
  content?: Array<{ type: string; id?: string }>;
}

/** Don't fork a half-completed tool batch and accidentally replay its effects. */
export function completedBranch(entries: readonly SessionEntry[]): {
  entries: SessionEntry[];
  omitted: number;
} {
  const pending = new Map<string, number>();
  let partialIndex = entries.length;
  entries.forEach((entry, index) => {
    if (entry.type === "compaction" || entry.type === "reset_boundary") pending.clear();
    if (entry.type !== "message") return;
    const message = entry.message as Message;
    if (message.role === "user") pending.clear();
    if (message.role === "assistant") {
      if (message.stopReason === "pending") partialIndex = Math.min(partialIndex, index);
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "toolCall" && block.id) pending.set(block.id, index);
        }
      }
    }
    if (message.role === "toolResult" && message.toolCallId) pending.delete(message.toolCallId);
  });
  const boundary = Math.min(partialIndex, ...pending.values());
  const end = Number.isFinite(boundary) ? boundary : entries.length;
  return { entries: entries.slice(0, end), omitted: entries.length - end };
}

export interface Snapshot {
  header: SessionHeader;
  entries: SessionEntry[];
  sourceFile: string;
  sessionDir: string;
  artifactDir?: string;
  omitted: number;
  fileName: string;
}

/** Synchronous capture is essential: the parent can continue appending after this. */
export function captureSnapshot(reader: SessionReader, cwd: string, host: Host, prompt: string): Snapshot {
  const sourceFile = reader.getSessionFile();
  const sourceHeader = reader.getHeader();
  if (!sourceFile || !sourceHeader) throw new Error("/side needs a persisted session (not --no-session).");
  const branch = JSON.parse(JSON.stringify(reader.getBranch())) as SessionEntry[];
  const completed = completedBranch(branch);
  const now = new Date().toISOString();
  const id = randomUUID();
  const title = `Side: ${prompt.replace(/\s+/g, " ").slice(0, 80) || "conversation"}`;
  const header: SessionHeader = {
    ...JSON.parse(JSON.stringify(sourceHeader)),
    type: "session",
    id,
    timestamp: now,
    cwd,
    parentSession: sourceFile,
  };
  // A child owns its native and provider identity; don't inherit relocation aliases.
  delete header.providerPromptCacheKey;
  delete header.previousSessionFiles;
  if (host === "omp") {
    header.title = title;
    header.titleSource = "user";
  }
  const entries = completed.entries;
  entries.push({
    type: host === "pi" ? "session_info" : "title_change",
    id: randomUUID(),
    parentId: entries.at(-1)?.id ?? null,
    timestamp: now,
    ...(host === "pi" ? { name: title } : { title, source: "user", trigger: "side" }),
  });
  return {
    header,
    entries,
    sourceFile,
    sessionDir: reader.getSessionDir(),
    artifactDir: host === "omp" ? reader.getArtifactsDir?.() ?? undefined : undefined,
    omitted: completed.omitted,
    fileName: `${now.replace(/[:.]/g, "-")}_${id}.jsonl`,
  };
}

export interface SavedSnapshot {
  sessionFile: string;
  artifactDir?: string;
}

export async function saveSnapshot(snapshot: Snapshot): Promise<SavedSnapshot> {
  await mkdir(snapshot.sessionDir, { recursive: true, mode: 0o700 });
  const sessionFile = join(snapshot.sessionDir, snapshot.fileName);
  const artifactDir = snapshot.artifactDir ? sessionFile.slice(0, -".jsonl".length) : undefined;
  // Exclusive creation: an existing file must never be overwritten or cleaned up.
  await writeFile(sessionFile, `${[snapshot.header, ...snapshot.entries].map(value => JSON.stringify(value)).join("\n")}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  try {
    if (snapshot.artifactDir && artifactDir) {
      let source: string | undefined;
      try { source = await realpath(snapshot.artifactDir); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (source && (await stat(source)).isDirectory()) {
        await cp(source, artifactDir, { recursive: true, force: false, errorOnExist: true, mode: constants.COPYFILE_FICLONE });
      }
    }
  } catch (error) {
    await removeSnapshot({ sessionFile, artifactDir });
    throw error;
  }
  return { sessionFile, artifactDir };
}

export async function removeSnapshot(saved: SavedSnapshot): Promise<void> {
  await rm(saved.sessionFile, { force: true });
  if (saved.artifactDir) await rm(saved.artifactDir, { recursive: true, force: true });
}
