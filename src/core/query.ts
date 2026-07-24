import {
  DEFAULT_MAX_FIXTURE_BYTES,
  parseFixtureJson,
  type FixtureParseOptions,
} from "./fixture.js";
import { parseScenarioId, type ScenarioId } from "./ids.js";
import { stableHash, utf8ByteLength } from "./json.js";
import type { JsonValue } from "./json-value.js";
import { err, ok, type Result } from "./result.js";
import type { LogicalRuntimeSnapshot } from "./runtime.js";
import type { ScenarioCatalog } from "./scenario.js";

export const SCENARIO_QUERY_KEY = "__direct_scenario" as const;
export const FIXTURE_QUERY_KEY = "__direct_fixture" as const;
const FIXTURE_QUERY_PREFIX_BYTES = utf8ByteLength(`?${FIXTURE_QUERY_KEY}=`);

/** Worst-case percent-encoded query bytes for a bounded fixture JSON string. */
export function maximumFixtureQueryBytes(maxFixtureBytes: number): number {
  return (maxFixtureBytes * 3) + FIXTURE_QUERY_PREFIX_BYTES;
}

export const DEFAULT_MAX_QUERY_BYTES = maximumFixtureQueryBytes(DEFAULT_MAX_FIXTURE_BYTES);

export interface ActiveDirect<World extends JsonValue, Route extends string> {
  readonly kind: "active";
  readonly source: "scenario" | "fixture";
  readonly scenario: ScenarioId;
  readonly route: Route;
  readonly world: World;
  readonly runtime: LogicalRuntimeSnapshot;
  readonly activationHash: string;
}

export interface InactiveDirect {
  readonly kind: "inactive";
}

export type DirectActivation<World extends JsonValue, Route extends string> =
  | InactiveDirect
  | ActiveDirect<World, Route>;

export type QueryErrorCode =
  | "duplicate-parameter"
  | "invalid-encoding"
  | "invalid-fixture"
  | "invalid-query"
  | "invalid-scenario"
  | "mismatched-scenario"
  | "oversized-query"
  | "unknown-parameter"
  | "unknown-scenario";

export interface QueryError {
  readonly code: QueryErrorCode;
  readonly message: string;
}

export interface DirectQueryOptions<World extends JsonValue, Route extends string>
  extends FixtureParseOptions<World, Route> {
  readonly maxQueryBytes?: number;
}

function queryError(code: QueryErrorCode, message: string): QueryError {
  return { code, message };
}

function decodeQueryPart(value: string): Result<string, QueryError> {
  try {
    return ok(decodeURIComponent(value.replaceAll("+", " ")));
  } catch {
    return err(queryError("invalid-encoding", "Direct query contains invalid percent encoding"));
  }
}

function queryBody(source: string): string {
  const question = source.indexOf("?");
  const candidate = question >= 0 ? source.slice(question + 1) : source.startsWith("?") ? source.slice(1) : source;
  const fragment = candidate.indexOf("#");
  return fragment >= 0 ? candidate.slice(0, fragment) : candidate;
}

interface ParsedActivationQuery {
  readonly scenario: string | null;
  readonly fixture: string | null;
}

function parseActivationParameters(source: string): Result<ParsedActivationQuery, QueryError> {
  let scenario: string | null = null;
  let fixture: string | null = null;
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

function activationHash<World extends JsonValue, Route extends string>(
  source: "scenario" | "fixture",
  scenario: ScenarioId,
  route: Route,
  world: World,
  runtime: LogicalRuntimeSnapshot,
): string {
  const hashed = stableHash({ source, scenario, route, world, runtime });
  if (!hashed.ok) {
    throw new Error(hashed.error.message);
  }
  return `${hashed.value.algorithm}:${hashed.value.value}`;
}

export function activateDirectScenario<World extends JsonValue, Route extends string>(
  id: unknown,
  scenarios: ScenarioCatalog<World, Route>,
): Result<ActiveDirect<World, Route>, QueryError> {
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
    activationHash: activationHash("scenario", scenario.id, scenario.route, scenario.world, scenario.runtime),
  }));
}

export function parseDirectQuery<World extends JsonValue, Route extends string>(
  source: unknown,
  options: DirectQueryOptions<World, Route>,
): Result<DirectActivation<World, Route>, QueryError> {
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

  const requestedScenario = parameters.value.scenario === null
    ? null
    : activateDirectScenario(parameters.value.scenario, options.scenarios);
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
    return err(queryError(
      "mismatched-scenario",
      `${SCENARIO_QUERY_KEY} does not match the fixture scenario`,
    ));
  }
  return ok(Object.freeze({
    kind: "active",
    source: "fixture",
    scenario: fixture.value.scenario,
    route: fixture.value.route,
    world: fixture.value.world,
    runtime: fixture.value.runtime,
    activationHash: activationHash(
      "fixture",
      fixture.value.scenario,
      fixture.value.route,
      fixture.value.world,
      fixture.value.runtime,
    ),
  }));
}
