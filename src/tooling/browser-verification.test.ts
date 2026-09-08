import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";
import { defineDirect } from "@hraness/direct";
import {
  createDirectSession,
  parseDirectProbeSnapshot,
  parseDirectSessionManifest,
} from "@hraness/direct/testing";
import { DIRECT_BROWSER_BRIDGE_SCHEMA } from "@hraness/direct/web";
import { assertAsyncProperty, assertProperty, fc } from "../core/test-support.js";
import { captureVerificationOutput, VERIFICATION_OUTPUT_TAIL_LIMIT } from "./verification-output.js";

import {
  acquireVerificationServer,
  agentBrowserCloseProcessTimeoutMs,
  agentBrowserProcessTimeoutMs,
  bindDirectBrowserContractEvidence,
  bindDirectScenarioCatalog,
  boundedAgentBrowserSessionName,
  canAutomaticallyStartLocalServer,
  createDirectBrowserContractReader,
  createAgentBrowser,
  createArtifactRun,
  isolatedAgentBrowserEnvironment,
  normalizeRootHttpOrigin,
  parseAgentBrowserBatchEnvelope,
  parseAgentBrowserEnvelope,
  parseBaseUrlArguments,
  renderAgentBrowserCommand,
  renderUnknown,
  runVerificationCommand,
  serializeAgentBrowserLaunchArguments,
  serverIsReachable,
  spawnVerificationServer,
  stopVerificationServer,
  tail,
  writeJsonAtomically,
  VerificationServerOutputTimeoutError,
  type ManagedVerificationServer,
  type VerificationOutputSnapshot,
} from "./browser-verification.js";

const temporaryDirectories: string[] = [];
const readDirectBrowserContract = createDirectBrowserContractReader({
  bridgeSchema: DIRECT_BROWSER_BRIDGE_SCHEMA,
  parseManifest: parseDirectSessionManifest,
  parseProbe: parseDirectProbeSnapshot,
});

function directContractFixture(options: Readonly<{
  claim?: string;
  count?: number;
  source?: "fixture" | "scenario";
  title?: string;
}> = {}) {
  const definition = defineDirect({
    parseWorld: (input) => {
      if (
        typeof input !== "object"
        || input === null
        || Array.isArray(input)
        || !("count" in input)
        || typeof input.count !== "number"
      ) {
        throw new Error("World count is required");
      }
      return { count: input.count };
    },
    defaultScenario: "surface.ready",
    scenarios: [{
      id: "surface.ready",
      title: options.title ?? "Ready surface",
      route: "/surface",
      world: { count: options.count ?? 1 },
    }],
    coverage: [{
      key: "surface.render",
      claim: options.claim ?? "The ready surface renders.",
      mode: "fixture",
      scenarios: ["surface.ready"],
    }],
  });
  const fixture = definition.serializeFixture({
    scenario: "surface.ready",
    world: { count: options.count ?? 1 },
  });
  if (!fixture.ok) throw new Error(fixture.error.message);
  const session = createDirectSession({
    definition,
    activation: options.source === "fixture"
      ? {
        kind: "query",
        source: `?__direct_fixture=${encodeURIComponent(fixture.value)}`,
      }
      : { kind: "scenario", scenario: "surface.ready" },
    create: () => ({}),
  });
  if (!session.ok) throw new Error(session.error.message);
  const probe = session.value.probe.snapshot();
  if (!probe.ok) throw new Error(probe.error.message);
  return {
    bridgeSchema: DIRECT_BROWSER_BRIDGE_SCHEMA,
    manifest: session.value.manifest,
    probe: probe.value,
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "direct-verification-"));
  temporaryDirectories.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

function fakeServer(options: { readonly exitCode?: number | null } = {}): {
  readonly calls: string[];
  readonly server: ManagedVerificationServer;
} {
  const calls: string[] = [];
  let resolveExit!: () => void;
  let exitCode = options.exitCode ?? null;
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
    if (exitCode !== null) resolve();
  });
  return {
    calls,
    server: {
      exited,
      exitCode: () => exitCode,
      output: Promise.resolve("server log"),
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
    },
  };
}

function controlledOutput(logLimit = 12_000) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  return { controller, capture: captureVerificationOutput(stream, logLimit) };
}

async function withinPipeFixture<Value>(operation: Promise<Value>, label: string): Promise<Value> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Inherited-pipe fixture ${label} exceeded 2000ms`)), 2_000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// These programs contain no runtime data. Configuration crosses only argv;
// nonce-bearing files and marker output remain ordinary data, never source.
const inheritedPipePrelude = String.raw`
const fs = require('node:fs');
const { join } = require('node:path');
const argument = process.argv[2];
if (process.argv.length !== 3 || typeof argument !== 'string' || argument.length > 1024) {
  throw new Error('Invalid inherited-pipe fixture arguments');
}
const config = JSON.parse(argument);
if (config === null || typeof config !== 'object' || Array.isArray(config)
  || Object.keys(config).sort().join(',') !== 'nonce,stderr,stdout'
  || typeof config.nonce !== 'string'
  || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(config.nonce)
  || typeof config.stdout !== 'boolean' || typeof config.stderr !== 'boolean') {
  throw new Error('Invalid inherited-pipe fixture configuration');
}
const childReady = join(__dirname, 'child-ready.json');
`;
const inheritedPipeChildProgram = inheritedPipePrelude + String.raw`
process.on('SIGTERM', () => {});
setTimeout(() => {
  fs.writeFileSync(join(__dirname, 'child-expired'), 'expired', { flag: 'wx' });
  process.exit(72);
}, 15000);
if (config.stdout) fs.writeSync(1, 'owned stdout €🙂\n');
if (config.stderr) fs.writeSync(2, 'owned stderr €🙂\n');
fs.writeFileSync(childReady + '.pending', JSON.stringify({ nonce: config.nonce, pid: process.pid, parent: process.ppid }), { flag: 'wx' });
fs.renameSync(childReady + '.pending', childReady);
`;
const inheritedPipeLeaderProgram = inheritedPipePrelude + String.raw`
const { spawn } = require('node:child_process');
const leaderReady = join(__dirname, 'leader-ready.json');
const releaseLeader = join(__dirname, 'release-leader');
setTimeout(() => process.exit(71), 15000);
const child = spawn(process.execPath, [join(__dirname, 'child.cjs'), argument], {
  stdio: ['ignore', config.stdout ? 'inherit' : 'ignore', config.stderr ? 'inherit' : 'ignore'],
});
child.unref();
// A live runtime may retain stream state. EOF is proved after leader exit.
fs.closeSync(1); fs.closeSync(2);
(async () => {
  while (!fs.existsSync(childReady)) await Bun.sleep(10);
  const ready = JSON.parse(fs.readFileSync(childReady, 'utf8'));
  if (ready.nonce !== config.nonce || ready.pid !== child.pid || ready.parent !== process.pid) process.exit(73);
  fs.writeFileSync(leaderReady + '.pending', JSON.stringify({ nonce: config.nonce, leader: process.pid, child: child.pid }), { flag: 'wx' });
  fs.renameSync(leaderReady + '.pending', leaderReady);
  while (!fs.existsSync(releaseLeader) || fs.readFileSync(releaseLeader, 'utf8') !== config.nonce) await Bun.sleep(10);
  process.exit(0);
})().catch(() => process.exit(74));
`;
const detachedDescendantProgram = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const childPidPath = process.argv.at(-1);
if (typeof childPidPath !== 'string' || childPidPath.length > 4096
  || !path.isAbsolute(childPidPath) || path.basename(childPidPath) !== 'child.pid'
  || fs.realpathSync(path.dirname(childPidPath)) !== fs.realpathSync(process.cwd())) {
  throw new Error('Invalid descendant fixture PID path');
}
const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 5000); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
child.unref();
fs.writeFileSync(childPidPath, String(child.pid));
`;

