import { cloneJson, freezeJson, parseJsonValue } from "../core/json.js";
import type { JsonValue } from "../core/json-value.js";
import { renderUnknownReason } from "../core/reason.js";
import { err, isRecord, ok, type Result } from "../core/result.js";
import type { ActivitySnapshot, DirectStore } from "../core/store.js";

export const DIRECT_PROBE_SCHEMA = "direct.probe/v1" as const;
export const MAX_DIRECT_PROBE_COUNTERS = 128;

export interface DirectCounterSource {
  readonly name: string;
  /** Foreign counter reads are validated on every snapshot. */
  readonly read: () => number;
}

export interface DirectProbeSnapshot {
  readonly schema: typeof DIRECT_PROBE_SCHEMA;
  readonly activationHash: string;
  readonly generation: number;
  readonly revision: number;
  readonly activity: ActivitySnapshot;
  readonly pending: Readonly<Record<string, number>>;
  readonly violations: Readonly<Record<string, number>>;
  /** Diagnostic only: remaining scripted work does not prevent quiescence. */
  readonly remainingWork: JsonValue;
  readonly isQuiescent: boolean;
}

export type DirectProbeErrorCode =
  | "asynchronous-read"
  | "duplicate-counter"
  | "invalid-activation-hash"
  | "invalid-counter"
  | "invalid-counter-name"
  | "invalid-counter-source"
  | "invalid-options"
  | "invalid-remaining-work"
  | "invalid-snapshot"
  | "probe-read-failed"
  | "too-many-counters";

export interface DirectProbeError {
  readonly code: DirectProbeErrorCode;
  readonly message: string;
  readonly counter: string | null;
}

export interface DirectProbe {
  readonly snapshot: () => Result<DirectProbeSnapshot, DirectProbeError>;
  readonly isQuiescent: () => Result<boolean, DirectProbeError>;
}

export interface DirectProbeOptions<World extends JsonValue> {
  readonly store: DirectStore<World>;
  readonly activationHash: string;
  readonly pending?: readonly DirectCounterSource[];
  readonly violations?: readonly DirectCounterSource[];
  readonly readRemainingWork?: () => JsonValue;
}

interface PreparedCounterSource extends DirectCounterSource {
  readonly category: "pending" | "violation";
}

function freezeCounterSources(
  sources: readonly DirectCounterSource[],
): readonly DirectCounterSource[] {
  return Object.freeze([...sources]);
}

const COUNTER_NAME_PATTERN = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/u;
const SNAPSHOT_KEYS = new Set([
  "schema",
  "activationHash",
  "generation",
  "revision",
  "activity",
  "pending",
  "violations",
  "remainingWork",
  "isQuiescent",
]);
const ACTIVITY_KEYS = new Set(["active", "started", "settled"]);

function probeError(
  code: DirectProbeErrorCode,
  message: string,
  counter: string | null = null,
): DirectProbeError {
  return Object.freeze({ code, message, counter });
}

function validActivationHash(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function readNonNegativeInteger(input: unknown): number | null {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
    ? input
    : null;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof Reflect.get(value, "then") === "function";
}

function containPromiseLike(value: unknown): boolean {
  if (!isPromiseLike(value)) return false;
  void Promise.resolve(value).catch(() => undefined);
  return true;
}

function parseSnapshotCounters(
  input: unknown,
  category: "pending" | "violation",
): Result<Readonly<Record<string, number>>, DirectProbeError> {
  if (!isRecord(input)) {
    return err(probeError("invalid-snapshot", `Probe ${category} counters must be an object`));
  }
  const output: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const [name, candidate] of Object.entries(input)) {
    if (name.length > 80 || !COUNTER_NAME_PATTERN.test(name)) {
      return err(probeError(
        "invalid-counter-name",
        "Counter names must be 1-80 ASCII alphanumeric characters with optional dots or hyphens",
        name,
      ));
    }
    const value = readNonNegativeInteger(candidate);
    if (value === null) {
      return err(probeError(
        "invalid-counter",
        `Counter ${name} must be a non-negative safe integer`,
        name,
      ));
    }
    output[name] = value;
  }
  return ok(Object.freeze(output));
}

