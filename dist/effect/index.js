import {
  err,
  ok
} from "../index-mm9mqmyc.js";

// src/effect/driver.ts
import { Cause as Cause2, Effect as Effect3, Exit as Exit2, FiberId, Layer, ManagedRuntime, Supervisor as Supervisor2 } from "effect";

// src/effect/deadline.ts
import { Clock, Duration, Effect, Scheduler } from "effect";
function driverError(code, message, reason = null) {
  return Object.freeze({ _tag: "DirectEffectDriverError", code, message, reason });
}
function createDeadlineControl(runtime, maxSteps, report) {
  let expectedTime = runtime.now();
  let sequence = 0;
  let draining = false;
  let advancing = false;
  let automaticQueued = false;
  let paused = false;
  let turnSteps = 0;
  const sleepers = new Set;
  const tasks = [];
  const drain = () => {
    if (draining)
      return ok(0);
    draining = true;
    let steps = 0;
    try {
      while (tasks.length > 0) {
        if ((advancing ? turnSteps : steps) >= maxSteps) {
          paused = true;
          const failure = driverError("step-limit", `Deadline continuation budget exceeded ${String(maxSteps)} steps`);
          report(failure);
          return err(failure);
        }
        tasks.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
        const next = tasks.shift();
        if (next === undefined)
          break;
        steps += 1;
        turnSteps += 1;
        next.task();
      }
      paused = false;
      return ok(steps);
    } finally {
      draining = false;
    }
  };
  const scheduler = {
    shouldYield: (fiber) => Scheduler.defaultScheduler.shouldYield(fiber),
    scheduleTask: (task, priority) => {
      tasks.push({ task, priority, sequence: sequence++ });
      if (!automaticQueued && !paused && !draining && !advancing) {
        automaticQueued = true;
        queueMicrotask(() => {
          automaticQueued = false;
          if (!paused)
            drain();
        });
      }
    }
  };
  const clock = {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => runtime.now(),
    unsafeCurrentTimeNanos: () => BigInt(runtime.now()) * 1000000n,
    currentTimeMillis: Effect.sync(() => runtime.now()),
    currentTimeNanos: Effect.sync(() => BigInt(runtime.now()) * 1000000n),
    sleep: (input) => Effect.suspend(() => {
      const decoded = Duration.toMillis(input);
      if (decoded === Infinity)
        return Effect.never;
      const duration = Math.ceil(decoded);
      const deadline = runtime.now() + duration;
      if (!Number.isSafeInteger(duration) || duration < 0 || !Number.isSafeInteger(deadline)) {
        return Effect.die(driverError("invalid-duration", "Deadline sleep requires safe non-negative integer milliseconds"));
      }
      if (duration === 0)
        return Effect.void;
      return Effect.async((resume) => {
        const sleeper = {
          deadline,
          sequence: sequence++,
          wake: () => resume(Effect.void)
        };
        sleepers.add(sleeper);
        return Effect.sync(() => {
          sleepers.delete(sleeper);
        });
      });
    })
  };
  const advance = (milliseconds) => {
    if (advancing || draining)
      return err(driverError("reentrant-advance", "Advance must run outside an Effect continuation"));
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || !Number.isSafeInteger(expectedTime + milliseconds)) {
      return err(driverError("invalid-duration", "Advance requires safe non-negative integer milliseconds"));
    }
    if (runtime.now() !== expectedTime) {
      return err(driverError("clock-conflict", "Do not mix FIFO waits or direct clock advancement with deadline mode"));
    }
    advancing = true;
    turnSteps = 0;
    const target = expectedTime + milliseconds;
    try {
      const initial = drain();
      if (!initial.ok)
        return initial;
      while (true) {
        const next = [...sleepers].filter((sleeper) => sleeper.deadline <= target).sort((left, right) => left.deadline - right.deadline || left.sequence - right.sequence)[0];
        if (next === undefined)
          break;
        if (turnSteps >= maxSteps) {
          const failure = driverError("step-limit", `Deadline wake budget exceeded ${String(maxSteps)} steps`);
          report(failure);
          return err(failure);
        }
        turnSteps += 1;
        const advanced2 = runtime.advance(next.deadline - runtime.now());
        if (!advanced2.ok)
          return err(driverError("invalid-duration", advanced2.error.message, advanced2.error));
        expectedTime = advanced2.value;
        sleepers.delete(next);
        next.wake();
        const drained = drain();
        if (!drained.ok)
          return drained;
      }
      const advanced = runtime.advance(target - runtime.now());
      if (!advanced.ok)
        return err(driverError("invalid-duration", advanced.error.message, advanced.error));
      expectedTime = advanced.value;
      return ok(expectedTime);
    } finally {
      advancing = false;
    }
  };
  return { clock, scheduler, advance, drain, pending: () => tasks.length, sleeps: () => sleepers.size };
}