describe("verification output diagnostics", () => {
  test("decodes split UTF-8 and observes EOF without changing the original log limit", async () => {
    const { controller, capture } = controlledOutput(4);
    const bytes = new TextEncoder().encode("a€🙂z");
    const initial = capture.snapshot();
    expect(initial.state).toBe("pending");
    expect(initial.inFlightRead).toBeTrue();
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
    expect(await capture.output).toBe("€🙂z");
    expect(capture.snapshot()).toEqual({ state: "eof", inFlightRead: false,
      bytesRead: bytes.length, chunksRead: bytes.length, countersSaturated: false, tail: "a€🙂z" });
    expect(initial).toEqual({ state: "pending", inFlightRead: true,
      bytesRead: 0, chunksRead: 0, countersSaturated: false, tail: "" });
  });

  test("snapshots remain detached, frozen and bounded while the stream keeps draining", async () => {
    const { controller, capture } = controlledOutput(3);
    controller.enqueue(new TextEncoder().encode("first"));
    await Promise.resolve();
    const first = capture.snapshot();
    expect(first.tail).toBe("first");
    expect(first.state).toBe("pending");
    expect(first.inFlightRead).toBeTrue();
    expect(Object.isFrozen(first)).toBeTrue();
    expect(Reflect.set(first, "tail", "replacement")).toBeFalse();
    controller.enqueue(new TextEncoder().encode("€".repeat(VERIFICATION_OUTPUT_TAIL_LIMIT + 20)));
    controller.close();
    expect(await capture.output).toBe("€€€");
    const terminal = capture.snapshot();
    expect(terminal.tail).toHaveLength(VERIFICATION_OUTPUT_TAIL_LIMIT);
    expect(terminal.bytesRead).toBe(5 + 3 * (VERIFICATION_OUTPUT_TAIL_LIMIT + 20));
    expect(terminal.chunksRead).toBe(2);
    expect(terminal.state).toBe("eof");
    expect(first.tail).toBe("first");
  });

  test("keeps a truncated final UTF-8 sequence in the EOF tail", async () => {
    const { controller, capture } = controlledOutput();
    controller.enqueue(Uint8Array.of(0xe2, 0x82));
    controller.close();
    expect(await capture.output).toBe("�");
    expect(capture.snapshot()).toEqual({ state: "eof", inFlightRead: false,
      bytesRead: 2, chunksRead: 1, countersSaturated: false, tail: "�" });
  });

  test("retains the first stream rejection and a bounded error snapshot", async () => {
    const { controller, capture } = controlledOutput();
    controller.enqueue(new TextEncoder().encode("before failure"));
    await Promise.resolve();
    const original = new Error("failure".repeat(1_000));
    const failed = capture.output.then(() => { throw new Error("Expected rejected capture"); }, (error: unknown) => error);
    controller.error(original);
    expect(await failed).toBe(original);
    const snapshot = capture.snapshot();
    expect(snapshot.state).toBe("error");
    expect(snapshot.inFlightRead).toBeFalse();
    expect(snapshot.tail).toBe("before failure");
    if (snapshot.state !== "error") throw new Error("Expected a terminal stream error");
    expect(snapshot.error).toHaveLength(1_024);
    expect(Object.isFrozen(snapshot)).toBeTrue();
  });

  test("foreign rejection diagnostics never invoke error getters or replace undefined rejection", async () => {
    let getterReads = 0;
    for (const original of [undefined, Object.defineProperty({}, "message", {
      get() { getterReads += 1; throw new Error("Do not inspect this getter"); },
    })]) {
      const { controller, capture } = controlledOutput();
      const failed = capture.output.then(() => ({ accepted: true }), (error: unknown) => ({ accepted: false, error }));
      controller.error(original);
      assert.deepEqual(await failed, { accepted: false, error: original });
      expect(capture.snapshot().state).toBe("error");
    }
    expect(getterReads).toBe(0);
  });

  test("arbitrary chunk boundaries preserve decoded output and finite counters", async () => {
    await assertAsyncProperty(fc.asyncProperty(fc.uint8Array({ maxLength: 256 }),
      fc.integer({ min: 1, max: 32 }), fc.integer({ min: 0, max: 64 }), async (bytes, width, limit) => {
        const { controller, capture } = controlledOutput(limit);
        for (let offset = 0; offset < bytes.length; offset += width) controller.enqueue(bytes.slice(offset, offset + width));
        controller.close();
        const decoded = new TextDecoder().decode(bytes);
        expect(await capture.output).toBe(tail(decoded, limit));
        const snapshot = capture.snapshot();
        expect(snapshot.tail).toBe(decoded);
        expect(snapshot.bytesRead).toBe(bytes.length);
        expect(snapshot.chunksRead).toBe(Math.ceil(bytes.length / width));
        expect(snapshot.countersSaturated).toBeFalse();
        expect(snapshot.state).toBe("eof");
      }));
  });

  test("timeout errors preserve the original message and copy immutable bounded snapshots", () => {
    const stream = { state: "pending" as const, inFlightRead: true,
      bytesRead: 3, chunksRead: 1, countersSaturated: false, tail: "old" };
    const snapshot = { schema: "direct.verification-output/v1" as const, stdout: { ...stream }, stderr: { ...stream } };
    const failure = new VerificationServerOutputTimeoutError(500, { outputSnapshot: () => snapshot });
    expect(failure.message).toBe("verification server output did not settle within 500ms after exit");
    expect(failure.name).toBe("VerificationServerOutputTimeoutError");
    expect(failure.outputSnapshot).toEqual(snapshot);
    snapshot.stdout.tail = "changed";
    expect(failure.outputSnapshot?.stdout.tail).toBe("old");
    expect(Object.isFrozen(failure.outputSnapshot)).toBeTrue();
    expect(Object.isFrozen(failure.outputSnapshot?.stdout)).toBeTrue();
    expect(Reflect.set(failure, "outputSnapshot", undefined)).toBeFalse();
    expect(failure.outputSnapshotFailure).toBeUndefined();
  });

  test("a timeout snapshot does not cancel draining or change when late output reaches EOF", async () => {
    const { controller, capture } = controlledOutput();
    const failure = new VerificationServerOutputTimeoutError(5, {
      outputSnapshot: () => ({ schema: "direct.verification-output/v1",
        stdout: capture.snapshot(), stderr: capture.snapshot() }),
    });
    controller.enqueue(new TextEncoder().encode("late output"));
    controller.close();
    expect(await capture.output).toBe("late output");
    expect(capture.snapshot().state).toBe("eof");
    expect(failure.outputSnapshot?.stdout.state).toBe("pending");
    expect(failure.outputSnapshot?.stdout.bytesRead).toBe(0);
    expect(failure.outputSnapshot?.stdout.tail).toBe("");
  });

  test("snapshot absence, rejection and invalid data never replace an output timeout", () => {
    const missing = new VerificationServerOutputTimeoutError(5, {});
    expect(missing.outputSnapshot).toBeUndefined();
    expect(missing.outputSnapshotFailure).toBeUndefined();
    for (const outputSnapshot of [() => { throw new Error("snapshot failed"); },
      () => ({ schema: "wrong" }) as unknown as VerificationOutputSnapshot]) {
      const failure = new VerificationServerOutputTimeoutError(5, { outputSnapshot });
      expect(failure).toBeInstanceOf(VerificationServerOutputTimeoutError);
      expect(failure.message).toBe("verification server output did not settle within 5ms after exit");
      expect(failure.outputSnapshot).toBeUndefined();
      expect(typeof failure.outputSnapshotFailure).toBe("string");
    }
  });

  test("timeout snapshots reject excessive tails, counters and contradictory terminal states", () => {
    const stream = { state: "pending", inFlightRead: true,
      bytesRead: 3, chunksRead: 1, countersSaturated: false, tail: "old" };
    for (const patch of [
      { tail: "x".repeat(VERIFICATION_OUTPUT_TAIL_LIMIT + 1) },
      { bytesRead: Number.POSITIVE_INFINITY }, { chunksRead: -1 },
      { state: "eof", inFlightRead: true },
      { state: "error", inFlightRead: false, error: "x".repeat(1_025) },
    ]) {
      const snapshot = { schema: "direct.verification-output/v1", stdout: { ...stream, ...patch }, stderr: stream };
      const failure = new VerificationServerOutputTimeoutError(5, {
        outputSnapshot: () => snapshot as VerificationOutputSnapshot,
      });
      expect(failure.message).toBe("verification server output did not settle within 5ms after exit");
      expect(failure.outputSnapshot).toBeUndefined();
      expect(typeof failure.outputSnapshotFailure).toBe("string");
    }
  });
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (reason: unknown) {
    return reason instanceof Error ? reason : new Error(String(reason));
  }
  throw new Error("Expected the operation to reject.");
}

type ProcessKill = (
  processId: number,
  signal?: NodeJS.Signals | number,
) => boolean;

async function withProcessKillAdapter<Value>(
  createAdapter: (kill: ProcessKill) => ProcessKill,
  operation: () => Promise<Value>,
): Promise<Value> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "kill");
  if (descriptor === undefined) throw new Error("process.kill descriptor is unavailable");
  const originalKill = process.kill.bind(process);
  const kill: ProcessKill = (processId, signal) => originalKill(processId, signal);
  Object.defineProperty(process, "kill", {
    ...descriptor,
    value: createAdapter(kill),
  });
  try {
    return await operation();
  } finally {
    Object.defineProperty(process, "kill", descriptor);
  }
}

