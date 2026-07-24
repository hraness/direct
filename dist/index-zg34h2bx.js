import {
  DEFAULT_LOGICAL_RUNTIME_SNAPSHOT,
  parseLogicalRuntimeSnapshot
} from "./index-wqwbtetw.js";
import {
  canonicalJson,
  err,
  isRecord,
  ok,
  parseAndCloneWorld,
  parseExactJsonSource,
  parseScenarioId,
  stableHash,
  utf8ByteLength
} from "./index-541zzq54.js";

// src/core/fixture.ts
var FIXTURE_SCHEMA = "direct.fixture/v1";
var DEFAULT_MAX_FIXTURE_BYTES = 65536;
var FIXTURE_KEYS = new Set(["schema", "scenario", "route", "world", "runtime"]);
function fixtureError(code, message) {
  return { code, message };
}
function maxFixtureBytes(value) {
  const maximum = value ?? DEFAULT_MAX_FIXTURE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Fixture maxBytes must be a positive safe integer");
  }
  return maximum;
}
function parseFixtureEnvelope(input, options) {
  const maximum = maxFixtureBytes(options.maxBytes);
  const serialized = canonicalJson(input);
  if (!serialized.ok) {
    return err(fixtureError("invalid-fixture", serialized.error.message));
  }
  if (utf8ByteLength(serialized.value) > maximum) {
    return err(fixtureError("oversized-fixture", "Fixture exceeds its byte limit"));
  }
  const foreign = JSON.parse(serialized.value);
  if (!isRecord(foreign)) {
    return err(fixtureError("invalid-fixture", "Fixture must be an object"));
  }
  for (const key of Object.keys(foreign)) {
    if (!FIXTURE_KEYS.has(key)) {
      return err(fixtureError("unknown-key", `Unknown fixture key: ${key}`));
    }
  }
  if (foreign.schema !== FIXTURE_SCHEMA) {
    return err(fixtureError("invalid-fixture", `Fixture schema must be ${FIXTURE_SCHEMA}`));
  }
  const id = parseScenarioId(foreign.scenario);
  if (!id.ok) {
    return err(fixtureError("invalid-scenario", id.error.message));
  }
  const scenario = options.scenarios.get(id.value);
  if (scenario === undefined) {
    return err(fixtureError("unknown-scenario", `Unknown fixture scenario: ${id.value}`));
  }
  if (typeof foreign.route !== "string" || foreign.route !== scenario.route) {
    return err(fixtureError("mismatched-route", `Fixture route must match scenario ${id.value}`));
  }
  const runtime = foreign.runtime === undefined ? ok(scenario.runtime) : parseLogicalRuntimeSnapshot(foreign.runtime);
  if (!runtime.ok) {
    return err(fixtureError("invalid-runtime", runtime.error.message));
  }
  const world = parseAndCloneWorld(foreign.world, options.parseWorld);
  if (!world.ok) {
    return err(fixtureError("invalid-world", world.error.message));
  }
  const envelope = Object.freeze({
    schema: FIXTURE_SCHEMA,
    scenario: id.value,
    route: scenario.route,
    world: world.value,
    runtime: runtime.value
  });
  const normalized = canonicalJson(envelope);
  if (!normalized.ok) {
    return err(fixtureError("invalid-fixture", normalized.error.message));
  }
  if (utf8ByteLength(normalized.value) > maximum) {
    return err(fixtureError("oversized-fixture", "Normalized fixture exceeds its byte limit"));
  }
  return ok(envelope);
}
function parseFixtureJson(source, options) {
  if (typeof source !== "string") {
    return err(fixtureError("invalid-json", "Fixture JSON source must be a string"));
  }
  if (utf8ByteLength(source) > maxFixtureBytes(options.maxBytes)) {
    return err(fixtureError("oversized-fixture", "Fixture exceeds its byte limit"));
  }
  const input = parseExactJsonSource(source);
  if (!input.ok) {
    return err(fixtureError(input.error.code === "duplicate-key" ? "duplicate-key" : "invalid-json", input.error.code === "duplicate-key" ? input.error.message : "Fixture is not valid JSON"));
  }
  return parseFixtureEnvelope(input.value, options);
}
function createFixtureEnvelope(input, options) {
  const id = parseScenarioId(input.scenario);
  if (!id.ok)
    return err(fixtureError("invalid-scenario", id.error.message));
  const scenario = options.scenarios.get(id.value);
  if (scenario === undefined) {
    return err(fixtureError("unknown-scenario", `Unknown fixture scenario: ${id.value}`));
  }
  return parseFixtureEnvelope({
    schema: FIXTURE_SCHEMA,
    scenario: id.value,
    route: scenario.route,
    world: input.world,
    runtime: input.runtime ?? scenario.runtime
  }, options);
}
function serializeFixtureJson(input, options) {
  const fixture = createFixtureEnvelope(input, options);
  if (!fixture.ok)
    return fixture;
  const serialized = canonicalJson(fixture.value);
  if (!serialized.ok) {
    return err(fixtureError("invalid-fixture", serialized.error.message));
  }
  if (utf8ByteLength(serialized.value) > maxFixtureBytes(options.maxBytes)) {
    return err(fixtureError("oversized-fixture", "Normalized fixture exceeds its byte limit"));
  }
  return ok(serialized.value);
}

