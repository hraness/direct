import {
  FIXTURE_QUERY_KEY,
  MAX_DIRECT_SCENARIOS,
  SCENARIO_QUERY_KEY,
  STABLE_HASH_ALGORITHM,
  cloneJson,
  createCoverageCatalogSnapshot,
  err,
  freezeJson,
  isRecord,
  ok,
  parseCoverageCatalogSnapshot,
  parseJsonValue,
  parseScenarioId,
  parseTaggedStableHash,
  renderUnknownReason,
  stableHash,
  tagStableHash
} from "./index-1csg00w4.js";

// src/testing/manifest.ts
var DIRECT_SESSION_MANIFEST_SCHEMA = "direct.session-manifest/v1";
var DIRECT_CATALOG_HASH_ALGORITHM = STABLE_HASH_ALGORITHM;
var DIRECT_SESSION_MANIFEST_JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 1e5,
  maxStringBytes: 16777216
});
var MANIFEST_KEYS = new Set([
  "active",
  "catalogHash",
  "coverage",
  "defaultScenario",
  "queries",
  "scenarios",
  "schema"
]);
var QUERY_KEYS = new Set(["fixture", "scenario"]);
var ACTIVE_KEYS = new Set([
  "activationHash",
  "route",
  "scenario",
  "selectionHash",
  "source"
]);
var SCENARIO_KEYS = new Set([
  "description",
  "id",
  "route",
  "title"
]);
function manifestError(code, message) {
  return Object.freeze({ code, message });
}
function exactKeys(input, expected, label) {
  for (const key of Object.keys(input)) {
    if (!expected.has(key))
      throw new Error(`Unknown ${label} key: ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(input, key))
      throw new Error(`Missing ${label} key: ${key}`);
  }
}
function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 || code === 127) {
      return true;
    }
  }
  return false;
}
function validText(value, maximum) {
  return value.trim().length > 0 && value.length <= maximum && !hasControlCharacters(value);
}
function validRoute(value) {
  if (value.trim().length === 0 || value.length > 256)
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127)
      return false;
  }
  return true;
}
function parseTaggedHash(value, label) {
  const parsed = parseTaggedStableHash(value);
  if (!parsed.ok)
    throw new Error(`${label}: ${parsed.error.message}`);
  return parsed.value;
}
function selectionHash(payload) {
  const hashed = stableHash(payload, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!hashed.ok) {
    return err(manifestError("invalid-manifest", hashed.error.message));
  }
  return ok(tagStableHash(hashed.value));
}
function catalogHash(payload) {
  const hashed = stableHash(payload, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!hashed.ok) {
    return err(manifestError("invalid-manifest", hashed.error.message));
  }
  return ok(tagStableHash(hashed.value));
}
function parseManifestUnchecked(input) {
  const parsedJson = parseJsonValue(input, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!parsedJson.ok || !isRecord(parsedJson.value)) {
    return err(manifestError("invalid-manifest", parsedJson.ok ? "Direct session manifest must be an object" : parsedJson.error.message));
  }
  const candidate = parsedJson.value;
  exactKeys(candidate, MANIFEST_KEYS, "Direct session manifest");
  if (candidate.schema !== DIRECT_SESSION_MANIFEST_SCHEMA) {
    throw new Error(`Direct session manifest schema must be ${DIRECT_SESSION_MANIFEST_SCHEMA}`);
  }
  if (!isRecord(candidate.queries)) {
    throw new Error("Direct session manifest queries must be an object");
  }
  exactKeys(candidate.queries, QUERY_KEYS, "Direct session manifest queries");
  if (candidate.queries.scenario !== SCENARIO_QUERY_KEY || candidate.queries.fixture !== FIXTURE_QUERY_KEY) {
    throw new Error("Direct session manifest query keys do not match Direct");
  }
  const queries = Object.freeze({
    scenario: SCENARIO_QUERY_KEY,
    fixture: FIXTURE_QUERY_KEY
  });
  const defaultScenario = parseScenarioId(candidate.defaultScenario);
  if (!defaultScenario.ok) {
    throw new Error(`Invalid default scenario: ${defaultScenario.error.message}`);
  }
  if (!Array.isArray(candidate.scenarios)) {
    throw new Error("Direct session manifest scenarios must be an array");
  }
  if (candidate.scenarios.length > MAX_DIRECT_SCENARIOS) {
    throw new Error(`Direct session manifests support at most ${String(MAX_DIRECT_SCENARIOS)} scenarios`);
  }
  const scenarios = [];
  const byId = new Map;
  for (const [index, rawScenario] of candidate.scenarios.entries()) {
    if (!isRecord(rawScenario)) {
      throw new Error(`Direct session manifest scenario ${String(index)} must be an object`);
    }
    exactKeys(rawScenario, SCENARIO_KEYS, `Direct session manifest scenario ${String(index)}`);
    const id = parseScenarioId(rawScenario.id);
    if (!id.ok) {
      throw new Error(`Invalid Direct session manifest scenario ${String(index)}: ${id.error.message}`);
    }
    if (byId.has(id.value)) {
      return err(manifestError("duplicate-scenario", `Duplicate Direct session manifest scenario: ${id.value}`));
    }
    if (typeof rawScenario.title !== "string" || !validText(rawScenario.title, 160)) {
      throw new Error(`Direct session manifest scenario ${id.value} title must contain 1-160 visible characters`);
    }
    if (rawScenario.description !== null && (typeof rawScenario.description !== "string" || !validText(rawScenario.description, 2000))) {
      throw new Error(`Direct session manifest scenario ${id.value} description must be null or contain 1-2000 visible characters`);
    }
    if (typeof rawScenario.route !== "string" || !validRoute(rawScenario.route)) {
      throw new Error(`Direct session manifest scenario ${id.value} route must contain 1-256 visible characters`);
    }
    const scenario = Object.freeze({
      id: id.value,
      title: rawScenario.title,
      description: rawScenario.description,
      route: rawScenario.route
    });
    scenarios.push(scenario);
    byId.set(id.value, scenario);
  }
  const frozenScenarios = Object.freeze(scenarios);
  if (!byId.has(defaultScenario.value)) {
    return err(manifestError("unknown-scenario", `Direct session manifest default scenario is missing: ${defaultScenario.value}`));
  }
  if (!isRecord(candidate.active)) {
    throw new Error("Direct session manifest active selection must be an object");
  }
  exactKeys(candidate.active, ACTIVE_KEYS, "Direct session manifest active selection");
  if (candidate.active.source !== "scenario" && candidate.active.source !== "fixture") {
    throw new Error("Direct session manifest active source must be scenario or fixture");
  }
  const activeScenario = parseScenarioId(candidate.active.scenario);
  if (!activeScenario.ok) {
    throw new Error(`Invalid active scenario: ${activeScenario.error.message}`);
  }
  const activeDefinition = byId.get(activeScenario.value);
  if (activeDefinition === undefined) {
    return err(manifestError("unknown-scenario", `Direct session manifest active scenario is missing: ${activeScenario.value}`));
  }
  if (typeof candidate.active.route !== "string" || !validRoute(candidate.active.route)) {
    throw new Error("Direct session manifest active route is invalid");
  }
  if (candidate.active.route !== activeDefinition.route) {
    return err(manifestError("route-mismatch", `Direct session manifest active route does not match scenario ${activeScenario.value}`));
  }
  const activationHash = parseTaggedHash(candidate.active.activationHash, "Direct session manifest activationHash");
  let suppliedSelectionHash;
  try {
    suppliedSelectionHash = parseTaggedHash(candidate.active.selectionHash, "Direct session manifest selectionHash");
  } catch (reason) {
    return err(manifestError("invalid-selection-hash", renderUnknownReason(reason, "Direct session manifest selectionHash is invalid")));
  }
  const expectedSelectionHash = selectionHash({
    source: candidate.active.source,
    scenario: activeScenario.value,
    route: activeDefinition.route,
    activationHash
  });
  if (!expectedSelectionHash.ok)
    return expectedSelectionHash;
  if (suppliedSelectionHash !== expectedSelectionHash.value) {
    return err(manifestError("selection-hash-mismatch", "Direct session manifest selectionHash does not match its active selection"));
  }
  const active = Object.freeze({
    source: candidate.active.source,
    scenario: activeScenario.value,
    route: activeDefinition.route,
    activationHash,
    selectionHash: expectedSelectionHash.value
  });
  const coverage = parseCoverageCatalogSnapshot(candidate.coverage, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!coverage.ok) {
    throw new Error(coverage.error.message);
  }
  for (const entry of coverage.value.entries) {
    for (const scenario of entry.scenarios) {
      if (!byId.has(scenario)) {
        return err(manifestError("unknown-coverage-scenario", `Coverage ${entry.key} cites unknown Direct session manifest scenario ${scenario}`));
      }
    }
  }
  let suppliedCatalogHash;
  try {
    const parsedHash = parseTaggedHash(candidate.catalogHash, "Direct session manifest catalogHash");
    const separator = parsedHash.indexOf(":");
    suppliedCatalogHash = `${DIRECT_CATALOG_HASH_ALGORITHM}:${parsedHash.slice(separator + 1)}`;
  } catch (reason) {
    return err(manifestError("invalid-catalog-hash", renderUnknownReason(reason, "Direct session manifest catalogHash is invalid")));
  }
  const expectedCatalogHash = catalogHash({
    queries,
    defaultScenario: defaultScenario.value,
    scenarios: frozenScenarios,
    coverage: coverage.value
  });
  if (!expectedCatalogHash.ok)
    return expectedCatalogHash;
  if (suppliedCatalogHash !== expectedCatalogHash.value) {
    return err(manifestError("catalog-hash-mismatch", "Direct session manifest catalogHash does not match its public catalog"));
  }
  return ok(Object.freeze({
    schema: DIRECT_SESSION_MANIFEST_SCHEMA,
    catalogHash: expectedCatalogHash.value,
    queries,
    defaultScenario: defaultScenario.value,
    active,
    scenarios: frozenScenarios,
    coverage: coverage.value
  }));
}
function parseDirectSessionManifest(input) {
  try {
    return parseManifestUnchecked(input);
  } catch (reason) {
    return err(manifestError("invalid-manifest", renderUnknownReason(reason, "Direct session manifest is invalid")));
  }
}
function createDirectSessionManifest(definition, activation) {
  try {
    const activeScenario = definition.scenarios.get(activation.scenario);
    if (activeScenario === undefined) {
      return err(manifestError("unknown-scenario", `Direct session activation is missing from its definition: ${activation.scenario}`));
    }
    if (activeScenario.route !== activation.route) {
      return err(manifestError("route-mismatch", `Direct session activation route does not match scenario ${activation.scenario}`));
    }
    const activeIdentity = {
      source: activation.source,
      scenario: activation.scenario,
      route: activation.route,
      world: activation.world,
      runtime: activation.runtime
    };
    const hashedActivation = stableHash(activeIdentity);
    if (!hashedActivation.ok) {
      return err(manifestError("invalid-manifest", hashedActivation.error.message));
    }
    const expectedActivationHash = tagStableHash(hashedActivation.value);
    if (activation.activationHash !== expectedActivationHash) {
      return err(manifestError("activation-hash-mismatch", "Direct session activationHash does not identify its active state"));
    }
    if (activation.source === "scenario") {
      const authoredHash = stableHash({
        source: activation.source,
        scenario: activeScenario.id,
        route: activeScenario.route,
        world: activeScenario.world,
        runtime: activeScenario.runtime
      });
      if (!authoredHash.ok) {
        return err(manifestError("invalid-manifest", authoredHash.error.message));
      }
      if (tagStableHash(authoredHash.value) !== expectedActivationHash) {
        return err(manifestError("activation-hash-mismatch", `Direct scenario activation does not match authored scenario ${activation.scenario}`));
      }
    }
    const scenarios = Object.freeze(definition.scenarios.list().map((scenario) => Object.freeze({
      id: scenario.id,
      title: scenario.title,
      description: scenario.description,
      route: scenario.route
    })));
    const queries = Object.freeze({
      scenario: SCENARIO_QUERY_KEY,
      fixture: FIXTURE_QUERY_KEY
    });
    const coverage = createCoverageCatalogSnapshot(definition.coverage);
    const hash = catalogHash({
      queries,
      defaultScenario: definition.defaultScenario.id,
      scenarios,
      coverage
    });
    if (!hash.ok)
      return hash;
    const activeSelectionHash = selectionHash({
      source: activation.source,
      scenario: activation.scenario,
      route: activation.route,
      activationHash: expectedActivationHash
    });
    if (!activeSelectionHash.ok)
      return activeSelectionHash;
    return parseDirectSessionManifest({
      schema: DIRECT_SESSION_MANIFEST_SCHEMA,
      catalogHash: hash.value,
      queries,
      defaultScenario: definition.defaultScenario.id,
      active: {
        source: activation.source,
        scenario: activation.scenario,
        route: activation.route,
        activationHash: expectedActivationHash,
        selectionHash: activeSelectionHash.value
      },
      scenarios,
      coverage
    });
  } catch (reason) {
    return err(manifestError("invalid-manifest", renderUnknownReason(reason, "Direct session manifest could not be created")));
  }
}

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
  const activationHash = parseTaggedStableHash(record.activationHash);
  if (!activationHash.ok) {
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
    activationHash: activationHash.value,
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
  const parsedActivationHash = parseTaggedStableHash(activationHash);
  if (!parsedActivationHash.ok) {
    return err(probeError("invalid-activation-hash", parsedActivationHash.error.message));
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
      activationHash: parsedActivationHash.value,
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

export { DIRECT_SESSION_MANIFEST_SCHEMA, DIRECT_CATALOG_HASH_ALGORITHM, parseDirectSessionManifest, createDirectSessionManifest, DIRECT_PROBE_SCHEMA, MAX_DIRECT_PROBE_COUNTERS, parseDirectProbeSnapshot, createDirectProbe };
