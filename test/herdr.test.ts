import assert from "node:assert/strict";
import { test } from "node:test";
import { Herdr, resultOf } from "../src/herdr.ts";
import type { Exec } from "../src/types.ts";

function fakeExec(width = 120, height = 40) {
  const calls: string[][] = [];
  const exec: Exec = async args => {
    calls.push(args);
    let result: unknown = {};
    if (args[1] === "current") result = { pane: { pane_id: "w1:p8" } };
    if (args[1] === "layout") result = { layout: { panes: [{ pane_id: "w1:p8", rect: { width, height } }] } };
    if (args[1] === "split") result = { pane: { pane_id: "w1:p99" } };
    if (args[1] === "process-info") result = { process_info: { shell_pid: 77, foreground_processes: [{ pid: 77 }] } };
    return { code: 0, stdout: JSON.stringify({ result }), stderr: "" };
  };
  return { calls, exec };
}

test("targets caller context, uses returned IDs, and never focuses the child", async () => {
  const { calls, exec } = fakeExec();
  const herdr = new Herdr(exec);
  const caller = await herdr.caller();
  const direction = await herdr.direction(caller);
  const child = await herdr.split(caller, direction, "/project with spaces");
  await herdr.waitForShell(child);
  await herdr.run(child, "sh '/private/launch.sh'");
  assert.deepEqual(calls[0], ["pane", "current", "--current"]);
  assert.deepEqual(calls[2], ["pane", "split", "--pane", "w1:p8", "--direction", "right", "--cwd", "/project with spaces", "--no-focus"]);
  assert.deepEqual(calls[4], ["pane", "run", "w1:p99", "sh '/private/launch.sh'"]);
  assert.ok(calls.every(args => !args.includes("--focus") && args[1] !== "focus"));
});

test("splits narrow panes down instead of making unusably narrow columns", async () => {
  const { exec } = fakeExec(60, 40);
  assert.equal(await new Herdr(exec).direction("w1:p8"), "down");
});

test("refuses to type into a pane with a foreground process", async () => {
  const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify({ result: { process_info: { shell_pid: 77, foreground_processes: [{ pid: 88 }] } } }), stderr: "" });
  await assert.rejects(new Herdr(exec).waitForShell("w1:p99", 1), /available shell/);
});

test("surfaces protocol and CLI failures", async () => {
  assert.throws(() => resultOf("invalid"));
  assert.throws(() => resultOf('{"error":{"message":"not found"}}'), /not found/);
  assert.throws(() => resultOf("{}"), /no result/);
  const herdr = new Herdr(async () => ({ code: 1, stdout: "", stderr: "server unavailable" }));
  await assert.rejects(herdr.caller(), /server unavailable/);
});
