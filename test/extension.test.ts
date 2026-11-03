import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import piExtension from "../pi.ts";
import ompExtension from "../omp.ts";
import { runSide } from "../src/extension.ts";
import { Herdr } from "../src/herdr.ts";
import type { Exec, Host, SideAPI, SideContext } from "../src/types.ts";

const exec = promisify(execFile);

async function setup(t: { after(fn: () => Promise<void>): void }, failure?: string) {
  const dir = await mkdtemp(join(tmpdir(), "side-handler-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const parentFile = join(dir, "parent.jsonl");
  await writeFile(parentFile, "parent must not change\n");
  const branch = [{ type: "message", id: "root", parentId: null, message: { role: "user", content: "existing conversation" } }];
  const notices: string[] = [];
  const ctx: SideContext = {
    mode: "tui", hasUI: true, cwd: dir, model: { provider: "test", id: "model" },
    ui: { notify: text => { notices.push(text); } },
    sessionManager: {
      getSessionFile: () => parentFile,
      getSessionDir: () => dir,
      getHeader: () => ({ type: "session", version: 3, id: "parent-id", cwd: dir }),
      getBranch: () => branch,
    },
  };
  const calls: string[][] = [];
  const runner: Exec = async args => {
    calls.push(args);
    if (args[1] === failure) return { code: 1, stdout: "", stderr: `failed ${failure}` };
    let result: unknown = {};
    if (args[1] === "current") result = { pane: { pane_id: "w1:p1" } };
    if (args[1] === "layout") result = { layout: { panes: [{ pane_id: "w1:p1", rect: { width: 150, height: 40 } }] } };
    if (args[1] === "split") result = { pane: { pane_id: "w1:p2" } };
    if (args[1] === "process-info") result = { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1 }] } };
    return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
  };
  const api: SideAPI = {
    registerCommand: () => {},
    getActiveTools: () => ["read", "bash"],
    getThinkingLevel: () => "high",
  };
  return { ctx, api, calls, notices, dir, branch, parentFile, dependencies: { environment: { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, command: [process.execPath, "-e", "process.exit(0)", "--"], herdr: new Herdr(runner) } };
}

for (const host of ["pi", "omp"] as Host[]) {
  test(`${host}: delegation changes neither parent history nor file and stays unfocused`, async t => {
    const fixture = await setup(t);
    const { ctx, api, calls, notices, dir, branch, parentFile, dependencies } = fixture;
    const before = JSON.stringify(branch);
    await runSide(api, host, "investigate a tangent", ctx, dependencies);
    assert.equal(JSON.stringify(branch), before);
    assert.equal(await readFile(parentFile, "utf8"), "parent must not change\n");
    const childFile = (await readdir(dir)).find(name => name.endsWith(".jsonl") && name !== "parent.jsonl")!;
    const child = await readFile(join(dir, childFile), "utf8");
    assert.notEqual(JSON.parse(child.split("\n")[0]).id, "parent-id");
    assert.ok(child.includes("existing conversation"));
    const run = calls.find(call => call[1] === "run")!;
    assert.ok(run);
    assert.ok(calls.find(call => call[1] === "split")!.includes("--no-focus"));
    assert.ok(!calls.some(call => call[1] === "focus" || call[1] === "wait"));
    assert.match(notices[0], /Focus stays here/);
    // Execute the private launcher against a fake child, exercising its self-cleanup.
    await exec("sh", ["-c", run[3]]);
  });
}

test("captures the branch before asynchronous Herdr calls", async t => {
  const fixture = await setup(t);
  const original = fixture.dependencies.herdr.caller.bind(fixture.dependencies.herdr);
  fixture.dependencies.herdr.caller = async () => {
    fixture.branch[0].message.content = "changed while awaiting Herdr";
    return original();
  };
  await runSide(fixture.api, "pi", "task", fixture.ctx, fixture.dependencies);
  const child = (await readdir(fixture.dir)).find(file => file.endsWith(".jsonl") && file !== "parent.jsonl")!;
  assert.ok((await readFile(join(fixture.dir, child), "utf8")).includes("existing conversation"));
  await exec("sh", ["-c", fixture.calls.find(call => call[1] === "run")![3]]);
});

test("cleans up only its own pane and fork when startup fails before submission", async t => {
  const fixture = await setup(t, "process-info");
  await runSide(fixture.api, "pi", "task", fixture.ctx, fixture.dependencies);
  assert.deepEqual(await readdir(fixture.dir), ["parent.jsonl"]);
  assert.deepEqual(fixture.calls.at(-1), ["pane", "close", "w1:p2"]);
  assert.ok(fixture.notices.some(notice => notice.includes("failed process-info")));
});

test("ambiguous submission failures keep the child instead of duplicating or killing work", async t => {
  const fixture = await setup(t, "run");
  await runSide(fixture.api, "pi", "task", fixture.ctx, fixture.dependencies);
  assert.equal(fixture.calls.filter(call => call[1] === "run").length, 1);
  assert.ok(!fixture.calls.some(call => call[1] === "close"));
  assert.equal((await readdir(fixture.dir)).filter(file => file.endsWith(".jsonl")).length, 2);
  assert.ok(fixture.notices.some(notice => notice.includes("Inspect the pane before retrying")));
  // The real user can retry the preserved launcher; clean up this test's fake launch.
  const command = fixture.calls.find(call => call[1] === "run")![3];
  await exec("sh", ["-c", command]);
});

test("does not contact Herdr outside an interactive managed pane", async t => {
  const fixture = await setup(t);
  await runSide(fixture.api, "pi", "task", fixture.ctx, { ...fixture.dependencies, environment: {} });
  assert.equal(fixture.calls.length, 0);
  assert.match(fixture.notices[0], /Herdr-managed/);
  assert.deepEqual(await readdir(fixture.dir), ["parent.jsonl"]);
});

test("both adapters register a local slash command, not a model tool or prompt hook", () => {
  for (const extension of [piExtension, ompExtension]) {
    const names: string[] = [];
    extension({ registerCommand: name => { names.push(name); }, getActiveTools: () => [], getThinkingLevel: () => undefined });
    assert.deepEqual(names, ["side"]);
  }
});
