import {
  createDirectStore
} from "../index-6mdfd2ey.js";
import {
  DIRECT_CATALOG_HASH_ALGORITHM,
  DIRECT_PROBE_SCHEMA,
  DIRECT_SESSION_MANIFEST_SCHEMA,
  MAX_DIRECT_PROBE_COUNTERS,
  createDirectProbe,
  createDirectSessionManifest,
  parseDirectProbeSnapshot,
  parseDirectSessionManifest
} from "../index-7n1h75n6.js";
import {
  canonicalJson,
  createCoverageCatalogSnapshot,
  createLogicalRuntime,
  err,
  isRecord,
  ok,
  parseAndCloneWorld,
  parseCoverageCatalogSnapshot,
  parseJsonValue,
  parseLogicalRuntimeSnapshot,
  parseTaggedStableHash,
  renderUnknownReason
} from "../index-1csg00w4.js";

// src/testing/activity.ts
function storeErrorMessage(cause) {
  return renderUnknownReason(cause, "Direct store operation failed");
}
function operationError(reason) {
  return Object.freeze({
    code: "operation-id-failed",
    message: renderUnknownReason(reason),
    operation: null,
    storeError: null,
    reason
  });
}
function closedScopeError() {
  return Object.freeze({
    code: "scope-closed",
    message: "The Direct activity scope is closed",
    operation: null,
    storeError: null,
    reason: null
  });
}
function storeError(code, operation, cause) {
  return Object.freeze({
    code,
    message: storeErrorMessage(cause),
    operation,
    storeError: cause,
    reason: null
  });
}
function createDirectActivityScope(store, runtime, options = {}) {
  const signal = options.signal;
  const isClosed = () => signal?.aborted === true;
  const begin = (namespace = "activity") => {
    if (isClosed())
      return err(closedScopeError());
    let operation;
    try {
      operation = runtime.nextOperationId(namespace);
    } catch (reason) {
      return err(operationError(reason));
    }
    if (isClosed())
      return err(closedScopeError());
    const currentGeneration = store.getSnapshot().generation;
    const started = store.beginActivity(currentGeneration, operation);
    if (!started.ok) {
      return err(storeError("store-begin-failed", operation, started.error));
    }
    if (isClosed()) {
      const settled = started.value.settle();
      return settled.ok ? err(closedScopeError()) : err(storeError("store-settle-failed", operation, settled.error));
    }
    let released = false;
    let releaseResult = null;
    const lease = Object.freeze({
      generation: currentGeneration,
      operation,
      isReleased: () => released,
      release: () => {
        if (releaseResult !== null)
          return releaseResult;
        released = true;
        const settled = started.value.settle();
        releaseResult = settled.ok ? ok(true) : err(storeError("store-settle-failed", operation, settled.error));
        return releaseResult;
      }
    });
    return ok(lease);
  };
  const run = async (namespace, work) => {
    const started = begin(namespace);
    if (!started.ok) {
      return err(Object.freeze({
        code: "begin-failed",
        message: started.error.message,
        operation: null,
        workError: null,
        activityError: started.error
      }));
    }
    let workResult;
    try {
      workResult = ok(await work());
    } catch (reason) {
      workResult = err(reason);
    }
    const released = started.value.release();
    if (workResult.ok && released.ok)
      return ok(workResult.value);
    if (!workResult.ok && released.ok) {
      return err(Object.freeze({
        code: "work-failed",
        message: renderUnknownReason(workResult.error),
        operation: started.value.operation,
        workError: workResult.error,
        activityError: null
      }));
    }
    if (workResult.ok && !released.ok) {
      return err(Object.freeze({
        code: "settlement-failed",
        message: released.error.message,
        operation: started.value.operation,
        workError: null,
        activityError: released.error
      }));
    }
    if (!workResult.ok && !released.ok) {
      return err(Object.freeze({
        code: "work-and-settlement-failed",
        message: `${renderUnknownReason(workResult.error)}; settlement failed: ${released.error.message}`,
        operation: started.value.operation,
        workError: workResult.error,
        activityError: released.error
      }));
    }
    throw new Error("Unreachable activity result");
  };
  return Object.freeze({ begin, run });
}
// src/testing/coverage-binding.ts
function sameEntry(actual, expected) {
  if (actual.key !== expected.key || actual.mode !== expected.mode || actual.claim !== expected.claim || actual.scenarios.length !== expected.scenarios.length)
    return false;
  return actual.scenarios.every((scenario, index) => scenario === expected.scenarios[index]);
}
function parseExpectedCoverageCatalogSnapshot(input, expected) {
  const parsed = parseCoverageCatalogSnapshot(input);
  if (!parsed.ok) {
    return err(Object.freeze({
      code: "invalid-coverage",
      message: parsed.error.message,
      coverageError: parsed.error
    }));
  }
  try {
    if (parsed.value.schema !== expected.schema || parsed.value.entries.length !== expected.entries.length || parsed.value.entries.some((entry, index) => {
      const expectedEntry = expected.entries[index];
      return expectedEntry === undefined || !sameEntry(entry, expectedEntry);
    })) {
      return err(Object.freeze({
        code: "coverage-mismatch",
        message: "Published Direct coverage does not exactly match the authored definition",
        coverageError: null
      }));
    }
  } catch (reason) {
    return err(Object.freeze({
      code: "invalid-definition",
      message: renderUnknownReason(reason, "Expected Direct coverage could not be inspected"),
      coverageError: null
    }));
  }
  return ok(expected);
}
function parseDefinitionCoverageSnapshot(input, definition) {
  let expected;
  try {
    expected = createCoverageCatalogSnapshot(definition.coverage);
  } catch (reason) {
    return err(Object.freeze({
      code: "invalid-definition",
      message: renderUnknownReason(reason, "Direct definition coverage could not be inspected"),
      coverageError: null
    }));
  }
  return parseExpectedCoverageCatalogSnapshot(input, expected);
}
// src/testing/evidence.ts
function classifyCoverageEvidence(entry, facts) {
  const directVerified = facts.directEvidence === "verified";
  if (entry.mode === "direct") {
    return directVerified ? "verified" : "direct-required";
  }
  let exercised = 0;
  for (const scenario of entry.scenarios) {
    if (facts.exercisedScenarios.has(scenario))
      exercised += 1;
  }
  if (exercised === 0) {
    return directVerified && entry.mode === "mixed" ? "partial" : "not-exercised";
  }
  if (exercised < entry.scenarios.length) {
    return "partial";
  }
  if (entry.mode === "fixture") {
    return "verified";
  }
  return directVerified ? "verified" : "fixture-verified";
}
// src/testing/session.ts
function frozenMessages(messages) {
  return Object.freeze([...messages]);
}
function isPromiseLike(value) {
  return (typeof value === "object" && value !== null || typeof value === "function") && typeof Reflect.get(value, "then") === "function";
}
function freezeCounterSources(sources) {
  return Object.freeze([...sources]);
}
function prepareSessionObservation(input) {
  const candidate = input;
  if (!isRecord(candidate)) {
    throw new Error("Direct observation must be an object");
  }
  const pending = input.pending;
  const violations = input.violations;
  const readRemainingWork = input.readRemainingWork;
  if (pending !== undefined && !Array.isArray(pending)) {
    throw new Error("Direct observation pending counters must be an array");
  }
  if (violations !== undefined && !Array.isArray(violations)) {
    throw new Error("Direct observation violation counters must be an array");
  }
  if (readRemainingWork !== undefined && typeof readRemainingWork !== "function") {
    throw new Error("Direct observation remaining-work reader must be a function");
  }
  return Object.freeze({
    ...pending === undefined ? {} : { pending: freezeCounterSources(pending) },
    ...violations === undefined ? {} : { violations: freezeCounterSources(violations) },
    ...readRemainingWork === undefined ? {} : { readRemainingWork }
  });
}
function sessionError(error, cleanupErrors = []) {
  const failures = frozenMessages(cleanupErrors);
  switch (error.code) {
    case "invalid-options":
    case "activation-failed":
    case "store-failed":
    case "harness-failed":
    case "observation-failed":
    case "probe-failed":
      return Object.freeze({ ...error, cleanupErrors: failures });
  }
}
function runCleanup(controller, cleanups) {
  const failures = [];
  try {
    controller.abort();
  } catch (reason) {
    failures.push(`Abort failed: ${renderUnknownReason(reason)}`);
  }
  for (const cleanup of [...cleanups].reverse()) {
    try {
      const returned = cleanup();
      if (returned !== undefined) {
        if (isPromiseLike(returned)) {
          Promise.resolve(returned).catch(() => {
            return;
          });
        }
        failures.push("Direct cleanup must complete synchronously and return undefined");
      }
    } catch (reason) {
      failures.push(renderUnknownReason(reason, "Direct cleanup failed"));
    }
  }
  return frozenMessages(failures);
}
function activateSession(definition, activation) {
  switch (activation.kind) {
    case "query":
      return definition.activate(activation.source);
    case "scenario":
      return definition.activateScenario(activation.scenario);
  }
}
function createDirectSession(options) {
  let definition;
  let requestedActivation;
  let createHarness;
  let observeHarness;
  let parseWorld;
  let sleep;
  let storeOptions;
  try {
    definition = options.definition;
    parseWorld = definition.parseWorld;
    const activationInput = options.activation;
    if (activationInput.kind === "query") {
      requestedActivation = Object.freeze({ kind: "query", source: activationInput.source });
    } else if (activationInput.kind === "scenario") {
      requestedActivation = Object.freeze({ kind: "scenario", scenario: activationInput.scenario });
    } else {
      throw new Error("Direct session activation kind must be query or scenario");
    }
    createHarness = options.create;
    observeHarness = options.observe;
    sleep = options.sleep;
    const storeOptionsInput = options.storeOptions;
    if (storeOptionsInput === undefined) {
      storeOptions = undefined;
    } else {
      const onListenerError = storeOptionsInput.onListenerError;
      const validateReplacements = storeOptionsInput.validateReplacements;
      storeOptions = Object.freeze({
        ...onListenerError === undefined ? {} : { onListenerError },
        ...validateReplacements === undefined ? {} : { validateReplacements }
      });
    }
  } catch (reason) {
    return err(sessionError({
      code: "invalid-options",
      message: renderUnknownReason(reason, "Direct session options could not be inspected"),
      queryError: null,
      storeError: null,
      probeError: null
    }));
  }
  let activationSource;
  let activationScenario;
  let activationRoute;
  let activationWorld;
  let activationRuntime;
  let activationHash;
  try {
    const activated = activateSession(definition, requestedActivation);
    if (!activated.ok) {
      const queryError = Object.freeze({
        code: activated.error.code,
        message: activated.error.message
      });
      return err(sessionError({
        code: "activation-failed",
        message: queryError.message,
        queryError,
        storeError: null,
        probeError: null
      }));
    }
    const candidate = activated.value;
    if (candidate.kind !== "active")
      throw new Error("Direct activation kind must be active");
    if (candidate.source !== "scenario" && candidate.source !== "fixture") {
      throw new Error("Direct activation source must be scenario or fixture");
    }
    if (typeof candidate.scenario !== "string") {
      throw new Error("Direct activation scenario must be a string");
    }
    if (typeof candidate.route !== "string") {
      throw new Error("Direct activation route must be a string");
    }
    const parsedActivationHash = parseTaggedStableHash(candidate.activationHash);
    if (!parsedActivationHash.ok)
      throw new Error(parsedActivationHash.error.message);
    const parsedRuntime = parseLogicalRuntimeSnapshot(candidate.runtime);
    if (!parsedRuntime.ok)
      throw new Error(parsedRuntime.error.message);
    activationSource = candidate.source;
    activationScenario = candidate.scenario;
    activationRoute = candidate.route;
    activationWorld = candidate.world;
    activationRuntime = parsedRuntime.value;
    activationHash = parsedActivationHash.value;
  } catch (reason) {
    return err(sessionError({
      code: "invalid-options",
      message: renderUnknownReason(reason, "Direct session activation failed unexpectedly"),
      queryError: null,
      storeError: null,
      probeError: null
    }));
  }
  const store = storeOptions === undefined ? createDirectStore(activationWorld, parseWorld) : createDirectStore(activationWorld, parseWorld, storeOptions);
  if (!store.ok) {
    return err(sessionError({
      code: "store-failed",
      message: store.error.message,
      queryError: null,
      storeError: store.error,
      probeError: null
    }));
  }
  const clock = sleep === undefined ? createLogicalRuntime(activationRuntime) : createLogicalRuntime(activationRuntime, sleep);
  const activation = Object.freeze({
    kind: "active",
    source: activationSource,
    scenario: activationScenario,
    route: activationRoute,
    world: store.value.getSnapshot().world,
    runtime: clock.snapshot(),
    activationHash
  });
  const createdManifest = createDirectSessionManifest(definition, activation);
  if (!createdManifest.ok) {
    return err(sessionError({
      code: "invalid-options",
      message: createdManifest.error.message,
      queryError: null,
      storeError: null,
      probeError: null
    }));
  }
  const manifest = createdManifest.value;
  const controller = new AbortController;
  const activity = createDirectActivityScope(store.value, clock, { signal: controller.signal });
  const cleanups = [];
  let registrationOpen = true;
  const context = Object.freeze({
    activation,
    world: activation.world,
    store: store.value,
    clock,
    activity,
    signal: controller.signal,
    onDispose: (cleanup) => {
      if (!registrationOpen) {
        throw new Error("Direct cleanup must be registered during synchronous session construction");
      }
      cleanups.push(cleanup);
      return;
    }
  });
  let harness;
  try {
    harness = createHarness(context);
    if (isPromiseLike(harness)) {
      Promise.resolve(harness).catch(() => {
        return;
      });
      throw new Error("Direct harness construction must complete synchronously");
    }
  } catch (reason) {
    registrationOpen = false;
    const cleanupErrors = runCleanup(controller, cleanups);
    return err(sessionError({
      code: "harness-failed",
      message: renderUnknownReason(reason, "Direct harness construction failed"),
      queryError: null,
      storeError: null,
      probeError: null
    }, cleanupErrors));
  }
  let observation;
  try {
    const observed = observeHarness === undefined ? Object.freeze({}) : observeHarness(harness, context);
    if (isPromiseLike(observed)) {
      Promise.resolve(observed).catch(() => {
        return;
      });
      throw new Error("Direct observation construction must complete synchronously");
    }
    observation = prepareSessionObservation(observed);
  } catch (reason) {
    registrationOpen = false;
    const cleanupErrors = runCleanup(controller, cleanups);
    return err(sessionError({
      code: "observation-failed",
      message: renderUnknownReason(reason, "Direct observation construction failed"),
      queryError: null,
      storeError: null,
      probeError: null
    }, cleanupErrors));
  }
  registrationOpen = false;
  const probe = createDirectProbe({
    store: store.value,
    activationHash: activation.activationHash,
    ...observation.pending === undefined ? {} : { pending: observation.pending },
    ...observation.violations === undefined ? {} : { violations: observation.violations },
    ...observation.readRemainingWork === undefined ? {} : { readRemainingWork: observation.readRemainingWork }
  });
  if (!probe.ok) {
    const cleanupErrors = runCleanup(controller, cleanups);
    return err(sessionError({
      code: "probe-failed",
      message: probe.error.message,
      queryError: null,
      storeError: null,
      probeError: probe.error
    }, cleanupErrors));
  }
  let disposed = false;
  let disposalErrors = Object.freeze([]);
  const onDispose = (cleanup) => {
    if (typeof cleanup !== "function") {
      return err(Object.freeze({
        code: "invalid-cleanup",
        message: "Direct cleanup must be a function"
      }));
    }
    if (disposed) {
      return err(Object.freeze({
        code: "session-disposed",
        message: "Cannot register cleanup on a disposed Direct session"
      }));
    }
    cleanups.push(cleanup);
    return ok(true);
  };
  const dispose = () => {
    if (disposed)
      return;
    disposed = true;
    disposalErrors = runCleanup(controller, cleanups);
    return;
  };
  return ok(Object.freeze({
    activation,
    world: activation.world,
    store: store.value,
    clock,
    activity,
    harness,
    probe: probe.value,
    manifest,
    coverage: manifest.coverage,
    signal: controller.signal,
    onDispose,
    dispose,
    isDisposed: () => disposed,
    disposalErrors: () => disposalErrors
  }));
}
// src/testing/scripted-transport.ts
var DEFAULT_SCRIPTED_TRANSPORT_LIMITS = Object.freeze({
  maxSteps: 1e4,
  maxEventsPerStep: 1000,
  maxRecordedInternalErrors: 32,
  maxLogicalDelayPerStepMs: 60000,
  maxTotalLogicalDelayMs: 3600000
});
var STEP_KEYS = new Set(["request", "outcome", "delayMs", "eventsBefore", "eventsAfter"]);
var OUTCOME_KEYS = new Set(["kind", "value", "error"]);
var LIMIT_KEYS = new Set([
  "maxSteps",
  "maxEventsPerStep",
  "maxRecordedInternalErrors",
  "maxLogicalDelayPerStepMs",
  "maxTotalLogicalDelayMs"
]);
function definitionError(code, message, step = null) {
  return Object.freeze({ code, message, step });
}
function validateLimits(limits) {
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS.has(key)) {
      return err(definitionError("invalid-limits", `Unknown scripted transport limit: ${key}`));
    }
  }
  for (const [name, value] of [
    ["maxSteps", limits.maxSteps],
    ["maxEventsPerStep", limits.maxEventsPerStep],
    ["maxRecordedInternalErrors", limits.maxRecordedInternalErrors]
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 1e5) {
      return err(definitionError("invalid-limits", `${name} must be a positive safe integer no greater than 100000`));
    }
  }
  for (const [name, value] of [
    ["maxLogicalDelayPerStepMs", limits.maxLogicalDelayPerStepMs],
    ["maxTotalLogicalDelayMs", limits.maxTotalLogicalDelayMs]
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return err(definitionError("invalid-limits", `${name} must be a non-negative safe integer`));
    }
  }
  return ok(Object.freeze({ ...limits }));
}
function parseOwned(input, parser, label, step) {
  const parsed = parseAndCloneWorld(input, parser);
  return parsed.ok ? parsed : err(definitionError("invalid-step", `${label}: ${parsed.error.message}`, step));
}
function parseEvents(input, parser, label, step) {
  if (!Array.isArray(input)) {
    return err(definitionError("invalid-step", `${label} must be an array`, step));
  }
  const events = [];
  for (const candidate of input) {
    const parsed = parseOwned(candidate, parser, label, step);
    if (!parsed.ok)
      return parsed;
    events.push(parsed.value);
  }
  return ok(Object.freeze(events));
}
function parseSteps(options, limits) {
  const json = parseJsonValue(options.steps);
  if (!json.ok || !Array.isArray(json.value)) {
    return err(definitionError("invalid-script", json.ok ? "Transport steps must be an array" : json.error.message));
  }
  if (json.value.length > limits.maxSteps) {
    return err(definitionError("script-too-large", `Transport script exceeds ${String(limits.maxSteps)} steps`));
  }
  const steps = [];
  let totalLogicalDelayMs = 0;
  for (const [index, candidate] of json.value.entries()) {
    if (!isRecord(candidate)) {
      return err(definitionError("invalid-step", "Transport steps must be objects", index));
    }
    for (const key of Object.keys(candidate)) {
      if (!STEP_KEYS.has(key)) {
        return err(definitionError("invalid-step", `Unknown transport step key: ${key}`, index));
      }
    }
    if (!("request" in candidate) || !("outcome" in candidate)) {
      return err(definitionError("invalid-step", "Transport steps require request and outcome", index));
    }
    const request = parseOwned(candidate.request, options.parseRequest, "Invalid scripted request", index);
    if (!request.ok)
      return request;
    const requestCanonical = canonicalJson(request.value);
    if (!requestCanonical.ok) {
      return err(definitionError("invalid-step", requestCanonical.error.message, index));
    }
    if (!isRecord(candidate.outcome)) {
      return err(definitionError("invalid-step", "Transport outcome must be an object", index));
    }
    for (const key of Object.keys(candidate.outcome)) {
      if (!OUTCOME_KEYS.has(key)) {
        return err(definitionError("invalid-step", `Unknown transport outcome key: ${key}`, index));
      }
    }
    let outcome;
    if (candidate.outcome.kind === "response") {
      if (!("value" in candidate.outcome) || "error" in candidate.outcome) {
        return err(definitionError("invalid-step", "A response outcome requires only value", index));
      }
      const response = parseOwned(candidate.outcome.value, options.parseResponse, "Invalid scripted response", index);
      if (!response.ok)
        return response;
      outcome = Object.freeze({ kind: "response", value: response.value });
    } else if (candidate.outcome.kind === "failure") {
      if (!("error" in candidate.outcome) || "value" in candidate.outcome) {
        return err(definitionError("invalid-step", "A failure outcome requires only error", index));
      }
      const failure = parseOwned(candidate.outcome.error, options.parseFailure, "Invalid scripted failure", index);
      if (!failure.ok)
        return failure;
      outcome = Object.freeze({ kind: "failure", error: failure.value });
    } else {
      return err(definitionError("invalid-step", "Transport outcome kind must be response or failure", index));
    }
    const delayMs = "delayMs" in candidate ? candidate.delayMs : 0;
    if (typeof delayMs !== "number" || !Number.isSafeInteger(delayMs) || delayMs < 0) {
      return err(definitionError("invalid-step", "Transport delayMs must be a non-negative safe integer", index));
    }
    if (delayMs > limits.maxLogicalDelayPerStepMs) {
      return err(definitionError("script-too-large", `Transport delayMs exceeds the per-step limit of ${String(limits.maxLogicalDelayPerStepMs)}`, index));
    }
    if (totalLogicalDelayMs > limits.maxTotalLogicalDelayMs - delayMs) {
      return err(definitionError("script-too-large", `Transport script exceeds the total logical delay limit of ${String(limits.maxTotalLogicalDelayMs)}`, index));
    }
    totalLogicalDelayMs += delayMs;
    const eventsBeforeInput = "eventsBefore" in candidate ? candidate.eventsBefore : [];
    const eventsAfterInput = "eventsAfter" in candidate ? candidate.eventsAfter : [];
    if (!Array.isArray(eventsBeforeInput) || !Array.isArray(eventsAfterInput)) {
      return err(definitionError("invalid-step", "eventsBefore and eventsAfter must be arrays", index));
    }
    if (eventsBeforeInput.length > limits.maxEventsPerStep || eventsAfterInput.length > limits.maxEventsPerStep - eventsBeforeInput.length) {
      return err(definitionError("script-too-large", `Transport step exceeds the combined event limit of ${String(limits.maxEventsPerStep)}`, index));
    }
    const eventsBefore = parseEvents(eventsBeforeInput, options.parseEvent, "eventsBefore", index);
    if (!eventsBefore.ok)
      return eventsBefore;
    const eventsAfter = parseEvents(eventsAfterInput, options.parseEvent, "eventsAfter", index);
    if (!eventsAfter.ok)
      return eventsAfter;
    steps.push(Object.freeze({
      request: request.value,
      requestCanonical: requestCanonical.value,
      outcome,
      delayMs,
      eventsBefore: eventsBefore.value,
      eventsAfter: eventsAfter.value
    }));
  }
  return ok(Object.freeze(steps));
}
function transportError(code, message, step, expectedRequest, actualRequest, remainingSteps, pendingDeliveries) {
  return Object.freeze({
    code,
    message,
    step,
    expectedRequest,
    actualRequest,
    remainingSteps,
    pendingDeliveries
  });
}
function runtimeFailureMessage(error) {
  return `Logical wait failed: ${renderUnknownReason(error, "Unknown logical runtime failure")}`;
}
function isPromiseLike2(value) {
  return (typeof value === "object" && value !== null || typeof value === "function") && typeof Reflect.get(value, "then") === "function";
}
function synchronousReturnViolation(value, label) {
  if (value === undefined)
    return null;
  if (isPromiseLike2(value)) {
    Promise.resolve(value).catch(() => {
      return;
    });
  }
  return new Error(`${label} must complete synchronously and return undefined`);
}
function createExactScriptedTransport(options) {
  let captured;
  try {
    captured = Object.freeze({
      wait: options.runtime.wait,
      parseRequest: options.parseRequest,
      parseResponse: options.parseResponse,
      parseEvent: options.parseEvent,
      parseFailure: options.parseFailure,
      steps: options.steps,
      beginActivity: options.activity?.begin,
      activityNamespace: options.activityNamespace ?? "transport",
      limits: options.limits ?? DEFAULT_SCRIPTED_TRANSPORT_LIMITS,
      onListenerError: options.onListenerError
    });
  } catch (reason) {
    return err(definitionError("invalid-options", renderUnknownReason(reason, "Scripted transport options could not be inspected")));
  }
  let limits;
  try {
    limits = validateLimits(captured.limits);
  } catch (reason) {
    return err(definitionError("invalid-options", renderUnknownReason(reason, "Scripted transport limits could not be inspected")));
  }
  if (!limits.ok)
    return limits;
  const parsedSteps = parseSteps(captured, limits.value);
  if (!parsedSteps.ok)
    return parsedSteps;
  const listeners = new Set;
  const activeCancellations = new Set;
  const disposalController = new AbortController;
  const internalErrors = [];
  let droppedInternalErrors = 0;
  let nextStep = 0;
  let pending = 0;
  let disposed = false;
  let idleWaiters = [];
  const remainingSteps = () => parsedSteps.value.length - nextStep;
  const recordInternalError = (reason) => {
    const message = renderUnknownReason(reason, "Uninspectable internal transport failure").slice(0, 500);
    if (internalErrors.length < limits.value.maxRecordedInternalErrors)
      internalErrors.push(message);
    else
      droppedInternalErrors += 1;
  };
  const notifyIdle = () => {
    if (pending !== 0)
      return;
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting)
      resolve();
  };
  const reportListenerError = (reason) => {
    if (captured.onListenerError === undefined)
      return;
    try {
      const returned = captured.onListenerError(reason);
      const violation = synchronousReturnViolation(returned, "Scripted transport listener-error reporters");
      if (violation !== null)
        recordInternalError(violation);
    } catch (reporterReason) {
      recordInternalError(reporterReason);
    }
  };
  const emit = (events) => {
    if (disposed)
      return false;
    for (const event of events) {
      if (disposed)
        return false;
      for (const listener of [...listeners]) {
        if (disposed)
          return false;
        try {
          const returned = listener(event);
          const violation = synchronousReturnViolation(returned, "Scripted transport listeners");
          if (violation !== null) {
            recordInternalError(violation);
            reportListenerError(violation);
          }
        } catch (reason) {
          recordInternalError(reason);
          reportListenerError(reason);
        }
      }
    }
    return !disposed;
  };
  const currentError = (code, message, step = null, expected = null, actual = null) => transportError(code, message, step, expected, actual, remainingSteps(), pending);
  const internalError = () => {
    if (internalErrors.length === 0 && droppedInternalErrors === 0)
      return null;
    const suffix = droppedInternalErrors === 0 ? "" : `; ${String(droppedInternalErrors)} more omitted`;
    return currentError("internal-failure", `${internalErrors.join("; ")}${suffix}`);
  };
  const settleLease = (lease) => {
    if (lease === null)
      return;
    try {
      const released = lease.release();
      if (!released.ok)
        recordInternalError(released.error);
    } catch (reason) {
      recordInternalError(reason);
    }
  };
  const beginLease = () => {
    if (captured.beginActivity === undefined)
      return ok(null);
    try {
      const started = captured.beginActivity(captured.activityNamespace);
      return started.ok ? ok(started.value) : err(renderUnknownReason(started.error, "Activity scope failed"));
    } catch (reason) {
      return err(renderUnknownReason(reason, "Activity scope threw"));
    }
  };
  const fail = (error) => {
    recordInternalError(`${error.code}: ${error.message}`);
    return err(Object.freeze({ kind: "transport", error }));
  };
  const disposedFailure = (step = null, expected = null, actual = null) => err(Object.freeze({
    kind: "transport",
    error: currentError("transport-disposed", "The scripted transport has been disposed", step, expected, actual)
  }));
  const dispose = () => {
    if (disposed)
      return;
    disposed = true;
    listeners.clear();
    for (const cancel of [...activeCancellations]) {
      try {
        cancel();
      } catch (reason) {
        recordInternalError(reason);
      }
    }
    activeCancellations.clear();
    try {
      disposalController.abort();
    } catch (reason) {
      recordInternalError(reason);
    }
    notifyIdle();
    return;
  };
  const request = (input) => {
    if (disposed)
      return Promise.resolve(disposedFailure());
    const parsedRequest = parseAndCloneWorld(input, captured.parseRequest);
    if (!parsedRequest.ok) {
      if (disposed)
        return Promise.resolve(disposedFailure());
      return Promise.resolve(fail(currentError("invalid-request", parsedRequest.error.message)));
    }
    if (disposed)
      return Promise.resolve(disposedFailure(null, null, parsedRequest.value));
    const requestCanonical = canonicalJson(parsedRequest.value);
    if (!requestCanonical.ok) {
      return Promise.resolve(fail(currentError("invalid-request", requestCanonical.error.message)));
    }
    if (disposed)
      return Promise.resolve(disposedFailure(null, null, parsedRequest.value));
    const step = parsedSteps.value[nextStep];
    if (step === undefined) {
      return Promise.resolve(fail(currentError("unexpected-request", "Transport received a request after its script was exhausted", nextStep, null, parsedRequest.value)));
    }
    if (requestCanonical.value !== step.requestCanonical) {
      return Promise.resolve(fail(currentError("request-mismatch", `Request does not match scripted step ${String(nextStep)}`, nextStep, step.request, parsedRequest.value)));
    }
    const stepIndex = nextStep;
    nextStep += 1;
    pending += 1;
    const lease = beginLease();
    if (!lease.ok) {
      pending -= 1;
      notifyIdle();
      if (disposed) {
        return Promise.resolve(disposedFailure(stepIndex, step.request, parsedRequest.value));
      }
      return Promise.resolve(fail(currentError("activity-failed", lease.error, stepIndex, step.request, parsedRequest.value)));
    }
    if (disposed) {
      settleLease(lease.value);
      pending -= 1;
      notifyIdle();
      return Promise.resolve(disposedFailure(stepIndex, step.request, parsedRequest.value));
    }
    return new Promise((resolve) => {
      let completed = false;
      let finalized = false;
      const finalize = (deliverAfterEvents) => {
        if (finalized)
          return;
        finalized = true;
        activeCancellations.delete(cancel);
        if (deliverAfterEvents && !disposed)
          emit(step.eventsAfter);
        settleLease(lease.value);
        if (pending > 0)
          pending -= 1;
        else
          recordInternalError("Transport pending-delivery accounting underflow");
        notifyIdle();
      };
      const scheduleFinalize = (deliverAfterEvents) => {
        try {
          queueMicrotask(() => finalize(deliverAfterEvents));
        } catch (reason) {
          recordInternalError(reason);
          finalize(deliverAfterEvents);
        }
      };
      const complete = (result, deliverAfterEvents) => {
        if (completed)
          return;
        completed = true;
        resolve(result);
        scheduleFinalize(deliverAfterEvents);
      };
      const completeTransportFailure = (code, message) => {
        complete(fail(currentError(code, message, stepIndex, step.request, parsedRequest.value)), false);
      };
      const cancel = () => {
        if (!completed) {
          completed = true;
          resolve(disposedFailure(stepIndex, step.request, parsedRequest.value));
        }
        finalize(false);
      };
      activeCancellations.add(cancel);
      if (disposed) {
        cancel();
        return;
      }
      const execute = async () => {
        if (!emit(step.eventsBefore)) {
          cancel();
          return;
        }
        let waited;
        try {
          waited = await captured.wait(step.delayMs, disposalController.signal);
        } catch (reason) {
          if (disposed) {
            cancel();
            return;
          }
          completeTransportFailure("logical-wait-failed", `Logical wait failed: ${renderUnknownReason(reason, "Logical wait threw")}`);
          return;
        }
        if (disposed) {
          cancel();
          return;
        }
        if (!waited.ok) {
          completeTransportFailure("logical-wait-failed", runtimeFailureMessage(waited.error));
          return;
        }
        const outcome = step.outcome.kind === "response" ? ok(step.outcome.value) : err(Object.freeze({
          kind: "scripted",
          failure: step.outcome.error
        }));
        complete(outcome, true);
      };
      execute().catch((reason) => {
        completeTransportFailure("internal-failure", `Transport delivery failed: ${renderUnknownReason(reason)}`);
      });
    });
  };
  const assertNoInternalError = () => {
    const failure = internalError();
    return failure === null ? ok(true) : err(failure);
  };
  const transport = {
    request,
    subscribe: (listener) => {
      if (disposed)
        return () => {
          return;
        };
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active)
          return;
        active = false;
        listeners.delete(listener);
        return;
      };
    },
    dispose,
    isDisposed: () => disposed,
    remainingSteps,
    pendingDeliveries: () => pending,
    violationCount: () => internalErrors.length + droppedInternalErrors,
    whenIdle: async () => {
      while (pending !== 0) {
        await new Promise((resolve) => {
          idleWaiters.push(resolve);
        });
      }
      return assertNoInternalError();
    },
    assertDrained: () => {
      const failure = internalError();
      if (failure !== null)
        return err(failure);
      if (pending !== 0) {
        return err(currentError("pending-deliveries", `${String(pending)} transport deliveries are still pending`));
      }
      if (remainingSteps() !== 0) {
        return err(currentError("remaining-steps", `${String(remainingSteps())} scripted transport steps remain`));
      }
      return ok(true);
    }
  };
  return ok(Object.freeze(transport));
}

// src/testing/index.ts
function parseCoverageCatalogSnapshot2(input) {
  return parseCoverageCatalogSnapshot(input);
}
export {
  parseExpectedCoverageCatalogSnapshot,
  parseDirectSessionManifest,
  parseDirectProbeSnapshot,
  parseDefinitionCoverageSnapshot,
  parseCoverageCatalogSnapshot2 as parseCoverageCatalogSnapshot,
  createExactScriptedTransport,
  createDirectSessionManifest,
  createDirectSession,
  createDirectProbe,
  createDirectActivityScope,
  classifyCoverageEvidence,
  MAX_DIRECT_PROBE_COUNTERS,
  DIRECT_SESSION_MANIFEST_SCHEMA,
  DIRECT_PROBE_SCHEMA,
  DIRECT_CATALOG_HASH_ALGORITHM,
  DEFAULT_SCRIPTED_TRANSPORT_LIMITS
};