// src/effect/supervisor.ts
import { Cause, Effect as Effect2, Exit, Option, Supervisor } from "effect";

class DriverSupervisor extends Supervisor.AbstractSupervisor {
  roots = new Set;
  active = new Map;
  failures = [];
  children = [];
  value = Effect2.sync(() => this.active.size);
  registerRoot(fiber) {
    this.roots.add(fiber.id().id);
    if (this.active.has(fiber.id().id))
      this.active.set(fiber.id().id, true);
  }
  forgetRoot(fiber) {
    this.roots.delete(fiber.id().id);
  }
  pending() {
    return this.active.size;
  }
  backgroundFailures() {
    return [...this.failures];
  }
  childFailures() {
    return [...this.children];
  }
  backgroundFailureCount() {
    return this.failures.filter((cause) => !Cause.isInterruptedOnly(cause)).length;
  }
  onStart(_context, _effect, parent, fiber) {
    const parentId = Option.isSome(parent) ? parent.value.id().id : undefined;
    const operationOwned = this.roots.has(fiber.id().id) || parentId !== undefined && (this.roots.has(parentId) || this.active.get(parentId) === true);
    this.active.set(fiber.id().id, operationOwned);
  }
  onEnd(exit, fiber) {
    if (Exit.isFailure(exit) && !this.roots.has(fiber.id().id)) {
      if (this.active.get(fiber.id().id) === false)
        this.failures.push(exit.cause);
      else if (this.active.get(fiber.id().id) === true)
        this.children.push(exit.cause);
    }
    this.active.delete(fiber.id().id);
  }
}

