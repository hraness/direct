import { afterEach, describe, expect, test } from "bun:test";
import { defineDirect } from "@hraness/direct";
import { createDirectSession } from "@hraness/direct/testing";
import { getEventListeners } from "node:events";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  attestDirectBombadilTrace,
  closeBombadilArtifactCopyHandles,
  createDirectBombadilInvocation,
  inspectBombadilArtifactTreeForTest,
  parseDirectBombadilArtifactReceipt,
  parseDirectBombadilFuzzArguments,
  parseDirectBombadilMatrixReceipt,
  parseDirectBombadilMatrixSummary,
  parseDirectBombadilSanitizedRunSummary,
  resolveDirectBombadilUploadLeaf,
  runBombadilNativeProcess,
  runDirectBombadilFuzz,
  runDirectBombadilFuzzMatrix,
  summarizeDirectBombadilTrace,
  validateDirectBombadilFuzzConfig,
  type DirectBombadilFuzzConfig,
  type DirectBombadilInvocation,
  type DirectBombadilMatrixRunInput,
  type DirectBombadilRunnerDependencies,
} from "./bombadil-runner.js";
import type {
  ManagedVerificationServer,
  ServerLease,
} from "./browser-verification.js";

const ARTIFACT_IO_TEST_TIMEOUT_MS = 30_000;
const temporaryDirectories: string[] = [];

function artifactRunPlan<
  UploadMode extends "private-vetted" | "public-summary" = "public-summary",
>(
  repositoryRoot: string,
  suffix: number,
  uploadMode: UploadMode = "public-summary" as UploadMode,
) {
  return {
    repositoryRoot,
    runId: `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`,
    uploadMode,
  } as const;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
}, ARTIFACT_IO_TEST_TIMEOUT_MS);

function nativeBinaryName(): string {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "bombadil-darwin-arm64";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "bombadil-linux-x64";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "bombadil-linux-arm64";
  }
  throw new Error(`Unsupported test host ${process.platform}-${process.arch}`);
}

async function fixture(): Promise<{
  readonly config: DirectBombadilFuzzConfig;
  readonly repositoryRoot: string;
}> {
  const repositoryRoot = await realpath(
    await mkdtemp(join(tmpdir(), "direct-bombadil-runner-")),
  );
  temporaryDirectories.push(repositoryRoot);
  const productRoot = join(repositoryRoot, "projects", "fixture");
  const specificationPath = join(productRoot, "direct", "bombadil-campaign.ts");
  const packageRoot = join(
    repositoryRoot,
    "node_modules",
    "@antithesishq",
    "bombadil",
  );
  const binaryPath = join(packageRoot, "binaries", nativeBinaryName());
  await mkdir(join(productRoot, "direct"), { recursive: true });
  await mkdir(join(packageRoot, "binaries"), { recursive: true });
  await writeFile(specificationPath, "export const specification = true;\n");
  await writeFile(binaryPath, "fixture native executable\n");
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({ version: "0.7.2" }));

  return {
    repositoryRoot,
    config: {
      artifactName: "fixture-product",
      baseUrl: "http://127.0.0.1:4919",
      expectedRoute: "/surface",
      label: "Fixture Direct Bombadil fuzz",
      repositoryRoot,
      scenario: "surface.ready",
      specificationPath,
      server: {
        command: ["bun", "run", "dev", "--port", "{port}"],
        cwd: productRoot,
        env: { CI: "1" },
        readinessPath: "/ready",
        startupTimeoutMs: 5_000,
      },
    },
  };
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function directObservation(options: {
  readonly activeScenario?: "surface.other" | "surface.ready";
  readonly catalogTitle?: string;
  readonly isQuiescent?: boolean;
  readonly violation?: number;
} = {}): Record<string, unknown> {
  const activeScenario = options.activeScenario ?? "surface.ready";
  let pending = options.isQuiescent === false ? 1 : 0;
  let violation = options.violation ?? 0;
  const definition = defineDirect({
    parseWorld: (input) => {
      if (
        typeof input !== "object"
        || input === null
        || Array.isArray(input)
        || typeof Reflect.get(input, "count") !== "number"
      ) {
        throw new Error("count is required");
      }
      return { count: Reflect.get(input, "count") as number };
    },
    defaultScenario: "surface.ready",
    scenarios: [{
      id: "surface.ready",
      title: options.catalogTitle ?? "Ready surface",
      route: "/surface",
      world: { count: 1 },
    }, {
      id: "surface.other",
      title: "Other surface",
      route: "/other",
      world: { count: 2 },
    }],
    coverage: [{
      key: "surface.visible",
      claim: "The surface is visible.",
      mode: "fixture",
      scenarios: ["surface.ready", "surface.other"],
    }],
  });
  const session = createDirectSession({
    definition,
    activation: { kind: "scenario", scenario: activeScenario },
    create: () => ({}),
    observe: () => ({
      pending: [{ name: "requests", read: () => pending }],
      violations: [{ name: "console", read: () => violation }],
      readRemainingWork: () => null,
    }),
  });
  if (!session.ok) throw new Error(session.error.message);
  pending = options.isQuiescent === false ? 1 : 0;
  violation = options.violation ?? 0;
  const snapshot = session.value.probe.snapshot();
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const manifest = jsonClone(session.value.manifest);
  const probe = jsonClone(snapshot.value);
  return {
    activationHash: manifest.active.activationHash,
    activeRoute: manifest.active.route,
    activeScenario: manifest.active.scenario,
    activeSource: manifest.active.source,
    bridgePresent: true,
    bridgeSchema: "direct.browser-bridge/v2",
    catalogHash: manifest.catalogHash,
    contractValid: true,
    isQuiescent: probe.isQuiescent,
    manifest,
    probe,
    violations: Object.values(probe.violations),
    violationsValid: true,
  };
}

function largeDirectObservation(): Record<string, unknown> {
  const scenarioIds = Array.from({ length: 256 }, (_, index) =>
    `s${String(index).padStart(3, "0")}.${"x".repeat(115)}`
  );
  const firstScenario = scenarioIds[0];
  if (firstScenario === undefined) throw new Error("large Direct fixture needs a scenario");
  const citedScenarios: [string, ...string[]] = [firstScenario, ...scenarioIds.slice(1)];
  const definition = defineDirect({
    parseWorld: (input) => {
      if (
        typeof input !== "object"
        || input === null
        || Array.isArray(input)
        || typeof Reflect.get(input, "count") !== "number"
      ) {
        throw new Error("count is required");
      }
      return { count: Reflect.get(input, "count") as number };
    },
    defaultScenario: firstScenario,
    scenarios: scenarioIds.map((id, index) => ({
      description: "d".repeat(2_000),
      id,
      route: `/surface/${String(index)}`,
      title: "t".repeat(160),
      world: { count: index },
    })),
    coverage: Array.from({ length: 256 }, (_, index) => ({
      claim: "c".repeat(1_000),
      key: `coverage.${String(index)}`,
      mode: "fixture" as const,
      scenarios: citedScenarios,
    })),
  });
  const session = createDirectSession({
    definition,
    activation: { kind: "scenario", scenario: firstScenario },
    create: () => ({}),
  });
  if (!session.ok) throw new Error(session.error.message);
  const snapshot = session.value.probe.snapshot();
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  const manifest = jsonClone(session.value.manifest);
  const probe = jsonClone(snapshot.value);
  return {
    activationHash: manifest.active.activationHash,
    activeRoute: manifest.active.route,
    activeScenario: manifest.active.scenario,
    activeSource: manifest.active.source,
    bridgePresent: true,
    bridgeSchema: "direct.browser-bridge/v2",
    catalogHash: manifest.catalogHash,
    contractValid: true,
    isQuiescent: probe.isQuiescent,
    manifest,
    probe,
    violations: Object.values(probe.violations),
    violationsValid: true,
  };
}

function absentObservation(): Record<string, unknown> {
  return {
    activationHash: "",
    activeRoute: "",
    activeScenario: "",
    activeSource: "",
    bridgePresent: false,
    bridgeSchema: "",
    catalogHash: "",
    contractValid: false,
    isQuiescent: false,
    manifest: null,
    probe: null,
    violations: [],
    violationsValid: false,
  };
}

interface TraceLineOptions {
  readonly action?: unknown;
  readonly namedSnapshots?: readonly { readonly name: string; readonly value: unknown }[];
  readonly url?: string;
  readonly violations?: readonly unknown[];
}

function traceLine(
  observation: unknown,
  timestamp: number,
  options: TraceLineOptions = {},
): string {
  return JSON.stringify({
    timestamp,
    action: options.action ?? null,
    state: {
      url: options.url ?? "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      hash_previous: timestamp === 1 ? null : timestamp - 1,
      hash_current: timestamp,
      screenshot: `/tmp/${String(timestamp)}.png`,
      resources: {
        js_heap_used: timestamp * 10,
        js_heap_total: timestamp * 20,
        dom_nodes: timestamp,
        documents: 1,
        js_event_listeners: timestamp * 2,
        layout_objects: timestamp * 3,
        timestamp,
        thread_time: timestamp / 10,
        task_duration: timestamp / 20,
        script_duration: timestamp / 30,
      },
    },
    snapshots: [
      { index: 0, name: "direct", value: observation, time: timestamp },
      ...(options.namedSnapshots ?? []).map((snapshot, index) => ({
        index: index + 1,
        name: snapshot.name,
        value: snapshot.value,
        time: timestamp,
      })),
    ],
    violations: options.violations ?? [],
  });
}

async function writeTrace(
  tracePath: string,
  observations: readonly unknown[],
  lineOptions: readonly TraceLineOptions[] = [],
): Promise<void> {
  await mkdir(join(tracePath, ".."), { recursive: true });
  await writeFile(
    tracePath,
    `${observations.map((observation, index) =>
      traceLine(observation, index + 1, lineOptions[index])
    ).join("\n")}\n`,
    "utf8",
  );
}