// src/core/query.ts
var SCENARIO_QUERY_KEY = "__direct_scenario";
var FIXTURE_QUERY_KEY = "__direct_fixture";
var FIXTURE_QUERY_PREFIX_BYTES = utf8ByteLength(`?${FIXTURE_QUERY_KEY}=`);
function maximumFixtureQueryBytes(maxFixtureBytes2) {
  return maxFixtureBytes2 * 3 + FIXTURE_QUERY_PREFIX_BYTES;
}
var DEFAULT_MAX_QUERY_BYTES = maximumFixtureQueryBytes(DEFAULT_MAX_FIXTURE_BYTES);
function queryError(code, message) {
  return { code, message };
}
function decodeQueryPart(value) {
  try {
    return ok(decodeURIComponent(value.replaceAll("+", " ")));
  } catch {
    return err(queryError("invalid-encoding", "Direct query contains invalid percent encoding"));
  }
}
function queryBody(source) {
  const question = source.indexOf("?");
  const candidate = question >= 0 ? source.slice(question + 1) : source.startsWith("?") ? source.slice(1) : source;
  const fragment = candidate.indexOf("#");
  return fragment >= 0 ? candidate.slice(0, fragment) : candidate;
}
function parseActivationParameters(source) {
  let scenario = null;
  let fixture = null;
  const body = queryBody(source);
  if (body.length === 0) {
    return ok({ scenario, fixture });
  }
  for (const part of body.split("&")) {
    if (part.length === 0) {
      continue;
    }
    const equals = part.indexOf("=");
    const encodedKey = equals < 0 ? part : part.slice(0, equals);
    const encodedValue = equals < 0 ? "" : part.slice(equals + 1);
    const key = decodeQueryPart(encodedKey);
    if (!key.ok) {
      return key;
    }
    const reserved = key.value.startsWith("__direct_");
    if (key.value !== SCENARIO_QUERY_KEY && key.value !== FIXTURE_QUERY_KEY) {
      if (reserved) {
        return err(queryError("unknown-parameter", `Unknown Direct query parameter: ${key.value}`));
      }
      continue;
    }
    const value = decodeQueryPart(encodedValue);
    if (!value.ok) {
      return value;
    }
    if (key.value === SCENARIO_QUERY_KEY) {
      if (scenario !== null) {
        return err(queryError("duplicate-parameter", `Duplicate ${SCENARIO_QUERY_KEY} parameter`));
      }
      scenario = value.value;
    } else {
      if (fixture !== null) {
        return err(queryError("duplicate-parameter", `Duplicate ${FIXTURE_QUERY_KEY} parameter`));
      }
      fixture = value.value;
    }
  }
  return ok({ scenario, fixture });
}
function activationHash(source, scenario, route, world, runtime) {
  const hashed = stableHash({ source, scenario, route, world, runtime });
  if (!hashed.ok) {
    throw new Error(hashed.error.message);
  }
  return `${hashed.value.algorithm}:${hashed.value.value}`;
}
function activateDirectScenario(id, scenarios) {
  const parsed = parseScenarioId(id);
  if (!parsed.ok) {
    return err(queryError("invalid-scenario", parsed.error.message));
  }
  const scenario = scenarios.get(parsed.value);
  if (scenario === undefined) {
    return err(queryError("unknown-scenario", `Unknown scenario: ${parsed.value}`));
  }
  return ok(Object.freeze({
    kind: "active",
    source: "scenario",
    scenario: scenario.id,
    route: scenario.route,
    world: scenario.world,
    runtime: scenario.runtime,
    activationHash: activationHash("scenario", scenario.id, scenario.route, scenario.world, scenario.runtime)
  }));
}
function parseDirectQuery(source, options) {
  const maxBytes = options.maxQueryBytes ?? DEFAULT_MAX_QUERY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Query maxQueryBytes must be a positive safe integer");
  }
  if (typeof source !== "string") {
    return err(queryError("invalid-query", "Direct query source must be a string"));
  }
  if (utf8ByteLength(source) > maxBytes) {
    return err(queryError("oversized-query", "Direct query exceeds its byte limit"));
  }
  const parameters = parseActivationParameters(source);
  if (!parameters.ok) {
    return parameters;
  }
  if (parameters.value.scenario === null && parameters.value.fixture === null) {
    return ok(Object.freeze({ kind: "inactive" }));
  }
  const requestedScenario = parameters.value.scenario === null ? null : activateDirectScenario(parameters.value.scenario, options.scenarios);
  if (requestedScenario !== null && !requestedScenario.ok) {
    return requestedScenario;
  }
  if (parameters.value.fixture === null) {
    return requestedScenario ?? err(queryError("invalid-scenario", "Missing scenario activation"));
  }
  const fixture = parseFixtureJson(parameters.value.fixture, options);
  if (!fixture.ok) {
    return err(queryError("invalid-fixture", fixture.error.message));
  }
  if (requestedScenario !== null && requestedScenario.value.scenario !== fixture.value.scenario) {
    return err(queryError("mismatched-scenario", `${SCENARIO_QUERY_KEY} does not match the fixture scenario`));
  }
  return ok(Object.freeze({
    kind: "active",
    source: "fixture",
    scenario: fixture.value.scenario,
    route: fixture.value.route,
    world: fixture.value.world,
    runtime: fixture.value.runtime,
    activationHash: activationHash("fixture", fixture.value.scenario, fixture.value.route, fixture.value.world, fixture.value.runtime)
  }));
}

