import {
  cloneJson,
  err,
  freezeJson,
  isRecord,
  ok,
  parseJsonValue,
  renderUnknownReason
} from "./index-541zzq54.js";

// src/testing/probe.ts
var DIRECT_PROBE_SCHEMA = "direct.probe/v1";
var MAX_DIRECT_PROBE_COUNTERS = 128;
function freezeCounterSources(sources) {
  return Object.freeze([...sources]);
}
var COUNTER_NAME_PATTERN = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/u;
var SNAPSHOT_KEYS = new Set([
  "schema",
  "activationHash",
  "generation",
  "revision",
  "activity",
  "pending",
  "violations",
  "remainingWork",
  "isQuiescent"
]);
var ACTIVITY_KEYS = new Set(["active", "started", "settled"]);
function probeError(code, message, counter = null) {
  return Object.freeze({ code, message, counter });
}
function validActivationHash(value) {
  if (value.length === 0 || value.length > 256)
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127)
      return false;
  }
  return true;
}
function readNonNegativeInteger(input) {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : null;
}
function isPromiseLike(value) {
  return (typeof value === "object" && value !== null || typeof value === "function") && typeof Reflect.get(value, "then") === "function";
}
function containPromiseLike(value) {
  if (!isPromiseLike(value))
    return false;
  Promise.resolve(value).catch(() => {
    return;
  });
  return true;
}
function parseSnapshotCounters(input, category) {
  if (!isRecord(input)) {
    return err(probeError("invalid-snapshot", `Probe ${category} counters must be an object`));
  }
  const output = Object.create(null);
  for (const [name, candidate] of Object.entries(input)) {
    if (name.length > 80 || !COUNTER_NAME_PATTERN.test(name)) {
      return err(probeError("invalid-counter-name", "Counter names must be 1-80 ASCII alphanumeric characters with optional dots or hyphens", name));
    }
    const value = readNonNegativeInteger(candidate);
    if (value === null) {
      return err(probeError("invalid-counter", `Counter ${name} must be a non-negative safe integer`, name));
    }
    output[name] = value;
  }
  return ok(Object.freeze(output));
}
function parseDirectProbeSnapshot(input) {
  const parsed = parseJsonValue(input);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return err(probeError("invalid-snapshot", parsed.ok ? "Direct probe snapshot must be an object" : parsed.error.message));
  }
  const record = parsed.value;
  for (const key of Object.keys(record)) {
    if (!SNAPSHOT_KEYS.has(key)) {
      return err(probeError("invalid-snapshot", `Unknown Direct probe snapshot key: ${key}`));
    }
  }
  if (record.schema !== DIRECT_PROBE_SCHEMA) {
    return err(probeError("invalid-snapshot", `Direct probe schema must be ${DIRECT_PROBE_SCHEMA}`));
  }
  if (typeof record.activationHash !== "string" || !validActivationHash(record.activationHash)) {
    return err(probeError("invalid-activation-hash", "Direct probe activation hash is invalid"));
  }
  const generation = readNonNegativeInteger(record.generation);
  const revision = readNonNegativeInteger(record.revision);
  if (generation === null || generation < 1 || revision === null) {
    return err(probeError("invalid-snapshot", "Direct probe generation must be positive and revision must be non-negative"));
  }
  if (generation - 1 > revision) {
    return err(probeError("invalid-snapshot", "Direct probe generation cannot exceed revision plus one"));
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
  if (active === null || started === null || settled === null || settled > started || active !== started - settled) {
    return err(probeError("invalid-snapshot", "Direct activity counters must be non-negative and conserve started work"));
  }
  if (started > revision || settled > revision - started) {
    return err(probeError("invalid-snapshot", "Direct activity transitions cannot exceed the store revision"));
  }
  const pending = parseSnapshotCounters(record.pending, "pending");
  if (!pending.ok)
    return pending;
  const violations = parseSnapshotCounters(record.violations, "violation");
  if (!violations.ok)
    return violations;
  if (Object.keys(pending.value).length + Object.keys(violations.value).length > MAX_DIRECT_PROBE_COUNTERS) {
    return err(probeError("too-many-counters", `A probe supports at most ${String(MAX_DIRECT_PROBE_COUNTERS)} counters`));
  }
  if (record.remainingWork === undefined) {
    return err(probeError("invalid-snapshot", "Direct probe snapshot requires remainingWork"));
  }
  if (typeof record.isQuiescent !== "boolean") {
    return err(probeError("invalid-snapshot", "Direct probe isQuiescent must be boolean"));
  }
  const expectedQuiescence = active === 0 && Object.values(pending.value).every((value) => value === 0);
  if (record.isQuiescent !== expectedQuiescence) {
    return err(probeError("invalid-snapshot", "Direct probe isQuiescent does not match its activity and pending counters"));
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
    isQuiescent: record.isQuiescent
  }));
}
function prepareCountersUnchecked(pending, violations) {
  if (pending.length + violations.length > MAX_DIRECT_PROBE_COUNTERS) {
    return err(probeError("too-many-counters", `A probe supports at most ${String(MAX_DIRECT_PROBE_COUNTERS)} counters`));
  }
  const prepared = [];
  const seen = new Set;
  for (const [category, sources] of [
    ["pending", pending],
    ["violation", violations]
  ]) {
    for (const source of sources) {
      const name = source.name;
      const read = source.read;
      if (typeof name !== "string" || name.length > 80 || !COUNTER_NAME_PATTERN.test(name)) {
        return err(probeError("invalid-counter-name", "Counter names must be 1-80 ASCII alphanumeric characters with optional dots or hyphens", typeof name === "string" ? name : null));
      }
      if (typeof read !== "function") {
        return err(probeError("invalid-counter-source", `Counter ${name} must provide a synchronous read function`, name));
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
function prepareCounters(pending, violations) {
  try {
    return prepareCountersUnchecked(pending, violations);
  } catch (reason) {
    return err(probeError("invalid-counter-source", renderUnknownReason(reason, "Direct counter inspection failed")));
  }
}
function readCounters(sources) {
  const pending = Object.create(null);
  const violations = Object.create(null);
  for (const source of sources) {
    let value;
    try {
      value = source.read();
      if (containPromiseLike(value)) {
        return err(probeError("asynchronous-read", `Counter ${source.name} must be read synchronously`, source.name));
      }
    } catch (reason) {
      return err(probeError("probe-read-failed", renderUnknownReason(reason, `Failed to read ${source.name}`), source.name));
    }
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return err(probeError("invalid-counter", `Counter ${source.name} must be a non-negative safe integer`, source.name));
    }
    (source.category === "pending" ? pending : violations)[source.name] = value;
  }
  return ok({ pending: Object.freeze(pending), violations: Object.freeze(violations) });
}
function readRemaining(read) {
  let candidate;
  try {
    candidate = read();
    if (containPromiseLike(candidate)) {
      return err(probeError("asynchronous-read", "Remaining work must be read synchronously"));
    }
  } catch (reason) {
    return err(probeError("probe-read-failed", renderUnknownReason(reason, "Failed to read remaining work")));
  }
  const cloned = cloneJson(candidate);
  return cloned.ok ? ok(freezeJson(cloned.value)) : err(probeError("invalid-remaining-work", cloned.error.message));
}
function createDirectProbe(options) {
  let store;
  let activationHash;
  let pending;
  let violations;
  let readRemainingWork;
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
    return err(probeError("invalid-options", renderUnknownReason(reason, "Direct probe options could not be inspected")));
  }
  if (typeof activationHash !== "string" || !validActivationHash(activationHash)) {
    return err(probeError("invalid-activation-hash", "Activation hashes must be 1-256 characters without control characters"));
  }
  const counters = prepareCounters(pending, violations);
  if (!counters.ok)
    return counters;
  const snapshot = () => {
    const read = readCounters(counters.value);
    if (!read.ok)
      return read;
    const remaining = readRemaining(readRemainingWork);
    if (!remaining.ok)
      return remaining;
    const storeSnapshot = store.getSnapshot();
    const isQuiescent = storeSnapshot.activity.active === 0 && Object.values(read.value.pending).every((value2) => value2 === 0);
    const value = {
      schema: DIRECT_PROBE_SCHEMA,
      activationHash,
      generation: Number(storeSnapshot.generation),
      revision: storeSnapshot.revision,
      activity: storeSnapshot.activity,
      pending: read.value.pending,
      violations: read.value.violations,
      remainingWork: remaining.value,
      isQuiescent
    };
    return ok(Object.freeze(value));
  };
  const probe = {
    snapshot,
    isQuiescent: () => {
      const current = snapshot();
      return current.ok ? ok(current.value.isQuiescent) : current;
    }
  };
  return ok(Object.freeze(probe));
}

export { DIRECT_PROBE_SCHEMA, MAX_DIRECT_PROBE_COUNTERS, parseDirectProbeSnapshot, createDirectProbe };