function nestedJson(depth: number): unknown {
  let value: unknown = null;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

function fakeServer(
  calls: string[],
  output: Promise<string> = Promise.resolve("server output"),
): ManagedVerificationServer {
  let exitCode: number | null = null;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  return {
    exited,
    exitCode: () => exitCode,
    output,
    terminate: () => {
      calls.push("terminate");
      exitCode = 0;
      resolveExit();
    },
    kill: () => {
      calls.push("kill");
      exitCode = 137;
      resolveExit();
    },
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the operation to reject");
}

function controllableSignals(): {
  readonly controller: DirectBombadilRunnerDependencies["signalController"];
  readonly emit: (signal: NodeJS.Signals) => void;
  readonly forwarded: NodeJS.Signals[];
  readonly listenerCount: () => number;
} {
  const listeners = new Map<NodeJS.Signals, Set<(signal: NodeJS.Signals) => void>>();
  const forwarded: NodeJS.Signals[] = [];
  return {
    controller: {
      forward: (signal) => {
        forwarded.push(signal);
      },
      once: (signal, listener) => {
        const signalListeners = listeners.get(signal) ?? new Set();
        signalListeners.add(listener);
        listeners.set(signal, signalListeners);
      },
      removeListener: (signal, listener) => {
        listeners.get(signal)?.delete(listener);
      },
    },
    emit: (signal) => {
      const signalListeners = [...(listeners.get(signal) ?? [])];
      listeners.delete(signal);
      for (const listener of signalListeners) listener(signal);
    },
    forwarded,
    listenerCount: () => [...listeners.values()].reduce(
      (total, signalListeners) => total + signalListeners.size,
      0,
    ),
  };
}

function dependencies(options: {
  readonly afterTrace?: (invocation: DirectBombadilInvocation) => Promise<void>;
  readonly exitCode?: number;
  readonly failAcquire?: boolean;
  readonly noTrace?: boolean;
  readonly neverServerOutput?: boolean;
  readonly observations?: readonly unknown[];
  readonly traceLineOptions?: readonly TraceLineOptions[];
  readonly serverOutputTimeoutMs?: number;
  readonly stopFailure?: boolean;
  readonly termination?: "aborted" | "timeout";
} = {}): {
  readonly calls: string[];
  readonly overrides: Partial<DirectBombadilRunnerDependencies>;
  readonly serverCommands: string[][];
} {
  const calls: string[] = [];
  const signals = controllableSignals();
  const serverCommands: string[][] = [];
  const server = fakeServer(
    calls,
    options.neverServerOutput === true
      ? new Promise<string>(() => undefined)
      : Promise.resolve("server output"),
  );
  const dates = [
    new Date("2026-08-26T12:00:00.000Z"),
    new Date("2026-08-26T12:00:01.250Z"),
  ];
  return {
    calls,
    serverCommands,
    overrides: {
      now: () => dates.shift() ?? new Date("2026-08-26T12:00:01.250Z"),
      spawnServer: (serverOptions) => {
        calls.push("spawn-server");
        serverCommands.push([...serverOptions.command]);
        return server;
      },
      acquireServer: (acquireOptions): Promise<ServerLease> => {
        calls.push("acquire-server");
        const started = acquireOptions.startServer();
        if (options.failAcquire === true) {
          return Promise.reject(new Error("listener ownership unknown"));
        }
        return Promise.resolve({ source: "started", server: started });
      },
      runBombadil: (invocation) => {
        calls.push("run-bombadil");
        expect(invocation.command[0]).toEndWith(
          `node_modules/@antithesishq/bombadil/binaries/${nativeBinaryName()}`,
        );
        return (async () => {
          if (options.noTrace === true) {
            await mkdir(invocation.outputPath, { recursive: true });
          } else {
            await writeTrace(
              join(invocation.outputPath, "trace.jsonl"),
              options.observations ?? [absentObservation(), directObservation()],
              options.traceLineOptions,
            );
          }
          await options.afterTrace?.(invocation);
          return {
            exitCode: options.exitCode ?? 0,
            stdout: "bombadil stdout",
            stderr: "bombadil stderr",
            termination: options.termination ?? null,
          };
        })();
      },
      signalController: signals.controller,
      ...(options.serverOutputTimeoutMs === undefined
        ? {}
        : { serverOutputTimeoutMs: options.serverOutputTimeoutMs }),
      stopServer: async (ownedServer) => {
        calls.push("stop-server");
        if (options.stopFailure === true) {
          throw new Error("server cleanup failed");
        }
        if (ownedServer.exitCode() === null) ownedServer.terminate();
        await ownedServer.exited;
      },
    },
  };
}

describe("Direct Bombadil CLI", () => {
  test("parses bounded local overrides and defaults", () => {
    expect(parseDirectBombadilFuzzArguments([], "http://127.0.0.1:5184")).toEqual({
      kind: "run",
      baseUrl: "http://127.0.0.1:5184",
      replayPath: null,
      timeLimitSeconds: 20,
    });
    expect(parseDirectBombadilFuzzArguments([
      "--base-url=http://localhost:6123",
      "--time-limit",
      "45s",
    ], "http://unused.test:1234")).toEqual({
      kind: "run",
      baseUrl: "http://localhost:6123",
      replayPath: null,
      timeLimitSeconds: 45,
    });
    expect(parseDirectBombadilFuzzArguments(["--help"], "invalid")).toEqual({ kind: "help" });
    expect(parseDirectBombadilFuzzArguments([
      "--replay",
      "artifacts/direct-bombadil/fixture/trace.jsonl",
    ], "http://127.0.0.1:5184")).toMatchObject({
      kind: "run",
      replayPath: "artifacts/direct-bombadil/fixture/trace.jsonl",
    });
  });

  test("rejects malformed, remote, ambiguous, and unbounded options", () => {
    expect(() => parseDirectBombadilFuzzArguments([
      "--base-url=https://127.0.0.1:5184",
    ], "http://unused.test:1234")).toThrow("must use HTTP");
    expect(() => parseDirectBombadilFuzzArguments([
      "--base-url=http://example.test:5184",
    ], "http://unused.test:1234")).toThrow("127.0.0.1");
    expect(() => parseDirectBombadilFuzzArguments([
      "--base-url=http://127.0.0.1",
    ], "http://unused.test:1234")).toThrow("explicit local server port");
    expect(() => parseDirectBombadilFuzzArguments([
      "--base-url=http://127.0.0.1:0",
    ], "http://unused.test:1234")).toThrow("between 1 and 65535");
    expect(() => parseDirectBombadilFuzzArguments([
      "--time-limit=11s",
    ], "http://127.0.0.1:5184")).toThrow("between 12s and 300s");
    expect(() => parseDirectBombadilFuzzArguments([
      "--time-limit=301s",
    ], "http://127.0.0.1:5184")).toThrow("between 12s and 300s");
    expect(() => parseDirectBombadilFuzzArguments([
      "--time-limit=12s",
      "--replay=trace.jsonl",
    ], "http://127.0.0.1:5184")).toThrow("cannot be used together");
    expect(() => parseDirectBombadilFuzzArguments([
      "--base-url=http://127.0.0.1:5184",
      "--base-url=http://127.0.0.1:5185",
    ], "http://unused.test:1234")).toThrow("only once");
    expect(() => parseDirectBombadilFuzzArguments([
      "--unknown=secret",
    ], "http://127.0.0.1:5184")).toThrow("position 1");
  });
});

describe("Direct Bombadil configuration and invocation", () => {
  test("validates repository-confined paths and resolves the native binary", async () => {
    const { config } = await fixture();
    const validated = validateDirectBombadilFuzzConfig(config);
    expect(validated.port).toBe("4919");
    expect(validated.entryPath).toBe("/");
    expect(validated.targetQuery).toEqual({});
    expect(validated.server.readinessPath).toBe("/ready");
    expect(validated.viewport).toEqual({
      deviceScaleFactor: 2,
      height: 768,
      width: 1_024,
    });
    expect(validateDirectBombadilFuzzConfig({
      ...config,
      viewport: { deviceScaleFactor: 1.5, height: 720, width: 1_280 },
    }).viewport).toEqual({
      deviceScaleFactor: 1.5,
      height: 720,
      width: 1_280,
    });
    expect(validated.bombadilExecutable).toEndWith(
      `node_modules/@antithesishq/bombadil/binaries/${nativeBinaryName()}`,
    );
  });

  test("orders query and policy artifacts by explicit code units", async () => {
    const { config } = await fixture();
    const validated = validateDirectBombadilFuzzConfig({
      ...config,
      targetQuery: { z: "4", "a.": "3", A: "1", "a-": "2" },
      explorationPolicy: {
        minDistinctNamedSnapshotValues: {
          z: 4,
          "a.": 3,
          A: 1,
          "a-": 2,
        },
        minNamedSnapshotChangesAfterActionKind: {
          z: { Wait: 4, Click: 3 },
          "a.": { SetViewport: 3 },
          A: { Wait: 1, Click: 2 },
          "a-": { TypeText: 2 },
        },
        minNamedSnapshotChangesAfterNonWait: {
          z: 4,
          "a.": 3,
          A: 1,
          "a-": 2,
        },
        requiredActionKinds: ["Wait", "TypeText", "Click"],
        requiredNamedSnapshots: ["z", "a.", "A", "a-"],
      },
    });
    const expectedNames = ["A", "a-", "a.", "z"];
    expect(Object.keys(validated.targetQuery)).toEqual(expectedNames);
    expect(validated.explorationPolicy?.requiredActionKinds).toEqual([
      "Click",
      "TypeText",
      "Wait",
    ]);
    expect(validated.explorationPolicy?.requiredNamedSnapshots).toEqual(
      expectedNames,
    );
    expect(Object.keys(
      validated.explorationPolicy?.minDistinctNamedSnapshotValues ?? {},
    )).toEqual(expectedNames);
    expect(Object.keys(
      validated.explorationPolicy?.minNamedSnapshotChangesAfterActionKind ?? {},
    )).toEqual(expectedNames);
    expect(Object.keys(
      validated.explorationPolicy?.minNamedSnapshotChangesAfterActionKind.A ?? {},
    )).toEqual(["Click", "Wait"]);
    expect(Object.keys(
      validated.explorationPolicy?.minNamedSnapshotChangesAfterNonWait ?? {},
    )).toEqual(expectedNames);
  });

  test("rejects unsafe artifact, scenario, route, path, readiness, and server command inputs", async () => {
    const { config, repositoryRoot } = await fixture();
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      artifactName: "../escape",
    })).toThrow("artifactName");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      artifactName: "a".repeat(81),
    })).toThrow("artifactName");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      scenario: "Unsafe Scenario",
    })).toThrow("scenario");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      scenario: "a".repeat(121),
    })).toThrow("scenario");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      expectedRoute: "",
    })).toThrow("expectedRoute");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      entryPath: "//external.test/path",
    })).toThrow("entryPath");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      targetQuery: { __direct_scenario: "surface.other" },
    })).toThrow("reserved parameter");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      targetQuery: { ["__proto__"]: "unsafe" },
    })).toThrow("invalid or reserved parameter");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      specificationPath: join(repositoryRoot, "..", "outside.ts"),
    })).toThrow("inside repositoryRoot");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      server: { ...config.server, command: ["bun", "run", "dev"] },
    })).toThrow("literal {port}");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      server: { ...config.server, readinessPath: "//external.test" },
    })).toThrow("origin-relative");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      viewport: { width: 0 },
    })).toThrow("viewport.width");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      viewport: { deviceScaleFactor: Number.POSITIVE_INFINITY },
    })).toThrow("deviceScaleFactor");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      explorationPolicy: { requiredActionKinds: ["Wait", "Wait"] },
    })).toThrow("duplicate kind");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      explorationPolicy: { minDistinctNamedSnapshotValues: { "unsafe name": 2 } },
    })).toThrow("safe bounded snapshot name");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      explorationPolicy: { minNamedSnapshotChangesAfterNonWait: { phase: 10_001 } },
    })).toThrow("between 1 and 10000");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      explorationPolicy: {
        minNamedSnapshotChangesAfterActionKind: { phase: {} },
      },
    })).toThrow("bounded action map");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      explorationPolicy: {
        minNamedSnapshotChangesAfterActionKind: {
          phase: { Unknown: 1 } as never,
        },
      },
    })).toThrow("unknown action kind");
    for (const minimum of [0, 10_001]) {
      expect(() => validateDirectBombadilFuzzConfig({
        ...config,
        explorationPolicy: {
          minNamedSnapshotChangesAfterActionKind: {
            phase: { Click: minimum },
          },
        },
      })).toThrow("between 1 and 10000");
    }
    const snapshotNames = (prefix: string): string[] =>
      Array.from({ length: 32 }, (_, index) => `${prefix}${String(index)}`);
    const maximumPolicy = {
      minDistinctNamedSnapshotValues: Object.fromEntries(
        snapshotNames("d").map((name) => [name, 1]),
      ),
      minNamedSnapshotChangesAfterActionKind: Object.fromEntries(
        snapshotNames("a").map((name) => [name, { Click: 1 }]),
      ),
      minNamedSnapshotChangesAfterNonWait: Object.fromEntries(
        snapshotNames("n").map((name) => [name, 1]),
      ),
      requiredNamedSnapshots: snapshotNames("r").slice(0, 31),
    } as const;
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      explorationPolicy: maximumPolicy,
    })).not.toThrow();
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      explorationPolicy: {
        ...maximumPolicy,
        requiredNamedSnapshots: snapshotNames("r"),
      },
    })).toThrow("at most 127 distinct non-Direct snapshots");
  });

  test("rejects specification, server cwd, and replay symlinks that escape the repository", async () => {
    const outside = await mkdtemp(join(tmpdir(), "direct-bombadil-outside-"));
    temporaryDirectories.push(outside);
    const outsideSpecification = join(outside, "outside-campaign.ts");
    const outsideReplay = join(outside, "outside-trace.jsonl");
    await writeFile(outsideSpecification, "export const outside = true;\n", "utf8");
    await writeFile(outsideReplay, "{}\n", "utf8");

    const specificationFixture = await fixture();
    const specificationLink = join(specificationFixture.repositoryRoot, "escaped-campaign.ts");
    await symlink(outsideSpecification, specificationLink);
    const specificationRuntime = dependencies();
    expect((await rejection(runDirectBombadilFuzz({
      ...specificationFixture.config,
      specificationPath: specificationLink,
    }, [], specificationRuntime.overrides))).message).toContain(
      "specificationPath resolves outside repositoryRoot",
    );
    expect(specificationRuntime.calls).toEqual([]);

    const cwdFixture = await fixture();
    const cwdLink = join(cwdFixture.repositoryRoot, "escaped-cwd");
    await symlink(outside, cwdLink);
    const cwdRuntime = dependencies();
    const cwdPlan = artifactRunPlan(cwdFixture.repositoryRoot, 43);
    const publicationFailure = new Error("forced sanitized receipt publication failure");
    const cwdError = await rejection(runDirectBombadilFuzz({
      ...cwdFixture.config,
      server: { ...cwdFixture.config.server, cwd: cwdLink },
    }, { arguments: [], artifactRun: cwdPlan }, {
      ...cwdRuntime.overrides,
      beforeArtifactCommit: () => {
        throw publicationFailure;
      },
    }));
    expect(cwdError).toBeInstanceOf(AggregateError);
    expect(cwdError.message).toContain(
      "server.cwd resolves outside repositoryRoot",
    );
    expect(cwdError.message).toContain(
      "sanitized Bombadil receipt publication also failed",
    );
    const persistenceErrors = (cwdError as AggregateError).errors;
    expect(persistenceErrors).toHaveLength(2);
    expect(persistenceErrors[0]).toBeInstanceOf(Error);
    expect((persistenceErrors[0] as Error).message).toBe(
      "server.cwd resolves outside repositoryRoot",
    );
    expect(cwdError.cause).toBe(persistenceErrors[0]);
    expect(persistenceErrors[1]).toBe(publicationFailure);
    expect(cwdRuntime.calls).toEqual([]);

    const replayFixture = await fixture();
    const replayLink = join(replayFixture.repositoryRoot, "escaped-trace.jsonl");
    await symlink(outsideReplay, replayLink);
    const replayRuntime = dependencies();
    expect((await rejection(runDirectBombadilFuzz(
      replayFixture.config,
      ["--replay=escaped-trace.jsonl"],
      replayRuntime.overrides,
    ))).message).toContain("--replay resolves outside repositoryRoot");
    expect(replayRuntime.calls).toEqual([]);
  }, ARTIFACT_IO_TEST_TIMEOUT_MS);

  test("builds an argv-only native invocation with both Direct query bindings", () => {
    const invocation = createDirectBombadilInvocation({
      baseUrl: "http://127.0.0.1:5184",
      bombadilExecutable: "/repo/native-bombadil",
      entryPath: "/direct/",
      outputPath: "/repo/artifacts/run/bombadil",
      replayPath: null,
      repositoryRoot: "/repo",
      scenario: "surface.ready",
      specificationPath: "/repo/spec.ts",
      targetQuery: { workbench: "frame" },
      timeLimitSeconds: 20,
      viewport: { deviceScaleFactor: 1.25, height: 720, width: 1_280 },
    });
    expect(invocation.targetUrl).toBe(
      "http://127.0.0.1:5184/direct/?__direct_scenario=surface.ready&workbench=frame",
    );
    expect(invocation.wallClockTimeoutMs).toBe(50_000);
    expect(invocation.command).toEqual([
      "/repo/native-bombadil",
      "browser",
      "test",
      invocation.targetUrl,
      "/repo/spec.ts",
      "--output-path",
      "/repo/artifacts/run/bombadil",
      "--headless",
      "--instrument-javascript=",
      "--width",
      "1280",
      "--height",
      "720",
      "--device-scale-factor",
      "1.25",
      "--exit-on-violation",
      "--time-limit",
      "20s",
    ]);
  });

  test("maps safe trace replay to bounded Bombadil reproduction", () => {
    const invocation = createDirectBombadilInvocation({
      baseUrl: "http://127.0.0.1:5184",
      bombadilExecutable: "/repo/native-bombadil",
      outputPath: "/repo/artifacts/run/bombadil",
      replayPath: "/repo/artifacts/prior/trace.jsonl",
      repositoryRoot: "/repo",
      scenario: "surface.ready",
      specificationPath: "/repo/spec.ts",
      timeLimitSeconds: 20,
    });
    expect(invocation.command).toContain("--reproduce");
    expect(invocation.command).toEqual(expect.arrayContaining([
      "--width", "1024", "--height", "768", "--device-scale-factor", "2",
    ]));
    expect(invocation.command).not.toContain("--time-limit");
    expect(invocation.command).not.toContain("--exit-on-violation");
    expect(invocation.wallClockTimeoutMs).toBe(330_000);
  });
});

