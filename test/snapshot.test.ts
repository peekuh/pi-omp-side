import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureSnapshot, completedBranch, saveSnapshot } from "../src/snapshot.ts";
import type { SessionEntry, SessionReader } from "../src/types.ts";

function fixture(dir: string): { reader: SessionReader; branch: SessionEntry[] } {
  const branch: SessionEntry[] = [
    { type: "model_change", id: "model", parentId: null, provider: "test", modelId: "test-model" },
    { type: "message", id: "user", parentId: "model", message: { role: "user", content: "original task" } },
    { type: "message", id: "answer", parentId: "user", message: { role: "assistant", content: [{ type: "text", text: "original answer" }] } },
  ];
  return {
    branch,
    reader: {
      getHeader: () => ({ type: "session", version: 3, id: "parent", cwd: dir, providerPromptCacheKey: "parent-cache", additionalDirectories: ["/extra"] }),
      getSessionFile: () => join(dir, "parent.jsonl"),
      getSessionDir: () => dir,
      getBranch: () => branch,
      getArtifactsDir: () => join(dir, "parent"),
    },
  };
}

for (const host of ["pi", "omp"] as const) {
  test(`${host}: creates independent native identity without touching the parent`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "side-snapshot-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { reader, branch } = fixture(dir);
    const parent = JSON.stringify(branch);
    const snapshot = captureSnapshot(reader, dir, host, "investigate");
    assert.notEqual(snapshot.header.id, "parent");
    assert.equal(snapshot.header.providerPromptCacheKey, undefined);
    assert.equal(snapshot.header.parentSession, join(dir, "parent.jsonl"));
    assert.deepEqual(snapshot.header.additionalDirectories, ["/extra"]);
    assert.equal(JSON.stringify(branch), parent);
    branch[1].message = { role: "user", content: "changed after capture" };
    branch.push({ type: "custom", id: "later", parentId: "answer" });
    const saved = await saveSnapshot(snapshot);
    const content = await readFile(saved.sessionFile, "utf8");
    assert.ok(content.includes("original task"));
    assert.ok(!content.includes("changed after capture"));
    assert.ok(!content.includes('"later"'));
    assert.equal((await stat(saved.sessionFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(content.split("\n")[0]).id, snapshot.header.id);
    const second = captureSnapshot(reader, dir, host, "another task");
    assert.notEqual(second.header.id, snapshot.header.id);
  });
}

test("omits an unfinished parallel tool batch, including already completed siblings", () => {
  const { branch } = fixture("/tmp");
  branch.push(
    { type: "message", id: "tools", parentId: "answer", message: { role: "assistant", content: [{ type: "toolCall", id: "one" }, { type: "toolCall", id: "two" }] } },
    { type: "message", id: "result", parentId: "tools", message: { role: "toolResult", toolCallId: "one" } },
  );
  assert.deepEqual(completedBranch(branch), { entries: branch.slice(0, 3), omitted: 2 });
  branch.push({ type: "message", id: "result2", parentId: "result", message: { role: "toolResult", toolCallId: "two" } });
  assert.deepEqual(completedBranch(branch), { entries: branch, omitted: 0 });
});

test("preserves compactions, context edits, and unknown host entries", () => {
  const { branch } = fixture("/tmp");
  branch.push(
    { type: "compaction", id: "compact", parentId: "answer", firstKeptEntryId: "answer", summary: "keep" },
    { type: "context_edit", id: "edit", parentId: "compact", targetId: "user", replacement: null },
    { type: "future-entry", id: "future", parentId: "edit", payload: { anything: true } },
  );
  assert.deepEqual(completedBranch(branch).entries, branch);
});

test("partial streaming messages are not inherited", () => {
  const { branch } = fixture("/tmp");
  branch.push({ type: "message", id: "partial", parentId: "answer", message: { role: "assistant", stopReason: "pending", content: [] } });
  assert.equal(completedBranch(branch).omitted, 1);
});

test("OMP artifacts are copied into the child's own artifact directory", async t => {
  const dir = await mkdtemp(join(tmpdir(), "side-artifact-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "parent"));
  await writeFile(join(dir, "parent", "1.read.log"), "original artifact");
  const { reader } = fixture(dir);
  const saved = await saveSnapshot(captureSnapshot(reader, dir, "omp", "read artifact"));
  assert.equal(await readFile(join(saved.artifactDir!, "1.read.log"), "utf8"), "original artifact");
  await writeFile(join(saved.artifactDir!, "1.read.log"), "child change");
  assert.equal(await readFile(join(dir, "parent", "1.read.log"), "utf8"), "original artifact");
});

test("refuses ephemeral sessions", () => {
  const { reader } = fixture("/tmp");
  reader.getSessionFile = () => undefined;
  assert.throws(() => captureSnapshot(reader, "/tmp", "pi", "task"), /persisted/);
});

test("existing child files are never overwritten or removed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "side-exclusive-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { reader } = fixture(dir);
  const snapshot = captureSnapshot(reader, dir, "pi", "task");
  const saved = await saveSnapshot(snapshot);
  const before = await readFile(saved.sessionFile, "utf8");
  await assert.rejects(saveSnapshot(snapshot), { code: "EEXIST" });
  assert.equal(await readFile(saved.sessionFile, "utf8"), before);
});