// src/core/scenario.ts
function validText(value, maximum) {
  if (value.trim().length === 0 || value.length > maximum) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 || code === 127) {
      return false;
    }
  }
  return true;
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
function scenarioError(code, scenario, message) {
  return { code, scenario, message };
}
function createScenarioCatalog(inputs, parseWorld) {
  const definitions = [];
  const byId = new Map;
  for (const input of inputs) {
    const id = parseScenarioId(input.id);
    if (!id.ok) {
      return err(scenarioError("invalid-scenario", input.id, id.error.message));
    }
    if (byId.has(id.value)) {
      return err(scenarioError("duplicate-scenario", id.value, `Duplicate scenario: ${id.value}`));
    }
    if (!validText(input.title, 160)) {
      return err(scenarioError("invalid-title", id.value, "Scenario titles must contain 1-160 visible characters"));
    }
    if (input.description !== undefined && !validText(input.description, 2000)) {
      return err(scenarioError("invalid-description", id.value, "Scenario descriptions must contain 1-2000 visible characters"));
    }
    if (!validRoute(input.route)) {
      return err(scenarioError("invalid-route", id.value, "Scenario routes must contain 1-256 visible characters"));
    }
    const runtime = parseLogicalRuntimeSnapshot(input.runtime ?? DEFAULT_LOGICAL_RUNTIME_SNAPSHOT);
    if (!runtime.ok) {
      return err(scenarioError("invalid-runtime", id.value, runtime.error.message));
    }
    const world = parseAndCloneWorld(input.world, parseWorld);
    if (!world.ok) {
      return err(scenarioError("invalid-world", id.value, world.error.message));
    }
    const definition = Object.freeze({
      id: id.value,
      title: input.title,
      description: input.description ?? null,
      route: input.route,
      world: world.value,
      runtime: runtime.value
    });
    definitions.push(definition);
    byId.set(id.value, definition);
  }
  const frozenDefinitions = Object.freeze(definitions);
  return ok(Object.freeze({
    size: frozenDefinitions.length,
    list: () => frozenDefinitions,
    get: (id) => byId.get(id),
    resolve: (input) => {
      const id = parseScenarioId(input);
      if (!id.ok) {
        return err(scenarioError("invalid-scenario", input, id.error.message));
      }
      const definition = byId.get(id.value);
      return definition === undefined ? err(scenarioError("unknown-scenario", id.value, `Unknown scenario: ${id.value}`)) : ok(definition);
    }
  }));
}

export { FIXTURE_SCHEMA, DEFAULT_MAX_FIXTURE_BYTES, parseFixtureEnvelope, parseFixtureJson, createFixtureEnvelope, serializeFixtureJson, SCENARIO_QUERY_KEY, FIXTURE_QUERY_KEY, maximumFixtureQueryBytes, DEFAULT_MAX_QUERY_BYTES, activateDirectScenario, parseDirectQuery, createScenarioCatalog };
