import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a source contract object");
  }
  return value as RecordValue;
}

const manifest = record(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")));
const workflow = record(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")));
const releaseWorkflow = record(Bun.YAML.parse(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8")));
const canonicalPackScript = 'set -euo pipefail\npackage_directory="$(mktemp -d "$RUNNER_TEMP/direct-canonical-ci.XXXXXX")"\nbun --no-env-file --config=/dev/null run ./scripts/prepare-npm-package.ts "$package_directory"\ncat "$package_directory/npm-pack.json"\n';
const canonicalPackStep = "      - name: Verify canonical npm archive\n        run: |\n"
  + canonicalPackScript.trimEnd().split("\n").map((line) => `          ${line}\n`).join("");
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
  expect(runs).toHaveLength(7);
  expect(runs[0]).toContain("npm install --global npm@11.19.0");
  expect(runs[1]).toBe("bun install --frozen-lockfile --ignore-scripts");
  expect(runs[2]).toBe("bun run check");
  expect(runs[3]).toBe('generated_status="$(git status --porcelain --untracked-files=all -- dist bun.lock)"\nif [[ -n "$generated_status" ]]; then\n  printf \'%s\\n\' "$generated_status"\n  exit 1\nfi\n');
  expect(runs[4]).toBe("bun pm pack --dry-run --ignore-scripts");
  expect(runs[5]).toBe('node --input-type=module -e \'await Promise.all(["./dist/index.js","./dist/core/index.js","./dist/react.js","./dist/testing/index.js","./dist/web.js","./dist/tooling/browser-verification-entry.js","./dist/tooling/bundle-boundary.js"].map((path) => import(path)))\'');
  expect(runs[6]).toBe(canonicalPackScript);
  const node = steps.find((step) => String(step.uses).startsWith("actions/setup-node@"));
  expect(record(node?.with)["node-version"]).toBe("24.18.1");
  expect(record(node?.with)["package-manager-cache"]).toBe(false);
  const releaseVerify = record(record(releaseWorkflow.jobs).verify);
  if (!Array.isArray(releaseVerify.steps)) throw new TypeError("Missing canonical release verification steps");
  const releaseSteps = releaseVerify.steps.map(record);
  const releaseNode = releaseSteps.find((step) => String(step.uses).startsWith("actions/setup-node@"));
  expect(record(node?.with)["node-version"]).toBe(record(releaseNode?.with)["node-version"]);
  expect(releaseSteps.some((step) => step.run === "npm install --global --ignore-scripts npm@11.19.0 --registry=https://registry.npmjs.org")).toBe(true);
  expect(releaseSteps.some((step) => typeof step.run === "string"
    && step.run.includes('bun --no-env-file --config=/dev/null run ./scripts/prepare-npm-package.ts "$release_directory"'))).toBe(true);
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
  const current = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  // Removing only this additive pack gate and its Node patch pin must recover all prior CI bytes.
  const prior = current.replace(canonicalPackStep, "").replace('node-version: "24.18.1"', 'node-version: "24"');
  expect(createHash("sha256").update(prior).digest("hex")).toBe("b47f2d0ead76414025eddf15dedbd940ba8114a53fc93b9efecc78554015aaa0");
  assertSourceCoverage(manifest, workflow);
});

test("canonical packing refuses helper, toolchain, conditional, and failure-propagation drift", () => {
  const mutations = [
    (steps: RecordValue[]) => { steps.pop(); },
    (steps: RecordValue[]) => { record(steps.at(-1)).run = "bun pm pack --dry-run --ignore-scripts"; },
    (steps: RecordValue[]) => { record(steps.at(-1)).run = `${canonicalPackScript.trimEnd()} || true\n`; },
    (steps: RecordValue[]) => { record(steps.at(-1)).if = "false"; },
    (steps: RecordValue[]) => { record(steps.at(-1))["continue-on-error"] = true; },
    (steps: RecordValue[]) => {
      record(steps.find((step) => String(step.uses).startsWith("actions/setup-node@"))?.with)["node-version"] = "24";
    },
    (steps: RecordValue[]) => {
      const pin = steps.find((step) => step.name === "Pin npm");
      record(pin).run = String(pin?.run).replaceAll("11.19.0", "11.18.0");
    },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(workflow);
    const check = record(record(changed.jobs).check);
    if (!Array.isArray(check.steps)) throw new TypeError("Missing check steps");
    mutate(check.steps as RecordValue[]);
    expect(() => assertSourceCoverage(manifest, changed)).toThrow();
  }
});

test("the actual canonical pack shell uses a fresh directory and propagates preparation failure", () => {
  const check = record(record(workflow.jobs).check);
  if (!Array.isArray(check.steps)) throw new TypeError("Missing check steps");
  const step = check.steps.map(record).find((value) => value.name === "Verify canonical npm archive");
  if (typeof step?.run !== "string") throw new TypeError("Missing canonical pack shell");
  for (const exitCode of [0, 23]) {
    const root = mkdtempSync(join(tmpdir(), "direct-ci-pack-shell-"));
    try {
      const child = spawnSync("/bin/bash", ["-c", `
bun() {
  printf '%s\\n' "$@" > "$RUNNER_TEMP/invocation"
  if [[ "$PREPARE_EXIT" != 0 ]]; then return "$PREPARE_EXIT"; fi
  printf '[]\\n' > "$5/npm-pack.json"
}
${step.run}printf 'canonical-complete\\n'
`], {
        env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", RUNNER_TEMP: root, PREPARE_EXIT: String(exitCode) },
        timeout: 2_000, maxBuffer: 4_096, encoding: "utf8",
      });
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(exitCode);
      const args = readFileSync(join(root, "invocation"), "utf8").trimEnd().split("\n");
      expect(args.slice(0, 4)).toEqual(["--no-env-file", "--config=/dev/null", "run", "./scripts/prepare-npm-package.ts"]);
      const directory = args[4];
      if (directory === undefined) throw new TypeError("Missing canonical output directory");
      expect(directory.startsWith(`${root}/direct-canonical-ci.`)).toBe(true);
      expect(readdirSync(directory)).toEqual(exitCode === 0 ? ["npm-pack.json"] : []);
      expect(existsSync(join(directory, "npm-pack.json"))).toBe(exitCode === 0);
      expect(child.stdout).toBe(exitCode === 0 ? "[]\ncanonical-complete\n" : "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
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
