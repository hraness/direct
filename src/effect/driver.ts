import { Cause, Effect, Exit, FiberId, Layer, ManagedRuntime, Scope, Supervisor } from "effect";
import type { OperationId } from "../core/ids.js";
import type { JsonValue } from "../core/json-value.js";
import type { Result } from "../core/result.js";
import type { DirectStoreSnapshot, StoreGeneration } from "../core/store.js";
import type { DirectActivityScopeError } from "../testing/activity.js";
import type { DirectSessionContext, DirectSessionObservation } from "../testing/session.js";
import { createDeadlineControl, driverError, type DirectEffectDriverError } from "./deadline.js";
import { DriverSupervisor } from "./supervisor.js";

export interface DirectEffectOperation<World extends JsonValue> {
  readonly generation: StoreGeneration;
  readonly operation: OperationId;
  readonly transact: (update: (draft: World) => World | void) => Effect.Effect<DirectStoreSnapshot<World>, DirectEffectDriverError>;
}

export interface DirectEffectCloseReport {
  readonly runtime: Exit.Exit<void>;
  readonly operationFailures: readonly Cause.Cause<unknown>[];
  readonly backgroundFailures: readonly Cause.Cause<unknown>[];
  /** Observed operation descendants; join/race/retry may have handled these exits. */
  readonly childFailures: readonly Cause.Cause<unknown>[];
  readonly settlementErrors: readonly DirectActivityScopeError[];
  readonly diagnostics: readonly DirectEffectDriverError[];
}

export interface DirectEffectDriverSnapshot {
  readonly clock: "deadline";
  readonly nowMs: number;
  readonly pendingOperations: number;
  readonly pendingContinuations: number;
  readonly pendingSleeps: number;
  readonly pendingFibers: number;
  readonly state: "open" | "closing" | "closed";
  readonly failures: number;
}

export interface DirectEffectDriver<World extends JsonValue, R, ER> {
  readonly runExit: <A, E>(namespace: string, program: (operation: DirectEffectOperation<World>) => Effect.Effect<A, E, R | Scope.Scope>) => Promise<Exit.Exit<A, E | ER | DirectEffectDriverError>>;
  readonly advance: (milliseconds: number) => Result<number, DirectEffectDriverError>;
  readonly drain: () => Result<number, DirectEffectDriverError>;
  readonly snapshot: () => DirectEffectDriverSnapshot;
  readonly observation: DirectSessionObservation;
  /** Synchronously fence admission and request interruption; await close for completion. */
  readonly interrupt: () => undefined;
  readonly close: () => Promise<DirectEffectCloseReport>;
}

export interface DirectEffectDriverOptions<World extends JsonValue, Route extends string, R, ER> {
  readonly context: DirectSessionContext<World, Route>;
  readonly layer: Layer.Layer<R, ER>;
  readonly clock: "deadline";
  readonly maxSteps?: number;
}

interface ActiveOperation {
  readonly generation: StoreGeneration;
  interrupt: () => void;
  readonly done: Promise<void>;
}

