import { parseScenarioId, type ScenarioId } from "./ids.js";
import {
  canonicalJson,
  parseAndCloneWorld,
  parseExactJsonSource,
  utf8ByteLength,
  type WorldParser,
} from "./json.js";
import type { JsonValue } from "./json-value.js";
import { err, isRecord, ok, type Result } from "./result.js";
import { parseLogicalRuntimeSnapshot, type LogicalRuntimeSnapshot } from "./runtime.js";
import type { ScenarioCatalog } from "./scenario.js";

export const FIXTURE_SCHEMA = "direct.fixture/v1" as const;
export const DEFAULT_MAX_FIXTURE_BYTES = 65_536;

export interface FixtureEnvelope<World extends JsonValue, Route extends string> {
  readonly schema: typeof FIXTURE_SCHEMA;
  readonly scenario: ScenarioId;
  readonly route: Route;
  readonly world: World;
  readonly runtime: LogicalRuntimeSnapshot;
}

export type FixtureErrorCode =
  | "duplicate-key"
  | "invalid-fixture"
  | "invalid-json"
  | "invalid-runtime"
  | "invalid-scenario"
  | "invalid-world"
  | "mismatched-route"
  | "oversized-fixture"
  | "unknown-key"
  | "unknown-scenario";

export interface FixtureError {
  readonly code: FixtureErrorCode;
  readonly message: string;
}

export interface FixtureParseOptions<World extends JsonValue, Route extends string> {
  readonly scenarios: ScenarioCatalog<World, Route>;
  readonly parseWorld: WorldParser<World>;
  readonly maxBytes?: number;
}

export interface FixtureCreateInput<World extends JsonValue> {
  readonly scenario: ScenarioId | string;
  readonly world: World;
  readonly runtime?: LogicalRuntimeSnapshot;
}

const FIXTURE_KEYS = new Set(["schema", "scenario", "route", "world", "runtime"]);

function fixtureError(code: FixtureErrorCode, message: string): FixtureError {
  return { code, message };
}

function maxFixtureBytes(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_FIXTURE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Fixture maxBytes must be a positive safe integer");
  }
  return maximum;
}

export function parseFixtureEnvelope<World extends JsonValue, Route extends string>(
  input: unknown,
  options: FixtureParseOptions<World, Route>,
): Result<FixtureEnvelope<World, Route>, FixtureError> {
  const maximum = maxFixtureBytes(options.maxBytes);
  const serialized = canonicalJson(input);
  if (!serialized.ok) {
    return err(fixtureError("invalid-fixture", serialized.error.message));
  }
  if (utf8ByteLength(serialized.value) > maximum) {
    return err(fixtureError("oversized-fixture", "Fixture exceeds its byte limit"));
  }
  const foreign = JSON.parse(serialized.value) as unknown;
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
  const runtime = foreign.runtime === undefined
    ? ok(scenario.runtime)
    : parseLogicalRuntimeSnapshot(foreign.runtime);
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
    runtime: runtime.value,
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

export function parseFixtureJson<World extends JsonValue, Route extends string>(
  source: unknown,
  options: FixtureParseOptions<World, Route>,
): Result<FixtureEnvelope<World, Route>, FixtureError> {
  if (typeof source !== "string") {
    return err(fixtureError("invalid-json", "Fixture JSON source must be a string"));
  }
  if (utf8ByteLength(source) > maxFixtureBytes(options.maxBytes)) {
    return err(fixtureError("oversized-fixture", "Fixture exceeds its byte limit"));
  }
  const input = parseExactJsonSource(source);
  if (!input.ok) {
    return err(fixtureError(
      input.error.code === "duplicate-key" ? "duplicate-key" : "invalid-json",
      input.error.code === "duplicate-key" ? input.error.message : "Fixture is not valid JSON",
    ));
  }
  return parseFixtureEnvelope(input.value, options);
}

/** Create an exact fixture envelope while deriving its route from the catalog. */
export function createFixtureEnvelope<World extends JsonValue, Route extends string>(
  input: FixtureCreateInput<World>,
  options: FixtureParseOptions<World, Route>,
): Result<FixtureEnvelope<World, Route>, FixtureError> {
  const id = parseScenarioId(input.scenario);
  if (!id.ok) return err(fixtureError("invalid-scenario", id.error.message));
  const scenario = options.scenarios.get(id.value);
  if (scenario === undefined) {
    return err(fixtureError("unknown-scenario", `Unknown fixture scenario: ${id.value}`));
  }
  return parseFixtureEnvelope({
    schema: FIXTURE_SCHEMA,
    scenario: id.value,
    route: scenario.route,
    world: input.world,
    runtime: input.runtime ?? scenario.runtime,
  }, options);
}

/** Serialize a validated fixture with canonical key ordering. */
export function serializeFixtureJson<World extends JsonValue, Route extends string>(
  input: FixtureCreateInput<World>,
  options: FixtureParseOptions<World, Route>,
): Result<string, FixtureError> {
  const fixture = createFixtureEnvelope(input, options);
  if (!fixture.ok) return fixture;
  const serialized = canonicalJson(fixture.value);
  if (!serialized.ok) {
    return err(fixtureError("invalid-fixture", serialized.error.message));
  }
  if (utf8ByteLength(serialized.value) > maxFixtureBytes(options.maxBytes)) {
    return err(fixtureError("oversized-fixture", "Normalized fixture exceeds its byte limit"));
  }
  return ok(serialized.value);
}
