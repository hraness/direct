import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { verifySupportHelper } from "./support-helper-contract.js";

const root = join(import.meta.dir, "..");

test("the standalone skill carries its own relocatable support protocol and isolated preferences", async () => {
  await verifySupportHelper(join(root, "skills", "direct"));
}, 30_000);

test("the committed helper matches reviewed immutable inputs and the Node build", () => {
  const result = spawnSync(process.execPath, ["scripts/build-support-helper.ts", "--check"], {
    cwd: root, env: process.env, encoding: "utf8", timeout: 10_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
});
