import type { JsonValue } from "../core/json-value.js";
import type { LogicalRuntime } from "../core/runtime.js";
import type {
  DirectStore,
  StoreError,
  StoreGeneration,
} from "../core/store.js";
import type { OperationId } from "../core/ids.js";
import { renderUnknownReason } from "../core/reason.js";
import { err, ok, type Result } from "../core/result.js";

export type DirectActivityScopeError =
  | {
    readonly code: "scope-closed";
    readonly message: string;
    readonly operation: null;
    readonly storeError: null;
    readonly reason: null;
  }
  | {
    readonly code: "operation-id-failed";
    readonly message: string;
    readonly operation: null;
    readonly storeError: null;
    readonly reason: unknown;
  }
  | {
    readonly code: "store-begin-failed" | "store-settle-failed";
    readonly message: string;
    readonly operation: OperationId;
    readonly storeError: StoreError;
    readonly reason: null;
  };

export type DirectActivityRunError =
  | {
    readonly code: "begin-failed";
    readonly message: string;
    readonly operation: null;
    readonly workError: null;
    readonly activityError: DirectActivityScopeError;
  }
  | {
    readonly code: "work-failed";
    readonly message: string;
    readonly operation: OperationId;
    readonly workError: unknown;
    readonly activityError: null;
  }
  | {
    readonly code: "settlement-failed";
    readonly message: string;
    readonly operation: OperationId;
    readonly workError: null;
    readonly activityError: DirectActivityScopeError;
  }
  | {
    readonly code: "work-and-settlement-failed";
    readonly message: string;
    readonly operation: OperationId;
    readonly workError: unknown;
    readonly activityError: DirectActivityScopeError;
  };

export interface DirectActivityLease {
  readonly generation: StoreGeneration;
  readonly operation: OperationId;
  /** Settle once. Later calls return the first settlement result unchanged. */
  readonly release: () => Result<true, DirectActivityScopeError>;
  readonly isReleased: () => boolean;
}

export interface DirectActivityScope {
  readonly begin: (namespace?: string) => Result<DirectActivityLease, DirectActivityScopeError>;
  readonly run: <Value>(
    namespace: string,
    work: () => Value | PromiseLike<Value>,
  ) => Promise<Result<Value, DirectActivityRunError>>;
}

export interface DirectActivityScopeOptions {
  /** Fence new activity once the owning composition has been aborted. */
  readonly signal?: AbortSignal;
}

function storeErrorMessage(cause: StoreError): string {
  return renderUnknownReason(cause, "Direct store operation failed");
}

function operationError(reason: unknown): DirectActivityScopeError {
  return Object.freeze({
    code: "operation-id-failed",
    message: renderUnknownReason(reason),
    operation: null,
    storeError: null,
    reason,
  });
}

function closedScopeError(): DirectActivityScopeError {
  return Object.freeze({
    code: "scope-closed",
    message: "The Direct activity scope is closed",
    operation: null,
    storeError: null,
    reason: null,
  });
}

function storeError(
  code: "store-begin-failed" | "store-settle-failed",
  operation: OperationId,
  cause: StoreError,
): DirectActivityScopeError {
  return Object.freeze({
    code,
    message: storeErrorMessage(cause),
    operation,
    storeError: cause,
    reason: null,
  });
}

/**
 * Couple deterministic operation IDs to the store's generation-fenced activity
 * ledger. A lease owns exactly one settlement attempt, including a failed one.
 */
export function createDirectActivityScope<World extends JsonValue>(
  store: DirectStore<World>,
  runtime: LogicalRuntime,
  options: DirectActivityScopeOptions = {},
): DirectActivityScope {
  const signal = options.signal;
  const isClosed = (): boolean => signal?.aborted === true;
  const begin = (namespace = "activity"): Result<DirectActivityLease, DirectActivityScopeError> => {
    if (isClosed()) return err(closedScopeError());
    let operation: OperationId;
    try {
      operation = runtime.nextOperationId(namespace);
    } catch (reason) {
      return err(operationError(reason));
    }
    if (isClosed()) return err(closedScopeError());

    const currentGeneration = store.getSnapshot().generation;
    const started = store.beginActivity(currentGeneration, operation);
    if (!started.ok) {
      return err(storeError("store-begin-failed", operation, started.error));
    }
    if (isClosed()) {
      const settled = started.value.settle();
      return settled.ok
        ? err(closedScopeError())
        : err(storeError("store-settle-failed", operation, settled.error));
    }

    let released = false;
    let releaseResult: Result<true, DirectActivityScopeError> | null = null;
    const lease: DirectActivityLease = Object.freeze({
      generation: currentGeneration,
      operation,
      isReleased: () => released,
      release: () => {
        if (releaseResult !== null) return releaseResult;
        released = true;
        const settled = started.value.settle();
        releaseResult = settled.ok
          ? ok<true>(true)
          : err(storeError("store-settle-failed", operation, settled.error));
        return releaseResult;
      },
    });
    return ok(lease);
  };

  const run: DirectActivityScope["run"] = async (namespace, work) => {
    const started = begin(namespace);
    if (!started.ok) {
      return err(Object.freeze({
        code: "begin-failed",
        message: started.error.message,
        operation: null,
        workError: null,
        activityError: started.error,
      }));
    }

    let workResult: Result<Awaited<ReturnType<typeof work>>, unknown>;
    try {
      workResult = ok(await work());
    } catch (reason) {
      workResult = err(reason);
    }
    const released = started.value.release();

    if (workResult.ok && released.ok) return ok(workResult.value);
    if (!workResult.ok && released.ok) {
      return err(Object.freeze({
        code: "work-failed",
        message: renderUnknownReason(workResult.error),
        operation: started.value.operation,
        workError: workResult.error,
        activityError: null,
      }));
    }
    if (workResult.ok && !released.ok) {
      return err(Object.freeze({
        code: "settlement-failed",
        message: released.error.message,
        operation: started.value.operation,
        workError: null,
        activityError: released.error,
      }));
    }
    if (!workResult.ok && !released.ok) {
      return err(Object.freeze({
        code: "work-and-settlement-failed",
        message: `${renderUnknownReason(workResult.error)}; settlement failed: ${released.error.message}`,
        operation: started.value.operation,
        workError: workResult.error,
        activityError: released.error,
      }));
    }
    throw new Error("Unreachable activity result");
  };

  return Object.freeze({ begin, run });
}
