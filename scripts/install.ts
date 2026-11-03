import { lstat, mkdir, readFile, readlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Refuse to overwrite an unrelated /side implementation. */
export async function installAdapter(host: "pi" | "omp", agentDir: string, uninstall = false): Promise<string> {
  const target = join(root, `${host}.ts`);
  const destination = join(agentDir, "extensions", "side.ts");
  const content = `// Managed by pi-omp-side. Run its installer to update or remove.\nexport { default } from ${JSON.stringify(target)};\n`;
  let existing: "link" | "wrapper" | undefined;
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() && resolve(dirname(destination), await readlink(destination)) === target) existing = "link";
    else if (info.isFile() && await readFile(destination, "utf8") === content) existing = "wrapper";
    else throw new Error(`Refusing to replace an unrelated file: ${destination}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (uninstall) {
    if (existing) await unlink(destination);
  } else if (existing !== "wrapper") {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (existing === "link") await unlink(destination);
    // Pi's Jiti loader resolves a symlinked entrypoint's relative imports from
    // the link directory. A tiny absolute-import wrapper works in both hosts.
    await writeFile(destination, content, { flag: "wx", mode: 0o600 });
  }
  return destination;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let piDir = join(homedir(), ".pi", "agent");
  let ompDir = join(homedir(), ".omp", "agent");
  let uninstall = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--uninstall") uninstall = true;
    else if (args[index] === "--pi-dir" && args[index + 1]) piDir = resolve(args[++index]);
    else if (args[index] === "--omp-dir" && args[index + 1]) ompDir = resolve(args[++index]);
    else throw new Error(`Unknown or incomplete option: ${args[index]}`);
  }
  for (const [host, directory] of [["pi", piDir], ["omp", ompDir]] as const) {
    const path = await installAdapter(host, directory, uninstall);
    console.log(`${uninstall ? "Removed" : "Installed"} ${host}: ${path}`);
  }
  console.log("Reload or restart Pi and OMP to apply the change.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
