import { resolve } from "node:path";
import { createArchitectureProgram, inspectEffectArchitecture } from "./check-effect-architecture.js";

const root = resolve(import.meta.dir, "..");
const findings = inspectEffectArchitecture(createArchitectureProgram(resolve(root, "tsconfig.json")), {
  root,
  modules: ["src/effect/driver.ts", "src/effect/deadline.ts", "src/effect/index.ts", "src/effect/supervisor.ts", "examples/effect/document-controller.ts"],
  adapters: ["src/effect/driver.ts", "src/effect/deadline.ts"],
  runtimeRoots: ["src/effect/driver.ts"],
  ignoredDirectories: ["scripts"],
});
for (const finding of findings) console.error(`${finding.file}:${String(finding.line)} ${finding.rule}: ${finding.message}`);
if (findings.length > 0) process.exitCode = 1;
