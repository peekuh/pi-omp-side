import assert from "node:assert/strict";
import { test } from "node:test";
import { sideTitle } from "../src/naming.ts";

const base = { parentName: "Pi setup", cwd: "/home/user/project", prompt: "Investigate context limits.\nDon't change files.", id: "a31f0000-0000-4000-8000-000000000000" };

test("names include the parent, explicit task label, and child's short native ID", () => {
  assert.equal(sideTitle({ ...base, name: "Context limits" }), "Pi setup ↳ Context limits · a31f");
});

test("automatic labels use only the first prompt line, or Explore for idle forks", () => {
  assert.equal(sideTitle(base), "Pi setup ↳ Investigate context limits. · a31f");
  assert.equal(sideTitle({ ...base, prompt: "" }), "Pi setup ↳ Explore · a31f");
});

test("unnamed sessions fall back to the working directory", () => {
  assert.equal(sideTitle({ ...base, parentName: undefined, name: "Audit" }), "project ↳ Audit · a31f");
  assert.equal(sideTitle({ ...base, parentName: " ", cwd: "/", name: "Audit" }), "Workspace ↳ Audit · a31f");
});

test("nested forks use the immediate parent's task instead of growing the title", () => {
  assert.equal(sideTitle({ ...base, parentName: "Pi setup ↳ FFF evaluation · b72e", name: "Ranking tests" }), "FFF evaluation ↳ Ranking tests · a31f");
});

test("long automatic labels and parent names are bounded without splitting Unicode code points", () => {
  const title = sideTitle({ ...base, parentName: "🔎".repeat(61), prompt: "🧪".repeat(81) });
  assert.equal(title, `${"🔎".repeat(59)}… ↳ ${"🧪".repeat(79)}… · a31f`);
});

test("automatic text is safe for a single-line pane label", () => {
  assert.equal(sideTitle({ ...base, parentName: "Pi\nsetup\u001b", prompt: "Audit\tthis\u0000" }), "Pi setup ↳ Audit this · a31f");
});

test("different child IDs distinguish repeated tasks", () => {
  assert.notEqual(sideTitle(base), sideTitle({ ...base, id: "b72e0000-0000-4000-8000-000000000000" }));
});
