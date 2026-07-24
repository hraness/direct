import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../core/json-value.js";
import { isRecord } from "../core/result.js";

import { createLogicalRuntime, type LogicalRuntime } from "../core/runtime.js";
import { createDirectStore } from "../core/store.js";
import { parseTestWorld } from "../core/test-support.js";
import { createDirectActivityScope } from "./activity.js";
import {
  DEFAULT_SCRIPTED_TRANSPORT_LIMITS,
  createExactScriptedTransport,
  type ScriptedTransportListener,
  type ScriptedTransportListenerErrorReporter,
  type ScriptedTransportLimits,
} from "./scripted-transport.js";

interface TestRequest extends JsonObject {
  readonly id: number;
  readonly payload: string;
}

interface TestResponse extends JsonObject {
  readonly accepted: boolean;
}

interface TestFailure extends JsonObject {
  readonly code: string;
}

function parseRequest(input: unknown): TestRequest {
  if (
    !isRecord(input)
    || typeof input.id !== "number"
    || !Number.isSafeInteger(input.id)
    || typeof input.payload !== "string"
  ) {
    throw new Error("Request must contain integer id and string payload");
  }
  return { id: input.id, payload: input.payload };
}

function parseResponse(input: unknown): TestResponse {
  if (!isRecord(input) || typeof input.accepted !== "boolean") throw new Error("Invalid response");
  return { accepted: input.accepted };
}

function parseEvent(input: unknown): string {
  if (typeof input !== "string") throw new Error("Invalid event");
  return input;
}

function parseFailure(input: unknown): TestFailure {
  if (!isRecord(input) || typeof input.code !== "string") throw new Error("Invalid failure");
  return { code: input.code };
}

function transportFixture(
  steps: unknown,
  runtime: LogicalRuntime = createLogicalRuntime(undefined, () => Promise.resolve()),
  limits?: ScriptedTransportLimits,
) {
  const options = {
    runtime,
    parseRequest,
    parseResponse,
    parseEvent,
    parseFailure,
    steps,
  };
  return limits === undefined
    ? createExactScriptedTransport(options)
    : createExactScriptedTransport({ ...options, limits });
}

function hostileThrownValue(): Error {
  return new Proxy(new Error("hostile"), {
    get: () => {
      throw new Error("hostile message getter");
    },
    getPrototypeOf: () => {
      throw new Error("hostile prototype");
    },
  });
}