/** Parse the versioned JSON value returned by a browser bridge from `unknown`. */
export function parseDirectProbeSnapshot(
  input: unknown,
): Result<DirectProbeSnapshot, DirectProbeError> {
  const parsed = parseJsonValue(input);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return err(probeError(
      "invalid-snapshot",
      parsed.ok ? "Direct probe snapshot must be an object" : parsed.error.message,
    ));
  }
  const record = parsed.value;
  for (const key of Object.keys(record)) {
    if (!SNAPSHOT_KEYS.has(key)) {
      return err(probeError("invalid-snapshot", `Unknown Direct probe snapshot key: ${key}`));
    }
  }
  if (record.schema !== DIRECT_PROBE_SCHEMA) {
    return err(probeError(
      "invalid-snapshot",
      `Direct probe schema must be ${DIRECT_PROBE_SCHEMA}`,
    ));
  }
  if (typeof record.activationHash !== "string" || !validActivationHash(record.activationHash)) {
    return err(probeError("invalid-activation-hash", "Direct probe activation hash is invalid"));
  }
  const generation = readNonNegativeInteger(record.generation);
  const revision = readNonNegativeInteger(record.revision);
  if (generation === null || generation < 1 || revision === null) {
    return err(probeError(
      "invalid-snapshot",
      "Direct probe generation must be positive and revision must be non-negative",
    ));
  }
  if (generation - 1 > revision) {
    return err(probeError(
      "invalid-snapshot",
      "Direct probe generation cannot exceed revision plus one",
    ));
  }
  if (!isRecord(record.activity)) {
    return err(probeError("invalid-snapshot", "Direct probe activity must be an object"));
  }
  for (const key of Object.keys(record.activity)) {
    if (!ACTIVITY_KEYS.has(key)) {
      return err(probeError("invalid-snapshot", `Unknown Direct activity key: ${key}`));
    }
  }
  const active = readNonNegativeInteger(record.activity.active);
  const started = readNonNegativeInteger(record.activity.started);
  const settled = readNonNegativeInteger(record.activity.settled);
  if (
    active === null
    || started === null
    || settled === null
    || settled > started
    || active !== started - settled
  ) {
    return err(probeError(
      "invalid-snapshot",
      "Direct activity counters must be non-negative and conserve started work",
    ));
  }
  if (started > revision || settled > revision - started) {
    return err(probeError(
      "invalid-snapshot",
      "Direct activity transitions cannot exceed the store revision",
    ));
  }
  const pending = parseSnapshotCounters(record.pending, "pending");
  if (!pending.ok) return pending;
  const violations = parseSnapshotCounters(record.violations, "violation");
  if (!violations.ok) return violations;
  if (Object.keys(pending.value).length + Object.keys(violations.value).length > MAX_DIRECT_PROBE_COUNTERS) {
    return err(probeError(
      "too-many-counters",
      `A probe supports at most ${String(MAX_DIRECT_PROBE_COUNTERS)} counters`,
    ));
  }
  if (record.remainingWork === undefined) {
    return err(probeError("invalid-snapshot", "Direct probe snapshot requires remainingWork"));
  }
  if (typeof record.isQuiescent !== "boolean") {
    return err(probeError("invalid-snapshot", "Direct probe isQuiescent must be boolean"));
  }
  const expectedQuiescence = active === 0
    && Object.values(pending.value).every((value) => value === 0);
  if (record.isQuiescent !== expectedQuiescence) {
    return err(probeError(
      "invalid-snapshot",
      "Direct probe isQuiescent does not match its activity and pending counters",
    ));
  }
  return ok(Object.freeze({
    schema: DIRECT_PROBE_SCHEMA,
    activationHash: record.activationHash,
    generation,
    revision,
    activity: Object.freeze({ active, started, settled }),
    pending: pending.value,
    violations: violations.value,
    remainingWork: freezeJson(record.remainingWork),
    isQuiescent: record.isQuiescent,
  }));
}

