import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runVerificationCommand } from "../../src/tooling/browser-verification.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
for (const target of ["production", "direct"] as const) {
  const output = await runVerificationCommand({
    command: ["node", "--experimental-strip-types", "examples/todos/build.ts", target],
    cwd: root,
    label: `Compiled Todo ${target} boundary`,
    timeoutMs: 120_000,
  });
  console.log(`Todo ${target} source-map and marker boundary passed.\n${output.trim()}`);
}