describe("Direct Bombadil campaign matrix", () => {
  test("runs unique bounded campaigns serially and selects exactly one", async () => {
    const { config, repositoryRoot } = await fixture();
    const campaigns = [{ id: "primary", config }, {
      id: "secondary",
      config: { ...config, artifactName: "fixture-secondary" },
    }] as const;
    const allRuntime = dependencies();
    const allSignals = controllableSignals();
    const matrixController = new AbortController();
    let controllerCount = 0;
    const all = await runDirectBombadilFuzzMatrix(
      campaigns,
      ["--time-limit=12s"],
      {
        ...allRuntime.overrides,
        createAbortController: () => {
          controllerCount += 1;
          return controllerCount === 1 ? matrixController : new AbortController();
        },
        signalController: allSignals.controller,
      },
    );
    expect(all).toMatchObject({
      kind: "matrix",
      results: [{ campaignId: "primary" }, { campaignId: "secondary" }],
    });
    expect(allRuntime.calls.filter((call) => call === "run-bombadil")).toHaveLength(2);
    expect(allSignals.listenerCount()).toBe(0);
    expect(getEventListeners(matrixController.signal, "abort")).toHaveLength(0);

    const selectedRuntime = dependencies();
    const selectedPlan = artifactRunPlan(repositoryRoot, 20);
    const selected = await runDirectBombadilFuzzMatrix(
      campaigns,
      {
        arguments: ["--campaign=secondary", "--time-limit=12s"],
        artifactRun: selectedPlan,
      },
      selectedRuntime.overrides,
    );
    expect(selected).toMatchObject({
      kind: "matrix",
      results: [{ campaignId: "secondary" }],
    });
    expect(selectedRuntime.calls.filter((call) => call === "run-bombadil")).toHaveLength(1);
    expect(JSON.parse(await readFile(selected.receiptPath, "utf8"))).toMatchObject({
      campaigns: [
        { campaignId: "primary", receipt: null, status: "not-selected" },
        {
          campaignId: "secondary",
          receipt: "campaigns/secondary/receipt.json",
          status: "passed",
        },
      ],
    });
  });

  test("rejects ambiguous replay, duplicate IDs, and unknown selection", async () => {
    const { config } = await fixture();
    const campaigns = [{ id: "primary", config }] as const;
    expect((await rejection(runDirectBombadilFuzzMatrix(
      campaigns,
      ["--replay=artifacts/trace.jsonl"],
    ))).message).toContain("requires exactly one --campaign");
    expect((await rejection(runDirectBombadilFuzzMatrix(
      campaigns,
      ["--campaign=missing"],
    ))).message).toContain("Unknown Bombadil campaign");
    expect((await rejection(runDirectBombadilFuzzMatrix([
      { id: "same", config },
      { id: "same", config: { ...config, artifactName: "other" } },
    ], []))).message).toContain("unique lowercase kebab");
  }, ARTIFACT_IO_TEST_TIMEOUT_MS);

  test("publishes rejected and partially executed matrix terminal states", async () => {
    const { config, repositoryRoot } = await fixture();
    const duplicatePlan = artifactRunPlan(repositoryRoot, 21);
    await rejection(runDirectBombadilFuzzMatrix([
      { id: "same", config },
      { id: "same", config: { ...config, artifactName: "other" } },
    ], { arguments: [], artifactRun: duplicatePlan }));
    const duplicateReceipt = JSON.parse(await readFile(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil-upload",
      duplicatePlan.runId,
      "receipt.json",
    ), "utf8")) as Record<string, unknown>;
    expect(duplicateReceipt).toMatchObject({
      schema: "direct.bombadil-matrix-receipt/v1",
      failureCode: "configuration-rejected",
      status: "failed",
      campaigns: [{ status: "rejected" }, { status: "rejected" }],
    });

    const runtime = dependencies();
    const baseRunBombadil = runtime.overrides.runBombadil;
    if (baseRunBombadil === undefined) throw new Error("Expected fixture Bombadil dependency");
    let invocationCount = 0;
    const partialPlan = artifactRunPlan(repositoryRoot, 22);
    await rejection(runDirectBombadilFuzzMatrix([
      { id: "first", config },
      { id: "second", config: { ...config, artifactName: "fixture-second" } },
      { id: "third", config: { ...config, artifactName: "fixture-third" } },
    ], { arguments: [], artifactRun: partialPlan }, {
      ...runtime.overrides,
      runBombadil: async (invocation) => {
        invocationCount += 1;
        const result = await baseRunBombadil(invocation);
        return invocationCount === 2 ? { ...result, exitCode: 9 } : result;
      },
    }));
    expect(invocationCount).toBe(2);
    const partialReceipt = JSON.parse(await readFile(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil-upload",
      partialPlan.runId,
      "receipt.json",
    ), "utf8")) as Record<string, unknown>;
    expect(partialReceipt).toMatchObject({
      schema: "direct.bombadil-matrix-receipt/v1",
      status: "failed",
      campaigns: [
        { campaignId: "first", status: "passed" },
        { campaignId: "second", status: "failed" },
        { campaignId: "third", status: "not-run" },
      ],
    });
  });

  test("bounds rejected matrices and rejects private matrix uploads with a public receipt", async () => {
    const { config, repositoryRoot } = await fixture();
    const campaigns = Array.from({ length: 34 }, (_, index) => ({
      config,
      id: `campaign-${String(index)}`,
    }));
    const oversizedPlan = artifactRunPlan(repositoryRoot, 23);
    await rejection(runDirectBombadilFuzzMatrix(campaigns, {
      arguments: [],
      artifactRun: oversizedPlan,
    }));
    const oversizedReceipt = JSON.parse(await readFile(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil-upload",
      oversizedPlan.runId,
      "receipt.json",
    ), "utf8")) as Record<string, unknown>;
    expect(oversizedReceipt).toMatchObject({
      mode: "public-summary",
      omittedCampaignCount: 2,
      status: "failed",
    });
    expect(oversizedReceipt.campaigns).toHaveLength(32);

    const privatePlan = artifactRunPlan(repositoryRoot, 24, "private-vetted");
    const privateInput = {
      arguments: [],
      artifactRun: privatePlan,
    } as unknown as DirectBombadilMatrixRunInput;
    const privateError = await rejection(runDirectBombadilFuzzMatrix(
      [{ id: "primary", config }],
      privateInput,
    ));
    expect(privateError.message).toContain("public-summary");
    const privateReceipt = JSON.parse(await readFile(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil-upload",
      privatePlan.runId,
      "receipt.json",
    ), "utf8")) as Record<string, unknown>;
    expect(privateReceipt).toMatchObject({
      failureCode: "configuration-rejected",
      mode: "public-summary",
      status: "failed",
    });

    const longIdPlan = artifactRunPlan(repositoryRoot, 25);
    await rejection(runDirectBombadilFuzzMatrix([
      { id: "a".repeat(81), config },
    ], { arguments: [], artifactRun: longIdPlan }));
    expect(JSON.parse(await readFile(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil-upload",
      longIdPlan.runId,
      "receipt.json",
    ), "utf8"))).toMatchObject({
      campaigns: [{ campaignId: null, status: "rejected" }],
    });
  });

  test("publishes one interrupted matrix leaf before forwarding its signal", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies();
    const baseRunBombadil = runtime.overrides.runBombadil;
    if (baseRunBombadil === undefined) throw new Error("Expected fixture Bombadil dependency");
    const signals = controllableSignals();
    const plan = artifactRunPlan(repositoryRoot, 26);
    const error = await rejection(runDirectBombadilFuzzMatrix(
      [{ id: "primary", config }, {
        id: "secondary",
        config: { ...config, artifactName: "fixture-secondary" },
      }],
      { arguments: [], artifactRun: plan },
      {
        ...runtime.overrides,
        runBombadil: async (invocation) => {
          const result = await baseRunBombadil(invocation);
          signals.emit("SIGTERM");
          return result;
        },
        signalController: signals.controller,
      },
    ));
    expect(error.message).toContain("SIGTERM");
    expect(signals.forwarded).toEqual(["SIGTERM"]);
    expect(signals.listenerCount()).toBe(0);
    expect(JSON.parse(await readFile(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil-upload",
      plan.runId,
      "receipt.json",
    ), "utf8"))).toMatchObject({
      failureCode: "interrupted",
      campaigns: [
        { campaignId: "primary", status: "failed" },
        { campaignId: "secondary", status: "not-run" },
      ],
      status: "failed",
    });
  });

  test("preserves a child configuration rejection in the parent receipt", async () => {
    const { config, repositoryRoot } = await fixture();
    const mutableConfig = { ...config };
    let controllerCount = 0;
    const plan = artifactRunPlan(repositoryRoot, 27);
    await rejection(runDirectBombadilFuzzMatrix(
      [{ id: "primary", config: mutableConfig }, {
        id: "secondary",
        config: { ...config, artifactName: "fixture-secondary" },
      }],
      { arguments: [], artifactRun: plan },
      {
        ...dependencies().overrides,
        createAbortController: () => {
          controllerCount += 1;
          if (controllerCount === 2) mutableConfig.artifactName = "../rejected";
          return new AbortController();
        },
      },
    ));
    expect(JSON.parse(await readFile(join(
      resolveDirectBombadilUploadLeaf(plan),
      "receipt.json",
    ), "utf8"))).toMatchObject({
      failureCode: "configuration-rejected",
      campaigns: [
        { campaignId: "primary", status: "rejected" },
        { campaignId: "secondary", status: "not-run" },
      ],
      status: "failed",
    });
    expect(JSON.parse(await readFile(join(
      resolveDirectBombadilUploadLeaf(plan),
      "campaigns",
      "primary",
      "receipt.json",
    ), "utf8"))).toMatchObject({
      failureCode: "configuration-rejected",
      status: "rejected",
    });
    expect(await readFile(join(
      resolveDirectBombadilUploadLeaf(plan),
      "campaigns",
      "primary",
      "summary.json",
    ), "utf8")).toContain("direct.bombadil-upload-summary/v1");
  });

  test("interrupts a child before acquisition and leaves no signal listeners", async () => {
    const { config, repositoryRoot } = await fixture();
    const signals = controllableSignals();
    const runtime = dependencies();
    const plan = artifactRunPlan(repositoryRoot, 28);
    let runIdCount = 0;
    await rejection(runDirectBombadilFuzzMatrix(
      [{ id: "primary", config }, {
        id: "secondary",
        config: { ...config, artifactName: "fixture-secondary" },
      }],
      { arguments: [], artifactRun: plan },
      {
        ...runtime.overrides,
        createRunId: () => {
          runIdCount += 1;
          if (runIdCount === 1) signals.emit("SIGTERM");
          return `10000000-0000-4000-8000-${String(runIdCount).padStart(12, "0")}`;
        },
        signalController: signals.controller,
      },
    ));
    expect(runtime.calls).toEqual([]);
    expect(signals.forwarded).toEqual(["SIGTERM"]);
    expect(signals.listenerCount()).toBe(0);
    expect(JSON.parse(await readFile(join(
      resolveDirectBombadilUploadLeaf(plan),
      "receipt.json",
    ), "utf8"))).toMatchObject({
      failureCode: "interrupted",
      campaigns: [
        { campaignId: "primary", status: "failed" },
        { campaignId: "secondary", status: "not-run" },
      ],
    });
  }, ARTIFACT_IO_TEST_TIMEOUT_MS);

  test("converts a parent-publication interruption and releases child abort listeners", async () => {
    const { config, repositoryRoot } = await fixture();
    const signals = controllableSignals();
    const matrixController = new AbortController();
    let controllerCount = 0;
    let commitCount = 0;
    const plan = artifactRunPlan(repositoryRoot, 29);
    const error = await rejection(runDirectBombadilFuzzMatrix(
      [{ id: "primary", config }, {
        id: "secondary",
        config: { ...config, artifactName: "fixture-secondary" },
      }],
      { arguments: [], artifactRun: plan },
      {
        ...dependencies().overrides,
        beforeArtifactCommit: () => {
          commitCount += 1;
          signals.emit("SIGTERM");
        },
        createAbortController: () => {
          controllerCount += 1;
          return controllerCount === 1 ? matrixController : new AbortController();
        },
        signalController: signals.controller,
      },
    ));
    expect(error.message).toContain("SIGTERM");
    expect(commitCount).toBe(1);
    expect(signals.forwarded).toEqual(["SIGTERM"]);
    expect(signals.listenerCount()).toBe(0);
    expect(getEventListeners(matrixController.signal, "abort")).toHaveLength(0);
    expect(JSON.parse(await readFile(join(
      resolveDirectBombadilUploadLeaf(plan),
      "receipt.json",
    ), "utf8"))).toMatchObject({
      failureCode: "interrupted",
      campaigns: [{ status: "passed" }, { status: "passed" }],
      status: "failed",
    });
  }, ARTIFACT_IO_TEST_TIMEOUT_MS);

  test("removes a failed matrix publication staging leaf", async () => {
    const { config, repositoryRoot } = await fixture();
    const plan = artifactRunPlan(repositoryRoot, 42);
    const error = await rejection(runDirectBombadilFuzzMatrix(
      [{ id: "primary", config }],
      { arguments: [], artifactRun: plan },
      {
        ...dependencies().overrides,
        beforeArtifactCommit: () => {
          throw new Error("matrix precommit rejected");
        },
      },
    ));
    expect(error.message).toContain("matrix precommit rejected");
    expect(await readdir(dirname(resolveDirectBombadilUploadLeaf(plan)))).toEqual([]);
  });
});

