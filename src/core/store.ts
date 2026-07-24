import { parseOperationId, type OperationId } from "./ids.js";
import { cloneJson, parseAndCloneWorld, type WorldParser } from "./json.js";
import type { JsonValue } from "./json-value.js";
import { renderUnknownReason } from "./reason.js";
import { err, ok, type Result } from "./result.js";

declare const generationBrand: unique symbol;
export type StoreGeneration = number & { readonly [generationBrand]: "StoreGeneration" };

export interface ActivitySnapshot {
  readonly active: number;
  readonly started: number;
  readonly settled: number;
}

export interface DirectStoreSnapshot<World extends JsonValue> {
  readonly generation: StoreGeneration;
  readonly revision: number;
  readonly world: World;
  readonly activity: ActivitySnapshot;
}

export type StoreErrorCode =
  | "activity-not-found"
  | "duplicate-activity"
  | "generation-overflow"
  | "invalid-operation"
  | "invalid-world"
  | "stale-generation"
  | "transaction-conflict"
  | "transaction-failed";

export interface StoreError {
  readonly code: StoreErrorCode;
  readonly message: string;
  readonly operation: OperationId | null;
}

export interface TypedActivityLease<World extends JsonValue> {
  readonly generation: StoreGeneration;
  readonly operation: OperationId;
  readonly settle: () => Result<DirectStoreSnapshot<World>, StoreError>;
}

export interface DirectStore<World extends JsonValue> {
  readonly getSnapshot: () => DirectStoreSnapshot<World>;
  readonly subscribe: (listener: () => void | PromiseLike<void>) => () => void;
  readonly transact: (
    generation: StoreGeneration,
    operation: OperationId,
    update: (draft: World) => World | void,
  ) => Result<DirectStoreSnapshot<World>, StoreError>;
  readonly reset: (world: World) => Result<DirectStoreSnapshot<World>, StoreError>;
  readonly beginActivity: (
    generation: StoreGeneration,
    operation: OperationId,
  ) => Result<TypedActivityLease<World>, StoreError>;
  readonly settleActivity: (
    generation: StoreGeneration,
    operation: OperationId,
  ) => Result<DirectStoreSnapshot<World>, StoreError>;
  readonly isQuiescent: (generation: StoreGeneration) => Result<boolean, StoreError>;
  readonly whenQuiescent: (
    generation: StoreGeneration,
  ) => Promise<Result<DirectStoreSnapshot<World>, StoreError>>;
}

export interface DirectStoreOptions {
  /** Listener failures are isolated from committed state and reported here. */
  readonly onListenerError?: (reason: unknown) => void;
}

function storeError(code: StoreErrorCode, message: string, operation: OperationId | null = null): StoreError {
  return { code, message, operation };
}

function generation(value: number): StoreGeneration {
  return value as StoreGeneration;
}

function activity(active: number, started: number, settled: number): ActivitySnapshot {
  return Object.freeze({ active, started, settled });
}

function storeSnapshot<World extends JsonValue>(
  currentGeneration: StoreGeneration,
  revision: number,
  world: World,
  currentActivity: ActivitySnapshot,
): DirectStoreSnapshot<World> {
  return Object.freeze({ generation: currentGeneration, revision, world, activity: currentActivity });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof Reflect.get(value, "then") === "function";
}

