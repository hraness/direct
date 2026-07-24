import {
  DEFAULT_MAX_FIXTURE_BYTES,
  DEFAULT_MAX_QUERY_BYTES,
  FIXTURE_QUERY_KEY,
  FIXTURE_SCHEMA,
  SCENARIO_QUERY_KEY,
  activateDirectScenario,
  createFixtureEnvelope,
  createScenarioCatalog,
  maximumFixtureQueryBytes,
  parseDirectQuery,
  parseFixtureEnvelope,
  parseFixtureJson,
  serializeFixtureJson
} from "../index-zg34h2bx.js";
import {
  createDirectStore
} from "../index-x5hgch7b.js";
import {
  DEFAULT_LOGICAL_RUNTIME_SNAPSHOT,
  LOGICAL_RUNTIME_SCHEMA,
  MAX_HOST_TIMER_MILLISECONDS,
  createLogicalRuntime,
  parseLogicalRuntimeSnapshot
} from "../index-wqwbtetw.js";
import {
  DEFAULT_JSON_LIMITS,
  DIRECT_COVERAGE_SCHEMA,
  EMPTY_COVERAGE_CATALOG_SNAPSHOT,
  canonicalJson,
  cloneJson,
  coverageKey,
  createCoverageCatalog,
  createCoverageCatalogSnapshot,
  err,
  freezeJson,
  isRecord,
  ok,
  operationId,
  parseAndCloneWorld,
  parseCoverageCatalogSnapshot,
  parseCoverageKey,
  parseExactJsonSource,
  parseJsonValue,
  parseOperationId,
  parseScenarioId,
  renderUnknownReason,
  scenarioId,
  stableHash,
  utf8ByteLength
} from "../index-541zzq54.js";
// src/core/effects.ts
function ownQueuedEffect(entry) {
  const id = parseOperationId(entry.id);
  if (!id.ok)
    throw new Error(id.error.message);
  if (!Number.isSafeInteger(entry.remaining) || entry.remaining < 1) {
    throw new Error("Queued effect remaining uses must be a positive safe integer");
  }
  const cloned = cloneJson(entry.effect);
  if (!cloned.ok)
    throw new Error(cloned.error.message);
  return Object.freeze({
    id: id.value,
    effect: freezeJson(cloned.value),
    remaining: entry.remaining
  });
}
function ownEffectQueue(queue) {
  return Object.freeze(queue.map((entry) => ownQueuedEffect(entry)));
}
function enqueueEffect(queue, id, effect, uses = 1) {
  if (!Number.isSafeInteger(uses) || uses < 1) {
    throw new Error("Queued effect uses must be a positive safe integer");
  }
  const ownedQueue = ownEffectQueue(queue);
  const appended = ownQueuedEffect({ id, effect, remaining: uses });
  return Object.freeze([...ownedQueue, appended]);
}
function consumeEffect(queue, matches = () => true) {
  const ownedQueue = ownEffectQueue(queue);
  const index = ownedQueue.findIndex(matches);
  if (index < 0) {
    return Object.freeze({ kind: "empty", queue: ownedQueue });
  }
  const matched = ownedQueue[index];
  if (matched === undefined) {
    return Object.freeze({ kind: "empty", queue: ownedQueue });
  }
  const next = [...ownedQueue];
  if (matched.remaining === 1) {
    next.splice(index, 1);
  } else {
    next[index] = Object.freeze({ ...matched, remaining: matched.remaining - 1 });
  }
  return Object.freeze({
    kind: "consumed",
    effect: matched.effect,
    queue: Object.freeze(next)
  });
}
var enqueueFault = enqueueEffect;
var consumeFault = consumeEffect;
export {
  utf8ByteLength,
  stableHash,
  serializeFixtureJson,
  scenarioId,
  renderUnknownReason,
  parseScenarioId,
  parseOperationId,
  parseLogicalRuntimeSnapshot,
  parseJsonValue,
  parseFixtureJson,
  parseFixtureEnvelope,
  parseExactJsonSource,
  parseDirectQuery,
  parseCoverageKey,
  parseCoverageCatalogSnapshot,
  parseAndCloneWorld,
  operationId,
  ok,
  maximumFixtureQueryBytes,
  isRecord,
  freezeJson,
  err,
  enqueueFault,
  enqueueEffect,
  createScenarioCatalog,
  createLogicalRuntime,
  createFixtureEnvelope,
  createDirectStore,
  createCoverageCatalogSnapshot,
  createCoverageCatalog,
  coverageKey,
  consumeFault,
  consumeEffect,
  cloneJson,
  canonicalJson,
  activateDirectScenario,
  SCENARIO_QUERY_KEY,
  MAX_HOST_TIMER_MILLISECONDS,
  LOGICAL_RUNTIME_SCHEMA,
  FIXTURE_SCHEMA,
  FIXTURE_QUERY_KEY,
  EMPTY_COVERAGE_CATALOG_SNAPSHOT,
  DIRECT_COVERAGE_SCHEMA,
  DEFAULT_MAX_QUERY_BYTES,
  DEFAULT_MAX_FIXTURE_BYTES,
  DEFAULT_LOGICAL_RUNTIME_SNAPSHOT,
  DEFAULT_JSON_LIMITS
};
