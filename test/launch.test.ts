import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { childArgs, childEnvironment, runtimeCommand, shellQuote, validatePrompt, writeLaunchFile } from "../src/launch.ts";

const exec = promisify(execFile);

for (const host of ["pi", "omp"] as const) {
  test(`${host}: opens the saved child directly with the parent's model and tools`, () => {
    const args = childArgs({ host, sessionFile: "/tmp/child.jsonl", sessionDir: "/tmp", model: { provider: "provider", id: "model" }, thinking: "high", tools: ["read", "bash"], prompt: "@file /reload --print" });
    assert.deepEqual(args.slice(0, 4), [host === "pi" ? "--session" : "--resume", "/tmp/child.jsonl", "--session-dir", "/tmp"]);
    assert.ok(args.includes("provider"));
    assert.ok(args.includes("read,bash"));
    assert.deepEqual(args.slice(-2), ["--", "Side task:\n\n@file /reload --print"]);
  });
}

test("an empty prompt opens an idle fork; disabled tools stay disabled", () => {
  const args = childArgs({ host: "pi", sessionFile: "/tmp/c.jsonl", sessionDir: "/tmp", tools: [], prompt: "" });
  assert.ok(args.includes("--no-tools"));
  assert.ok(!args.includes("--"));
});

test("does not leak parent pane/session identifiers into the child", () => {
  const env = childEnvironment({ HERDR_PANE_ID: "parent-pane", HERDR_SOCKET_PATH: "parent-socket", PI_SESSION_ID: "parent-session", PI_SESSION_FILE: "parent.jsonl", TERM: "old-term", PWD: "/old", OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/config", TEST_API_KEY: "key", HTTPS_PROXY: "proxy" });
  assert.deepEqual(env, { OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/config", TEST_API_KEY: "key", HTTPS_PROXY: "proxy" });
});

test("private one-shot launcher preserves literal prompts and credentials without shell evaluation", async t => {
  const root = await mkdtemp(join(tmpdir(), "side-launch-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "arguments.json");
  const malicious = `quotes ' \" ; $(touch ${join(root, "injected")})\nsecond line 🐈`;
  const code = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({args:process.argv.slice(2), key:process.env.SIDE_TEST_KEY, pane:process.env.HERDR_PANE_ID}))";
  const file = await writeLaunchFile([process.execPath, "-e", code], [output, malicious], { SIDE_TEST_KEY: malicious, HERDR_PANE_ID: "parent" });
  assert.equal((await stat(file.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file.file)).mode & 0o777, 0o600);
  await exec("sh", [file.file], { env: { PATH: process.env.PATH, HERDR_PANE_ID: "new-pane" } });
  assert.deepEqual(JSON.parse(await readFile(output, "utf8")), { args: [malicious], key: malicious, pane: "new-pane" });
  await assert.rejects(access(join(root, "injected")));
  await assert.rejects(access(file.directory));
});

test("runtime command uses the exact current executable and script", () => {
  assert.deepEqual(runtimeCommand("omp", "/runtime/bun", "/omp/cli.js"), ["/runtime/bun", "/omp/cli.js"]);
  assert.deepEqual(runtimeCommand("pi", "/runtime/node", "cli.js"), ["pi"]);
});

test("rejects NULs and oversized prompts", () => {
  assert.throws(() => shellQuote("x\0y"), /NUL/);
  assert.throws(() => validatePrompt("x\0y"), /NUL/);
  assert.throws(() => validatePrompt("x".repeat(65537)), /64 KiB/);
  validatePrompt("x".repeat(65536));
});