describe("Direct Bombadil sanitized evidence contracts", () => {
  test("closes the source descriptor even when destination cleanup fails", async () => {
    const calls: string[] = [];
    const destinationError = new Error("destination close failed");
    const error = await rejection(closeBombadilArtifactCopyHandles(
      {
        close: async () => {
          calls.push("destination");
          throw destinationError;
        },
      },
      {
        close: async () => {
          calls.push("source");
        },
      },
    ));
    expect(error).toBe(destinationError);
    expect(calls).toEqual(["destination", "source"]);

    const both = await rejection(closeBombadilArtifactCopyHandles(
      { close: async () => { throw new Error("destination"); } },
      { close: async () => { throw new Error("source"); } },
    ));
    expect(both).toBeInstanceOf(AggregateError);
    expect((both as AggregateError).errors).toHaveLength(2);
  });

  test("round-trips all four emitted evidence files and resolves the exact upload leaf", async () => {
    const { config, repositoryRoot } = await fixture();
    const runPlan = artifactRunPlan(repositoryRoot, 31);
    const run = await runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: runPlan,
    }, dependencies().overrides);
    if (run.kind !== "run") throw new Error("Expected a run result");
    expect(run.uploadArtifactPath).toBe(resolveDirectBombadilUploadLeaf(runPlan));
    const runReceipt = parseDirectBombadilArtifactReceipt(JSON.parse(await readFile(
      join(run.uploadArtifactPath, "receipt.json"),
      "utf8",
    )));
    const runSummary = parseDirectBombadilSanitizedRunSummary(JSON.parse(await readFile(
      join(run.uploadArtifactPath, "summary.json"),
      "utf8",
    )));

    const matrixPlan = artifactRunPlan(repositoryRoot, 32);
    const matrix = await runDirectBombadilFuzzMatrix(
      [{ id: "primary", config }],
      { arguments: [], artifactRun: matrixPlan },
      dependencies().overrides,
    );
    if (matrix.kind !== "matrix") throw new Error("Expected a matrix result");
    const matrixReceipt = parseDirectBombadilMatrixReceipt(JSON.parse(await readFile(
      join(matrix.uploadArtifactPath, "receipt.json"),
      "utf8",
    )));
    const matrixSummary = parseDirectBombadilMatrixSummary(JSON.parse(await readFile(
      join(matrix.uploadArtifactPath, "summary.json"),
      "utf8",
    )));
    for (const parsed of [runReceipt, runSummary, matrixReceipt, matrixSummary]) {
      expect(parsed.ok).toBeTrue();
      if (parsed.ok) expect(Object.isFrozen(parsed.value)).toBeTrue();
    }
    if (!runReceipt.ok || !matrixReceipt.ok || !matrixSummary.ok) {
      throw new Error("Expected parsed Bombadil evidence");
    }
    expect(Object.isFrozen(runReceipt.value.inventory)).toBeTrue();
    expect(Object.isFrozen(runReceipt.value.policy)).toBeTrue();
    expect(Object.isFrozen(matrixReceipt.value.campaigns)).toBeTrue();
    expect(Object.isFrozen(matrixSummary.value.campaigns)).toBeTrue();
    expect(resolveDirectBombadilUploadLeaf({
      repositoryRoot,
      runId: runPlan.runId,
    })).toBe(run.uploadArtifactPath);
    expect(resolveDirectBombadilUploadLeaf({
      ...runPlan,
      uploadMode: "private-vetted",
    })).toBe(run.uploadArtifactPath);
    expect(() => resolveDirectBombadilUploadLeaf({
      ...runPlan,
      repositoryRoot: `${repositoryRoot}/../invalid`,
    })).toThrow("absolute normalized path");
    expect(() => resolveDirectBombadilUploadLeaf({
      ...runPlan,
      runId: "not-a-uuid",
    })).toThrow("lowercase RFC 4122 UUID");
    expect(() => resolveDirectBombadilUploadLeaf({
      ...runPlan,
      uploadMode: "invalid" as "public-summary",
    })).toThrow("public-summary or private-vetted");
  });

  test("rejects hostile values, exact-key tampering, and impossible terminal states", async () => {
    const { config, repositoryRoot } = await fixture();
    const runPlan = artifactRunPlan(repositoryRoot, 33);
    const run = await runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: runPlan,
    }, dependencies().overrides);
    if (run.kind !== "run") throw new Error("Expected a run result");
    const receipt = record(JSON.parse(await readFile(
      join(run.uploadArtifactPath, "receipt.json"),
      "utf8",
    )), "run receipt");
    const summary = record(JSON.parse(await readFile(
      join(run.uploadArtifactPath, "summary.json"),
      "utf8",
    )), "run summary");
    expect(parseDirectBombadilArtifactReceipt({ ...receipt, extra: true }).ok).toBeFalse();
    expect(parseDirectBombadilArtifactReceipt({ ...receipt, schema: "wrong" }).ok).toBeFalse();
    expect(parseDirectBombadilArtifactReceipt({
      ...receipt,
      inventory: {
        ...record(receipt.inventory, "run receipt inventory"),
        fileCount: 0,
      },
    }).ok).toBeFalse();
    expect(parseDirectBombadilArtifactReceipt({
      ...receipt,
      inventory: {
        entryCount: 0,
        fileCount: 0,
        inventorySha256: null,
        totalBytes: 0,
      },
    }).ok).toBeFalse();
    expect(parseDirectBombadilArtifactReceipt({
      ...receipt,
      diagnosticsRetained: true,
      failureCode: "interrupted",
      mode: "private-vetted",
      status: "failed",
    }).ok).toBeFalse();
    expect(parseDirectBombadilArtifactReceipt({
      ...receipt,
      failureCode: "writer-settlement",
      status: "failed",
    }).ok).toBeFalse();
    const accessorReceipt = Object.defineProperty({ ...receipt }, "status", {
      enumerable: true,
      get: () => "passed",
    });
    expect(parseDirectBombadilArtifactReceipt(accessorReceipt).ok).toBeFalse();
    expect(parseDirectBombadilArtifactReceipt(new Proxy(receipt, {
      ownKeys: () => {
        throw new Error("hostile proxy");
      },
    })).ok).toBeFalse();
    expect(parseDirectBombadilSanitizedRunSummary({
      ...summary,
      attestation: null,
    }).ok).toBeFalse();
    const failedSummary = { ...summary, failureCode: "unknown", status: "failed" };
    expect(parseDirectBombadilSanitizedRunSummary({
      ...failedSummary,
      attestation: {
        invalidObservationCount: 0,
        observationCount: 0,
        validObservationCount: 0,
      },
    }).ok).toBeFalse();
    expect(parseDirectBombadilSanitizedRunSummary({
      ...summary,
      failureCode: "writer-settlement",
      status: "failed",
    }).ok).toBeFalse();
    expect(parseDirectBombadilSanitizedRunSummary({
      ...failedSummary,
      exploration: {
        ...record(summary.exploration, "run summary exploration"),
        traceLineCount: 1,
      },
    }).ok).toBeFalse();

    const matrixPlan = artifactRunPlan(repositoryRoot, 34);
    const matrix = await runDirectBombadilFuzzMatrix(
      [{ id: "primary", config }],
      { arguments: [], artifactRun: matrixPlan },
      dependencies().overrides,
    );
    if (matrix.kind !== "matrix") throw new Error("Expected a matrix result");
    const matrixReceipt = record(JSON.parse(await readFile(
      join(matrix.uploadArtifactPath, "receipt.json"),
      "utf8",
    )), "matrix receipt");
    const matrixSummary = record(JSON.parse(await readFile(
      join(matrix.uploadArtifactPath, "summary.json"),
      "utf8",
    )), "matrix summary");
    const campaigns = matrixReceipt.campaigns;
    if (!Array.isArray(campaigns)) throw new Error("Expected matrix campaigns");
    expect(parseDirectBombadilMatrixReceipt({
      ...matrixReceipt,
      campaigns: campaigns.map((campaign) => ({
        ...record(campaign, "matrix campaign"),
        receipt: "campaigns/primary/other.json",
      })),
    }).ok).toBeFalse();
    expect(parseDirectBombadilMatrixSummary({
      ...matrixSummary,
      campaigns: {
        ...record(matrixSummary.campaigns, "matrix summary campaigns"),
        omitted: 1,
      },
    }).ok).toBeFalse();
  });
});

describe("Direct Bombadil trace attestation", () => {
  async function attest(
    observations: readonly unknown[],
    lineOptions: readonly TraceLineOptions[] = [],
  ) {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-trace-"));
    temporaryDirectories.push(directory);
    const tracePath = join(directory, "trace.jsonl");
    await writeTrace(tracePath, observations, lineOptions);
    return attestDirectBombadilTrace({
      expectedRoute: "/surface",
      expectedScenario: "surface.ready",
      tracePath,
    });
  }

  test("allows bridge absence only before the first exact requested activation", async () => {
    const initial = directObservation();
    const final = directObservation();
    const result = await attest([absentObservation(), initial, final]);
    expect(result).toMatchObject({
      catalogHash: initial.catalogHash,
      observationCount: 3,
      invalidObservationCount: 1,
      validObservationCount: 2,
      initial: {
        scenario: "surface.ready",
        route: "/surface",
        source: "scenario",
      },
      final: {
        scenario: "surface.ready",
        route: "/surface",
        isQuiescent: true,
      },
    });
  });

  test("ignores unrelated Bombadil snapshots outside the Direct attestation contract", async () => {
    const oversizedValue = "x".repeat(2 * 1024 * 1024 + 1);
    const cases: readonly {
      readonly label: string;
      readonly snapshots: NonNullable<TraceLineOptions["namedSnapshots"]>;
    }[] = [{
      label: "arbitrary name",
      snapshots: [{ name: "phase state", value: "ready" }],
    }, {
      label: "duplicate unrelated name",
      snapshots: [
        { name: "phase", value: "loading" },
        { name: "phase", value: "ready" },
      ],
    }, {
      label: "depth 65 value",
      snapshots: [{ name: "deep", value: nestedJson(65) }],
    }, {
      label: "value above two MiB",
      snapshots: [{ name: "large", value: oversizedValue }],
    }];

    for (const testCase of cases) {
      const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-compatible-trace-"));
      temporaryDirectories.push(directory);
      const tracePath = join(directory, "trace.jsonl");
      await writeTrace(tracePath, [directObservation()], [{
        namedSnapshots: testCase.snapshots,
      }]);
      const result = await attestDirectBombadilTrace({
        expectedRoute: "/surface",
        expectedScenario: "surface.ready",
        tracePath,
      });
      expect(result.validObservationCount, testCase.label).toBe(1);
    }
  });

  test("keeps exact Direct uniqueness and schema bounds independent of diagnostic limits", async () => {
    const duplicateError = await rejection(attest([directObservation()], [{
      namedSnapshots: [{ name: "direct", value: directObservation() }],
    }]));
    expect(duplicateError.message).toContain("must contain one named direct snapshot");

    const observation = largeDirectObservation();
    expect(Buffer.byteLength(JSON.stringify(observation), "utf8"))
      .toBeGreaterThan(2 * 1024 * 1024);
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-large-direct-trace-"));
    temporaryDirectories.push(directory);
    const tracePath = join(directory, "trace.jsonl");
    await writeTrace(tracePath, [observation]);
    const result = await attestDirectBombadilTrace({
      expectedRoute: String(observation.activeRoute),
      expectedScenario: String(observation.activeScenario),
      tracePath,
    });
    expect(result.validObservationCount).toBe(1);
    const summary = await summarizeDirectBombadilTrace({
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath,
    });
    expect(summary.namedSnapshots).toEqual([
      expect.objectContaining({ name: "direct", observationCount: 1 }),
    ]);
  });

  test("rejects a vacuous, wrongly activated, or post-activation missing trace", async () => {
    expect((await rejection(attest([absentObservation()]))).message)
      .toContain("never reached a valid Direct contract");
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-wrong-route-"));
    temporaryDirectories.push(directory);
    const tracePath = join(directory, "trace.jsonl");
    await writeTrace(tracePath, [directObservation()]);
    expect((await rejection(attestDirectBombadilTrace({
      expectedRoute: "/wrong",
      expectedScenario: "surface.ready",
      tracePath,
    }))).message).toContain("requested scenario and route");
    expect((await rejection(attest([
      directObservation(),
      absentObservation(),
      directObservation(),
    ]))).message).toContain("lost the Direct bridge");
  });

  test("rejects catalog drift, nonzero violations, and a nonquiescent final state", async () => {
    expect((await rejection(attest([
      directObservation(),
      directObservation({ activeScenario: "surface.other" }),
    ]))).message).toContain("activation changed");
    expect((await rejection(attest([
      directObservation(),
      directObservation({ catalogTitle: "Changed catalog" }),
    ]))).message).toContain("catalog changed");
    expect((await rejection(attest([
      directObservation({ violation: 1 }),
    ]))).message).toContain("nonzero Direct violation");
    expect((await rejection(attest([
      directObservation(),
      directObservation({ isQuiescent: false }),
    ]))).message).toContain("not quiescent");
  });

  test("canonical parsers reject tampered manifest and probe contracts", async () => {
    const cases: Array<readonly [string, (observation: Record<string, unknown>) => void]> = [
      ["catalog hash", (observation) => {
        record(observation.manifest, "manifest").catalogHash = "fnv1a-64:aaaaaaaaaaaaaaaa";
      }],
      ["selection hash", (observation) => {
        record(record(observation.manifest, "manifest").active, "active").selectionHash =
          "fnv1a-64:aaaaaaaaaaaaaaaa";
      }],
      ["coverage", (observation) => {
        const coverage = record(record(observation.manifest, "manifest").coverage, "coverage");
        const entries = coverage.entries;
        if (!Array.isArray(entries) || entries.length === 0) throw new Error("coverage entries missing");
        record(entries[0], "coverage entry").claim = "Tampered claim";
      }],
      ["probe transition", (observation) => {
        record(record(observation.probe, "probe").activity, "activity").active = 1;
      }],
      ["remaining work", (observation) => {
        delete record(observation.probe, "probe").remainingWork;
      }],
      ["counter limit", (observation) => {
        record(observation.probe, "probe").pending = Object.fromEntries(
          Array.from({ length: 129 }, (_, index) => [`counter${String(index)}`, 0]),
        );
      }],
    ];
    for (const [label, mutate] of cases) {
      const observation = directObservation();
      mutate(observation);
      const error = await rejection(attest([observation]));
      expect(error.message, label).toMatch(/Direct (manifest|probe) is invalid/u);
    }
  });

  test("requires an existing nonempty JSONL trace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-empty-trace-"));
    temporaryDirectories.push(directory);
    const tracePath = join(directory, "trace.jsonl");
    expect((await rejection(attestDirectBombadilTrace({
      expectedRoute: "/surface",
      expectedScenario: "surface.ready",
      tracePath,
    }))).message).toContain("not an openable regular file");
    await writeFile(tracePath, "", "utf8");
    expect((await rejection(attestDirectBombadilTrace({
      expectedRoute: "/surface",
      expectedScenario: "surface.ready",
      tracePath,
    }))).message).toContain("not a bounded regular file");
  });
});