/** An opt-in asynchronous owner around one Direct session and one Effect Layer. */
export function createDirectEffectDriver<World extends JsonValue, Route extends string, R, ER>(
  options: DirectEffectDriverOptions<World, Route, R, ER>,
): DirectEffectDriver<World, R, ER> {
  const { context } = options;
  const maxSteps = options.maxSteps ?? 10_000;
  if (options.clock !== "deadline" || !Number.isSafeInteger(maxSteps) || maxSteps < 1) {
    throw new TypeError("Effect driver requires deadline mode and a positive safe step budget");
  }
  let state: DirectEffectDriverSnapshot["state"] = "open";
  const active = new Set<ActiveOperation>();
  const operationFailures: Cause.Cause<unknown>[] = [];
  const settlementErrors: DirectActivityScopeError[] = [];
  const diagnostics: DirectEffectDriverError[] = [];
  let runtimeFailure: Cause.Cause<never> | undefined;
  const control = createDeadlineControl(context.clock, maxSteps, failure => { diagnostics.push(failure); });
  const supervisor = new DriverSupervisor();
  const runtime = ManagedRuntime.make(options.layer.pipe(
    Layer.provide(Layer.mergeAll(
      Layer.setClock(control.clock), Layer.setScheduler(control.scheduler), Supervisor.addSupervisor(supervisor),
    )),
  ));

  const interrupt = (): undefined => {
    if (state === "closed") return;
    state = "closing";
    for (const operation of active) operation.interrupt();
  };
  const unsubscribe = context.store.subscribe(() => {
    const current = context.store.getSnapshot().generation;
    for (const operation of active) {
      if (operation.generation !== current) operation.interrupt();
    }
  });
  context.signal.addEventListener("abort", interrupt, { once: true });
  context.onDispose(interrupt);
  if (context.signal.aborted) interrupt();

  const runExit = <A, E>(
    namespace: string,
    program: (operation: DirectEffectOperation<World>) => Effect.Effect<A, E, R | Scope.Scope>,
  ): Promise<Exit.Exit<A, E | ER | DirectEffectDriverError>> => {
    if (state !== "open" || context.signal.aborted) {
      return Promise.resolve(Exit.fail(driverError("closed", "Effect driver is closed to new operations")));
    }
    const begun = context.activity.begin(namespace);
    if (!begun.ok) return Promise.resolve(Exit.fail(driverError("activity-failed", begun.error.message, begun.error)));
    const lease = begun.value;
    let settled = false;
    let resolveDone: () => void = () => undefined;
    const entry: ActiveOperation = {
      generation: lease.generation,
      interrupt: () => undefined,
      done: new Promise<void>(resolve => { resolveDone = resolve; }),
    };
    active.add(entry);
    const operation: DirectEffectOperation<World> = Object.freeze({
      generation: lease.generation,
      operation: lease.operation,
      transact: (update: (draft: World) => World | void) => Effect.suspend(() => {
        let failure: DirectEffectDriverError | undefined;
        if (context.store.getSnapshot().generation !== lease.generation) {
          failure = driverError("stale-generation", "Operation belongs to an earlier Direct generation");
        } else if (settled) {
          failure = driverError("operation-settled", "Operation has already settled");
        } else if (state !== "open" || context.signal.aborted) {
          failure = driverError("closed", "Operation owner is closing");
        }
        if (failure !== undefined) {
          diagnostics.push(failure);
          return Effect.fail(failure);
        }
        const result = context.store.transact(lease.generation, lease.operation, update);
        return result.ok ? Effect.succeed(result.value) : Effect.fail(driverError("store-failed", result.error.message, result.error));
      }),
    });
    const fiber = runtime.runFork(Effect.scoped(Effect.suspend(() => program(operation))), {
      scheduler: control.scheduler,
      immediate: false,
    });
    supervisor.registerRoot(fiber);
    entry.interrupt = () => { fiber.unsafeInterruptAsFork(FiberId.none); };
    if (state !== "open" || context.signal.aborted || context.store.getSnapshot().generation !== lease.generation) entry.interrupt();
    return new Promise(resolve => {
      fiber.addObserver(exit => {
        settled = true;
        if (Exit.isFailure(exit)) operationFailures.push(exit.cause);
        const released = lease.release();
        // Reset deliberately clears the old ledger; this is an expected stale settlement.
        const settlementError = !released.ok && released.error.storeError?.code !== "stale-generation"
          ? released.error : undefined;
        if (settlementError !== undefined) settlementErrors.push(settlementError);
        const failure = settlementError === undefined ? undefined
          : Cause.fail(driverError("activity-failed", settlementError.message, settlementError));
        const result: Exit.Exit<A, E | ER | DirectEffectDriverError> = failure === undefined ? exit
          : Exit.failCause(Exit.isFailure(exit) ? Cause.sequential(exit.cause, failure) : failure);
        active.delete(entry);
        supervisor.forgetRoot(fiber);
        resolveDone();
        resolve(result);
      });
      control.drain();
    });
  };

  let closing: Promise<DirectEffectCloseReport> | undefined;
  const close = (): Promise<DirectEffectCloseReport> => {
    if (closing !== undefined) return closing;
    interrupt();
    closing = (async () => {
      control.drain();
      await Promise.all([...active].map(operation => operation.done));
      const runtimeExit = await Effect.runPromiseExit(runtime.disposeEffect.pipe(
        Effect.withClock(control.clock), Effect.withScheduler(control.scheduler),
      ));
      if (Exit.isFailure(runtimeExit)) runtimeFailure = runtimeExit.cause;
      unsubscribe();
      context.signal.removeEventListener("abort", interrupt);
      state = "closed";
      return Object.freeze({
        runtime: runtimeExit,
        operationFailures: Object.freeze([...operationFailures]),
        backgroundFailures: Object.freeze(supervisor.backgroundFailures()),
        childFailures: Object.freeze(supervisor.childFailures()),
        settlementErrors: Object.freeze([...settlementErrors]),
        diagnostics: Object.freeze([...diagnostics]),
      });
    })();
    return closing;
  };
  const failures = (): number => diagnostics.length + settlementErrors.length
    + operationFailures.filter(cause => Cause.defects(cause).length > 0).length
    + supervisor.backgroundFailureCount()
    + (runtimeFailure === undefined ? 0 : 1);
  const snapshot = (): DirectEffectDriverSnapshot => Object.freeze({
    clock: "deadline", nowMs: context.clock.now(), pendingOperations: active.size,
    pendingContinuations: control.pending(), pendingSleeps: control.sleeps(), state, failures: failures(),
    pendingFibers: supervisor.pending(),
  });
  return Object.freeze({
    runExit, advance: control.advance, drain: control.drain, snapshot, interrupt, close,
    observation: Object.freeze({
      pending: [
        { name: "effect.operations", read: () => active.size },
        { name: "effect.continuations", read: control.pending },
        { name: "effect.fibers", read: () => supervisor.pending() },
        { name: "effect.close", read: () => state === "closing" ? 1 : 0 },
      ],
      violations: [{ name: "effect.failures", read: failures }],
    }),
  });
}
