import { parseOperationId, type OperationId } from "./ids.js";
import { parseJsonValue } from "./json.js";
import { renderUnknownReason } from "./reason.js";
import { err, isRecord, ok, type Result } from "./result.js";

export const LOGICAL_RUNTIME_SCHEMA = "direct.runtime/v1" as const;
export const MAX_HOST_TIMER_MILLISECONDS = 2_147_483_647;

export interface LogicalRuntimeSnapshot {
  readonly schema: typeof LOGICAL_RUNTIME_SCHEMA;
  readonly nowMs: number;
  readonly nextOperation: number;
  readonly acceleration: number;
}

export const DEFAULT_LOGICAL_RUNTIME_SNAPSHOT = Object.freeze({
  schema: LOGICAL_RUNTIME_SCHEMA,
  nowMs: 0,
  nextOperation: 1,
  acceleration: 100,
}) satisfies LogicalRuntimeSnapshot;

export type RuntimeErrorCode =
  | "invalid-duration"
  | "invalid-runtime"
  | "sleep-failed"
  | "time-overflow"
  | "wait-cancelled";

export interface RuntimeError {
  readonly code: RuntimeErrorCode;
  readonly message: string;
}

export type LogicalSleep = (wallMilliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface LogicalRuntime {
  readonly now: () => number;
  readonly snapshot: () => LogicalRuntimeSnapshot;
  readonly nextOperationId: (namespace?: string) => OperationId;
  readonly advance: (logicalMilliseconds: number) => Result<number, RuntimeError>;
  readonly wait: (
    logicalMilliseconds: number,
    signal?: AbortSignal,
  ) => Promise<Result<number, RuntimeError>>;
}

const RUNTIME_KEYS = new Set(["schema", "nowMs", "nextOperation", "acceleration"]);
const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export function parseLogicalRuntimeSnapshot(input: unknown): Result<LogicalRuntimeSnapshot, RuntimeError> {
  const parsedJson = parseJsonValue(input);
  if (!parsedJson.ok || !isRecord(parsedJson.value)) {
    return err({ code: "invalid-runtime", message: "Logical runtime must be an object" });
  }
  for (const key of Object.keys(parsedJson.value)) {
    if (!RUNTIME_KEYS.has(key)) {
      return err({ code: "invalid-runtime", message: `Unknown logical runtime key: ${key}` });
    }
  }
  const record = parsedJson.value;
  if (record.schema !== LOGICAL_RUNTIME_SCHEMA) {
    return err({ code: "invalid-runtime", message: `Logical runtime schema must be ${LOGICAL_RUNTIME_SCHEMA}` });
  }
  if (typeof record.nowMs !== "number" || !Number.isSafeInteger(record.nowMs) || record.nowMs < 0) {
    return err({ code: "invalid-runtime", message: "Logical nowMs must be a non-negative safe integer" });
  }
  if (
    typeof record.nextOperation !== "number"
    || !Number.isSafeInteger(record.nextOperation)
    || record.nextOperation < 1
  ) {
    return err({ code: "invalid-runtime", message: "Logical nextOperation must be a positive safe integer" });
  }
  if (
    typeof record.acceleration !== "number"
    || !Number.isFinite(record.acceleration)
    || record.acceleration < 1
    || record.acceleration > 1_000_000
  ) {
    return err({ code: "invalid-runtime", message: "Logical acceleration must be in [1, 1000000]" });
  }
  return ok(Object.freeze({
    schema: LOGICAL_RUNTIME_SCHEMA,
    nowMs: record.nowMs,
    nextOperation: record.nextOperation,
    acceleration: record.acceleration,
  }));
}

function sleepTimerChunk(wallMilliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
    timeout = setTimeout(finish, wallMilliseconds);
  });
}

