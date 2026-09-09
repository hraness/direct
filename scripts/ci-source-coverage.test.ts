import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a source contract object");
  }
  return value as RecordValue;
}

const manifest = record(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
const workflow = record(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const phases = [
  "typecheck", "check:effect", "test:npm-release", "build", "test:package", "test", "lint",
  "example:test", "example:typecheck", "example:verify", "example:react-native:test",
  "example:react-native:typecheck", "example:react-native:verify",
];
const commands = {
  typecheck: "tsc --noEmit",
  "check:effect": "bun run scripts/effect-policy.ts && bun test scripts/check-effect-architecture.test.ts",
  build: "bun run build:clean && bun run build:runtime && bun run build:tooling",
  "test:package": "bun run ./scripts/package-smoke.ts",
  test: "bun test ./src",
  lint: "eslint src examples scripts",
  "example:test": "bun test ./examples/todos",
  "example:typecheck": "tsc -p examples/todos/tsconfig.json --noEmit",
  "example:verify": "bun run examples/todos/verify.ts",
  "example:react-native:test": "bun run --cwd examples/react-native test",
  "example:react-native:typecheck": "tsc -p examples/react-native/tsconfig.json --noEmit",
  "example:react-native:verify": "bun run examples/react-native/verify.ts",
};

function assertSourceCoverage(packageValue: RecordValue, workflowValue: RecordValue): void {
  const scripts = record(packageValue.scripts);
  expect(scripts.check).toBe(phases.map((phase) => `bun run ${phase}`).join(" && "));
  for (const [name, command] of Object.entries(commands)) expect(scripts[name]).toBe(command);
  const releaseTests = scripts["test:npm-release"];
  expect(typeof releaseTests).toBe("string");
  const releaseArguments = String(releaseTests).split(" ");
  expect(releaseArguments.slice(0, 2)).toEqual(["bun", "test"]);
  expect(releaseArguments.slice(2).every((path) => /^\.\/scripts\/[a-z-]+\.test\.ts$/u.test(path))).toBe(true);
  expect(releaseArguments).toContain("./scripts/npm-publish-workflow.test.ts");
  expect(releaseArguments).toContain("./scripts/ci-source-coverage.test.ts");
  expect(packageValue.packageManager).toBe("bun@1.3.14");
  expect(workflowValue.on).toEqual({ pull_request: null, push: { branches: ["main"] } });
  expect(workflowValue.permissions).toEqual({ contents: "read" });
  const jobs = record(workflowValue.jobs);
  expect(Object.keys(jobs).sort()).toEqual(["check", "required"]);
  const check = record(jobs.check);
  expect(check.if).toBeUndefined();
  expect(check["continue-on-error"]).toBeUndefined();
  expect(check["runs-on"]).toBe("ubuntu-latest");
  expect(check["timeout-minutes"]).toBe(30);
  if (!Array.isArray(check.steps)) throw new TypeError("Missing complete check steps");
  const steps = check.steps.map(record);
  for (const step of steps) {
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeUndefined();
  }
  const runs = steps.map((step) => step.run).filter((run): run is string => typeof run === "string");
  expect(runs).toHaveLength(6);
  expect(runs[0]).toContain("npm install --global npm@11.19.0");
  expect(runs[1]).toBe("bun install --frozen-lockfile --ignore-scripts");
  expect(runs[2]).toBe("bun run check");
  expect(runs[3]).toBe('generated_status="$(git status --porcelain --untracked-files=all -- dist bun.lock)"\nif [[ -n "$generated_status" ]]; then\n  printf \'%s\\n\' "$generated_status"\n  exit 1\nfi\n');
  expect(runs[4]).toBe("bun pm pack --dry-run --ignore-scripts");
  expect(runs[5]).toBe('node --input-type=module -e \'await Promise.all(["./dist/index.js","./dist/core/index.js","./dist/react.js","./dist/testing/index.js","./dist/web.js","./dist/tooling/browser-verification-entry.js","./dist/tooling/bundle-boundary.js"].map((path) => import(path)))\'');
  const required = record(jobs.required);
  expect(required.name).toBe("Required");
  expect(required.if).toBe("always()");
  expect(required.needs).toEqual(["check"]);
  expect(required["continue-on-error"]).toBeUndefined();
  if (!Array.isArray(required.steps) || required.steps.length !== 1) throw new TypeError("Missing Required result gate");
  const gate = record(required.steps[0]);
  expect(gate.if).toBeUndefined();
  expect(gate["continue-on-error"]).toBeUndefined();
  expect(gate.env).toEqual({ CHECK: "${{ needs.check.result }}" });
}

test("complete CI retains the root aggregate, release-contract discovery, and committed-output checks", () => {
  expect(createHash("sha256").update(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url))).digest("hex")).toBe("b47f2d0ead76414025eddf15dedbd940ba8114a53fc93b9efecc78554015aaa0");
  assertSourceCoverage(manifest, workflow);
});

test("coverage admission detects omitted phases, filtered tests, conditional jobs, and ignored failures", () => {
  const mutations = [
    (scripts: RecordValue) => { scripts.check = phases.slice(1).map((phase) => `bun run ${phase}`).join(" && "); },
    (scripts: RecordValue) => { scripts.test = "bun test ./src --test-name-pattern smoke"; },
    (scripts: RecordValue) => { scripts["test:npm-release"] = "bun test ./scripts/npm-publish-workflow.test.ts"; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(manifest);
    mutate(record(changed.scripts));
    expect(() => assertSourceCoverage(changed, workflow)).toThrow();
  }
  for (const [jobName, key, value] of [
    ["check", "if", "false"], ["check", "continue-on-error", true],
    ["check", "timeout-minutes", 1], ["required", "needs", []],
    ["required", "if", "success()"], ["required", "continue-on-error", true],
  ] as const) {
    const changed = structuredClone(workflow);
    record(record(changed.jobs)[jobName])[key] = value;
    expect(() => assertSourceCoverage(manifest, changed)).toThrow();
  }
});

test("the actual Required shell admits success and rejects every non-success result", () => {
  const required = record(record(workflow.jobs).required);
  if (!Array.isArray(required.steps)) throw new TypeError("Missing Required steps");
  const script = record(required.steps[0]).run;
  if (typeof script !== "string") throw new TypeError("Missing Required shell");
  for (const result of ["success", "failure", "cancelled", "skipped", "timed_out", "in_progress", "", "unknown"]) {
    const child = spawnSync("/bin/bash", ["-c", script], {
      env: { CHECK: result, NODE_ENV: "test" }, timeout: 2_000, maxBuffer: 4_096,
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(result === "success" ? 0 : 1);
  }
});