async function waitForMissingProcess(processId: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    try {
      process.kill(processId, 0);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return;
      if (code !== "EPERM") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Process ${String(processId)} survived its test cleanup`);
    }
    await Bun.sleep(10);
  }
}

async function forceCleanupProcess(processId: number): Promise<void> {
  try {
    process.kill(processId, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  await waitForMissingProcess(processId);
}

describe("browser verification targets", () => {
  test("normalizes only credential-free HTTP server roots", () => {
    expect(normalizeRootHttpOrigin("https://example.test/")).toBe("https://example.test");
    expect(() => normalizeRootHttpOrigin("file:///tmp/site")).toThrow("http:");
    expect(() => normalizeRootHttpOrigin("https://user:secret@example.test")).toThrow("credentials");
    expect(() => normalizeRootHttpOrigin("https://example.test/nested")).toThrow("server root");
    expect(() => normalizeRootHttpOrigin("https://example.test/?run=one")).toThrow("server root");
  });

  test("parses the shared base URL CLI without accepting ambiguous values", () => {
    expect(parseBaseUrlArguments([], "http://127.0.0.1:8080")).toEqual({
      kind: "run",
      baseUrl: "http://127.0.0.1:8080",
    });
    expect(parseBaseUrlArguments(["--base-url=https://example.test"], "http://unused.test")).toEqual({
      kind: "run",
      baseUrl: "https://example.test",
    });
    expect(parseBaseUrlArguments(["-h"], "http://unused.test")).toEqual({ kind: "help" });
    expect(() => parseBaseUrlArguments(["--base-url"], "http://unused.test")).toThrow("requires a value");
    expect(() => parseBaseUrlArguments(["--unknown"], "http://unused.test")).toThrow("Unknown argument");
    expect(() => parseBaseUrlArguments([
      "--base-url=https://first.example",
      "--base-url",
      "https://second.example",
    ], "http://unused.test")).toThrow("only once");
  });

  test("property: rejected CLI values are never reflected into diagnostics", () => {
    const secret = fc.array(
      fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
      { minLength: 1, maxLength: 80 },
    ).map((characters) => `SECRET_${characters.join("")}_TOKEN`);

    assertProperty(fc.property(secret, (generatedSecret) => {
      for (const arguments_ of [
        [`--unknown=${generatedSecret}`],
        [`--base-url=${generatedSecret}`],
        ["--base-url", `https://${generatedSecret}@example.test`],
        ["--base-url=https://first.example", `--base-url=${generatedSecret}`],
      ]) {
        let rejection: unknown;
        try {
          parseBaseUrlArguments(arguments_, "http://unused.test");
        } catch (reason) {
          rejection = reason;
        }
        expect(rejection).toBeInstanceOf(Error);
        expect(renderUnknown(rejection)).not.toContain(generatedSecret);
      }
    }));
  });

  test("limits automatic startup to explicitly allowed local HTTP hosts", () => {
    expect(canAutomaticallyStartLocalServer("http://127.0.0.1:8080")).toBeTrue();
    expect(canAutomaticallyStartLocalServer("http://localhost:8080")).toBeTrue();
    expect(canAutomaticallyStartLocalServer("http://[::1]:8080")).toBeFalse();
    expect(canAutomaticallyStartLocalServer("http://[::1]:8080", new Set(["[::1]"]))).toBeTrue();
    expect(canAutomaticallyStartLocalServer("https://127.0.0.1:8080")).toBeFalse();
  });
});