describe("Direct Bombadil exploration summary", () => {
  async function summaryTrace(lines: readonly string[]): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-summary-"));
    temporaryDirectories.push(directory);
    const tracePath = join(directory, "trace.jsonl");
    await writeFile(tracePath, `${lines.join("\n")}\n`, "utf8");
    return tracePath;
  }

  test("derives deterministic bounded diagnostics without retaining typed text or labels", async () => {
    const observation = directObservation();
    const tracePath = await summaryTrace([
      traceLine(observation, 1, {
        namedSnapshots: [{ name: "phase", value: { b: 2, a: 1 } }],
      }),
      traceLine(observation, 2, {
        action: {
          Click: {
            fingerprint: {
              accessible_name: "sensitive button label",
              tag: "button",
            },
            point: { x: 1, y: 1 },
          },
        },
        namedSnapshots: [{ name: "phase", value: { a: 2 } }],
      }),
      traceLine(observation, 3, {
        action: "Wait",
        namedSnapshots: [{ name: "phase", value: { a: 2 } }],
      }),
      traceLine(observation, 4, {
        action: { TypeText: { delay_millis: 0, text: "sensitive typed text" } },
        namedSnapshots: [{ name: "phase", value: { a: 2 } }],
        violations: [{
          name: "noConsoleErrors",
          violation: { False: { condition: "sensitive formula source" } },
        }],
      }),
    ]);
    const options = {
      explorationPolicy: {
        minDistinctNamedSnapshotValues: { phase: 2 },
        minNamedSnapshotChangesAfterActionKind: { phase: { Click: 1 } },
        minNamedSnapshotChangesAfterNonWait: { phase: 1 },
        minNonWaitActions: 2,
        requireStableTargetUrl: true,
        requiredActionKinds: ["Click", "TypeText"] as const,
        requiredNamedSnapshots: ["phase"],
      },
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath,
    };
    const first = await summarizeDirectBombadilTrace(options);
    const second = await summarizeDirectBombadilTrace(options);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      schema: "direct.bombadil-exploration-summary/v2",
      actions: {
        byKind: { Click: 1, TypeText: 1, Wait: 1 },
        maxWaitStreak: 1,
        nonWaitCount: 2,
        targetTags: { button: 1 },
        total: 3,
      },
      urls: {
        distinctFingerprintCount: 1,
        observationCount: 4,
        rawDistinctFingerprintCount: 1,
        rawObservationCount: 4,
        stableTarget: true,
      },
      transitions: {
        distinctNonNullHashCount: 4,
        nonNullHashCount: 4,
        rawDistinctNonNullHashCount: 4,
        rawNonNullHashCount: 4,
      },
      propertyViolations: { byName: { noConsoleErrors: 1 }, total: 1 },
      resourceHighWaterMarks: {
        domNodes: 4,
        jsHeapUsedBytes: 40,
      },
      policy: { configured: true, failures: [], satisfied: true },
    });
    expect(first.namedSnapshots.find((entry) => entry.name === "phase")).toMatchObject({
      changeAfterActionKind: { Click: 1 },
      changeAfterNonWaitCount: 1,
      distinctValueCount: 2,
      observationCount: 4,
    });
    expect(first.trace.sha256).toHaveLength(64);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("sensitive button label");
    expect(serialized).not.toContain("sensitive typed text");
    expect(serialized).not.toContain("sensitive formula source");
    expect(serialized).not.toContain("127.0.0.1");
    expect(serialized).not.toContain("/tmp/");
  });

  test("omits out-of-contract unrelated snapshots while keeping policy snapshots strict", async () => {
    const observation = directObservation();
    const oversizedValue = "x".repeat(2 * 1024 * 1024 + 1);
    const tracePath = await summaryTrace([traceLine(observation, 1, {
      namedSnapshots: [
        { name: "owned", value: "ready" },
        { name: "phase state", value: "ready" },
        { name: "duplicate", value: 0 },
        { name: "duplicate", value: 1 },
        { name: "deep", value: nestedJson(65) },
        { name: "large", value: oversizedValue },
      ],
    })]);
    const summary = await summarizeDirectBombadilTrace({
      explorationPolicy: { requiredNamedSnapshots: ["owned"] },
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath,
    });
    expect(summary.namedSnapshots.map(({ name }) => name)).toEqual(["direct", "owned"]);
    expect(summary.policy).toMatchObject({ configured: true, failures: [], satisfied: true });

    const strictCases: readonly {
      readonly label: string;
      readonly snapshots: NonNullable<TraceLineOptions["namedSnapshots"]>;
      readonly expected: string;
    }[] = [{
      label: "duplicate",
      snapshots: [
        { name: "owned", value: 0 },
        { name: "owned", value: 1 },
      ],
      expected: "repeats named snapshot owned",
    }, {
      label: "depth",
      snapshots: [{ name: "owned", value: nestedJson(65) }],
      expected: "exceeds JSON depth",
    }, {
      label: "size",
      snapshots: [{ name: "owned", value: oversizedValue }],
      expected: "exceeds 2097152 canonical bytes",
    }];
    for (const testCase of strictCases) {
      const strictTracePath = await summaryTrace([traceLine(observation, 1, {
        namedSnapshots: testCase.snapshots,
      })]);
      const error = await rejection(summarizeDirectBombadilTrace({
        explorationPolicy: { requiredNamedSnapshots: ["owned"] },
        targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
        tracePath: strictTracePath,
      }));
      expect(error.message, testCase.label).toContain(testCase.expected);
    }
  });

  test("accepts every exact Bombadil 0.7.2 browser action payload", async () => {
    const actions = [
      "Back",
      {
        Click: {
          fingerprint: { accessible_name: "private click label", tag: "button" },
          point: { x: 1, y: 2 },
        },
      },
      {
        DoubleClick: {
          delay_millis: 10,
          fingerprint: {
            structural_path: "private/path",
            tag: "x-private.widget_\u00e9",
          },
          point: { x: 2, y: 3 },
        },
      },
      "Forward",
      {
        MouseDrag: {
          delay_millis: 5,
          from: { x: 3, y: 4 },
          steps: 10,
          to: { x: 30, y: 40 },
        },
      },
      { PressKey: { code: 13 } },
      "Reload",
      { ScrollDown: { distance: 100, origin: { x: 5, y: 6 } } },
      { ScrollUp: { distance: 100, origin: { x: 5, y: 6 } } },
      {
        SetFileInputFiles: {
          files: ["/private/file.txt"],
          selector: "#private-file-input",
        },
      },
      { SetViewport: { height: 720, width: 1_280 } },
      { TypeText: { delay_millis: 5, text: "private typed text" } },
      "Wait",
    ] as const;
    const observation = directObservation();
    const tracePath = await summaryTrace([
      traceLine(observation, 1),
      ...actions.map((action, index) => traceLine(observation, index + 2, {
        action,
      })),
    ]);
    const summary = await summarizeDirectBombadilTrace({
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath,
    });
    expect(Object.keys(summary.actions.byKind)).toEqual([
      "Back",
      "Click",
      "DoubleClick",
      "Forward",
      "MouseDrag",
      "PressKey",
      "Reload",
      "ScrollDown",
      "ScrollUp",
      "SetFileInputFiles",
      "SetViewport",
      "TypeText",
      "Wait",
    ]);
    expect(summary.actions.total).toBe(actions.length);
    expect(Object.keys(summary.actions.targetTags)).toContain("button");
    expect(Object.keys(summary.actions.targetTags).some((tag) =>
      /^sha256:[a-f0-9]{64}$/u.test(tag)
    )).toBeTrue();
    expect(JSON.stringify(summary)).not.toContain("private");
  });

  test("reports strict policy misses while keeping the diagnostic summary", async () => {
    const tracePath = await summaryTrace([traceLine(directObservation(), 1)]);
    const summary = await summarizeDirectBombadilTrace({
      explorationPolicy: {
        minDistinctNamedSnapshotValues: { phase: 2 },
        minNonWaitActions: 1,
        requireStableTargetUrl: true,
        requiredActionKinds: ["Click"],
        requiredNamedSnapshots: ["phase"],
      },
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath,
    });
    expect(summary.policy.satisfied).toBeFalse();
    expect(summary.policy.failures).toHaveLength(4);
  });

  test("does not credit bootstrap or Wait-only state changes to product actions", async () => {
    const observation = directObservation();
    const tracePath = await summaryTrace([
      traceLine(observation, 1, {
        namedSnapshots: [{ name: "phase", value: "loading" }],
      }),
      traceLine(observation, 2, {
        action: "Wait",
        namedSnapshots: [{ name: "phase", value: "ready" }],
      }),
    ]);
    const summary = await summarizeDirectBombadilTrace({
      explorationPolicy: {
        minDistinctNamedSnapshotValues: { phase: 2 },
        minNamedSnapshotChangesAfterNonWait: { phase: 1 },
      },
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath,
    });
    expect(summary.namedSnapshots.find((entry) => entry.name === "phase")).toMatchObject({
      changeAfterNonWaitCount: 0,
      distinctValueCount: 2,
    });
    expect(summary.policy).toMatchObject({
      failures: [expect.stringContaining("post-non-Wait change minimum")],
      satisfied: false,
    });
  });

  test("attributes named changes to the exact action kind", async () => {
    const observation = directObservation();
    const noOpClickTrace = await summaryTrace([
      traceLine(observation, 1, {
        namedSnapshots: [{ name: "phase", value: 0 }],
      }),
      traceLine(observation, 2, {
        action: {
          Click: {
            fingerprint: { tag: "button" },
            point: { x: 1, y: 1 },
          },
        },
        namedSnapshots: [{ name: "phase", value: 0 }],
      }),
      traceLine(observation, 3, {
        action: { SetViewport: { height: 720, width: 1_280 } },
        namedSnapshots: [{ name: "phase", value: 1 }],
      }),
    ]);
    const failed = await summarizeDirectBombadilTrace({
      explorationPolicy: {
        minNamedSnapshotChangesAfterActionKind: {
          phase: { Click: 1, SetViewport: 1 },
        },
        minNamedSnapshotChangesAfterNonWait: { phase: 1 },
      },
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath: noOpClickTrace,
    });
    expect(failed.namedSnapshots.find((entry) => entry.name === "phase"))
      .toMatchObject({
        changeAfterActionKind: { SetViewport: 1 },
        changeAfterNonWaitCount: 1,
      });
    expect(failed.policy).toMatchObject({
      failures: [expect.stringContaining("post-Click change minimum")],
      satisfied: false,
    });

    const attributedTrace = await summaryTrace([
      traceLine(observation, 1, {
        namedSnapshots: [{ name: "phase", value: 0 }],
      }),
      traceLine(observation, 2, {
        action: {
          Click: {
            fingerprint: { tag: "button" },
            point: { x: 1, y: 1 },
          },
        },
        namedSnapshots: [{ name: "phase", value: 1 }],
      }),
      traceLine(observation, 3, {
        action: { SetViewport: { height: 720, width: 1_280 } },
        namedSnapshots: [{ name: "phase", value: 2 }],
      }),
    ]);
    const attributed = await summarizeDirectBombadilTrace({
      explorationPolicy: {
        minNamedSnapshotChangesAfterActionKind: {
          phase: { SetViewport: 1, Click: 1 },
        },
      },
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath: attributedTrace,
    });
    const phase = attributed.namedSnapshots.find((entry) => entry.name === "phase");
    expect(phase?.changeAfterActionKind).toEqual({ Click: 1, SetViewport: 1 });
    expect(phase?.changeAfterNonWaitCount).toBe(2);
    expect(phase?.changeAfterNonWaitCount).toBe(
      Object.entries(phase?.changeAfterActionKind ?? {})
        .filter(([kind]) => kind !== "Wait")
        .reduce((total, [, count]) => total + count, 0),
    );
    expect(attributed.policy.satisfied).toBeTrue();
  });

  test("requires adjacent exact observations for action attribution", async () => {
    const exact = directObservation();
    const click = {
      Click: {
        fingerprint: { tag: "button" },
        point: { x: 1, y: 1 },
      },
    } as const;
    const missingSnapshotTrace = await summaryTrace([
      traceLine(exact, 1, {
        namedSnapshots: [{ name: "phase", value: 0 }],
      }),
      traceLine(exact, 2),
      traceLine(exact, 3, {
        action: click,
        namedSnapshots: [{ name: "phase", value: 1 }],
      }),
    ]);
    const invalidCurrentTrace = await summaryTrace([
      traceLine(exact, 1, {
        namedSnapshots: [{ name: "phase", value: 0 }],
      }),
      traceLine(absentObservation(), 2, {
        action: click,
        namedSnapshots: [{ name: "phase", value: 1 }],
      }),
    ]);
    for (const tracePath of [missingSnapshotTrace, invalidCurrentTrace]) {
      const summary = await summarizeDirectBombadilTrace({
        explorationPolicy: {
          minNamedSnapshotChangesAfterActionKind: { phase: { Click: 1 } },
        },
        targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
        tracePath,
      });
      expect(summary.namedSnapshots.find((entry) => entry.name === "phase")
        ?.changeAfterActionKind).toEqual({});
      expect(summary.policy.satisfied).toBeFalse();
    }
  });

  test("uses the first exact Direct observation only as the policy baseline", async () => {
    const tracePath = await summaryTrace([
      traceLine(absentObservation(), 20, {
        namedSnapshots: [{ name: "phase", value: "loading" }],
        violations: [{
          name: "startup_contract",
          violation: { False: {} },
        }],
      }),
      traceLine(absentObservation(), 2, {
        action: {
          Click: {
            fingerprint: { tag: "button" },
            point: { x: 1, y: 1 },
          },
        },
        namedSnapshots: [{ name: "phase", value: "pre-handshake-click" }],
      }),
      traceLine(directObservation(), 3, {
        action: {
          Click: {
            fingerprint: { tag: "button" },
            point: { x: 1, y: 1 },
          },
        },
        namedSnapshots: [{ name: "phase", value: "ready" }],
      }),
    ]);
    const summary = await summarizeDirectBombadilTrace({
      explorationPolicy: {
        minDistinctNamedSnapshotValues: { phase: 2 },
        minNamedSnapshotChangesAfterActionKind: { phase: { Click: 1 } },
        minNamedSnapshotChangesAfterNonWait: { phase: 1 },
        minNonWaitActions: 1,
        requiredActionKinds: ["Click"],
        requiredNamedSnapshots: ["phase"],
      },
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath,
    });
    expect(summary.actions).toMatchObject({
      byKind: {},
      nonWaitCount: 0,
      total: 0,
    });
    expect(summary.urls.observationCount).toBe(1);
    expect(summary.urls.rawObservationCount).toBe(3);
    expect(summary.transitions).toEqual({
      distinctNonNullHashCount: 1,
      nonNullHashCount: 1,
      rawDistinctNonNullHashCount: 3,
      rawNonNullHashCount: 3,
    });
    expect(summary.propertyViolations).toEqual({
      byName: { startup_contract: 1 },
      total: 1,
    });
    expect(summary.resourceHighWaterMarks.domNodes).toBe(20);
    expect(summary.namedSnapshots.find((entry) => entry.name === "phase"))
      .toMatchObject({
        changeAfterNonWaitCount: 0,
        distinctValueCount: 1,
        observationCount: 1,
      });
    expect(summary.policy).toMatchObject({
      failures: [
        expect.stringContaining("minimum non-Wait"),
        expect.stringContaining("required action kind Click"),
        expect.stringContaining("distinct-value minimum"),
        expect.stringContaining("post-non-Wait change minimum"),
        expect.stringContaining("post-Click change minimum"),
      ],
      satisfied: false,
    });
  });

  test("orders mixed-case and punctuation summary names by code unit", async () => {
    const observation = directObservation();
    const tracePath = await summaryTrace([traceLine(observation, 1, {
      namedSnapshots: [
        { name: "z", value: 4 },
        { name: "a.", value: 3 },
        { name: "A", value: 1 },
        { name: "a-", value: 2 },
      ],
      violations: [
        { name: "z", violation: { False: {} } },
        { name: "a.", violation: { False: {} } },
        { name: "A", violation: { False: {} } },
        { name: "a-", violation: { False: {} } },
      ],
    })]);
    const summary = await summarizeDirectBombadilTrace({
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath,
    });
    expect(summary.namedSnapshots.map(({ name }) => name)).toEqual([
      "A",
      "a-",
      "a.",
      "direct",
      "z",
    ]);
    expect(Object.keys(summary.propertyViolations.byName)).toEqual([
      "A",
      "a-",
      "a.",
      "z",
    ]);
  });

  test("rejects hostile envelopes, action targets, and excessively deep snapshot JSON", async () => {
    const observation = directObservation();
    const badTarget = await summaryTrace([traceLine(observation, 1, {
      action: {
        Click: {
          fingerprint: { tag: "" },
          point: { x: 1, y: 1 },
        },
      },
    })]);
    expect((await rejection(summarizeDirectBombadilTrace({
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath: badTarget,
    }))).message).toContain("invalid action target tag");

    for (const action of [
      { PressKey: {} },
      { PressKey: { code: 256 } },
      { SetViewport: {} },
      { SetViewport: { height: 720, width: 0 } },
      {
        MouseDrag: {
          delay_millis: 0,
          from: { x: 0, y: 0 },
          steps: 0,
          to: { x: 1, y: 1 },
        },
      },
      { TypeText: { delay_millis: 0, text: "safe", unexpected: true } },
    ]) {
      const malformedAction = await summaryTrace([traceLine(observation, 1, {
        action,
      })]);
      expect((await rejection(summarizeDirectBombadilTrace({
        targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
        tracePath: malformedAction,
      }))).message).toContain("invalid action");
    }

    let deep: unknown = null;
    for (let index = 0; index < 70; index += 1) deep = [deep];
    const deepTrace = await summaryTrace([traceLine(observation, 1, {
      namedSnapshots: [{ name: "deep", value: deep }],
    })]);
    expect((await rejection(summarizeDirectBombadilTrace({
      explorationPolicy: { requiredNamedSnapshots: ["deep"] },
      targetUrl: "http://127.0.0.1:4919/?__direct_scenario=surface.ready",
      tracePath: deepTrace,
    }))).message).toContain("exceeds JSON depth");
  });
});

