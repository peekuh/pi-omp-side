import { basename } from "node:path";
import { MAX_NAME_LENGTH, validateName } from "./arguments.ts";

function shorten(value: string, limit: number): string {
  const characters = [...value];
  return characters.length <= limit ? value : `${characters.slice(0, limit - 1).join("")}…`;
}

function clean(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Human-readable labels never replace the child's independent native UUID. */
export function sideTitle(options: { parentName?: string; cwd: string; prompt: string; id: string; name?: string }): string {
  const parentName = clean(options.parentName ?? "");
  // A fork of a fork uses the immediate parent's task, not an ever-growing lineage.
  const parentTask = /^.* ↳ (.+) · [0-9a-f]{4}$/u.exec(parentName)?.[1];
  const parent = shorten(parentTask || parentName || clean(basename(options.cwd)) || "Workspace", 60);
  const label = options.name === undefined
    ? shorten(clean(options.prompt.trim().split(/\r?\n/u)[0]) || "Explore", MAX_NAME_LENGTH)
    : validateName(options.name);
  return `${parent} ↳ ${label} · ${options.id.slice(0, 4)}`;
}