// src/effect/driver.ts
function createDirectEffectDriver(options) {
  const { context } = options;
  const maxSteps = options.maxSteps ?? 1e4;
  if (options.clock !== "deadline" || !Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError("Effect driver requires deadline mode and a positive safe step budget");
  }
  let state = "open";
  const active = new Set;
  const operationFailures = [];
  const settlementErrors = [];
  const diagnostics = [];
  let runtimeFailure;
  const control = createDeadlineControl(context.clock, maxSteps, (failure) => {
    diagnostics.push(failure);
  });
  const supervisor = new DriverSupervisor;
  const runtime = ManagedRuntime.make(options.layer.pipe(Layer.provide(Layer.mergeAll(Layer.setClock(control.clock), Layer.setScheduler(control.scheduler), Supervisor2.addSupervisor(supervisor)))));
  const interrupt = () => {
    if (state === "closed")
      return;
    state = "closing";
    for (const operation of active)
      operation.interrupt();
  };
  const unsubscribe = context.store.subscribe(() => {
    const current = context.store.getSnapshot().generation;
    for (const operation of active) {
      if (operation.generation !== current)
        operation.interrupt();
    }
  });
  context.signal.addEventListener("abort", interrupt, { once: true });
  context.onDispose(interrupt);
  if (context.signal.aborted)
    interrupt();
  const runExit = (namespace, program) => {
    if (state !== "open" || context.signal.aborted) {
      return Promise.resolve(Exit2.fail(driverError("closed", "Effect driver is closed to new operations")));
    }
    const begun = context.activity.begin(namespace);
    if (!begun.ok)
      return Promise.resolve(Exit2.fail(driverError("activity-failed", begun.error.message, begun.error)));
    const lease = begun.value;
    let settled = false;
    let resolveDone = () => {
      return;
    };
    const entry = {
      generation: lease.generation,
      interrupt: () => {
        return;
      },
      done: new Promise((resolve) => {
        resolveDone = resolve;
      })
    };
    active.add(entry);
    const operation = Object.freeze({
      generation: lease.generation,
      operation: lease.operation,
      transact: (update) => Effect3.suspend(() => {
        let failure;
        if (context.store.getSnapshot().generation !== lease.generation) {
          failure = driverError("stale-generation", "Operation belongs to an earlier Direct generation");
        } else if (settled) {
          failure = driverError("operation-settled", "Operation has already settled");
        } else if (state !== "open" || context.signal.aborted) {
          failure = driverError("closed", "Operation owner is closing");
        }
        if (failure !== undefined) {
          diagnostics.push(failure);
          return Effect3.fail(failure);
        }
        const result = context.store.transact(lease.generation, lease.operation, update);
        return result.ok ? Effect3.succeed(result.value) : Effect3.fail(driverError("store-failed", result.error.message, result.error));
      })
    });
    const fiber = runtime.runFork(Effect3.scoped(Effect3.suspend(() => program(operation))), {
      scheduler: control.scheduler,
      immediate: false
    });
    supervisor.registerRoot(fiber);
    entry.interrupt = () => {
      fiber.unsafeInterruptAsFork(FiberId.none);
    };
    if (state !== "open" || context.signal.aborted || context.store.getSnapshot().generation !== lease.generation)
      entry.interrupt();
    return new Promise((resolve) => {
      fiber.addObserver((exit) => {
        settled = true;
        if (Exit2.isFailure(exit))
          operationFailures.push(exit.cause);
        const released = lease.release();
        const settlementError = !released.ok && released.error.storeError?.code !== "stale-generation" ? released.error : undefined;
        if (settlementError !== undefined)
          settlementErrors.push(settlementError);
        const failure = settlementError === undefined ? undefined : Cause2.fail(driverError("activity-failed", settlementError.message, settlementError));
        const result = failure === undefined ? exit : Exit2.failCause(Exit2.isFailure(exit) ? Cause2.sequential(exit.cause, failure) : failure);
        active.delete(entry);
        supervisor.forgetRoot(fiber);
        resolveDone();
        resolve(result);
      });
      control.drain();
    });
  };
  let closing;
  const close = () => {
    if (closing !== undefined)
      return closing;
    interrupt();
    closing = (async () => {
      control.drain();
      await Promise.all([...active].map((operation) => operation.done));
      const runtimeExit = await Effect3.runPromiseExit(runtime.disposeEffect.pipe(Effect3.withClock(control.clock), Effect3.withScheduler(control.scheduler)));
      if (Exit2.isFailure(runtimeExit))
        runtimeFailure = runtimeExit.cause;
      unsubscribe();
      context.signal.removeEventListener("abort", interrupt);
      state = "closed";
      return Object.freeze({
        runtime: runtimeExit,
        operationFailures: Object.freeze([...operationFailures]),
        backgroundFailures: Object.freeze(supervisor.backgroundFailures()),
        childFailures: Object.freeze(supervisor.childFailures()),
        settlementErrors: Object.freeze([...settlementErrors]),
        diagnostics: Object.freeze([...diagnostics])
      });
    })();
    return closing;
  };
  const failures = () => diagnostics.length + settlementErrors.length + operationFailures.filter((cause) => Cause2.defects(cause).length > 0).length + supervisor.backgroundFailureCount() + (runtimeFailure === undefined ? 0 : 1);
  const snapshot = () => Object.freeze({
    clock: "deadline",
    nowMs: context.clock.now(),
    pendingOperations: active.size,
    pendingContinuations: control.pending(),
    pendingSleeps: control.sleeps(),
    state,
    failures: failures(),
    pendingFibers: supervisor.pending()
  });
  return Object.freeze({
    runExit,
    advance: control.advance,
    drain: control.drain,
    snapshot,
    interrupt,
    close,
    observation: Object.freeze({
      pending: [
        { name: "effect.operations", read: () => active.size },
        { name: "effect.continuations", read: control.pending },
        { name: "effect.fibers", read: () => supervisor.pending() },
        { name: "effect.close", read: () => state === "closing" ? 1 : 0 }
      ],
      violations: [{ name: "effect.failures", read: failures }]
    })
  });
}
export {
  createDirectEffectDriver
};