describe("agent-browser envelopes", () => {
  test("bounds session names for macOS namespace socket paths", () => {
    const session = boundedAgentBrowserSessionName(
      "ds-forced-colors-with-an-unnecessarily-long-label",
      40_558,
      "246832c3-05b0-4f37-a227-b027af03dff3",
    );
    expect(session.length).toBeLessThanOrEqual(20);
    expect(session).toMatch(/^ds-for-[a-z0-9]+-246832$/);
  });

  test("returns successful data and rejects malformed or failed commands", () => {
    expect(parseAgentBrowserEnvelope(JSON.stringify({ success: true, data: { value: 3 }, error: null }))).toEqual({ value: 3 });
    expect(() => parseAgentBrowserEnvelope("not json")).toThrow("one JSON document");
    expect(() => parseAgentBrowserEnvelope(JSON.stringify({ success: true }))).toThrow("invalid envelope");
    expect(() => parseAgentBrowserEnvelope(JSON.stringify({ success: false, data: null, error: "closed" }))).toThrow("closed");
  });

  test("validates every batch result and preserves command order", () => {
    expect(parseAgentBrowserBatchEnvelope(JSON.stringify([
      { command: ["mouse", "move", "1", "2"], error: null, result: { moved: true }, success: true },
      { command: ["wait", "200"], error: null, result: { waited: "timeout" }, success: true },
    ]))).toEqual([{ moved: true }, { waited: "timeout" }]);
    expect(() => parseAgentBrowserBatchEnvelope("not json")).toThrow("one JSON document");
    expect(() => parseAgentBrowserBatchEnvelope("[]")).toThrow("invalid envelope");
    expect(() => parseAgentBrowserBatchEnvelope(JSON.stringify([
      { command: [], error: null, result: null, success: true },
    ]))).toThrow("position 1");
    expect(() => parseAgentBrowserBatchEnvelope(JSON.stringify([
      { command: ["mouse", "move"], error: "closed", result: null, success: false },
    ]))).toThrow("mouse move");
    const largeEvaluation = "secret-program".repeat(1_000);
    let batchFailure: unknown;
    try {
      parseAgentBrowserBatchEnvelope(JSON.stringify([
        {
          command: ["eval", largeEvaluation],
          error: "timed out",
          result: null,
          success: false,
        },
      ]));
    } catch (error) {
      batchFailure = error;
    }
    expect(renderUnknown(batchFailure)).toContain("eval (14000 character payload)");
    expect(renderUnknown(batchFailure)).not.toContain(largeEvaluation);
  });

  test("keeps only the bounded log tail", () => {
    expect(tail("abcdef", 4)).toBe("cdef");
  });

  test("describes large browser programs without repeating their contents", () => {
    expect(renderAgentBrowserCommand(["eval", "secret-program".repeat(1_000)]))
      .toBe("eval (14000 character payload)");
    expect(renderAgentBrowserCommand(["batch", "[large batch]"]))
      .toBe("batch (13 character payload)");
    expect(renderAgentBrowserCommand([
      "batch",
      "--bail",
      "mouse move 1 2",
      "wait 200",
    ])).toBe("batch (30 character payload)");
    expect(renderAgentBrowserCommand(["open", "https://example.com"]))
      .toBe("open https://example.com");
  });

  test("bounds close separately and rotates after an unresponsive namespace", async () => {
    expect(agentBrowserCloseProcessTimeoutMs).toBe(10_000);
    expect(agentBrowserProcessTimeoutMs(["eval", "1"], 60_000)).toBe(65_000);
    expect(agentBrowserProcessTimeoutMs(["close"], 60_000)).toBe(10_000);

    const repositoryRoot = await temporaryDirectory();
    const binaryDirectory = join(repositoryRoot, "node_modules/.bin");
    await mkdir(binaryDirectory, { recursive: true });
    await writeFile(join(binaryDirectory, "agent-browser"), `
      const command = process.argv[3];
      if (command === "close") {
        console.error("simulated unresponsive namespace");
        process.exit(1);
      }
      console.log(JSON.stringify({
        data: { result: process.env.AGENT_BROWSER_NAMESPACE },
        error: null,
        success: true,
      }));
    `);
    const browser = createAgentBrowser({
      defaultTimeoutMs: 1_000,
      repositoryRoot,
      sessionPrefix: "test",
    });
    const firstNamespace = await browser.evaluate("1");
    await browser.restart();
    const secondNamespace = await browser.evaluate("1");

    expect(typeof firstNamespace).toBe("string");
    expect(typeof secondNamespace).toBe("string");
    expect(secondNamespace).not.toBe(firstNamespace);
  });

  test("renders hostile, cyclic, and oversized foreign failures without throwing or growing logs", () => {
    const hostile = new Proxy({}, {
      get: () => { throw new Error("getter rejected"); },
      ownKeys: () => { throw new Error("keys rejected"); },
    });
    expect(renderUnknown(hostile)).toBe("Unknown failure");

    const cyclic = new Error("cycle");
    cyclic.cause = cyclic;
    expect(renderUnknown(cyclic)).toBe("Error: cycle; caused by [Circular]");

    const rendered = renderUnknown(new Error("x".repeat(20_000)));
    expect(rendered.length).toBe(4_096);
    expect(rendered.endsWith("…")).toBeTrue();
  });

  test("serializes explicit Chrome launch flags without a shell boundary", () => {
    expect(serializeAgentBrowserLaunchArguments([
      "--force-high-contrast",
      "--disable-extensions",
    ])).toBe("--force-high-contrast,--disable-extensions");
    expect(() => serializeAgentBrowserLaunchArguments(["force-high-contrast"]))
      .toThrow("Chrome flags");
    expect(() => serializeAgentBrowserLaunchArguments(["--flag,also-flag"]))
      .toThrow("comma-free");
  });

  test("removes inherited browser attachment and persistence state", () => {
    const environment = isolatedAgentBrowserEnvironment({
      configPath: "/repo/scripts/direct/agent-browser.verify.json",
      defaultTimeoutMs: 12_345,
      inheritedEnvironment: {
        AGENT_BROWSER_ARGS: "--force-device-scale-factor=0.9",
        AGENT_BROWSER_ALLOWED_DOMAINS: "example.com",
        AGENT_BROWSER_AUTO_CONNECT: "1",
        AGENT_BROWSER_CDP: "9222",
        AGENT_BROWSER_CONFIG: "/tmp/ambient-agent-browser.json",
        AGENT_BROWSER_ENABLE: "react-devtools",
        AGENT_BROWSER_EXECUTABLE_PATH: "/tmp/browser",
        AGENT_BROWSER_EXTENSIONS: "/tmp/extension",
        AGENT_BROWSER_INIT_SCRIPTS: "/tmp/init.js",
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "86400000",
        AGENT_BROWSER_IOS_DEVICE: "iPhone 15 Pro",
        AGENT_BROWSER_PLUGINS: "[]",
        AGENT_BROWSER_PROFILE: "/tmp/persistent-profile",
        AGENT_BROWSER_PROVIDER: "browserless",
        AGENT_BROWSER_UNRECOGNIZED_FUTURE_OPTION: "must-not-leak",
        AGENT_BROWSER_RESTORE: "persisted-session",
        AGENT_BROWSER_RESTORE_SAVE: "always",
        AGENT_BROWSER_SESSION_NAME: "legacy-session",
        AGENT_BROWSER_STATE: "/tmp/browser-state.json",
        PRESERVED_ENVIRONMENT_VALUE: "present",
      },
      session: "fresh-session",
    });

    expect(environment).toEqual({
      AGENT_BROWSER_CONFIG: "/repo/scripts/direct/agent-browser.verify.json",
      AGENT_BROWSER_DEFAULT_TIMEOUT: "12345",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "72345",
      AGENT_BROWSER_NAMESPACE: "fresh-session",
      AGENT_BROWSER_RESTORE_SAVE: "never",
      AGENT_BROWSER_SESSION: "fresh-session",
      PRESERVED_ENVIRONMENT_VALUE: "present",
    });

    const extendedIdleEnvironment = isolatedAgentBrowserEnvironment({
      configPath: "/repo/scripts/direct/agent-browser.verify.json",
      defaultTimeoutMs: 12_345,
      idleTimeoutMs: 240_000,
      inheritedEnvironment: {},
      session: "cold-direct-server",
    });
    expect(extendedIdleEnvironment.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("240000");
  });

  test("uses only explicitly supplied Chrome launch flags", () => {
    const environment = isolatedAgentBrowserEnvironment({
      configPath: "/repo/scripts/direct/agent-browser.verify.json",
      defaultTimeoutMs: 35_000,
      inheritedEnvironment: {
        AGENT_BROWSER_ARGS: "--inherited-flag",
      },
      launchArguments: ["--force-high-contrast", "--disable-extensions"],
      session: "forced-colors",
    });

    expect(environment.AGENT_BROWSER_ARGS).toBe(
      "--force-high-contrast,--disable-extensions",
    );
  });
});

describe("Direct browser contract binding", () => {
  test("parses one atomic sample and requires the requested active identity", async () => {
    const fixture = directContractFixture();
    const browser = {
      evaluate: () => Promise.resolve(fixture),
    };

    const contract = await readDirectBrowserContract(browser, {
      source: "scenario",
      scenario: "surface.ready",
      route: "/surface",
    });
    expect(String(contract.manifest.active.scenario)).toBe("surface.ready");
    expect(contract.probe.activationHash).toBe(
      contract.manifest.active.activationHash,
    );
  });

  test("rejects non-exact and hostile outer envelopes before nested parsing", async () => {
    const fixture = directContractFixture();
    const expectation = {
      source: "scenario" as const,
      scenario: "surface.ready",
      route: "/surface",
    };

    expect((await rejection(readDirectBrowserContract({
      evaluate: () => Promise.resolve({ ...fixture, extra: true }),
    }, expectation))).message).toContain("invalid envelope");

    const hostile = Object.defineProperty({ ...fixture }, "bridgeSchema", {
      enumerable: true,
      get: () => {
        throw new Error("foreign getter");
      },
    });
    expect((await rejection(readDirectBrowserContract({
      evaluate: () => Promise.resolve(hostile),
    }, expectation))).message).toContain("invalid envelope");
  });

  test("rejects bridge, scenario, route, and probe identity drift", async () => {
    const fixture = directContractFixture();
    const fixtureActivation = directContractFixture({ source: "fixture" });
    const browser = {
      evaluate: () => Promise.resolve(fixture),
    };

    expect((await rejection(readDirectBrowserContract(browser, {
      source: "scenario",
      scenario: "surface.missing",
      route: "/surface",
    }))).message).toContain("instead of surface.missing");
    expect((await rejection(readDirectBrowserContract(browser, {
      source: "scenario",
      scenario: "surface.ready",
      route: "/wrong",
    }))).message).toContain("instead of /wrong");
    expect((await rejection(readDirectBrowserContract({
      evaluate: () => Promise.resolve(fixtureActivation),
    }, {
      source: "scenario",
      scenario: "surface.ready",
      route: "/surface",
    }))).message).toContain("from fixture instead of scenario");
    expect((await rejection(readDirectBrowserContract({
      evaluate: () => Promise.resolve({
        ...fixture,
        bridgeSchema: "direct.browser-bridge/v1",
      }),
    }, {
      source: "scenario",
      scenario: "surface.ready",
      route: "/surface",
    }))).message).toContain(DIRECT_BROWSER_BRIDGE_SCHEMA);
    expect((await rejection(readDirectBrowserContract({
      evaluate: () => Promise.resolve({
        ...fixture,
        probe: {
          ...fixture.probe,
          activationHash: "fnv1a-64:0000000000000000",
        },
      }),
    }, {
      source: "scenario",
      scenario: "surface.ready",
      route: "/surface",
    }))).message).toContain("different activations");
  });

  test("binds independently loaded scenarios to one exact catalog", () => {
    const fixture = directContractFixture();
    const secondManifest = {
      ...fixture.manifest,
      active: {
        ...fixture.manifest.active,
        scenario: fixture.manifest.defaultScenario,
      },
    };
    expect(bindDirectScenarioCatalog([
      fixture.manifest,
      secondManifest,
    ])).toBe(fixture.manifest.coverage);

    expect(() => bindDirectScenarioCatalog([])).toThrow("at least one");
    expect(() => bindDirectScenarioCatalog([
      fixture.manifest,
      {
        ...secondManifest,
        catalogHash: "fnv1a-64:0000000000000000",
      },
    ])).toThrow("exposed catalog");
    expect(() => bindDirectScenarioCatalog([
      fixture.manifest,
      {
        ...secondManifest,
        coverage: {
          ...fixture.manifest.coverage,
          entries: [],
        },
      },
    ])).toThrow("different coverage");
    expect(() => bindDirectScenarioCatalog([
      fixture.manifest,
      {
        ...secondManifest,
        scenarios: secondManifest.scenarios.map((scenario) => ({
          ...scenario,
          title: `${scenario.title} drifted`,
        })),
      },
    ])).toThrow("different public metadata");
  });

  test("binds final evidence to the exact initial catalog and activation", () => {
    const initial = directContractFixture();
    const final = {
      manifest: initial.manifest,
      probe: {
        ...initial.probe,
        revision: initial.probe.revision + 1,
      },
    };
    expect(bindDirectBrowserContractEvidence(initial, final)).toBe(final);

    expect(() => bindDirectBrowserContractEvidence(
      initial,
      directContractFixture({ count: 2 }),
    )).toThrow("activation identity changed");
    expect(() => bindDirectBrowserContractEvidence(
      initial,
      directContractFixture({ title: "Changed title" }),
    )).toThrow("public catalog metadata changed");
    expect(() => bindDirectBrowserContractEvidence(
      initial,
      directContractFixture({ claim: "Changed coverage claim." }),
    )).toThrow("coverage changed");
    expect(() => bindDirectBrowserContractEvidence(initial, {
      manifest: initial.manifest,
      probe: {
        ...initial.probe,
        activationHash: "fnv1a-64:0000000000000000",
      },
    })).toThrow("probe identity changed");
    expect(() => bindDirectBrowserContractEvidence(initial, final, {
      ...initial.probe,
      activationHash: "fnv1a-64:0000000000000000",
    })).toThrow("probe identity changed");
  });
});

describe("server leases", () => {
  for (const arm of [
    { name: "stdout", stdout: true, stderr: false },
    { name: "stderr", stdout: false, stderr: true },
    { name: "both", stdout: true, stderr: true },
    { name: "neither", stdout: false, stderr: false },
  ] as const) {
    test(`collects real descendant pipes (${arm.name}) after an admitted leader exit`, async () => {
      // Register for deletion only after complete proof. Failures retain the
      // scripts, handshake, identities and stream snapshots for diagnosis.
      const directory = await mkdtemp(join(tmpdir(), "direct-inherited-pipes-"));
      const nonce = randomUUID();
      const leaderReady = join(directory, "leader-ready.json");
      const releaseLeader = join(directory, "release-leader");
      const childExpired = join(directory, "child-expired");
      const childPath = join(directory, "child.cjs");
      const leaderPath = join(directory, "leader.cjs");
      const markers = { stdout: "owned stdout €🙂\n", stderr: "owned stderr €🙂\n" };
      await writeFile(childPath, inheritedPipeChildProgram, { flag: "wx" });
      await writeFile(leaderPath, inheritedPipeLeaderProgram, { flag: "wx" });
      const configuration = JSON.stringify({ nonce, stdout: arm.stdout, stderr: arm.stderr });

      const waitForState = async (condition: () => boolean | Promise<boolean>, label: string): Promise<void> => {
        const deadline = performance.now() + 2_000;
        for (;;) {
          const satisfied = await condition();
          if (performance.now() >= deadline) throw new Error(`Inherited-pipe fixture ${label} exceeded 2000ms`);
          if (satisfied) return;
          await Bun.sleep(10);
        }
      };
      let server: ManagedVerificationServer | undefined;
      let identities: { leader: number; child: number } | undefined;
      let failureOutput: VerificationOutputSnapshot | undefined;
      let failureExitCode: number | null | undefined;
      let collected = false;
      const failures: unknown[] = [];
      try {
        server = spawnVerificationServer({ command: [process.execPath, leaderPath, configuration], cwd: directory, detachedProcessGroup: true });
        await waitForState(() => Bun.file(leaderReady).exists(), "ready handshake");
        const ready: unknown = JSON.parse(await readFile(leaderReady, "utf8"));
        assert.ok(ready !== null && typeof ready === "object");
        assert.ok("nonce" in ready && ready.nonce === nonce);
        assert.ok("leader" in ready && typeof ready.leader === "number" && Number.isSafeInteger(ready.leader) && ready.leader > 1);
        assert.ok("child" in ready && typeof ready.child === "number" && Number.isSafeInteger(ready.child) && ready.child > 1);
        assert.notEqual(ready.leader, ready.child);
        identities = { leader: ready.leader, child: ready.child };
        const snapshot = server.outputSnapshot;
        assert.ok(snapshot !== undefined);
        await waitForState(() => {
          const current = snapshot();
          return (["stdout", "stderr"] as const).every((name) => arm[name]
            ? current[name].state === "pending" && current[name].inFlightRead && current[name].tail === markers[name]
            : current[name].state !== "error" && current[name].bytesRead === 0 && current[name].tail === "");
        }, "pre-exit pipe state");
        expect(server.exitCode()).toBeNull();
        expect(process.kill(identities.leader, 0)).toBeTrue();
        expect(process.kill(identities.child, 0)).toBeTrue();
        const beforeExit = snapshot();
        const beforeExitJson = JSON.stringify(beforeExit);
        for (const name of ["stdout", "stderr"] as const) {
          expect(beforeExit[name].bytesRead).toBe(arm[name] ? Buffer.byteLength(markers[name]) : 0);
          expect(beforeExit[name].countersSaturated).toBeFalse();
        }
        await writeFile(releaseLeader, nonce, { flag: "wx" });
        await waitForState(() => server?.exitCode() !== null, "leader exit");
        await withinPipeFixture(server.exited, "leader exit settlement");
        expect(server.exitCode()).toBe(0);
        await waitForState(() => {
          const current = snapshot();
          return (["stdout", "stderr"] as const).every((name) => arm[name]
            ? current[name].state === "pending" && current[name].inFlightRead && current[name].tail === markers[name]
            : current[name].state === "eof" && current[name].bytesRead === 0 && current[name].tail === "");
        }, "post-exit pipe state");
        expect(process.kill(identities.child, 0)).toBeTrue();
        for (const name of ["stdout", "stderr"] as const) {
          expect(snapshot()[name].state).toBe(arm[name] ? "pending" : "eof");
        }
        await stopVerificationServer(server, 2_000);
        collected = true;
        await waitForMissingProcess(identities.child);
        await waitForMissingProcess(-identities.leader);
        const afterStop = snapshot();
        expect(afterStop.stdout.state).toBe("eof");
        expect(afterStop.stderr.state).toBe("eof");
        expect(afterStop.stdout.inFlightRead).toBeFalse();
        expect(afterStop.stderr.inFlightRead).toBeFalse();
        expect(await server.output).toBe(`${arm.stdout ? markers.stdout : ""}\n${arm.stderr ? markers.stderr : ""}`.trim());
        expect(await Bun.file(childExpired).exists()).toBeFalse();
        expect(JSON.stringify(beforeExit)).toBe(beforeExitJson);
      } catch (error: unknown) {
        failureOutput = server?.outputSnapshot?.();
        failureExitCode = server?.exitCode();
        failures.push(error);
      } finally {
        if (server !== undefined && !collected) {
          try { await stopVerificationServer(server, 2_000); collected = true; }
          catch (error: unknown) { failures.push(error); }
        }
      }
      if (failures.length > 0) {
        try {
          await writeFile(join(directory, "failure.json"), `${JSON.stringify({ accepted: false, arm: arm.name,
            identities, collected, failureExitCode, failureOutput,
            output: server?.outputSnapshot?.(), failures: failures.map(renderUnknown) }, null, 2)}\n`, { flag: "wx" });
        } catch (error: unknown) { failures.push(error); }
        throw new AggregateError(failures, `Inherited-pipe fixture evidence preserved at ${directory}`);
      }
      temporaryDirectories.push(directory);
    }, 20_000);
  }

  test("omits coordination secrets from managed server environments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-server-environment-"));
    temporaryDirectories.push(directory);
    const server = spawnVerificationServer({
      command: [
        process.execPath,
        "-e",
        "console.log(process.env.DIRECT_BOMBADIL_RUN_ID ?? 'absent')",
      ],
      cwd: directory,
      env: { DIRECT_BOMBADIL_RUN_ID: "child-visible-secret" },
      omitEnvironment: ["DIRECT_BOMBADIL_RUN_ID"],
    });
    await server.exited;
    expect(await server.output).toBe("absent");
  });

  test("stops descendants only for an explicitly detached owned server group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-server-process-group-"));
    temporaryDirectories.push(directory);
    const childPidPath = join(directory, "child.pid");
    const server = spawnVerificationServer({
      command: [process.execPath, "-e", detachedDescendantProgram, childPidPath],
      cwd: directory,
      detachedProcessGroup: true,
    });
    let childPid: number | null = null;
    let childMissing = false;
    let stopped = false;
    let processGroupId: number | null = null;
    let processGroupKills = 0;
    let processGroupProbes = 0;
    try {
      for (let attempt = 0; attempt < 100 && !(await Bun.file(childPidPath).exists()); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(childPidPath).exists()).toBeTrue();
      childPid = Number.parseInt(await Bun.file(childPidPath).text(), 10);
      await server.exited;
      await withProcessKillAdapter(
        (kill) => (processId, signal) => {
          if (processId < 0 && signal === "SIGKILL") {
            processGroupId = -processId;
            processGroupKills += 1;
          }
          if (
            processGroupId !== null
            && processId === -processGroupId
            && signal === 0
          ) {
            processGroupProbes += 1;
            if (processGroupProbes === 1) {
              throw Object.assign(new Error("synthetic transient process-group probe"), {
                code: "EPERM",
              });
            }
          }
          return kill(processId, signal);
        },
        async () => await stopVerificationServer(server, 500),
      );
      stopped = true;
      expect(processGroupKills).toBe(1);
      expect(processGroupProbes).toBeGreaterThanOrEqual(2);
      expect(Number.isSafeInteger(childPid)).toBeTrue();
      await waitForMissingProcess(childPid);
      childMissing = true;
    } finally {
      if (!stopped) await stopVerificationServer(server, 500);
      if (childPid !== null && !childMissing) await forceCleanupProcess(childPid);
    }
  });

  test("fails closed after persistent EPERM while stopping detached descendants", async () => {
    const directory = await mkdtemp(join(tmpdir(), "direct-server-process-group-eperm-"));
    temporaryDirectories.push(directory);
    const childPidPath = join(directory, "child.pid");
    const server = spawnVerificationServer({
      command: [process.execPath, "-e", detachedDescendantProgram, childPidPath],
      cwd: directory,
      detachedProcessGroup: true,
    });
    let childPid: number | null = null;
    let childMissing = false;
    try {
      for (let attempt = 0; attempt < 100 && !(await Bun.file(childPidPath).exists()); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(await Bun.file(childPidPath).exists()).toBeTrue();
      childPid = Number.parseInt(await Bun.file(childPidPath).text(), 10);
      await server.exited;
      let processGroupId: number | null = null;
      let processGroupKills = 0;
      let processGroupProbes = 0;
      const failure = await withProcessKillAdapter(
        (kill) => (processId, signal) => {
          if (processId < 0 && signal === "SIGKILL") {
            processGroupId = -processId;
            processGroupKills += 1;
          }
          if (
            processGroupId !== null
            && processId === -processGroupId
            && signal === 0
          ) {
            processGroupProbes += 1;
            throw Object.assign(new Error("synthetic persistent process-group probe"), {
              code: "EPERM",
            });
          }
          return kill(processId, signal);
        },
        async () => await rejection(stopVerificationServer(server, 50)),
      );
      expect(failure.message).toContain("survived cleanup");
      expect(processGroupKills).toBe(1);
      expect(processGroupProbes).toBeGreaterThanOrEqual(2);
      expect(Number.isSafeInteger(childPid)).toBeTrue();
      await waitForMissingProcess(childPid);
      childMissing = true;
    } finally {
      if (childPid === null) {
        await stopVerificationServer(server, 500);
      } else if (!childMissing) {
        await forceCleanupProcess(childPid);
      }
    }
  });

  test("bounds one-shot verification commands and reports their exact outcome", async () => {
    expect(await runVerificationCommand({
      command: [process.execPath, "-e", "console.log('built')"],
      cwd: process.cwd(),
      label: "Fixture build",
      timeoutMs: 1_000,
    })).toBe("built");

    expect((await rejection(runVerificationCommand({
      command: [process.execPath, "-e", "process.exit(23)"],
      cwd: process.cwd(),
      label: "Fixture build",
      timeoutMs: 1_000,
    }))).message).toContain("Fixture build exited with 23");

    expect((await rejection(runVerificationCommand({
      command: [process.execPath, "-e", "await Bun.sleep(10_000)"],
      cwd: process.cwd(),
      label: "Fixture build",
      timeoutMs: 1,
    }))).message).toContain("Fixture build exceeded its 1ms deadline");
  });

  test("probes an explicit lightweight route without changing the server root", async () => {
    const requests: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request) => {
      requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return Promise.resolve(new Response("ready"));
    }) as typeof fetch;
    try {
      expect(await serverIsReachable("http://localhost:8080", 100, "/design?ready=1")).toBeTrue();
      expect(requests).toEqual(["http://localhost:8080/design?ready=1"]);
      expect((await rejection(
        serverIsReachable("http://localhost:8080", 100, "//elsewhere.test"),
      )).message).toContain("origin-relative path");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reuses a reachable server without starting another process", async () => {
    let starts = 0;
    const lease = await acquireVerificationServer({
      baseUrl: "http://127.0.0.1:8080",
      label: "Fixture server",
      reuseProbeIntervalMs: 0,
      startupTimeoutMs: 100,
      startServer: () => {
        starts += 1;
        return fakeServer().server;
      },
      isReachable: () => true,
    });
    expect(lease).toEqual({ source: "reused" });
    expect(starts).toBe(0);
  });

  test("refuses a reachable local server when its worktree ownership is unknown", async () => {
    expect((await rejection(acquireVerificationServer({
      baseUrl: "http://127.0.0.1:8080",
      label: "Fixture server",
      reuseExistingLocalServer: false,
      startupTimeoutMs: 100,
      startServer: () => fakeServer().server,
      isReachable: () => true,
    }))).message).toContain("worktree ownership is unknown");
  });

  test("starts a fresh local server when a reachable listener is shutting down", async () => {
    const fixture = fakeServer();
    const reachability = [true, false, true];
    let starts = 0;
    const lease = await acquireVerificationServer({
      baseUrl: "http://127.0.0.1:8080",
      label: "Fixture server",
      reuseProbeIntervalMs: 0,
      startupTimeoutMs: 100,
      startServer: () => {
        starts += 1;
        return fixture.server;
      },
      isReachable: () => reachability.shift() ?? false,
    });
    expect(lease.source).toBe("started");
    expect(starts).toBe(1);
    expect(reachability).toEqual([]);
    if (lease.source === "started") await stopVerificationServer(lease.server);
    expect(fixture.calls).toEqual(["terminate"]);
  });

  test("starts a local server and returns ownership after readiness", async () => {
    const fixture = fakeServer();
    let probes = 0;
    const readinessPaths: string[] = [];
    const lease = await acquireVerificationServer({
      baseUrl: "http://localhost:8080",
      label: "Fixture server",
      pollIntervalMs: 0,
      readinessPath: "/design",
      startupTimeoutMs: 100,
      startServer: () => fixture.server,
      isReachable: (_baseUrl, _probeTimeoutMs, readinessPath) => {
        readinessPaths.push(readinessPath);
        probes += 1;
        return probes >= 2;
      },
    });
    expect(lease.source).toBe("started");
    expect(fixture.calls).toEqual([]);
    if (lease.source === "started") await stopVerificationServer(lease.server);
    expect(fixture.calls).toEqual(["terminate"]);
    expect(readinessPaths).toEqual(["/design", "/design"]);
  });

  test("refuses remote startup and reports an exited local process", async () => {
    expect((await rejection(acquireVerificationServer({
      baseUrl: "https://fixtures.example",
      label: "Fixture server",
      startupTimeoutMs: 100,
      startServer: () => fakeServer().server,
      isReachable: () => false,
    }))).message).toContain("local HTTP");

    const fixture = fakeServer({ exitCode: 23 });
    expect((await rejection(acquireVerificationServer({
      baseUrl: "http://localhost:8080",
      label: "Fixture server",
      startupTimeoutMs: 100,
      startServer: () => fixture.server,
      isReachable: () => false,
    }))).message).toContain("exited with 23");
    expect(fixture.calls).toEqual([]);
  });

  test("terminates an owned server when readiness times out", async () => {
    const fixture = fakeServer();
    expect((await rejection(acquireVerificationServer({
      baseUrl: "http://localhost:8080",
      label: "Fixture server",
      startupTimeoutMs: 0,
      startServer: () => fixture.server,
      isReachable: () => false,
    }))).message).toContain("did not become reachable");
    expect(fixture.calls).toEqual(["terminate"]);
  });

  test("aborts a pending readiness probe and terminates the owned server", async () => {
    const fixture = fakeServer();
    const controller = new AbortController();
    let markPendingProbe!: () => void;
    const pendingProbe = new Promise<void>((resolve) => {
      markPendingProbe = resolve;
    });
    const neverReachable = new Promise<boolean>(() => undefined);
    let probes = 0;
    const acquisition = acquireVerificationServer({
      abortSignal: controller.signal,
      baseUrl: "http://localhost:8080",
      label: "Fixture server",
      startupTimeoutMs: 120_000,
      startServer: () => fixture.server,
      isReachable: () => {
        probes += 1;
        if (probes === 1) return false;
        markPendingProbe();
        return neverReachable;
      },
    });
    await pendingProbe;
    controller.abort();
    const failure = await rejection(acquisition);
    expect(failure.message).toBe("Verification server acquisition was aborted");
    expect(fixture.calls).toEqual(["terminate"]);
  }, 1_000);

  test("does not return a lease when cancellation follows readiness", async () => {
    const fixture = fakeServer();
    const controller = new AbortController();
    let markPendingProbe!: () => void;
    const pendingProbe = new Promise<void>((resolve) => {
      markPendingProbe = resolve;
    });
    let resolveReachability!: (reachable: boolean) => void;
    const reachability = new Promise<boolean>((resolve) => {
      resolveReachability = resolve;
    });
    let probes = 0;
    const acquisition = acquireVerificationServer({
      abortSignal: controller.signal,
      baseUrl: "http://localhost:8080",
      label: "Fixture server",
      startupTimeoutMs: 120_000,
      startServer: () => fixture.server,
      isReachable: () => {
        probes += 1;
        if (probes === 1) return false;
        markPendingProbe();
        return reachability;
      },
    });
    await pendingProbe;
    resolveReachability(true);
    queueMicrotask(() => controller.abort());
    const failure = await rejection(acquisition);
    expect(failure.message).toBe("Verification server acquisition was aborted");
    expect(fixture.calls).toEqual(["terminate"]);
  });

  test("bounds cleanup when a server never exits after SIGKILL", async () => {
    const calls: string[] = [];
    const never = new Promise<never>(() => undefined);
    const server: ManagedVerificationServer = {
      exited: never,
      exitCode: () => null,
      output: Promise.resolve("unreachable output"),
      terminate: () => calls.push("terminate"),
      kill: () => calls.push("kill"),
    };

    const failure = await rejection(stopVerificationServer(server, 1));

    expect(calls).toEqual(["terminate", "kill"]);
    expect(failure.message).toBe("verification server did not exit within 1ms after SIGKILL");
  }, 1_000);

  test("bounds output draining after a server exits", async () => {
    const never = new Promise<never>(() => undefined);
    const server: ManagedVerificationServer = {
      exited: Promise.resolve(),
      exitCode: () => 0,
      output: never,
      terminate: () => {
        throw new Error("an exited server must not receive SIGTERM");
      },
      kill: () => {
        throw new Error("an exited server must not receive SIGKILL");
      },
    };

    const failure = await rejection(stopVerificationServer(server, 1));

    expect(failure).toBeInstanceOf(VerificationServerOutputTimeoutError);
    expect(failure.message).toBe("verification server output did not settle within 1ms after exit");
  }, 1_000);

  test("a throwing diagnostic callback cannot replace the stop operation's EOF timeout", async () => {
    const server: ManagedVerificationServer = {
      exited: Promise.resolve(),
      exitCode: () => 0,
      output: new Promise<never>(() => undefined),
      outputSnapshot: () => { throw new Error("snapshot unavailable"); },
      terminate: () => { throw new Error("An exited server must not receive SIGTERM"); },
      kill: () => { throw new Error("An exited server must not receive SIGKILL"); },
    };
    const failure = await rejection(stopVerificationServer(server, 1));
    expect(failure).toBeInstanceOf(VerificationServerOutputTimeoutError);
    expect(failure.message).toBe("verification server output did not settle within 1ms after exit");
    if (!(failure instanceof VerificationServerOutputTimeoutError)) throw new Error("Expected an output timeout");
    expect(failure.outputSnapshot).toBeUndefined();
    expect(failure.outputSnapshotFailure).toBe("snapshot unavailable");
  }, 1_000);

  test("reports the bounded server tail once after timeout cleanup completes", async () => {
    const calls: string[] = [];
    let exitCode: number | null = null;
    let resolveExit!: () => void;
    let resolveOutput!: (output: string) => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const output = new Promise<string>((resolve) => {
      resolveOutput = resolve;
    });
    const rawOutput = `discarded-prefix${"x".repeat(13_000)}\nstdout-tail\nstderr-tail`;
    const boundedOutput = tail(rawOutput);
    const server: ManagedVerificationServer = {
      exited,
      exitCode: () => exitCode,
      output,
      terminate: () => {
        calls.push("terminate");
        exitCode = 0;
        resolveExit();
        queueMicrotask(() => {
          calls.push("output");
          resolveOutput(rawOutput);
        });
      },
      kill: () => {
        throw new Error("graceful timeout cleanup should not require SIGKILL");
      },
    };

    const failure = await rejection(acquireVerificationServer({
      baseUrl: "http://localhost:8080",
      label: "Fixture server",
      startupTimeoutMs: 0,
      startServer: () => server,
      isReachable: () => false,
    }));

    expect(calls).toEqual(["terminate", "output"]);
    expect(boundedOutput).toHaveLength(12_000);
    expect(failure.message).toEndWith(`within 0ms:\n${boundedOutput}`);
    expect(failure.message.match(/stderr-tail/gu)).toHaveLength(1);
    expect(failure.message).not.toContain("discarded-prefix");
  });
});

test("artifact runs use deterministic names and atomically replace the manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "direct-verification-"));
  temporaryDirectories.push(root);
  const artifactRoot = join(root, "artifacts", "direct", "fixture");
  const run = await createArtifactRun({
    artifactRoot,
    generatedAt: "2026-07-20T12:34:56.789Z",
    processId: 42,
  });
  expect(run.runDirectory).toBe(join(artifactRoot, "2026-07-20T12-34-56-789Z-42"));
  await writeJsonAtomically(run.manifestPath, { version: 1 });
  await writeJsonAtomically(run.manifestPath, { version: 2 });
  expect(await readFile(run.manifestPath, "utf8")).toBe('{\n  "version": 2\n}\n');
  expect((await readdir(artifactRoot)).sort()).toEqual([
    "2026-07-20T12-34-56-789Z-42",
    "manifest.json",
  ]);
});
