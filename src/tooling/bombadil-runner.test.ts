import { afterEach, describe, expect, test } from "bun:test";
import { defineDirect } from "@hraness/direct";
import { createDirectSession } from "@hraness/direct/testing";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attestDirectBombadilTrace,
  createDirectBombadilInvocation,
  parseDirectBombadilFuzzArguments,
  runBombadilNativeProcess,
  runDirectBombadilFuzz,
  validateDirectBombadilFuzzConfig,
  type DirectBombadilFuzzConfig,
  type DirectBombadilInvocation,
  type DirectBombadilRunnerDependencies,
} from "./bombadil-runner.js";
import type {
  ManagedVerificationServer,
  ServerLease,
} from "./browser-verification.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
});

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
  const repositoryRoot = await mkdtemp(join(tmpdir(), "direct-bombadil-runner-"));
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

function traceLine(observation: unknown, timestamp: number): string {
  return JSON.stringify({
    timestamp,
    action: null,
    state: {},
    snapshots: [{ index: 0, name: "direct", value: observation, time: timestamp }],
    violations: [],
  });
}

async function writeTrace(
  tracePath: string,
  observations: readonly unknown[],
): Promise<void> {
  await mkdir(join(tracePath, ".."), { recursive: true });
  await writeFile(
    tracePath,
    `${observations.map((observation, index) => traceLine(observation, index + 1)).join("\n")}\n`,
    "utf8",
  );
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

function dependencies(options: {
  readonly exitCode?: number;
  readonly failAcquire?: boolean;
  readonly noTrace?: boolean;
  readonly neverServerOutput?: boolean;
  readonly observations?: readonly unknown[];
  readonly serverOutputTimeoutMs?: number;
  readonly stopFailure?: boolean;
  readonly termination?: "aborted" | "timeout";
} = {}): {
  readonly calls: string[];
  readonly overrides: Partial<DirectBombadilRunnerDependencies>;
  readonly serverCommands: string[][];
} {
  const calls: string[] = [];
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
          if (options.noTrace !== true) {
            await writeTrace(
              join(invocation.outputPath, "trace.jsonl"),
              options.observations ?? [absentObservation(), directObservation()],
            );
          }
          return {
            exitCode: options.exitCode ?? 0,
            stdout: "bombadil stdout",
            stderr: "bombadil stderr",
            termination: options.termination ?? null,
          };
        })();
      },
      ...(options.serverOutputTimeoutMs === undefined
        ? {}
        : { serverOutputTimeoutMs: options.serverOutputTimeoutMs }),
      stopServer: async (ownedServer) => {
        calls.push("stop-server");
        if (options.stopFailure === true) {
          throw new Error("server cleanup failed");
        }
        ownedServer.terminate();
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
    expect(validated.bombadilExecutable).toEndWith(
      `node_modules/@antithesishq/bombadil/binaries/${nativeBinaryName()}`,
    );
  });

  test("rejects unsafe artifact, scenario, route, path, readiness, and server command inputs", async () => {
    const { config, repositoryRoot } = await fixture();
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      artifactName: "../escape",
    })).toThrow("artifactName");
    expect(() => validateDirectBombadilFuzzConfig({
      ...config,
      scenario: "Unsafe Scenario",
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
    expect((await rejection(runDirectBombadilFuzz({
      ...cwdFixture.config,
      server: { ...cwdFixture.config.server, cwd: cwdLink },
    }, [], cwdRuntime.overrides))).message).toContain(
      "server.cwd resolves outside repositoryRoot",
    );
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
  });

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
    expect(invocation.command).not.toContain("--time-limit");
    expect(invocation.command).not.toContain("--exit-on-violation");
    expect(invocation.wallClockTimeoutMs).toBe(330_000);
  });
});

describe("Direct Bombadil trace attestation", () => {
  async function attest(observations: readonly unknown[]) {
    const directory = await mkdtemp(join(tmpdir(), "direct-bombadil-trace-"));
    temporaryDirectories.push(directory);
    const tracePath = join(directory, "trace.jsonl");
    await writeTrace(tracePath, observations);
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
    }))).message).toContain("nonempty trace.jsonl");
    await writeFile(tracePath, "", "utf8");
    expect((await rejection(attestDirectBombadilTrace({
      expectedRoute: "/surface",
      expectedScenario: "surface.ready",
      tracePath,
    }))).message).toContain("nonempty trace.jsonl");
  });
});

describe("Direct Bombadil process lifecycle", () => {
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

  test("aborts and escalates an uncooperative native child promptly", async () => {
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

  test("bounds server output after cleanup fails and still writes artifacts", async () => {
    const { config, repositoryRoot } = await fixture();
    const runtime = dependencies({
      neverServerOutput: true,
      serverOutputTimeoutMs: 10,
      stopFailure: true,
    });
    const startedAt = Date.now();
    expect((await rejection(runDirectBombadilFuzz(config, [], runtime.overrides))).message)
      .toContain("server cleanup failed");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    const manifest = JSON.parse(await readFile(
      join(repositoryRoot, "artifacts", "direct-bombadil", "fixture-product", "manifest.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      status: "failed",
      failure: "Error: server cleanup failed",
      server: {
        logPresent: false,
        outputFailure: expect.stringContaining("did not settle within 10ms"),
      },
    });
    const server = record(manifest.server, "server");
    expect(await readFile(String(server.logPath), "utf8")).toBe("");
  });
});
