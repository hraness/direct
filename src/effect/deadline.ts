import { Clock, Duration, Effect, Scheduler } from "effect";
import type { LogicalRuntime } from "../core/runtime.js";
import { err, ok, type Result } from "../core/result.js";

export interface DirectEffectDriverError {
  readonly _tag: "DirectEffectDriverError";
  readonly code: "closed" | "stale-generation" | "operation-settled" | "activity-failed"
    | "store-failed" | "invalid-duration" | "clock-conflict" | "step-limit" | "reentrant-advance";
  readonly message: string;
  readonly reason: unknown;
}

export function driverError(
  code: DirectEffectDriverError["code"], message: string, reason: unknown = null,
): DirectEffectDriverError {
  return Object.freeze({ _tag: "DirectEffectDriverError", code, message, reason });
}

interface Sleeper {
  readonly deadline: number;
  readonly sequence: number;
  readonly wake: () => void;
}

/** Internal clock and scheduler. All time is stored in the existing logical runtime. */
export function createDeadlineControl(
  runtime: LogicalRuntime,
  maxSteps: number,
  report: (error: DirectEffectDriverError) => void,
) {
  let expectedTime = runtime.now();
  let sequence = 0;
  let draining = false;
  let advancing = false;
  let automaticQueued = false;
  let paused = false;
  let turnSteps = 0;
  const sleepers = new Set<Sleeper>();
  const tasks: { readonly task: Scheduler.Task; readonly priority: number; readonly sequence: number }[] = [];

  const drain = (): Result<number, DirectEffectDriverError> => {
    if (draining) return ok(0);
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
        if (next === undefined) break;
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

  const scheduler: Scheduler.Scheduler = {
    shouldYield: fiber => Scheduler.defaultScheduler.shouldYield(fiber),
    scheduleTask: (task, priority) => {
      tasks.push({ task, priority, sequence: sequence++ });
      if (!automaticQueued && !paused && !draining && !advancing) {
        automaticQueued = true;
        queueMicrotask(() => {
          automaticQueued = false;
          if (!paused) drain();
        });
      }
    },
  };

  const clock: Clock.Clock = {
    [Clock.ClockTypeId]: Clock.ClockTypeId,
    unsafeCurrentTimeMillis: () => runtime.now(),
    unsafeCurrentTimeNanos: () => BigInt(runtime.now()) * 1_000_000n,
    currentTimeMillis: Effect.sync(() => runtime.now()),
    currentTimeNanos: Effect.sync(() => BigInt(runtime.now()) * 1_000_000n),
    sleep: input => Effect.suspend(() => {
      const decoded = Duration.toMillis(input);
      if (decoded === Infinity) return Effect.never;
      const duration = Math.ceil(decoded);
      const deadline = runtime.now() + duration;
      if (!Number.isSafeInteger(duration) || duration < 0 || !Number.isSafeInteger(deadline)) {
        return Effect.die(driverError("invalid-duration", "Deadline sleep requires safe non-negative integer milliseconds"));
      }
      if (duration === 0) return Effect.void;
      return Effect.async<void>(resume => {
        const sleeper: Sleeper = {
          deadline,
          sequence: sequence++,
          wake: () => resume(Effect.void),
        };
        sleepers.add(sleeper);
        return Effect.sync(() => { sleepers.delete(sleeper); });
      });
    }),
  };

  const advance = (milliseconds: number): Result<number, DirectEffectDriverError> => {
    if (advancing || draining) return err(driverError("reentrant-advance", "Advance must run outside an Effect continuation"));
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
      if (!initial.ok) return initial;
      while (true) {
        const next = [...sleepers]
          .filter(sleeper => sleeper.deadline <= target)
          .sort((left, right) => left.deadline - right.deadline || left.sequence - right.sequence)[0];
        if (next === undefined) break;
        if (turnSteps >= maxSteps) {
          const failure = driverError("step-limit", `Deadline wake budget exceeded ${String(maxSteps)} steps`);
          report(failure);
          return err(failure);
        }
        turnSteps += 1;
        const advanced = runtime.advance(next.deadline - runtime.now());
        if (!advanced.ok) return err(driverError("invalid-duration", advanced.error.message, advanced.error));
        expectedTime = advanced.value;
        sleepers.delete(next);
        next.wake();
        const drained = drain();
        if (!drained.ok) return drained;
      }
      const advanced = runtime.advance(target - runtime.now());
      if (!advanced.ok) return err(driverError("invalid-duration", advanced.error.message, advanced.error));
      expectedTime = advanced.value;
      return ok(expectedTime);
    } finally {
      advancing = false;
    }
  };

  return { clock, scheduler, advance, drain, pending: () => tasks.length, sleeps: () => sleepers.size };
}