describe("Direct Bombadil process lifecycle", () => {
  test("tolerates only live-scan entry disappearance and fails final proof closed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-entry-race-"));
    temporaryDirectories.push(directory);
    const transientPath = join(directory, "transient.log");
    const policy = {
      maxDepth: 4,
      maxEntries: 8,
      maxFileBytes: 1_024,
      maxFiles: 4,
      maxPathBytes: 256,
      maxTotalBytes: 2_048,
    };
    await writeFile(transientPath, "transient\n");
    const transient = await rejection(inspectBombadilArtifactTreeForTest({
      allowTransientEntryAbsence: true,
      beforeEntryInspect: async (path) => {
        await rm(path);
      },
      hashFiles: false,
      policy,
      root: directory,
    }));
    expect((transient as NodeJS.ErrnoException).code).toBe("ENOENT");

    await writeFile(transientPath, "final\n");
    const final = await rejection(inspectBombadilArtifactTreeForTest({
      beforeEntryInspect: async (path) => {
        await rm(path);
      },
      hashFiles: true,
      policy,
      root: directory,
    }));
    expect(final.name).toBe("BombadilArtifactPolicyError");
    expect(final.message).toContain("could not be inspected safely");

    const nested = join(directory, "nested");
    await mkdir(nested);
    await writeFile(join(nested, "trace.log"), "transient\n");
    const nestedTransient = await rejection(inspectBombadilArtifactTreeForTest({
      allowTransientEntryAbsence: true,
      beforeDirectoryOpen: async (path) => {
        if (path === nested) await rm(path, { recursive: true });
      },
      hashFiles: false,
      policy,
      root: directory,
    }));
    expect((nestedTransient as NodeJS.ErrnoException).code).toBe("ENOENT");

    await mkdir(nested);
    await writeFile(join(nested, "trace.log"), "final\n");
    const nestedFinal = await rejection(inspectBombadilArtifactTreeForTest({
      beforeDirectoryOpen: async (path) => {
        if (path === nested) await rm(path, { recursive: true });
      },
      hashFiles: true,
      policy,
      root: directory,
    }));
    expect(nestedFinal.name).toBe("BombadilArtifactPolicyError");
    expect(nestedFinal.message).toMatch(
      /Bombadil artifact directory could not be (?:opened|inspected) safely:/u,
    );
  });

  test("omits the upload coordination UUID from the native process environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-native-environment-"));
    temporaryDirectories.push(directory);
    const previous = process.env.DIRECT_BOMBADIL_RUN_ID;
    process.env.DIRECT_BOMBADIL_RUN_ID = "child-visible-secret";
    const running = runBombadilNativeProcess({
      command: [
        process.execPath,
        "-e",
        "console.log(process.env.DIRECT_BOMBADIL_RUN_ID ?? 'absent')",
      ],
      cwd: directory,
      outputPath: directory,
      targetUrl: "http://127.0.0.1:4919/",
      wallClockTimeoutMs: 5_000,
    });
    if (previous === undefined) delete process.env.DIRECT_BOMBADIL_RUN_ID;
    else process.env.DIRECT_BOMBADIL_RUN_ID = previous;
    const result = await running;
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("absent");
  });

  test("aborts the owned process group when live artifacts exceed quota", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-artifact-quota-"));
    temporaryDirectories.push(directory);
    const overflowPath = join(directory, "overflow.log");
    const source = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(overflowPath)}, Buffer.alloc(4096));`,
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const startedAt = Date.now();
    const error = await rejection(runBombadilNativeProcess({
      artifactPolicy: {
        maxDepth: 4,
        maxEntries: 8,
        maxFileBytes: 1_024,
        maxFiles: 4,
        maxPathBytes: 256,
        maxTotalBytes: 2_048,
      },
      command: [process.execPath, "-e", source],
      cwd: directory,
      outputPath: directory,
      targetUrl: "http://127.0.0.1:4919/",
      terminationGraceMs: 50,
      wallClockTimeoutMs: 5_000,
    }));
    expect(error.message).toContain("per-file byte quota");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("promotes an artifact-policy result that races a clean process exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-artifact-exit-race-"));
    temporaryDirectories.push(directory);
    const overflowPath = join(directory, "overflow.log");
    const error = await rejection(runBombadilNativeProcess({
      artifactPolicy: {
        maxDepth: 4,
        maxEntries: 8,
        maxFileBytes: 1_024,
        maxFiles: 4,
        maxPathBytes: 256,
        maxTotalBytes: 2_048,
      },
      command: [
        process.execPath,
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(overflowPath)}, Buffer.alloc(4096));`,
      ],
      cwd: directory,
      outputPath: directory,
      targetUrl: "http://127.0.0.1:4919/",
      terminationGraceMs: 50,
      wallClockTimeoutMs: 5_000,
    }));
    expect(error.message).toContain("per-file byte quota");
  });

  test("cleans descendants and inherited pipes after a normal leader exit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-normal-exit-"));
    temporaryDirectories.push(directory);
    const childSource = [
      "process.on('SIGTERM', () => {});",
      "setTimeout(() => process.exit(0), 5000);",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const leaderSource = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'inherit', 'inherit'] });`,
      "child.unref();",
      "console.log('normal leader output');",
    ].join(" ");
    const startedAt = Date.now();
    const result = await runBombadilNativeProcess({
      command: [process.execPath, "-e", leaderSource],
      cwd: directory,
      outputPath: directory,
      targetUrl: "http://127.0.0.1:4919/",
      terminationGraceMs: 50,
      wallClockTimeoutMs: 5_000,
    });
    expect(result).toMatchObject({ exitCode: 0, termination: null });
    expect(result.stdout).toContain("normal leader output");
    expect(Date.now() - startedAt).toBeLessThan(3_500);
  }, 10_000);

  test("kills an uncooperative native child after the outer wall-clock limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-timeout-"));
    temporaryDirectories.push(directory);
    const invocation: DirectBombadilInvocation = {
      command: [
        process.execPath,
        "-e",
        "console.log('timeout output'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      cwd: directory,
      outputPath: directory,
      targetUrl: "http://127.0.0.1:4919/",
      terminationGraceMs: 50,
      wallClockTimeoutMs: 500,
    };
    const startedAt = Date.now();
    const result = await runBombadilNativeProcess(invocation);
    expect(result.termination).toBe("timeout");
    expect(result.stdout).toContain("timeout output");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("kills an ignoring process-group descendant after its leader exits", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-descendant-timeout-"));
    temporaryDirectories.push(directory);
    const childSource = [
      "const { spawn } = require('node:child_process');",
      "spawn(process.execPath, ['-e', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`], { stdio: ['ignore', 'inherit', 'inherit'] });",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const startedAt = Date.now();
    const result = await runBombadilNativeProcess({
      command: [process.execPath, "-e", childSource],
      cwd: directory,
      outputPath: directory,
      targetUrl: "http://127.0.0.1:4919/",
      terminationGraceMs: 50,
      wallClockTimeoutMs: 100,
    });
    expect(result.termination).toBe("timeout");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("kills an uncooperative native child immediately on abort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-abort-"));
    temporaryDirectories.push(directory);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 250);
    const startedAt = Date.now();
    const result = await runBombadilNativeProcess({
      abortSignal: controller.signal,
      command: [
        process.execPath,
        "-e",
        "console.log('abort output'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
      ],
      cwd: directory,
      outputPath: directory,
      targetUrl: "http://127.0.0.1:4919/",
      terminationGraceMs: 50,
      wallClockTimeoutMs: 5_000,
    });
    expect(result.termination).toBe("aborted");
    expect(result.stdout).toContain("abort output");
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test("gives an aborted artifact writer no quota-growing TERM grace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-abort-quota-"));
    temporaryDirectories.push(directory);
    const growingPath = join(directory, "growing.log");
    const controller = new AbortController();
    const source = [
      "const fs = require('node:fs');",
      `const path = ${JSON.stringify(growingPath)};`,
      "process.on('SIGTERM', () => fs.appendFileSync(path, Buffer.alloc(8192)));",
      "fs.writeFileSync(path, Buffer.alloc(256));",
      "setInterval(() => {}, 1000);",
    ].join(" ");
    const running = runBombadilNativeProcess({
      abortSignal: controller.signal,
      artifactPolicy: {
        maxDepth: 4,
        maxEntries: 8,
        maxFileBytes: 4_096,
        maxFiles: 4,
        maxPathBytes: 256,
        maxTotalBytes: 8_192,
      },
      command: [process.execPath, "-e", source],
      cwd: directory,
      outputPath: directory,
      targetUrl: "http://127.0.0.1:4919/",
      terminationGraceMs: 2_000,
      wallClockTimeoutMs: 5_000,
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(growingPath);
        ready = true;
        break;
      } catch {
        await Bun.sleep(10);
      }
    }
    if (!ready) {
      controller.abort();
      await running;
      throw new Error("Bombadil writer did not publish its readiness file");
    }
    const startedAt = Date.now();
    controller.abort();
    const result = await running;
    expect(result.termination).toBe("aborted");
    expect((await readFile(growingPath)).byteLength).toBeLessThanOrEqual(4_096);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});