describe("exact scripted transport", () => {
  test("publishes conservative default script, event, failure, and logical-delay bounds", () => {
    expect(DEFAULT_SCRIPTED_TRANSPORT_LIMITS).toEqual({
      maxSteps: 10_000,
      maxEventsPerStep: 1_000,
      maxRecordedInternalErrors: 32,
      maxLogicalDelayPerStepMs: 60_000,
      maxTotalLogicalDelayMs: 3_600_000,
    });
  });

  test("matches canonical JSON, advances logical time, and orders events around response settlement", async () => {
    const transport = transportFixture([
      {
        request: { id: 1, payload: "hello" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 25,
        eventsBefore: ["before"],
        eventsAfter: ["after"],
      },
      {
        request: { id: 2, payload: "fail" },
        outcome: { kind: "failure", error: { code: "offline" } },
      },
    ]);
    if (!transport.ok) throw new Error(transport.error.message);
    const observed: string[] = [];
    const unsubscribe = transport.value.subscribe((event) => { observed.push(event); });

    const responsePromise = transport.value.request({ payload: "hello", id: 1 });
    void responsePromise.then(() => observed.push("response"));
    expect(await responsePromise).toEqual({ ok: true, value: { accepted: true } });
    expect(observed).toEqual(["before", "response"]);
    expect(transport.value.pendingDeliveries()).toBe(1);
    expect(await transport.value.whenIdle()).toEqual({ ok: true, value: true });
    expect(observed).toEqual(["before", "response", "after"]);

    expect(await transport.value.request({ id: 2, payload: "fail" })).toEqual({
      ok: false,
      error: { kind: "scripted", failure: { code: "offline" } },
    });
    await transport.value.whenIdle();
    expect(transport.value.assertDrained()).toEqual({ ok: true, value: true });
    unsubscribe();
  });

  test("mismatch is exact, does not consume its step, and permanently fails drain", async () => {
    const transport = transportFixture([{
      request: { id: 1, payload: "expected" },
      outcome: { kind: "response", value: { accepted: true } },
    }]);
    if (!transport.ok) throw new Error(transport.error.message);

    expect(await transport.value.request({ id: 1, payload: "other" })).toMatchObject({
      ok: false,
      error: { kind: "transport", error: { code: "request-mismatch" } },
    });
    expect(transport.value.remainingSteps()).toBe(1);
    expect(transport.value.violationCount()).toBe(1);
    expect(await transport.value.request({ id: 1, payload: "expected" })).toMatchObject({ ok: true });
    await transport.value.whenIdle();
    expect(transport.value.assertDrained()).toMatchObject({
      ok: false,
      error: { code: "internal-failure", remainingSteps: 0 },
    });
  });

  test("unexpected requests after exhaustion remain verifier-visible", async () => {
    const transport = transportFixture([]);
    if (!transport.ok) throw new Error(transport.error.message);
    expect(await transport.value.request({ id: 1, payload: "extra" })).toMatchObject({
      ok: false,
      error: { kind: "transport", error: { code: "unexpected-request", remainingSteps: 0 } },
    });
    expect(transport.value.violationCount()).toBe(1);
    expect(transport.value.assertDrained()).toMatchObject({ ok: false, error: { code: "internal-failure" } });
  });

  test("runtime failures settle activity and remain verifier-visible", async () => {
    const runtime = createLogicalRuntime(undefined, () => Promise.reject(new Error("clock unavailable")));
    const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
    if (!store.ok) throw new Error(store.error.message);
    const transport = createExactScriptedTransport({
      runtime,
      parseRequest,
      parseResponse,
      parseEvent,
      parseFailure,
      activity: createDirectActivityScope(store.value, runtime),
      steps: [{
        request: { id: 1, payload: "wait" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 10,
      }],
    });
    if (!transport.ok) throw new Error(transport.error.message);

    expect(await transport.value.request({ id: 1, payload: "wait" })).toMatchObject({
      ok: false,
      error: { kind: "transport", error: { code: "logical-wait-failed" } },
    });
    expect(await transport.value.whenIdle()).toMatchObject({ ok: false, error: { code: "internal-failure" } });
    expect(transport.value.pendingDeliveries()).toBe(0);
    expect(store.value.getSnapshot().activity).toEqual({ active: 0, started: 1, settled: 1 });
    expect(transport.value.assertDrained()).toMatchObject({ ok: false, error: { code: "internal-failure" } });
  });

  test("dispose cancels active waits, suppresses delayed events, and settles cleanly", async () => {
    const runtime = createLogicalRuntime();
    const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
    if (!store.ok) throw new Error(store.error.message);
    const transport = createExactScriptedTransport({
      runtime,
      parseRequest,
      parseResponse,
      parseEvent,
      parseFailure,
      activity: createDirectActivityScope(store.value, runtime),
      steps: [{
        request: { id: 1, payload: "slow" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 5_000,
        eventsBefore: ["before"],
        eventsAfter: ["after"],
      }],
    });
    if (!transport.ok) throw new Error(transport.error.message);
    const observed: string[] = [];
    transport.value.subscribe((event) => { observed.push(event); });

    const response = transport.value.request({ id: 1, payload: "slow" });
    const logicalAtDisposal = runtime.snapshot();
    expect(observed).toEqual(["before"]);
    expect(transport.value.pendingDeliveries()).toBe(1);
    expect(store.value.getSnapshot().activity.active).toBe(1);

    transport.value.dispose();
    transport.value.dispose();
    expect(transport.value.isDisposed()).toBe(true);
    expect(await response).toMatchObject({
      ok: false,
      error: { kind: "transport", error: { code: "transport-disposed" } },
    });
    expect(await transport.value.whenIdle()).toEqual({ ok: true, value: true });
    expect(transport.value.pendingDeliveries()).toBe(0);
    expect(transport.value.violationCount()).toBe(0);
    expect(store.value.getSnapshot().activity).toEqual({ active: 0, started: 1, settled: 1 });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(runtime.snapshot()).toEqual(logicalAtDisposal);
    expect(observed).toEqual(["before"]);
    expect(await transport.value.request({ id: 2, payload: "late" })).toMatchObject({
      ok: false,
      error: { kind: "transport", error: { code: "transport-disposed" } },
    });
    expect(transport.value.assertDrained()).toEqual({ ok: true, value: true });
  });

  test("dispose reentered from activity publication starts no delivery work", async () => {
    const runtime = createLogicalRuntime(undefined, () => Promise.resolve());
    const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
    if (!store.ok) throw new Error(store.error.message);
    const transport = createExactScriptedTransport({
      runtime,
      parseRequest,
      parseResponse,
      parseEvent,
      parseFailure,
      activity: createDirectActivityScope(store.value, runtime),
      steps: [{
        request: { id: 1, payload: "reentrant-dispose" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 25,
        eventsBefore: ["must-not-deliver"],
      }],
    });
    if (!transport.ok) throw new Error(transport.error.message);
    const observed: string[] = [];
    transport.value.subscribe((event) => { observed.push(event); });
    const unsubscribe = store.value.subscribe(() => {
      if (store.value.getSnapshot().activity.active === 1) transport.value.dispose();
    });

    expect(await transport.value.request({ id: 1, payload: "reentrant-dispose" })).toMatchObject({
      ok: false,
      error: { kind: "transport", error: { code: "transport-disposed" } },
    });
    expect(observed).toEqual([]);
    expect(runtime.now()).toBe(0);
    expect(transport.value.pendingDeliveries()).toBe(0);
    expect(transport.value.violationCount()).toBe(0);
    expect(store.value.getSnapshot().activity).toEqual({ active: 0, started: 1, settled: 1 });
    expect(transport.value.assertDrained()).toEqual({ ok: true, value: true });
    unsubscribe();
  });

  test("dispose after response settlement suppresses queued after-events", async () => {
    const transport = transportFixture([{
      request: { id: 1, payload: "settled" },
      outcome: { kind: "response", value: { accepted: true } },
      eventsAfter: ["after"],
    }]);
    if (!transport.ok) throw new Error(transport.error.message);
    const observed: string[] = [];
    transport.value.subscribe((event) => { observed.push(event); });

    const response = transport.value.request({ id: 1, payload: "settled" });
    const disposed = response.then(() => transport.value.dispose());
    expect(await response).toEqual({ ok: true, value: { accepted: true } });
    await disposed;
    expect(await transport.value.whenIdle()).toEqual({ ok: true, value: true });
    expect(observed).toEqual([]);
    expect(transport.value.assertDrained()).toEqual({ ok: true, value: true });
  });

  test("whenIdle rejoins a request causally queued by an after-event", async () => {
    let releaseSecondWait = (): void => {
      throw new Error("The second logical wait has not started.");
    };
    let markSecondWaitStarted = (): void => undefined;
    const secondWaitStarted = new Promise<void>((resolve) => {
      markSecondWaitStarted = () => resolve();
    });
    const runtime = createLogicalRuntime(undefined, () => new Promise((resolve) => {
      releaseSecondWait = () => resolve();
      markSecondWaitStarted();
    }));
    const transport = transportFixture([
      {
        request: { id: 1, payload: "first" },
        outcome: { kind: "response", value: { accepted: true } },
        eventsAfter: ["chain"],
      },
      {
        request: { id: 2, payload: "second" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 10,
      },
    ], runtime);
    if (!transport.ok) throw new Error(transport.error.message);
    const causal = { chainedRequest: null as Promise<unknown> | null };
    transport.value.subscribe((event) => {
      if (event !== "chain") return;
      queueMicrotask(() => {
        causal.chainedRequest = transport.value.request({ id: 2, payload: "second" });
      });
    });

    const first = transport.value.request({ id: 1, payload: "first" });
    expect(await first).toMatchObject({ ok: true });
    let idleSettled = false;
    const idle = transport.value.whenIdle().then((result) => {
      idleSettled = true;
      return result;
    });
    await secondWaitStarted;

    expect(transport.value.pendingDeliveries()).toBe(1);
    expect(transport.value.remainingSteps()).toBe(0);
    expect(idleSettled).toBe(false);
    releaseSecondWait();
    const chainedRequest = causal.chainedRequest;
    if (chainedRequest === null) throw new Error("The after-event did not queue its request.");
    expect(await chainedRequest).toMatchObject({ ok: true });
    expect(await idle).toEqual({ ok: true, value: true });
    expect(transport.value.pendingDeliveries()).toBe(0);
    expect(transport.value.assertDrained()).toEqual({ ok: true, value: true });
  });

  test("reserves a step before activity publication can reenter request", async () => {
    const runtime = createLogicalRuntime(undefined, () => Promise.resolve());
    const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
    if (!store.ok) throw new Error(store.error.message);
    const transport = createExactScriptedTransport({
      runtime,
      parseRequest,
      parseResponse,
      parseEvent,
      parseFailure,
      activity: createDirectActivityScope(store.value, runtime),
      steps: [{
        request: { id: 1, payload: "once" },
        outcome: { kind: "response", value: { accepted: true } },
      }],
    });
    if (!transport.ok) throw new Error(transport.error.message);

    const reentrantRequests: Promise<unknown>[] = [];
    let reentered = false;
    const unsubscribe = store.value.subscribe(() => {
      if (reentered || store.value.getSnapshot().activity.active !== 1) return;
      reentered = true;
      reentrantRequests.push(transport.value.request({ id: 1, payload: "once" }));
    });

    expect(await transport.value.request({ id: 1, payload: "once" })).toMatchObject({ ok: true });
    expect(reentrantRequests).toHaveLength(1);
    expect(await reentrantRequests[0]).toMatchObject({
      ok: false,
      error: { kind: "transport", error: { code: "unexpected-request", remainingSteps: 0 } },
    });
    expect(await transport.value.whenIdle()).toMatchObject({ ok: false, error: { code: "internal-failure" } });
    expect(transport.value.remainingSteps()).toBe(0);
    expect(transport.value.pendingDeliveries()).toBe(0);
    expect(transport.value.violationCount()).toBe(1);
    expect(store.value.getSnapshot().activity).toEqual({ active: 0, started: 1, settled: 1 });
    unsubscribe();
  });

  test("consumes a reserved step when activity begin throws", async () => {
    const transport = createExactScriptedTransport({
      runtime: createLogicalRuntime(undefined, () => Promise.resolve()),
      parseRequest,
      parseResponse,
      parseEvent,
      parseFailure,
      activity: {
        begin: () => {
          throw new Error("activity unavailable");
        },
      },
      steps: [{
        request: { id: 1, payload: "reserved" },
        outcome: { kind: "response", value: { accepted: true } },
      }],
    });
    if (!transport.ok) throw new Error(transport.error.message);
    expect(await transport.value.request({ id: 1, payload: "reserved" })).toMatchObject({
      ok: false,
      error: { kind: "transport", error: { code: "activity-failed", remainingSteps: 0 } },
    });
    expect(transport.value.remainingSteps()).toBe(0);
    expect(transport.value.pendingDeliveries()).toBe(0);
    expect(transport.value.violationCount()).toBe(1);
    expect(transport.value.assertDrained()).toMatchObject({ ok: false, error: { code: "internal-failure" } });
  });

  test("isolates subscriber failures and records a bounded drain violation", async () => {
    const transport = transportFixture([{
      request: { id: 1, payload: "event" },
      outcome: { kind: "response", value: { accepted: true } },
      eventsBefore: ["event"],
    }]);
    if (!transport.ok) throw new Error(transport.error.message);
    transport.value.subscribe(() => {
      throw new Error("subscriber broke");
    });
    expect(await transport.value.request({ id: 1, payload: "event" })).toMatchObject({ ok: true });
    await transport.value.whenIdle();
    expect(transport.value.violationCount()).toBe(1);
    expect(transport.value.assertDrained()).toMatchObject({
      ok: false,
      error: { code: "internal-failure", message: "subscriber broke" },
    });
  });

  test("contains rejected asynchronous listeners and retains the synchronous-contract violation", async () => {
    const transport = transportFixture([{
      request: { id: 1, payload: "event" },
      outcome: { kind: "response", value: { accepted: true } },
      eventsBefore: ["event"],
    }]);
    if (!transport.ok) throw new Error(transport.error.message);
    transport.value.subscribe((() => Promise.reject(new Error("listener rejected"))) as unknown as
      ScriptedTransportListener<string>);

    expect(await transport.value.request({ id: 1, payload: "event" })).toMatchObject({ ok: true });
    expect(await transport.value.whenIdle()).toMatchObject({
      ok: false,
      error: {
        code: "internal-failure",
        message: "Scripted transport listeners must complete synchronously and return undefined",
      },
    });
    expect(transport.value.violationCount()).toBe(1);
    await Promise.resolve();
  });

  test("contains rejected asynchronous listener-error reporters as a second drain violation", async () => {
    const transport = createExactScriptedTransport({
      runtime: createLogicalRuntime(undefined, () => Promise.resolve()),
      parseRequest,
      parseResponse,
      parseEvent,
      parseFailure,
      onListenerError: (() => Promise.reject(new Error("reporter rejected"))) as unknown as
        ScriptedTransportListenerErrorReporter,
      steps: [{
        request: { id: 1, payload: "event" },
        outcome: { kind: "response", value: { accepted: true } },
        eventsBefore: ["event"],
      }],
    });
    if (!transport.ok) throw new Error(transport.error.message);
    transport.value.subscribe(() => {
      throw new Error("listener threw");
    });

    expect(await transport.value.request({ id: 1, payload: "event" })).toMatchObject({ ok: true });
    expect(await transport.value.whenIdle()).toMatchObject({ ok: false, error: { code: "internal-failure" } });
    expect(transport.value.violationCount()).toBe(2);
    await Promise.resolve();
  });

  test("captures parser and runtime references before retaining caller configuration", async () => {
    const options = {
      runtime: createLogicalRuntime(undefined, () => Promise.resolve()),
      parseRequest,
      parseResponse,
      parseEvent,
      parseFailure,
      steps: [{
        request: { id: 1, payload: "captured" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 5,
      }],
    };
    const transport = createExactScriptedTransport(options);
    if (!transport.ok) throw new Error(transport.error.message);

    options.parseRequest = () => {
      throw new Error("mutated parser must not run");
    };
    options.runtime = createLogicalRuntime(undefined, () => Promise.reject(new Error("mutated wait must not run")));

    expect(await transport.value.request({ id: 1, payload: "captured" })).toEqual({
      ok: true,
      value: { accepted: true },
    });
    expect(await transport.value.whenIdle()).toEqual({ ok: true, value: true });
    expect(transport.value.assertDrained()).toEqual({ ok: true, value: true });
  });

  test("turns hostile option access into a definition Result", () => {
    const hostileOptions = new Proxy({}, {
      get: () => {
        throw new Error("option getter failed");
      },
    });
    expect(createExactScriptedTransport(hostileOptions as never)).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "option getter failed" },
    });
    const baseLimits: ScriptedTransportLimits = {
      maxSteps: 1,
      maxEventsPerStep: 1,
      maxRecordedInternalErrors: 1,
      maxLogicalDelayPerStepMs: 0,
      maxTotalLogicalDelayMs: 0,
    };
    const hostileLimits = new Proxy(baseLimits, {
      ownKeys: () => {
        throw new Error("limit inspection failed");
      },
    });
    expect(createExactScriptedTransport({
      runtime: createLogicalRuntime(undefined, () => Promise.resolve()),
      parseRequest,
      parseResponse,
      parseEvent,
      parseFailure,
      steps: [],
      limits: hostileLimits,
    })).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "limit inspection failed" },
    });
  });

  test("rejects extra and incomplete outcome shapes before retaining a script", () => {
    for (const outcome of [
      { kind: "response" },
      { kind: "response", value: { accepted: true }, error: { code: "ambiguous" } },
      { kind: "failure", error: { code: "offline" }, value: { accepted: false } },
      { kind: "failure" },
      { kind: "response", value: { accepted: true }, extra: true },
    ]) {
      expect(transportFixture([{
        request: { id: 1, payload: "shape" },
        outcome,
      }])).toMatchObject({ ok: false, error: { code: "invalid-step", step: 0 } });
    }
  });

  test("turns hostile parser throws into definition errors", () => {
    const hostile = hostileThrownValue();
    expect(createExactScriptedTransport({
      runtime: createLogicalRuntime(undefined, () => Promise.resolve()),
      parseRequest: () => {
        throw hostile;
      },
      parseResponse,
      parseEvent,
      parseFailure,
      steps: [{
        request: { id: 1, payload: "parser" },
        outcome: { kind: "response", value: { accepted: true } },
      }],
    })).toEqual({
      ok: false,
      error: {
        code: "invalid-step",
        message: "Invalid scripted request: Unknown failure",
        step: 0,
      },
    });
  });

  test("hostile runtime rejections resolve and finalize every delivery boundary", async () => {
    const hostile = hostileThrownValue();
    const baseRuntime = createLogicalRuntime(undefined, () => Promise.resolve());
    const runtime = Object.freeze({
      ...baseRuntime,
      wait: () => Promise.reject(hostile),
    }) satisfies LogicalRuntime;
    const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
    if (!store.ok) throw new Error(store.error.message);
    const transport = createExactScriptedTransport({
      runtime,
      parseRequest,
      parseResponse,
      parseEvent,
      parseFailure,
      activity: createDirectActivityScope(store.value, runtime),
      steps: [{
        request: { id: 1, payload: "hostile-wait" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 1,
      }],
    });
    if (!transport.ok) throw new Error(transport.error.message);

    expect(await transport.value.request({ id: 1, payload: "hostile-wait" })).toMatchObject({
      ok: false,
      error: {
        kind: "transport",
        error: { code: "logical-wait-failed", message: "Logical wait failed: Logical wait threw" },
      },
    });
    expect(await transport.value.whenIdle()).toMatchObject({ ok: false, error: { code: "internal-failure" } });
    expect(transport.value.pendingDeliveries()).toBe(0);
    expect(transport.value.remainingSteps()).toBe(0);
    expect(transport.value.violationCount()).toBe(1);
    expect(store.value.getSnapshot().activity).toEqual({ active: 0, started: 1, settled: 1 });
  });

  test("bounds each logical delay and the overflow-safe total before execution", () => {
    const limits = {
      ...DEFAULT_SCRIPTED_TRANSPORT_LIMITS,
      maxLogicalDelayPerStepMs: 10,
      maxTotalLogicalDelayMs: 15,
    };
    expect(transportFixture([{
      request: { id: 1, payload: "too-long" },
      outcome: { kind: "response", value: { accepted: true } },
      delayMs: 11,
    }], undefined, limits)).toMatchObject({
      ok: false,
      error: { code: "script-too-large", step: 0, message: "Transport delayMs exceeds the per-step limit of 10" },
    });
    expect(transportFixture([
      {
        request: { id: 1, payload: "first" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 10,
      },
      {
        request: { id: 2, payload: "second" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 6,
      },
    ], undefined, limits)).toMatchObject({
      ok: false,
      error: { code: "script-too-large", step: 1, message: "Transport script exceeds the total logical delay limit of 15" },
    });

    const maximum = Number.MAX_SAFE_INTEGER;
    expect(transportFixture([
      {
        request: { id: 1, payload: "maximum" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: maximum,
      },
      {
        request: { id: 2, payload: "overflow" },
        outcome: { kind: "response", value: { accepted: true } },
        delayMs: 1,
      },
    ], undefined, {
      ...DEFAULT_SCRIPTED_TRANSPORT_LIMITS,
      maxLogicalDelayPerStepMs: maximum,
      maxTotalLogicalDelayMs: maximum,
    })).toMatchObject({ ok: false, error: { code: "script-too-large", step: 1 } });

    expect(transportFixture([], undefined, {
      ...DEFAULT_SCRIPTED_TRANSPORT_LIMITS,
      maxTotalLogicalDelayMs: Number.MAX_SAFE_INTEGER + 1,
    })).toMatchObject({ ok: false, error: { code: "invalid-limits" } });
  });

  test("applies maxEventsPerStep to before and after events combined", () => {
    const limits = { ...DEFAULT_SCRIPTED_TRANSPORT_LIMITS, maxEventsPerStep: 2 };
    expect(transportFixture([{
      request: { id: 1, payload: "events" },
      outcome: { kind: "response", value: { accepted: true } },
      eventsBefore: ["one", "two"],
      eventsAfter: ["three"],
    }], undefined, limits)).toMatchObject({
      ok: false,
      error: { code: "script-too-large", step: 0, message: "Transport step exceeds the combined event limit of 2" },
    });
    expect(transportFixture([{
      request: { id: 1, payload: "events" },
      outcome: { kind: "response", value: { accepted: true } },
      eventsBefore: ["one"],
      eventsAfter: ["two"],
    }], undefined, limits)).toMatchObject({ ok: true });
  });
});