export function createDirectStore<World extends JsonValue>(
  initialWorld: World,
  parseWorld: WorldParser<World>,
  options: DirectStoreOptions = {},
): Result<DirectStore<World>, StoreError> {
  const initial = parseAndCloneWorld(initialWorld, parseWorld);
  if (!initial.ok) {
    return err(storeError("invalid-world", initial.error.message));
  }

  let currentGeneration = generation(1);
  let revision = 0;
  let currentActivity = activity(0, 0, 0);
  let snapshot = storeSnapshot(currentGeneration, revision, initial.value, currentActivity);
  const listeners = new Set<() => void | PromiseLike<void>>();
  const activeOperations = new Set<OperationId>();
  const onListenerError = options.onListenerError;

  const reportListenerError = (reason: unknown): void => {
    if (onListenerError === undefined) return;
    try {
      const returned: unknown = onListenerError(reason);
      if (isPromiseLike(returned)) {
        void Promise.resolve(returned).catch(() => undefined);
      }
    } catch {
      // A reporter is another listener boundary and cannot roll back committed state.
    }
  };

  const publish = (world: World = snapshot.world): DirectStoreSnapshot<World> => {
    revision += 1;
    const committed = storeSnapshot(currentGeneration, revision, world, currentActivity);
    snapshot = committed;
    for (const listener of [...listeners]) {
      try {
        const returned: unknown = listener();
        if (isPromiseLike(returned)) {
          void Promise.resolve(returned).catch(reportListenerError);
        }
      } catch (reason) {
        reportListenerError(reason);
      }
    }
    return committed;
  };

  const stale = (expected: StoreGeneration, operation: OperationId | null = null): StoreError | null => (
    expected === currentGeneration
      ? null
      : storeError(
        "stale-generation",
        `Generation ${String(expected)} is stale; current generation is ${String(currentGeneration)}`,
        operation,
      )
  );

  const validateOperation = (candidate: OperationId): Result<OperationId, StoreError> => {
    const parsed = parseOperationId(candidate);
    return parsed.ok
      ? ok(parsed.value)
      : err(storeError("invalid-operation", parsed.error.message));
  };

  const settleActivity = (
    expected: StoreGeneration,
    candidate: OperationId,
  ): Result<DirectStoreSnapshot<World>, StoreError> => {
    const operation = validateOperation(candidate);
    if (!operation.ok) {
      return operation;
    }
    const staleError = stale(expected, operation.value);
    if (staleError !== null) {
      return err(staleError);
    }
    if (!activeOperations.delete(operation.value)) {
      return err(storeError("activity-not-found", `Activity is not active: ${operation.value}`, operation.value));
    }
    currentActivity = activity(
      currentActivity.active - 1,
      currentActivity.started,
      currentActivity.settled + 1,
    );
    return ok(publish());
  };

  const store: DirectStore<World> = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void | PromiseLike<void>) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    transact: (expected, candidate, update) => {
      const operation = validateOperation(candidate);
      if (!operation.ok) {
        return operation;
      }
      const staleError = stale(expected, operation.value);
      if (staleError !== null) {
        return err(staleError);
      }
      const baseSnapshot = snapshot;
      const cloned = cloneJson(snapshot.world);
      if (!cloned.ok) {
        return err(storeError("invalid-world", cloned.error.message, operation.value));
      }
      let candidateWorld: World;
      try {
        // The current snapshot already passed parseWorld. Its JSON clone is an
        // owned mutable draft and cannot alias a value returned by the parser.
        const draft = cloned.value as World;
        const returned = update(draft);
        candidateWorld = returned === undefined ? draft : returned;
      } catch (reason) {
        return err(storeError("transaction-failed", renderUnknownReason(reason), operation.value));
      }
      const validated = parseAndCloneWorld(candidateWorld, parseWorld);
      if (!validated.ok) {
        return err(storeError("invalid-world", validated.error.message, operation.value));
      }
      const nextStaleError = stale(expected, operation.value);
      if (nextStaleError !== null) {
        return err(nextStaleError);
      }
      if (snapshot !== baseSnapshot) {
        return err(storeError(
          "transaction-conflict",
          `Store revision changed during transaction ${operation.value}`,
          operation.value,
        ));
      }
      return ok(publish(validated.value));
    },
    reset: (world) => {
      const validated = parseAndCloneWorld(world, parseWorld);
      if (!validated.ok) {
        return err(storeError("invalid-world", validated.error.message));
      }
      const nextGeneration = Number(currentGeneration) + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        return err(storeError("generation-overflow", "Store generation exceeds the safe integer range"));
      }
      currentGeneration = generation(nextGeneration);
      activeOperations.clear();
      currentActivity = activity(0, 0, 0);
      return ok(publish(validated.value));
    },
    beginActivity: (expected, candidate) => {
      const operation = validateOperation(candidate);
      if (!operation.ok) {
        return operation;
      }
      const staleError = stale(expected, operation.value);
      if (staleError !== null) {
        return err(staleError);
      }
      if (activeOperations.has(operation.value)) {
        return err(storeError("duplicate-activity", `Activity is already active: ${operation.value}`, operation.value));
      }
      activeOperations.add(operation.value);
      currentActivity = activity(
        currentActivity.active + 1,
        currentActivity.started + 1,
        currentActivity.settled,
      );
      publish();
      const lease: TypedActivityLease<World> = Object.freeze({
        generation: expected,
        operation: operation.value,
        settle: () => settleActivity(expected, operation.value),
      });
      return ok(lease);
    },
    settleActivity,
    isQuiescent: (expected) => {
      const staleError = stale(expected);
      return staleError === null ? ok(currentActivity.active === 0) : err(staleError);
    },
    whenQuiescent: (expected) => {
      const staleError = stale(expected);
      if (staleError !== null) {
        return Promise.resolve(err(staleError));
      }
      if (currentActivity.active === 0) {
        return Promise.resolve(ok(snapshot));
      }
      return new Promise((resolve) => {
        const unsubscribe = store.subscribe(() => {
          const nextStaleError = stale(expected);
          if (nextStaleError !== null) {
            unsubscribe();
            resolve(err(nextStaleError));
          } else if (currentActivity.active === 0) {
            unsubscribe();
            resolve(ok(snapshot));
          }
        });
      });
    },
  };

  return ok(Object.freeze(store));
}
