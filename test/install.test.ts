import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installAdapter } from "../scripts/install.ts";

for (const host of ["pi", "omp"] as const) {
  test(`${host}: installation and removal are idempotent and target the correct adapter`, async t => {
    const dir = await mkdtemp(join(tmpdir(), "side-install-test-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const destination = await installAdapter(host, dir);
    assert.ok((await readFile(destination, "utf8")).includes(`/${host}.ts\";`));
    assert.equal(await installAdapter(host, dir), destination);
    await installAdapter(host, dir, true);
    await assert.rejects(lstat(destination), { code: "ENOENT" });
    await installAdapter(host, dir, true);
  });
}

test("never overwrites unrelated files, including broken symlinks", async t => {
  const dir = await mkdtemp(join(tmpdir(), "side-install-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const destination = join(dir, "extensions", "side.ts");
  await mkdir(join(dir, "extensions"));
  await writeFile(destination, "an existing extension");
  await assert.rejects(installAdapter("pi", dir), /unrelated/);
  await assert.rejects(installAdapter("pi", dir, true), /unrelated/);
  assert.equal(await readFile(destination, "utf8"), "an existing extension");
  await rm(destination);
  await symlink("/missing/other-extension.ts", destination);
  await assert.rejects(installAdapter("pi", dir), /unrelated/);
  assert.equal(await readlink(destination), "/missing/other-extension.ts");
});