async function defaultSleep(wallMilliseconds: number, signal?: AbortSignal): Promise<void> {
  let remaining = wallMilliseconds;
  while (remaining > 0 && signal?.aborted !== true) {
    const chunk = Math.min(remaining, MAX_HOST_TIMER_MILLISECONDS);
    await sleepTimerChunk(chunk, signal);
    remaining -= chunk;
  }
}

function parseDuration(logicalMilliseconds: number): Result<number, RuntimeError> {
  return Number.isSafeInteger(logicalMilliseconds) && logicalMilliseconds >= 0
    ? ok(logicalMilliseconds)
    : err({ code: "invalid-duration", message: "Logical durations must be non-negative safe integers" });
}

function isWaitCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function waitCancelled(): Result<never, RuntimeError> {
  return err({
    code: "wait-cancelled",
    message: "Logical wait was cancelled",
  });
}

function nextLogicalTime(nowMs: number, duration: number): Result<number, RuntimeError> {
  const nextNow = nowMs + duration;
  return Number.isSafeInteger(nextNow)
    ? ok(nextNow)
    : err({ code: "time-overflow", message: "Logical time exceeds the safe integer range" });
}

export function createLogicalRuntime(
  initial: LogicalRuntimeSnapshot = DEFAULT_LOGICAL_RUNTIME_SNAPSHOT,
  sleep: LogicalSleep = defaultSleep,
): LogicalRuntime {
  const parsed = parseLogicalRuntimeSnapshot(initial);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  let nowMs = parsed.value.nowMs;
  let nextOperation = parsed.value.nextOperation;
  const acceleration = parsed.value.acceleration;
  let waitTail = Promise.resolve();

  const snapshot = (): LogicalRuntimeSnapshot => Object.freeze({
    schema: LOGICAL_RUNTIME_SCHEMA,
    nowMs,
    nextOperation,
    acceleration,
  });

  const advance = (logicalMilliseconds: number): Result<number, RuntimeError> => {
    const duration = parseDuration(logicalMilliseconds);
    if (!duration.ok) {
      return duration;
    }
    const nextNow = nextLogicalTime(nowMs, duration.value);
    if (!nextNow.ok) {
      return nextNow;
    }
    nowMs = nextNow.value;
    return ok(nowMs);
  };

  const wait = (
    logicalMilliseconds: number,
    signal?: AbortSignal,
  ): Promise<Result<number, RuntimeError>> => {
    const duration = parseDuration(logicalMilliseconds);
    if (!duration.ok) {
      return Promise.resolve(duration);
    }
    const run = waitTail.then(async () => {
      if (isWaitCancelled(signal)) return waitCancelled();
      const target = nextLogicalTime(nowMs, duration.value);
      if (!target.ok) return target;
      const wallMilliseconds = Math.ceil(duration.value / acceleration);
      try {
        if (wallMilliseconds > 0) {
          await sleep(wallMilliseconds, signal);
        }
      } catch (reason) {
        if (isWaitCancelled(signal)) return waitCancelled();
        return err<RuntimeError>({
          code: "sleep-failed",
          message: renderUnknownReason(reason, "Logical sleep failed"),
        });
      }
      if (isWaitCancelled(signal)) return waitCancelled();
      return advance(duration.value);
    });
    waitTail = run.then(() => undefined, () => undefined);
    return run;
  };

  return Object.freeze({
    now: () => nowMs,
    snapshot,
    nextOperationId: (namespace = "operation") => {
      if (!NAMESPACE_PATTERN.test(namespace) || namespace.length > 48) {
        throw new Error("Operation namespaces must be lowercase hyphen-separated ASCII identifiers");
      }
      if (!Number.isSafeInteger(nextOperation) || nextOperation >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Operation sequence exceeds the safe integer range");
      }
      const candidate = `${namespace}-${String(nextOperation).padStart(6, "0")}`;
      nextOperation += 1;
      const parsedOperation = parseOperationId(candidate);
      if (!parsedOperation.ok) {
        throw new Error(parsedOperation.error.message);
      }
      return parsedOperation.value;
    },
    advance,
    wait,
  });
}
