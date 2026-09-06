import { describe, expect, test } from "bun:test";
import { Cause, Context, Effect, Exit, Fiber, Layer, Schedule } from "effect";
import fc from "fast-check";
import { defineDirect } from "../core/definition.js";
import { createLogicalRuntime } from "../core/runtime.js";
import { parseTestWorld, type TestWorld } from "../core/test-support.js";
import { createDirectSession } from "../testing/session.js";
import { createDirectEffectDriver, type DirectEffectOperation } from "./index.js";

function session<R, E>(layer: Layer.Layer<R, E>, maxSteps = 10_000) {
  const created = createDirectSession({
    definition: defineDirect({
      parseWorld: parseTestWorld, defaultScenario: "counter.empty",
      scenarios: [{ id: "counter.empty", title: "Empty counter", route: "/", world: { count: 0, messages: [] } }],
      coverage: [],
    }),
    activation: { kind: "query", source: "" },
    create: context => createDirectEffectDriver({ context, layer, clock: "deadline", maxSteps }),
    observe: driver => driver.observation,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("opt-in Effect driver", () => {
  test("deadline 10/20 completes at 20 while existing FIFO still sums to 30", async () => {
    const fifo = createLogicalRuntime(undefined, async () => undefined);
    await Promise.all([fifo.wait(10), fifo.wait(20)]);
    expect(fifo.now()).toBe(30);
    const owner = session(Layer.empty);
    const trace: number[] = [];
    const work = owner.harness.runExit("waits", () => Effect.all([
      Effect.sleep(10).pipe(Effect.zipRight(Effect.sync(() => { trace.push(owner.clock.now()); }))),
      Effect.sleep(20).pipe(Effect.zipRight(Effect.sync(() => { trace.push(owner.clock.now()); }))),
    ], { concurrency: "unbounded" }));
    expect(owner.harness.advance(9)).toEqual({ ok: true, value: 9 });
    expect(trace).toEqual([]);
    expect(owner.harness.advance(11)).toEqual({ ok: true, value: 20 });
    expect(Exit.isSuccess(await work)).toBeTrue();
    expect(trace).toEqual([10, 20]);
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: true });
    owner.dispose();
    await owner.harness.close();
  });

  test("arbitrary concurrent deadlines follow independent sorted elapsed-time oracle", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 12 }), async durations => {
      const owner = session(Layer.empty);
      const trace: number[] = [];
      const work = owner.harness.runExit("law", () => Effect.all(durations.map(duration =>
        Effect.sleep(duration).pipe(Effect.zipRight(Effect.sync(() => { trace.push(owner.clock.now()); }))),
      ), { concurrency: "unbounded" }));
      expect(owner.harness.advance(Math.max(...durations)).ok).toBeTrue();
      expect(Exit.isSuccess(await work)).toBeTrue();
      expect(trace).toEqual([...durations].sort((a, b) => a - b));
      owner.dispose();
      await owner.harness.close();
    }), { numRuns: 30 });
  });

  test("retries and timeout use the same deadline clock; no duplicate post-timeout mutation", async () => {
    const owner = session(Layer.empty);
    let attempts = 0;
    const retry = owner.harness.runExit("retry", op => Effect.gen(function* () {
      attempts += 1;
      if (attempts < 3) return yield* Effect.fail("temporary");
      return yield* op.transact(world => { world.count += 1; });
    }).pipe(Effect.retry(Schedule.spaced(5))));
    expect(owner.harness.advance(10).ok).toBeTrue();
    expect(Exit.isSuccess(await retry)).toBeTrue();
    expect(attempts).toBe(3);
    const timeout = owner.harness.runExit("timeout", op => Effect.sleep(20).pipe(
      Effect.zipRight(op.transact(world => { world.count += 10; })), Effect.timeout(5),
    ));
    expect(owner.harness.advance(30).ok).toBeTrue();
    expect(Exit.isFailure(await timeout)).toBeTrue();
    expect(owner.store.getSnapshot().world.count).toBe(1);
    owner.dispose();
    await owner.harness.close();
  });

  test("reset interrupts old work and fences a retained transaction without hiding finalizers", async () => {
    const owner = session(Layer.empty);
    let retained: DirectEffectOperation<TestWorld> | undefined;
    let released = false;
    const work = owner.harness.runExit("reset", op => Effect.gen(function* () {
      retained = op;
      yield* Effect.addFinalizer(() => Effect.sleep(5).pipe(Effect.zipRight(Effect.sync(() => { released = true; }))));
      yield* Effect.never;
    }));
    expect(owner.store.reset({ count: 7, messages: [] }).ok).toBeTrue();
    owner.harness.drain();
    expect(owner.store.getSnapshot().activity.active).toBe(0);
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: false });
    expect(owner.harness.advance(5).ok).toBeTrue();
    const interrupted = await work;
    expect(Exit.isFailure(interrupted)).toBeTrue();
    if (Exit.isFailure(interrupted)) expect(Cause.isInterrupted(interrupted.cause)).toBeTrue();
    expect(released).toBeTrue();
    if (retained === undefined) throw new Error("missing operation");
    const oldOperation = retained;
    const stale = await owner.harness.runExit("stale", () => oldOperation.transact(world => { world.count = 99; }));
    expect(stale).toMatchObject({ _tag: "Failure", cause: { _tag: "Fail", error: { code: "stale-generation" } } });
    expect(owner.store.getSnapshot().world.count).toBe(7);
    owner.dispose();
    await owner.harness.close();
  });

  test("dispose fences synchronously; close joins scoped children and is idempotent", async () => {
    const owner = session(Layer.empty);
    let released = 0;
    const work = owner.harness.runExit("scope", () => Effect.gen(function* () {
      yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => { released += 1; })), Effect.forkScoped);
      yield* Effect.never;
    }));
    expect(owner.dispose()).toBeUndefined();
    const denied = await owner.harness.runExit("denied", () => Effect.succeed(1));
    expect(denied).toMatchObject({ _tag: "Failure", cause: { error: { code: "closed" } } });
    const close = owner.harness.close();
    expect(owner.harness.close()).toBe(close);
    await work;
    const report = await close;
    expect(released).toBe(1);
    expect(Exit.isSuccess(report.runtime)).toBeTrue();
    expect(owner.harness.snapshot().state).toBe("closed");
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: true });
    expect(owner.disposalErrors()).toEqual([]);
  });

  test("one layer lifetime retains primary and cleanup failures separately", async () => {
    class Resource extends Context.Tag("@hraness/direct/example/Resource")<Resource, { readonly value: number }>() {}
    let acquired = 0;
    const layer = Layer.scoped(Resource, Effect.acquireRelease(
      Effect.sync(() => { acquired += 1; return { value: 5 }; }),
      () => Effect.die("cleanup-defect"),
    ));
    const owner = session(layer);
    expect(await owner.harness.runExit("first", () => Effect.map(Resource, resource => resource.value))).toEqual(Exit.succeed(5));
    const failed = await owner.harness.runExit("failed", () => Effect.fail({ _tag: "DomainFailure" }));
    expect(Exit.isFailure(failed)).toBeTrue();
    expect(acquired).toBe(1);
    owner.dispose();
    const report = await owner.harness.close();
    expect(report.operationFailures).toHaveLength(1);
    expect(Exit.isFailure(report.runtime)).toBeTrue();
    if (Exit.isFailure(report.runtime)) expect([...Cause.defects(report.runtime.cause)]).toEqual(["cleanup-defect"]);
  });

  test("guarded transactions expire at operation completion and direct clock mutation is rejected", async () => {
    const owner = session(Layer.empty);
    const completed = await owner.harness.runExit("capture", op => Effect.succeed(op));
    if (Exit.isFailure(completed)) throw new Error("capture failed");
    const expired = await owner.harness.runExit("expired", () => completed.value.transact(world => { world.count = 1; }));
    expect(expired).toMatchObject({ _tag: "Failure", cause: { error: { code: "operation-settled" } } });
    owner.clock.advance(1);
    expect(owner.harness.advance(1)).toMatchObject({ ok: false, error: { code: "clock-conflict" } });
    expect(owner.harness.advance(-1)).toMatchObject({ ok: false, error: { code: "invalid-duration" } });
    owner.dispose();
    await owner.harness.close();
  });

  test("bounded drain reports endless cooperative work instead of hanging", async () => {
    const owner = session(Layer.empty, 20);
    const work = owner.harness.runExit("loop", () => Effect.forever(Effect.yieldNow()));
    expect(owner.harness.snapshot().failures).toBeGreaterThan(0);
    owner.dispose();
    owner.harness.drain();
    await work;
    await owner.harness.close();
  });

  test("a scoped race cancels its losing sleeper", async () => {
    const owner = session(Layer.empty);
    const work = owner.harness.runExit("race", () => Effect.race(Effect.sleep(5), Effect.sleep(50)));
    owner.harness.advance(5);
    expect(Exit.isSuccess(await work)).toBeTrue();
    expect(owner.harness.snapshot().pendingSleeps).toBe(0);
    const nested = owner.harness.runExit("join", () => Effect.gen(function* () {
      const child = yield* Effect.sleep(5).pipe(Effect.as(42), Effect.forkScoped);
      return yield* Fiber.join(child);
    }));
    owner.harness.advance(5);
    expect(await nested).toEqual(Exit.succeed(42));
    owner.dispose();
    await owner.harness.close();
  });

  test("finite fractional sleeps round up and infinite sleeps remain interruptible", async () => {
    const owner = session(Layer.empty);
    const trace: number[] = [];
    const finite = owner.harness.runExit("fraction", () => Effect.gen(function* () {
      yield* Effect.sleep(0.1);
      trace.push(owner.clock.now());
      yield* Effect.sleep(2.1);
      trace.push(owner.clock.now());
    }));
    owner.harness.advance(4);
    expect(Exit.isSuccess(await finite)).toBeTrue();
    expect(trace).toEqual([1, 4]);
    const infinite = owner.harness.runExit("infinity", () => Effect.sleep(Infinity));
    owner.dispose();
    await owner.harness.close();
    const interrupted = await infinite;
    expect(Exit.isFailure(interrupted)).toBeTrue();
    if (Exit.isFailure(interrupted)) expect(Cause.isInterrupted(interrupted.cause)).toBeTrue();
  });

  test("async Layer teardown remains pending until it finishes and retains its defect", async () => {
    let enter: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    let release: () => void = () => undefined;
    const layer = Layer.scopedDiscard(Effect.addFinalizer(() => Effect.async<void>(resume => {
      release = () => { resume(Effect.die("async-cleanup")); };
      enter();
    })));
    const owner = session(layer);
    await owner.harness.runExit("initialize", () => Effect.void);
    owner.dispose();
    const closing = owner.harness.close();
    await entered;
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: false });
    release();
    const report = await closing;
    expect(Exit.isFailure(report.runtime)).toBeTrue();
    expect(owner.harness.snapshot().failures).toBe(1);
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: true });
  });

  test("failed Layer construction is preserved and close before first run is safe", async () => {
    const owner = session(Layer.effectDiscard(Effect.fail({ _tag: "AcquireFailed" })));
    const failed = await owner.harness.runExit("init", () => Effect.void);
    expect(failed).toMatchObject({ _tag: "Failure", cause: { error: { _tag: "AcquireFailed" } } });
    owner.dispose();
    expect((await owner.harness.close()).operationFailures).toHaveLength(1);
    const unused = session(Layer.empty);
    unused.dispose();
    expect(Exit.isSuccess((await unused.harness.close()).runtime)).toBeTrue();
  });

  test("a Layer-owned suspended fiber keeps the probe nonquiescent after a root operation finishes", async () => {
    let finalized = false;
    const layer = Layer.scopedDiscard(Effect.never.pipe(
      Effect.ensuring(Effect.sync(() => { finalized = true; })), Effect.forkScoped,
    ));
    const owner = session(layer);
    await owner.harness.runExit("initialize", () => Effect.void);
    expect(owner.harness.snapshot().pendingOperations).toBe(0);
    expect(owner.harness.snapshot().pendingSleeps).toBe(0);
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: false });
    owner.dispose();
    await owner.harness.close();
    expect(finalized).toBeTrue();
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: true });
  });

  test("a failed Layer worker leaves visible failure evidence after becoming quiescent", async () => {
    const layer = Layer.scopedDiscard(Effect.sleep(5).pipe(
      Effect.zipRight(Effect.fail({ _tag: "WorkerFailed" })), Effect.forkScoped,
    ));
    const owner = session(layer);
    await owner.harness.runExit("initialize", () => Effect.void);
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: false });
    owner.harness.advance(5);
    expect(owner.probe.snapshot()).toMatchObject({
      ok: true, value: { isQuiescent: true, violations: { "effect.failures": 1 } },
    });
    owner.dispose();
    const report = await owner.harness.close();
    expect(report.backgroundFailures).toHaveLength(1);
    expect([...Cause.failures(report.backgroundFailures[0] ?? Cause.empty)]).toEqual([{ _tag: "WorkerFailed" }]);
  });

  test("a successful root retains a failed scoped child's observed Cause", async () => {
    const owner = session(Layer.empty);
    const root = await owner.harness.runExit("parent", () => Effect.gen(function* () {
      yield* Effect.fail({ _tag: "ChildFailed" }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow();
      return "parent completed";
    }));
    expect(root).toEqual(Exit.succeed("parent completed"));
    owner.dispose();
    const report = await owner.harness.close();
    expect(report.operationFailures).toHaveLength(0);
    expect(report).toHaveProperty("childFailures");
    expect(report.childFailures).toHaveLength(1);
    expect(report.childFailures[0]).toMatchObject({ _tag: "Fail", error: { _tag: "ChildFailed" } });
    // An observed child exit does not establish whether the application handled it.
    expect(owner.harness.snapshot().failures).toBe(0);
  });
});