describe("Direct Bombadil run lifecycle", () => {
  test("starts and stops the owned server and writes attested passing artifacts", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies();
    const result = await runDirectBombadilFuzz(config, ["--time-limit=12s"], runtime.overrides);

    expect(result.kind).toBe("run");
    expect(runtime.serverCommands).toEqual([[
      "bun", "run", "dev", "--port", "4919",
    ]]);
    expect(runtime.calls).toEqual([
      "acquire-server",
      "spawn-server",
      "run-bombadil",
      "stop-server",
      "terminate",
    ]);
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      schema: "direct.bombadil-run/v1",
      evidenceClass: "diagnostic-fuzz",
      status: "passed",
      scenario: "surface.ready",
      expectedRoute: "/surface",
      durationMs: 1_250,
      serverSource: "started",
      timeLimitSeconds: 12,
      attestation: {
        schema: "direct.bombadil-trace-attestation/v1",
        initial: { source: "scenario", scenario: "surface.ready", route: "/surface" },
      },
      initialDirect: { source: "scenario", scenario: "surface.ready", route: "/surface" },
      server: { logPresent: true },
      explorationSummary: {
        schema: "direct.bombadil-exploration-summary/v2",
        policy: { configured: false, satisfied: true },
      },
      viewport: { deviceScaleFactor: 2, height: 768, width: 1_024 },
    });
    const bombadil = record(manifest.bombadil, "bombadil");
    expect(bombadil.version).toBe("0.7.2");
    expect(bombadil.termination).toBeNull();
    expect(bombadil.logPath).toBeString();
    expect(bombadil.rawTracePath).toBeString();
    expect(bombadil.tracePath).toBeString();
    expect(await readFile(String(bombadil.logPath), "utf8")).toContain("bombadil stdout");
    const server = record(manifest.server, "server");
    expect(await readFile(String(server.logPath), "utf8")).toContain("server output");
    const summaryPath = String(manifest.explorationSummaryPath);
    expect(JSON.parse(await readFile(summaryPath, "utf8"))).toMatchObject({
      schema: "direct.bombadil-exploration-summary/v2",
      trace: { lineCount: 2 },
    });
    if (result.kind !== "run") throw new Error("Expected a Bombadil run result");
    expect((await readdir(result.uploadArtifactPath)).sort()).toEqual([
      "receipt.json",
      "summary.json",
    ]);
    expect(JSON.parse(await readFile(result.receiptPath, "utf8"))).toMatchObject({
      schema: "direct.bombadil-artifact-receipt/v1",
      failureCode: null,
      mode: "public-summary",
      status: "passed",
      inventory: { fileCount: 1 },
    });
  });

  test("publishes only sanitized files publicly and descriptor-vetted files privately", async () => {
    const { config, repositoryRoot } = await fixture();
    const sentinel = "secret-query-and-log-sentinel";
    const publicRuntime = dependencies();
    const publicResult = await runDirectBombadilFuzz({
      ...config,
      targetQuery: { token: sentinel },
    }, {
      arguments: [],
      artifactRun: artifactRunPlan(repositoryRoot, 11),
    }, publicRuntime.overrides);
    if (publicResult.kind !== "run") throw new Error("Expected a public Bombadil run result");
    const publicPayload = (await Promise.all((await readdir(publicResult.uploadArtifactPath)).map(
      async (name) => await readFile(join(publicResult.uploadArtifactPath, name), "utf8"),
    ))).join("\n");
    expect(publicPayload).not.toContain(sentinel);
    expect(publicPayload).not.toContain(repositoryRoot);
    expect(publicPayload).not.toContain("bombadil stdout");
    expect(JSON.parse(await readFile(publicResult.receiptPath, "utf8"))).toMatchObject({
      diagnosticsRetained: false,
      mode: "public-summary",
    });

    const privateRuntime = dependencies();
    const privateResult = await runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: artifactRunPlan(repositoryRoot, 12, "private-vetted"),
    }, privateRuntime.overrides);
    if (privateResult.kind !== "run") throw new Error("Expected a private Bombadil run result");
    expect((await readdir(privateResult.uploadArtifactPath)).sort()).toEqual([
      "diagnostics",
      "receipt.json",
      "summary.json",
    ]);
    expect(await readFile(
      join(privateResult.uploadArtifactPath, "diagnostics", "bombadil-output", "trace.jsonl"),
      "utf8",
    )).toContain('"name":"direct"');
    expect(await readFile(
      join(privateResult.uploadArtifactPath, "diagnostics", "host", "bombadil.log"),
      "utf8",
    )).toContain("bombadil stdout");
    expect(JSON.parse(await readFile(privateResult.receiptPath, "utf8"))).toMatchObject({
      diagnosticsRetained: true,
      mode: "private-vetted",
    });
  });

  test("rejects symlink artifacts and publishes a receipt without raw diagnostics", async () => {
    const { config, repositoryRoot } = await fixture();
    const outside = join(repositoryRoot, "outside.txt");
    await writeFile(outside, "do not copy\n");
    const runtime = dependencies({
      afterTrace: async (invocation) => {
        await symlink(outside, join(invocation.outputPath, "escaped.txt"));
      },
    });
    const plan = artifactRunPlan(repositoryRoot, 13, "private-vetted");
    const error = await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, runtime.overrides));
    expect(error.message).toContain("symbolic link");
    const upload = join(repositoryRoot, "artifacts", "direct-bombadil-upload", plan.runId);
    expect((await readdir(upload)).sort()).toEqual(["receipt.json", "summary.json"]);
    expect(JSON.parse(await readFile(join(upload, "receipt.json"), "utf8"))).toMatchObject({
      diagnosticsRetained: false,
      failureCode: "artifact-policy",
      status: "failed",
    });
  });

  test("rejects multiply-linked artifacts before private copying", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({
      afterTrace: async (invocation) => {
        await link(
          join(invocation.outputPath, "trace.jsonl"),
          join(invocation.outputPath, "duplicate.jsonl"),
        );
      },
    });
    const plan = artifactRunPlan(repositoryRoot, 15, "private-vetted");
    const error = await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, runtime.overrides));
    expect(error.message).toContain("multiply-linked");
    const upload = join(repositoryRoot, "artifacts", "direct-bombadil-upload", plan.runId);
    expect((await readdir(upload)).sort()).toEqual(["receipt.json", "summary.json"]);
  });

  test("includes tagged empty directories in the authoritative inventory hash", async () => {
    const { config, repositoryRoot } = await fixture();
    const baselinePlan = artifactRunPlan(repositoryRoot, 16);
    await runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: baselinePlan,
    }, dependencies().overrides);
    const baselineReceipt = record(JSON.parse(await readFile(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil-upload",
      baselinePlan.runId,
      "receipt.json",
    ), "utf8")), "baseline receipt");

    const emptyDirectoryPlan = artifactRunPlan(repositoryRoot, 17);
    await runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: emptyDirectoryPlan,
    }, dependencies({
      afterTrace: async (invocation) => {
        await mkdir(join(invocation.outputPath, "empty"));
      },
    }).overrides);
    const emptyDirectoryReceipt = record(JSON.parse(await readFile(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil-upload",
      emptyDirectoryPlan.runId,
      "receipt.json",
    ), "utf8")), "empty-directory receipt");
    const baselineInventory = record(baselineReceipt.inventory, "baseline inventory");
    const emptyDirectoryInventory = record(
      emptyDirectoryReceipt.inventory,
      "empty-directory inventory",
    );
    expect(emptyDirectoryInventory).toMatchObject({ entryCount: 2, fileCount: 1 });
    expect(emptyDirectoryInventory.inventorySha256).not.toBe(
      baselineInventory.inventorySha256,
    );
  });

  test("preserves the primary failure when sanitized receipt publication also fails", async () => {
    const { config, repositoryRoot } = await fixture();
    const plan = artifactRunPlan(repositoryRoot, 18);
    await mkdir(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil-upload",
      `.staging-${plan.runId}`,
    ), { recursive: true });
    const error = await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, dependencies({ exitCode: 9 }).overrides));
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toContain("exited with status 9");
    expect(error.message).toContain("receipt publication also failed");
  });

  test("publishes a sanitized rejection receipt before invalid configuration can spawn", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies();
    const plan = artifactRunPlan(repositoryRoot, 14);
    const error = await rejection(runDirectBombadilFuzz({
      ...config,
      artifactName: "../escape",
      targetQuery: { token: "configuration-secret" },
    }, { arguments: [], artifactRun: plan }, runtime.overrides));
    expect(error.message).toContain("artifactName");
    expect(runtime.calls).toEqual([]);
    const upload = join(repositoryRoot, "artifacts", "direct-bombadil-upload", plan.runId);
    const payload = await readFile(join(upload, "receipt.json"), "utf8");
    expect(payload).not.toContain("configuration-secret");
    expect(JSON.parse(payload)).toMatchObject({
      failureCode: "configuration-rejected",
      status: "rejected",
    });
  });

  test("runs with policy-owned evidence despite arbitrary unrelated named snapshots", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({
      observations: [directObservation()],
      traceLineOptions: [{
        namedSnapshots: [
          { name: "owned", value: "ready" },
          { name: "phase state", value: "ready" },
          { name: "duplicate", value: 0 },
          { name: "duplicate", value: 1 },
          { name: "deep", value: nestedJson(65) },
          { name: "large", value: "x".repeat(2 * 1024 * 1024 + 1) },
        ],
      }],
    });
    const result = await runDirectBombadilFuzz({
      ...config,
      explorationPolicy: { requiredNamedSnapshots: ["owned"] },
    }, [], runtime.overrides);
    expect(result.kind).toBe("run");
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      status: "passed",
      attestation: { validObservationCount: 1 },
      explorationSummary: {
        namedSnapshots: [{ name: "direct" }, { name: "owned" }],
        policy: { configured: true, failures: [], satisfied: true },
      },
    });
  });

  test("publishes an interrupted receipt when a signal wins during preflight", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies();
    const signals = controllableSignals();
    const runId = "00000000-0000-4000-8000-000000000035";
    let runIdCount = 0;
    const error = await rejection(runDirectBombadilFuzz(config, [], {
      ...runtime.overrides,
      createRunId: () => {
        runIdCount += 1;
        signals.emit("SIGTERM");
        return runId;
      },
      signalController: signals.controller,
    }));
    expect(error.message).toContain("interrupted");
    expect(runtime.calls).toEqual([]);
    expect(signals.forwarded).toEqual(["SIGTERM"]);
    expect(signals.listenerCount()).toBe(0);
    expect(runIdCount).toBe(1);
    expect(JSON.parse(await readFile(join(
      resolveDirectBombadilUploadLeaf({ repositoryRoot, runId }),
      "receipt.json",
    ), "utf8"))).toMatchObject({
      diagnosticsRetained: false,
      failureCode: "interrupted",
      status: "failed",
    });
  });

  test("publishes an interrupted receipt when a signal wins during acquisition", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies();
    const signals = controllableSignals();
    const plan = artifactRunPlan(repositoryRoot, 36);
    await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, {
      ...runtime.overrides,
      acquireServer: async () => {
        runtime.calls.push("acquire-server");
        signals.emit("SIGINT");
        throw new Error("acquisition interrupted");
      },
      signalController: signals.controller,
    }));
    expect(runtime.calls).toEqual(["acquire-server"]);
    expect(signals.forwarded).toEqual(["SIGINT"]);
    expect(signals.listenerCount()).toBe(0);
    expect(JSON.parse(await readFile(join(
      resolveDirectBombadilUploadLeaf(plan),
      "receipt.json",
    ), "utf8"))).toMatchObject({
      failureCode: "interrupted",
      status: "failed",
    });
  });

  test("converts a pre-commit signal into one interrupted immutable leaf", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies();
    const signals = controllableSignals();
    const plan = artifactRunPlan(repositoryRoot, 37, "private-vetted");
    let commitCount = 0;
    const error = await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, {
      ...runtime.overrides,
      beforeArtifactCommit: () => {
        commitCount += 1;
        signals.emit("SIGTERM");
      },
      signalController: signals.controller,
    }));
    expect(error.message).toContain("SIGTERM");
    expect(commitCount).toBe(1);
    expect(signals.forwarded).toEqual(["SIGTERM"]);
    expect(signals.listenerCount()).toBe(0);
    const upload = resolveDirectBombadilUploadLeaf(plan);
    expect((await readdir(upload)).sort()).toEqual(["receipt.json", "summary.json"]);
    expect(JSON.parse(await readFile(join(upload, "receipt.json"), "utf8"))).toMatchObject({
      diagnosticsRetained: false,
      failureCode: "interrupted",
      status: "failed",
    });
  });

  test("removes private diagnostics when a publication precheck rejects", async () => {
    const { config, repositoryRoot } = await fixture();
    const plan = artifactRunPlan(repositoryRoot, 41, "private-vetted");
    const error = await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, {
      ...dependencies().overrides,
      beforeArtifactCommit: () => {
        throw new Error("run precommit rejected");
      },
    }));
    expect(error.message).toContain("run precommit rejected");
    expect(await readdir(dirname(resolveDirectBombadilUploadLeaf(plan)))).toEqual([]);
  });

  test("does not spawn when cancellation wins before server startup", async () => {
    const { config } = await fixture();
    const runtime = dependencies();
    const controller = new AbortController();
    const error = await rejection(runDirectBombadilFuzz(config, [], {
      ...runtime.overrides,
      createAbortController: () => controller,
      acquireServer: (options): Promise<ServerLease> => {
        runtime.calls.push("acquire-server");
        controller.abort();
        return Promise.resolve({ source: "started", server: options.startServer() });
      },
    }));
    expect(error.message).toContain("Bombadil fuzzing was interrupted");
    expect(runtime.calls).toEqual(["acquire-server"]);
  });

  test("terminates a server when cancellation wins during spawn", async () => {
    const { config } = await fixture();
    const runtime = dependencies();
    const controller = new AbortController();
    const server = fakeServer(runtime.calls);
    const error = await rejection(runDirectBombadilFuzz(config, [], {
      ...runtime.overrides,
      createAbortController: () => controller,
      spawnServer: () => {
        runtime.calls.push("spawn-server");
        controller.abort();
        return server;
      },
    }));
    expect(error.message).toContain("Bombadil fuzzing was interrupted");
    expect(runtime.calls).toEqual([
      "acquire-server",
      "spawn-server",
      "terminate",
      "stop-server",
    ]);
    expect(server.exitCode()).toBe(0);
  });

  test("cleans a just-acquired server before Bombadil can run", async () => {
    const { config } = await fixture();
    const runtime = dependencies();
    const controller = new AbortController();
    const error = await rejection(runDirectBombadilFuzz(config, [], {
      ...runtime.overrides,
      createAbortController: () => controller,
      acquireServer: (options): Promise<ServerLease> => {
        runtime.calls.push("acquire-server");
        const server = options.startServer();
        controller.abort();
        return Promise.resolve({ source: "started", server });
      },
    }));
    expect(error.message).toContain("Bombadil fuzzing was interrupted");
    expect(runtime.calls).toEqual([
      "acquire-server",
      "spawn-server",
      "terminate",
      "stop-server",
    ]);
    expect(runtime.calls).not.toContain("run-bombadil");
  });

  test("unwinds a pending server acquisition when cancellation arrives", async () => {
    const { config } = await fixture();
    const runtime = dependencies();
    const controller = new AbortController();
    let markAcquiring!: () => void;
    const acquiring = new Promise<void>((resolve) => {
      markAcquiring = resolve;
    });
    const run = runDirectBombadilFuzz(config, [], {
      ...runtime.overrides,
      createAbortController: () => controller,
      acquireServer: async (options): Promise<ServerLease> => {
        runtime.calls.push("acquire-server");
        const server = options.startServer();
        markAcquiring();
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => reject(new Error("acquisition aborted"));
          options.abortSignal?.addEventListener("abort", abort, { once: true });
          if (options.abortSignal?.aborted === true) abort();
        });
        return { source: "started", server };
      },
    });
    await acquiring;
    controller.abort();
    const error = await rejection(run);
    expect(error.message).toContain("Bombadil fuzzing was interrupted");
    expect(runtime.calls).toEqual([
      "acquire-server",
      "spawn-server",
      "stop-server",
      "terminate",
    ]);
    expect(runtime.calls).not.toContain("run-bombadil");
  });

  test("fails a configured exploration policy while retaining the derived sidecar", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies();
    expect((await rejection(runDirectBombadilFuzz({
      ...config,
      explorationPolicy: {
        minNonWaitActions: 1,
        requiredActionKinds: ["Click"],
      },
    }, [], runtime.overrides))).message).toContain("exploration policy was not satisfied");
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      status: "failed",
      explorationSummary: {
        policy: { configured: true, satisfied: false },
      },
    });
    expect(await readFile(String(manifest.explorationSummaryPath), "utf8"))
      .toContain("direct.bombadil-exploration-summary/v2");
  });

  test("retains an attested failure artifact and server log for a nonzero exit", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({ exitCode: 9 });
    expect((await rejection(runDirectBombadilFuzz(config, [], runtime.overrides))).message)
      .toContain("Bombadil exited with status 9");
    expect(runtime.calls).toContain("stop-server");
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      status: "failed",
      failure: "Error: Bombadil exited with status 9",
      attestation: { validObservationCount: 1 },
      server: { logPresent: true },
    });
  });

  test("rejects exit zero without attestation and does not claim a trace path", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({ noTrace: true });
    expect((await rejection(runDirectBombadilFuzz(config, [], runtime.overrides))).message)
      .toContain("nonempty trace.jsonl");
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      status: "failed",
      attestation: null,
      bombadil: { rawTracePath: null, tracePath: null },
    });
    expect(manifest.attestationFailure).toBeString();
    expect(String(manifest.attestationFailure)).toContain("nonempty trace.jsonl");
  });

  test("retains a raw trace and process logs when exact attestation fails", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({ observations: [absentObservation()] });
    expect((await rejection(runDirectBombadilFuzz(config, [], runtime.overrides))).message)
      .toContain("never reached a valid Direct contract");
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    const bombadil = record(manifest.bombadil, "bombadil");
    expect(bombadil.rawTracePath).toBeString();
    expect(bombadil.tracePath).toBeNull();
    expect(await readFile(String(bombadil.rawTracePath), "utf8")).toContain('"name":"direct"');
    expect(await readFile(String(bombadil.logPath), "utf8")).toContain("bombadil stdout");
  });

  test("attests and retains output from a wall-clock-terminated process", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({ termination: "timeout" });
    expect((await rejection(runDirectBombadilFuzz(config, [], runtime.overrides))).message)
      .toContain("wall-clock limit");
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      status: "failed",
      attestation: { validObservationCount: 1 },
      bombadil: { termination: "timeout" },
    });
    const bombadil = record(manifest.bombadil, "bombadil");
    expect(bombadil.rawTracePath).toBeString();
    expect(bombadil.tracePath).toBeString();
    expect(await readFile(String(bombadil.logPath), "utf8")).toContain("bombadil stderr");
  });

  test("stops an owned server and retains its output when acquisition rejects", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({ failAcquire: true });
    expect((await rejection(runDirectBombadilFuzz(config, [], runtime.overrides))).message)
      .toContain("listener ownership unknown");
    expect(runtime.calls).toEqual([
      "acquire-server",
      "spawn-server",
      "stop-server",
      "terminate",
    ]);
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      status: "failed",
      serverSource: null,
      failure: "Error: listener ownership unknown",
      server: { logPresent: true },
    });
    const server = record(manifest.server, "server");
    expect(await readFile(String(server.logPath), "utf8")).toContain("server output");
  });

  test("bounds a server-output drain independently of writer settlement", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({
      neverServerOutput: true,
      serverOutputTimeoutMs: 10,
    });
    const plan = artifactRunPlan(repositoryRoot, 38);
    const startedAt = Date.now();
    const error = await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, runtime.overrides));
    expect(error.message).toContain("server output did not settle");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const manifest = record(JSON.parse(await readFile(join(
      repositoryRoot,
      "artifacts",
      "direct-bombadil",
      "fixture-product",
      "manifest.json",
    ), "utf8")), "manifest");
    expect(record(manifest.server, "server").outputFailure).toBeString();
    expect(JSON.parse(await readFile(join(
      resolveDirectBombadilUploadLeaf(plan),
      "receipt.json",
    ), "utf8"))).toMatchObject({
      failureCode: "server",
      status: "failed",
    });
  });

  test("classifies local evidence-write failure as persistence", async () => {
    const { config, repositoryRoot } = await fixture();
    const plan = artifactRunPlan(repositoryRoot, 39, "private-vetted");
    const runtime = dependencies({
      afterTrace: async (invocation) => {
        await mkdir(join(dirname(invocation.outputPath), "bombadil.log"));
      },
    });
    const error = await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, runtime.overrides));
    expect(error.message).toContain("local diagnostic logs could not be persisted");
    const upload = resolveDirectBombadilUploadLeaf(plan);
    expect((await readdir(upload)).sort()).toEqual([
      "diagnostics",
      "receipt.json",
      "summary.json",
    ]);
    expect(JSON.parse(await readFile(join(
      upload,
      "receipt.json",
    ), "utf8"))).toMatchObject({
      diagnosticsRetained: true,
      failureCode: "persistence",
      mode: "private-vetted",
      status: "failed",
    });
  });

  test("classifies an unreadable allowlisted output as artifact-policy", async () => {
    const { config, repositoryRoot } = await fixture();
    const plan = artifactRunPlan(repositoryRoot, 40);
    const runtime = dependencies({
      afterTrace: async (invocation) => {
        await chmod(join(invocation.outputPath, "trace.jsonl"), 0o000);
      },
    });
    const error = await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, runtime.overrides));
    expect(error.name).toBe("BombadilArtifactPolicyError");
    expect(error.message).toContain(
      "Bombadil artifact directory could not be inspected safely",
    );
    expect(JSON.parse(await readFile(join(
      resolveDirectBombadilUploadLeaf(plan),
      "receipt.json",
    ), "utf8"))).toMatchObject({
      failureCode: "artifact-policy",
      status: "failed",
    });
  });

  test("suppresses artifact inspection and private copying when server cleanup fails", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({
      neverServerOutput: true,
      serverOutputTimeoutMs: 10,
      stopFailure: true,
    });
    const plan = artifactRunPlan(repositoryRoot, 19, "private-vetted");
    const startedAt = Date.now();
    expect((await rejection(runDirectBombadilFuzz(config, {
      arguments: [],
      artifactRun: plan,
    }, runtime.overrides))).message).toContain("writers were not proven absent");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      status: "failed",
      failure: expect.stringContaining("BombadilWriterSettlementError"),
      server: {
        logPresent: false,
        outputFailure: null,
      },
    });
    const server = record(manifest.server, "server");
    expect(await readFile(String(server.logPath), "utf8")).toBe("");
    const upload = join(repositoryRoot, "artifacts", "direct-bombadil-upload", plan.runId);
    expect((await readdir(upload)).sort()).toEqual(["receipt.json", "summary.json"]);
    expect(JSON.parse(await readFile(join(upload, "receipt.json"), "utf8"))).toMatchObject({
      failureCode: "writer-settlement",
      inventory: { entryCount: 0, fileCount: 0, inventorySha256: null },
      status: "failed",
    });
    expect(parseDirectBombadilArtifactReceipt(JSON.parse(await readFile(
      join(upload, "receipt.json"),
      "utf8",
    ))).ok).toBeTrue();
    expect(parseDirectBombadilSanitizedRunSummary(JSON.parse(await readFile(
      join(upload, "summary.json"),
      "utf8",
    ))).ok).toBeTrue();
  });
});