function prepareCountersUnchecked(
  pending: readonly DirectCounterSource[],
  violations: readonly DirectCounterSource[],
): Result<readonly PreparedCounterSource[], DirectProbeError> {
  if (pending.length + violations.length > MAX_DIRECT_PROBE_COUNTERS) {
    return err(probeError(
      "too-many-counters",
      `A probe supports at most ${String(MAX_DIRECT_PROBE_COUNTERS)} counters`,
    ));
  }
  const prepared: PreparedCounterSource[] = [];
  const seen = new Set<string>();
  for (const [category, sources] of [
    ["pending", pending],
    ["violation", violations],
  ] as const) {
    for (const source of sources) {
      const name = source.name;
      const read = source.read;
      if (typeof name !== "string" || name.length > 80 || !COUNTER_NAME_PATTERN.test(name)) {
        return err(probeError(
          "invalid-counter-name",
          "Counter names must be 1-80 ASCII alphanumeric characters with optional dots or hyphens",
          typeof name === "string" ? name : null,
        ));
      }
      if (typeof read !== "function") {
        return err(probeError(
          "invalid-counter-source",
          `Counter ${name} must provide a synchronous read function`,
          name,
        ));
      }
      const key = `${category}:${name}`;
      if (seen.has(key)) {
        return err(probeError("duplicate-counter", `Duplicate ${category} counter: ${name}`, name));
      }
      seen.add(key);
      prepared.push(Object.freeze({ name, read, category }));
    }
  }
  prepared.sort((left, right) => {
    const leftKey = `${left.category}:${left.name}`;
    const rightKey = `${right.category}:${right.name}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return ok(Object.freeze(prepared));
}

function prepareCounters(
  pending: readonly DirectCounterSource[],
  violations: readonly DirectCounterSource[],
): Result<readonly PreparedCounterSource[], DirectProbeError> {
  try {
    return prepareCountersUnchecked(pending, violations);
  } catch (reason) {
    return err(probeError(
      "invalid-counter-source",
      renderUnknownReason(reason, "Direct counter inspection failed"),
    ));
  }
}

function readCounters(
  sources: readonly PreparedCounterSource[],
): Result<{
  readonly pending: Readonly<Record<string, number>>;
  readonly violations: Readonly<Record<string, number>>;
}, DirectProbeError> {
  const pending: Record<string, number> = Object.create(null) as Record<string, number>;
  const violations: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const source of sources) {
    let value: unknown;
    try {
      value = source.read();
      if (containPromiseLike(value)) {
        return err(probeError(
          "asynchronous-read",
          `Counter ${source.name} must be read synchronously`,
          source.name,
        ));
      }
    } catch (reason) {
      return err(probeError(
        "probe-read-failed",
        renderUnknownReason(reason, `Failed to read ${source.name}`),
        source.name,
      ));
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return err(probeError(
        "invalid-counter",
        `Counter ${source.name} must be a non-negative safe integer`,
        source.name,
      ));
    }
    (source.category === "pending" ? pending : violations)[source.name] = value;
  }
  return ok({ pending: Object.freeze(pending), violations: Object.freeze(violations) });
}

function readRemaining(read: () => JsonValue): Result<JsonValue, DirectProbeError> {
  let candidate: unknown;
  try {
    candidate = read();
    if (containPromiseLike(candidate)) {
      return err(probeError(
        "asynchronous-read",
        "Remaining work must be read synchronously",
      ));
    }
  } catch (reason) {
    return err(probeError(
      "probe-read-failed",
      renderUnknownReason(reason, "Failed to read remaining work"),
    ));
  }
  const cloned = cloneJson(candidate);
  return cloned.ok
    ? ok(freezeJson(cloned.value))
    : err(probeError("invalid-remaining-work", cloned.error.message));
}

/** Build a stable, JSON-safe verifier view without publishing the product world. */
export function createDirectProbe<World extends JsonValue>(
  options: DirectProbeOptions<World>,
): Result<DirectProbe, DirectProbeError> {
  let store: DirectStore<World>;
  let activationHash: string;
  let pending: readonly DirectCounterSource[];
  let violations: readonly DirectCounterSource[];
  let readRemainingWork: () => JsonValue;
  try {
    store = options.store;
    activationHash = options.activationHash;
    const pendingInput = options.pending ?? [];
    const violationsInput = options.violations ?? [];
    readRemainingWork = options.readRemainingWork ?? (() => Object.freeze({}));
    if (!Array.isArray(pendingInput) || !Array.isArray(violationsInput)) {
      return err(probeError("invalid-options", "Direct probe counters must be arrays"));
    }
    if (typeof readRemainingWork !== "function") {
      return err(probeError("invalid-options", "Direct remaining-work reader must be a function"));
    }
    pending = freezeCounterSources(pendingInput);
    violations = freezeCounterSources(violationsInput);
  } catch (reason) {
    return err(probeError(
      "invalid-options",
      renderUnknownReason(reason, "Direct probe options could not be inspected"),
    ));
  }

  if (typeof activationHash !== "string" || !validActivationHash(activationHash)) {
    return err(probeError(
      "invalid-activation-hash",
      "Activation hashes must be 1-256 characters without control characters",
    ));
  }
  const counters = prepareCounters(pending, violations);
  if (!counters.ok) return counters;

  const snapshot = (): Result<DirectProbeSnapshot, DirectProbeError> => {
    const read = readCounters(counters.value);
    if (!read.ok) return read;
    const remaining = readRemaining(readRemainingWork);
    if (!remaining.ok) return remaining;
    const storeSnapshot = store.getSnapshot();
    const isQuiescent = storeSnapshot.activity.active === 0
      && Object.values(read.value.pending).every((value) => value === 0);
    const value = {
      schema: DIRECT_PROBE_SCHEMA,
      activationHash,
      generation: Number(storeSnapshot.generation),
      revision: storeSnapshot.revision,
      activity: storeSnapshot.activity,
      pending: read.value.pending,
      violations: read.value.violations,
      remainingWork: remaining.value,
      isQuiescent,
    } satisfies DirectProbeSnapshot;
    return ok(Object.freeze(value));
  };

  const probe: DirectProbe = {
    snapshot,
    isQuiescent: () => {
      const current = snapshot();
      return current.ok ? ok(current.value.isQuiescent) : current;
    },
  };
  return ok(Object.freeze(probe));
}
