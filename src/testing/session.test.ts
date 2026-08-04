import { describe, expect, test } from "bun:test";

import { defineDirect } from "../core/definition.js";
import { operationId } from "../core/ids.js";
import { SCENARIO_QUERY_KEY } from "../core/query.js";
import type {
  DirectStoreReplacementValidationContext,
} from "../core/store.js";
import { parseTestWorld, type TestWorld } from "../core/test-support.js";
import {
  createDirectSession,
  type DirectSessionCleanup,
  type DirectSessionObservation,
} from "./session.js";

function definition() {
  return defineDirect({
    parseWorld: parseTestWorld,
    defaultScenario: "chat.empty",
    scenarios: [{
      id: "chat.empty",
      title: "Empty chat",
      route: "/chat",
      world: { count: 0, messages: [] },
    }],
    coverage: [],
  });
}

describe("Direct session", () => {
  test("owns activation, clock, activity, harness observation, and teardown", () => {
    const cleanup: string[] = [];
    let pending = 1;
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "query", source: "" },
      create: (context) => {
        context.onDispose(() => { cleanup.push("first"); });
        context.onDispose(() => { cleanup.push("second"); });
        return { count: context.world.count };
      },
      observe: () => ({
        pending: [{ name: "requests", read: () => pending }],
        readRemainingWork: () => ({ queued: pending }),
      }),
    });
    if (!created.ok) throw new Error(created.error.message);

    expect(String(created.value.activation.scenario)).toBe("chat.empty");
    expect(created.value.clock.now()).toBe(0);
    expect(created.value.harness).toEqual({ count: 0 });
    expect(created.value.coverage).toEqual({ schema: "direct.coverage/v2", entries: [] });
    expect(created.value.probe.isQuiescent()).toEqual({ ok: true, value: false });
    pending = 0;
    expect(created.value.probe.snapshot()).toMatchObject({
      ok: true,
      value: { isQuiescent: true, remainingWork: { queued: 0 } },
    });

    created.value.dispose();
    created.value.dispose();
    expect(created.value.signal.aborted).toBeTrue();
    expect(created.value.isDisposed()).toBeTrue();
    expect(cleanup).toEqual(["second", "first"]);
    expect(created.value.disposalErrors()).toEqual([]);
  });

  test("does not construct a harness after invalid activation", () => {
    let constructions = 0;
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "query", source: `?${SCENARIO_QUERY_KEY}=missing` },
      create: () => {
        constructions += 1;
        return {};
      },
      observe: () => ({}),
    });
    expect(created).toMatchObject({ ok: false, error: { code: "activation-failed" } });
    expect(constructions).toBe(0);
  });

  test("captures store callback configuration before world parsing can mutate it", () => {
    const reports = { captured: 0, mutated: 0 };
    const storeOptions = {
      onListenerError: () => {
        reports.captured += 1;
      },
    };
    let mutateDuringParse = false;
    const customDefinition = defineDirect({
      parseWorld: (input) => {
        if (mutateDuringParse) {
          storeOptions.onListenerError = () => {
            reports.mutated += 1;
          };
        }
        return parseTestWorld(input);
      },
      defaultScenario: "chat.empty",
      scenarios: [{
        id: "chat.empty",
        title: "Empty chat",
        route: "/chat",
        world: { count: 0, messages: [] },
      }],
      coverage: [],
    });
    mutateDuringParse = true;
    const created = createDirectSession({
      definition: customDefinition,
      activation: { kind: "scenario", scenario: "chat.empty" },
      storeOptions,
      create: () => ({}),
    });
    if (!created.ok) throw new Error(created.error.message);
    created.value.store.subscribe(() => {
      throw new Error("listener failed");
    });

    const lease = created.value.activity.begin("reporter-capture");
    if (!lease.ok) throw new Error(lease.error.message);
    expect(lease.value.release()).toEqual({ ok: true, value: true });
    expect(reports).toEqual({ captured: 2, mutated: 0 });
    created.value.dispose();
  });

  test("passes captured primitive replacement validation through the session store", () => {
    const contexts: DirectStoreReplacementValidationContext<TestWorld>[] = [];
    let retargetedCalls = 0;
    const storeOptions = {
      validateReplacements: (
        context: DirectStoreReplacementValidationContext<TestWorld>,
      ): undefined => {
        contexts.push(context);
        return undefined;
      },
    };
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      storeOptions,
      create: () => ({}),
    });
    if (!created.ok) throw new Error(created.error.message);
    storeOptions.validateReplacements = () => {
      retargetedCalls += 1;
      return undefined;
    };
    const before = created.value.store.getSnapshot();

    const committed = created.value.store.transactReplacements(
      before.generation,
      operationId("session-replacement-validation"),
      [{ expected: 0, path: ["count"], value: 1 }],
    );

    expect(committed).toMatchObject({ ok: true, value: { world: { count: 1 } } });
    if (!committed.ok) throw new Error(committed.error.message);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.baseWorld).toBe(before.world);
    expect(contexts[0]?.candidateWorld).toBe(committed.value.world);
    expect(retargetedCalls).toBe(0);
    created.value.dispose();
  });

  test("turns hostile session option access into an error Result", () => {
    const hostileOptions = new Proxy({}, {
      get: () => {
        throw new Error("session option getter failed");
      },
    });
    expect(createDirectSession(hostileOptions as never)).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "session option getter failed" },
    });
    const unsupportedActivation = {
      kind: "unsupported",
    };
    const invalidActivationOptions = {
      definition: definition(),
      activation: unsupportedActivation,
      create: () => ({}),
    };
    expect(createDirectSession(invalidActivationOptions as never)).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "Direct session activation kind must be query or scenario" },
    });
  });

  test("contains hostile structural definition activation behind the Result boundary", () => {
    const throwingDefinition = {
      ...definition(),
      activateScenario: () => {
        throw new Error("structural activation failed");
      },
    };
    expect(createDirectSession({
      definition: throwingDefinition,
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: () => ({}),
    })).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "structural activation failed" },
    });

    const hostileResultDefinition = {
      ...definition(),
      activate: () => new Proxy({}, {
        get: () => {
          throw new Error("structural activation result failed");
        },
      }),
    };
    expect(createDirectSession({
      definition: hostileResultDefinition as never,
      activation: { kind: "query", source: "" },
      create: () => ({}),
    })).toMatchObject({
      ok: false,
      error: { code: "invalid-options", message: "structural activation result failed" },
    });
  });

  test("aborts and unwinds registered cleanup when harness construction fails", () => {
    const cleanup: string[] = [];
    let aborted = false;
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: (context) => {
        context.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        context.onDispose(() => { cleanup.push("cleaned"); });
        throw new Error("adapter unavailable");
      },
      observe: () => ({}),
    });
    expect(created).toMatchObject({
      ok: false,
      error: { code: "harness-failed", message: "adapter unavailable", cleanupErrors: [] },
    });
    expect(aborted).toBeTrue();
    expect(cleanup).toEqual(["cleaned"]);
  });

  test("turns hostile observation values into Results and always unwinds construction", () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const cases: readonly [label: string, observe: () => DirectSessionObservation][] = [
      ["null", () => null as unknown as DirectSessionObservation],
      ["revoked proxy", () => revoked.proxy],
      ["throwing accessor", () => Object.defineProperty({}, "pending", {
        get: () => {
          throw new Error("pending getter failed");
        },
      })],
    ];

    for (const [label, observe] of cases) {
      const lifecycle = { aborted: false, cleanups: 0 };
      const created = createDirectSession({
        definition: definition(),
        activation: { kind: "scenario", scenario: "chat.empty" },
        create: (context) => {
          context.signal.addEventListener("abort", () => { lifecycle.aborted = true; }, { once: true });
          context.onDispose(() => {
            lifecycle.cleanups += 1;
            return undefined;
          });
          return {};
        },
        observe,
      });

      if (created.ok) {
        created.value.dispose();
        throw new Error(`${label} observation unexpectedly constructed a session`);
      }
      expect(created.error.code).toBe("observation-failed");
      expect(lifecycle).toEqual({ aborted: true, cleanups: 1 });
    }
  });

  test("unwinds construction when observation counters cannot form a probe", () => {
    const lifecycle = { aborted: false, cleanups: 0 };
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: (context) => {
        context.signal.addEventListener("abort", () => { lifecycle.aborted = true; }, { once: true });
        context.onDispose(() => {
          lifecycle.cleanups += 1;
          return undefined;
        });
        return {};
      },
      observe: () => ({ pending: [{ name: "invalid counter", read: () => 0 }] }),
    });

    expect(created).toMatchObject({
      ok: false,
      error: { code: "probe-failed", probeError: { code: "invalid-counter-name" } },
    });
    expect(lifecycle).toEqual({ aborted: true, cleanups: 1 });
  });

  test("records cleanup failures while still running every callback", () => {
    const cleanup: string[] = [];
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "query", source: "" },
      create: (context) => {
        context.onDispose(() => { cleanup.push("last"); });
        context.onDispose(() => { throw new Error("cleanup failed"); });
        context.onDispose(() => { cleanup.push("first"); });
        return {};
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    created.value.dispose();
    expect(cleanup).toEqual(["first", "last"]);
    expect(created.value.disposalErrors()).toEqual(["cleanup failed"]);
  });

  test("accepts post-construction cleanup until disposal and then fails closed", () => {
    const cleanup: string[] = [];
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: () => ({}),
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(created.value.onDispose(() => {
      cleanup.push("browser");
      return undefined;
    })).toEqual({ ok: true, value: true });
    expect(created.value.onDispose(null as never)).toMatchObject({
      ok: false,
      error: { code: "invalid-cleanup" },
    });

    created.value.dispose();
    expect(cleanup).toEqual(["browser"]);
    expect(created.value.onDispose(() => undefined)).toMatchObject({
      ok: false,
      error: { code: "session-disposed" },
    });
  });

  test("fences session-owned activity before reentrant cleanup and after disposal", () => {
    const duringCleanup: unknown[] = [];
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: (context) => {
        const beforeDisposal = context.activity.begin("before-disposal");
        if (!beforeDisposal.ok) throw new Error(beforeDisposal.error.message);
        context.onDispose(() => {
          expect(beforeDisposal.value.release()).toEqual({ ok: true, value: true });
          duringCleanup.push(context.activity.begin("during-cleanup"));
          return undefined;
        });
        return {};
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    expect(created.value.store.getSnapshot().activity).toEqual({ active: 1, started: 1, settled: 0 });

    created.value.dispose();
    expect(duringCleanup).toEqual([{
      ok: false,
      error: {
        code: "scope-closed",
        message: "The Direct activity scope is closed",
        operation: null,
        storeError: null,
        reason: null,
      },
    }]);
    expect(created.value.activity.begin("after-disposal")).toMatchObject({
      ok: false,
      error: { code: "scope-closed", operation: null },
    });
    expect(created.value.store.getSnapshot().activity).toEqual({ active: 0, started: 1, settled: 1 });
    expect(created.value.probe.isQuiescent()).toEqual({ ok: true, value: true });
  });

  test("supports programmatic scenario activation without an observation adapter", () => {
    const created = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: (context) => ({ route: context.activation.route }),
    });
    if (!created.ok) throw new Error(created.error.message);

    expect(created.value.harness).toEqual({ route: "/chat" });
    expect(created.value.probe.snapshot()).toMatchObject({
      ok: true,
      value: { isQuiescent: true },
    });
  });

  test("fails closed on asynchronous construction and reports asynchronous cleanup", () => {
    const product = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: () => Promise.resolve({}),
    });
    expect(product).toMatchObject({
      ok: false,
      error: {
        code: "harness-failed",
        message: "Direct harness construction must complete synchronously",
      },
    });

    const observation = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: () => ({}),
      observe: (() => Promise.resolve({})) as unknown as () => DirectSessionObservation,
    });
    expect(observation).toMatchObject({
      ok: false,
      error: {
        code: "observation-failed",
        message: "Direct observation construction must complete synchronously",
      },
    });

    const cleanup = createDirectSession({
      definition: definition(),
      activation: { kind: "scenario", scenario: "chat.empty" },
      create: (context) => {
        context.onDispose((() => Promise.resolve()) as unknown as DirectSessionCleanup);
        return {};
      },
    });
    if (!cleanup.ok) throw new Error(cleanup.error.message);
    cleanup.value.dispose();
    expect(cleanup.value.disposalErrors()).toEqual([
      "Direct cleanup must complete synchronously and return undefined",
    ]);
  });
});
