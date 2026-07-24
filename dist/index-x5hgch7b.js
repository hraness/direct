import {
  cloneJson,
  err,
  ok,
  parseAndCloneWorld,
  parseOperationId,
  renderUnknownReason
} from "./index-541zzq54.js";

// src/core/store.ts
function storeError(code, message, operation = null) {
  return { code, message, operation };
}
function generation(value) {
  return value;
}
function activity(active, started, settled) {
  return Object.freeze({ active, started, settled });
}
function storeSnapshot(currentGeneration, revision, world, currentActivity) {
  return Object.freeze({ generation: currentGeneration, revision, world, activity: currentActivity });
}
function isPromiseLike(value) {
  return (typeof value === "object" && value !== null || typeof value === "function") && typeof Reflect.get(value, "then") === "function";
}
function createDirectStore(initialWorld, parseWorld, options = {}) {
  const initial = parseAndCloneWorld(initialWorld, parseWorld);
  if (!initial.ok) {
    return err(storeError("invalid-world", initial.error.message));
  }
  let currentGeneration = generation(1);
  let revision = 0;
  let currentActivity = activity(0, 0, 0);
  let snapshot = storeSnapshot(currentGeneration, revision, initial.value, currentActivity);
  const listeners = new Set;
  const activeOperations = new Set;
  const onListenerError = options.onListenerError;
  const reportListenerError = (reason) => {
    if (onListenerError === undefined)
      return;
    try {
      const returned = onListenerError(reason);
      if (isPromiseLike(returned)) {
        Promise.resolve(returned).catch(() => {
          return;
        });
      }
    } catch {}
  };
  const publish = (world = snapshot.world) => {
    revision += 1;
    const committed = storeSnapshot(currentGeneration, revision, world, currentActivity);
    snapshot = committed;
    for (const listener of [...listeners]) {
      try {
        const returned = listener();
        if (isPromiseLike(returned)) {
          Promise.resolve(returned).catch(reportListenerError);
        }
      } catch (reason) {
        reportListenerError(reason);
      }
    }
    return committed;
  };
  const stale = (expected, operation = null) => expected === currentGeneration ? null : storeError("stale-generation", `Generation ${String(expected)} is stale; current generation is ${String(currentGeneration)}`, operation);
  const validateOperation = (candidate) => {
    const parsed = parseOperationId(candidate);
    return parsed.ok ? ok(parsed.value) : err(storeError("invalid-operation", parsed.error.message));
  };
  const settleActivity = (expected, candidate) => {
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
    currentActivity = activity(currentActivity.active - 1, currentActivity.started, currentActivity.settled + 1);
    return ok(publish());
  };
  const store = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
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
      let candidateWorld;
      try {
        const draft = cloned.value;
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
        return err(storeError("transaction-conflict", `Store revision changed during transaction ${operation.value}`, operation.value));
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
      currentActivity = activity(currentActivity.active + 1, currentActivity.started + 1, currentActivity.settled);
      publish();
      const lease = Object.freeze({
        generation: expected,
        operation: operation.value,
        settle: () => settleActivity(expected, operation.value)
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
    }
  };
  return ok(Object.freeze(store));
}

export { createDirectStore };
