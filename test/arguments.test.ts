import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSideArguments, validateName } from "../src/arguments.ts";

for (const [input, name, prompt] of [
  ["", undefined, ""],
  ["  Investigate this\nwithout changing files.  ", undefined, "Investigate this\nwithout changing files."],
  ['--name "Webhook audit" Investigate idempotency.', "Webhook audit", "Investigate idempotency."],
  ["--name 'Webhook audit'", "Webhook audit", ""],
  ["--name Audit Inspect this", "Audit", "Inspect this"],
  ['--name="Webhook audit" Inspect this', "Webhook audit", "Inspect this"],
  ["--name=Audit Inspect this", "Audit", "Inspect this"],
  ['--name "Say \\"hello\\"" task', 'Say "hello"', "task"],
  ["--name Webhook\\ audit task", "Webhook audit", "task"],
  ['--name "$(touch /tmp/nope); `id`" task', "$(touch /tmp/nope); `id`", "task"],
  ['--name Audit -- @file /reload --print "quoted"\nsecond line', "Audit", '@file /reload --print "quoted"\nsecond line'],
  ['-- --name "literal prompt"', undefined, '--name "literal prompt"'],
  ["--print keep old option-like prompts", undefined, "--print keep old option-like prompts"],
  ['Explain --name "without parsing it"', undefined, 'Explain --name "without parsing it"'],
  ['--name Audit Explain --name "without parsing it"', "Audit", 'Explain --name "without parsing it"'],
] as const) {
  test(`parses ${JSON.stringify(input)}`, () => {
    assert.deepEqual(parseSideArguments(input), { name, prompt });
  });
}

for (const input of ["--name", "--name=", "--name -- task", '--name "" task', "--name 'unterminated", '--name "unfinished\\', "--name Audit --name Again task", '--name "line\nbreak" task', '--name "\u001b[31m" task', '--name "\u0000" task', `--name "${"x".repeat(81)}" task`]) {
  test(`rejects invalid name arguments ${JSON.stringify(input)}`, () => {
    assert.throws(() => parseSideArguments(input), /name|--name/);
  });
}

test("names are trimmed, accept Unicode, and count code points instead of UTF-16 units", () => {
  assert.equal(validateName("  Webhook audit  "), "Webhook audit");
  assert.equal(validateName("🔎".repeat(80)), "🔎".repeat(80));
  assert.throws(() => validateName(" "), /empty/);
});
