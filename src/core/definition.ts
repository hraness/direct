import {
  DIRECT_COVERAGE_SCHEMA,
  createCoverageCatalog,
  parseCoverageCatalogSnapshot,
  type CoverageCatalog,
  type CoverageEntryInput,
  type CoverageError,
} from "./coverage.js";
import {
  DEFAULT_MAX_FIXTURE_BYTES,
  createFixtureEnvelope,
  parseFixtureEnvelope,
  parseFixtureJson,
  serializeFixtureJson,
  type FixtureCreateInput,
  type FixtureEnvelope,
  type FixtureError,
} from "./fixture.js";
import type { ScenarioId } from "./ids.js";
import { parseJsonValue, type WorldParser } from "./json.js";
import type { JsonValue } from "./json-value.js";
import { renderUnknownReason } from "./reason.js";
import {
  DEFAULT_MAX_QUERY_BYTES,
  activateDirectScenario,
  maximumFixtureQueryBytes,
  parseDirectQuery,
  type ActiveDirect,
  type QueryError,
} from "./query.js";
import { err, isRecord, ok, type Result } from "./result.js";
import { parseLogicalRuntimeSnapshot } from "./runtime.js";
import {
  createScenarioCatalog,
  type ScenarioCatalog,
  type ScenarioCatalogError,
  type ScenarioDefinition,
  type ScenarioDefinitionInput,
} from "./scenario.js";

export interface DirectDefinitionInput<World extends JsonValue, Route extends string> {
  readonly parseWorld: WorldParser<World>;
  readonly defaultScenario: ScenarioId | string;
  readonly scenarios: readonly ScenarioDefinitionInput<World, Route>[];
  readonly coverage: readonly CoverageEntryInput[];
  readonly maxFixtureBytes?: number;
  readonly maxQueryBytes?: number;
}

export type DirectDefinitionError =
  | {
    readonly code: "invalid-options";
    readonly message: string;
    readonly scenarioError: null;
    readonly coverageError: null;
  }
  | {
    readonly code: "invalid-scenarios";
    readonly message: string;
    readonly scenarioError: ScenarioCatalogError;
    readonly coverageError: null;
  }
  | {
    readonly code: "invalid-default-scenario";
    readonly message: string;
    readonly scenarioError: ScenarioCatalogError;
    readonly coverageError: null;
  }
  | {
    readonly code: "invalid-coverage";
    readonly message: string;
    readonly scenarioError: null;
    readonly coverageError: CoverageError;
  }
  | {
    readonly code: "invalid-limits";
    readonly message: string;
    readonly scenarioError: null;
    readonly coverageError: null;
  };

export interface DirectDefinitionLimits {
  readonly maxFixtureBytes: number;
  readonly maxQueryBytes: number;
}

export interface DirectDefinition<World extends JsonValue, Route extends string> {
  readonly defaultScenario: ScenarioDefinition<World, Route>;
  readonly scenarios: ScenarioCatalog<World, Route>;
  readonly coverage: CoverageCatalog;
  readonly parseWorld: WorldParser<World>;
  readonly limits: DirectDefinitionLimits;
  /** Parse a foreign query. An empty query activates the validated default scenario. */
  readonly activate: (source: unknown) => Result<ActiveDirect<World, Route>, QueryError>;
  /** Activate a named catalog scenario without going through a browser URL. */
  readonly activateScenario: (scenario: unknown) => Result<ActiveDirect<World, Route>, QueryError>;
  /** Parse a foreign fixture under this definition's catalog, parser, and byte limit. */
  readonly parseFixture: (input: unknown) => Result<FixtureEnvelope<World, Route>, FixtureError>;
  /** Parse fixture JSON under this definition's catalog, parser, and byte limit. */
  readonly parseFixtureJson: (source: unknown) => Result<FixtureEnvelope<World, Route>, FixtureError>;
  /** Create a fixture under this definition's catalog, parser, and byte limit. */
  readonly createFixture: (
    input: FixtureCreateInput<World>,
  ) => Result<FixtureEnvelope<World, Route>, FixtureError>;
  /** Serialize a fixture that this definition can activate. */
  readonly serializeFixture: (input: FixtureCreateInput<World>) => Result<string, FixtureError>;
}

function definitionError(
  code: DirectDefinitionError["code"],
  message: string,
  causes: {
    readonly scenarioError?: ScenarioCatalogError;
    readonly coverageError?: CoverageError;
  } = {},
): DirectDefinitionError {
  if (code === "invalid-scenarios" || code === "invalid-default-scenario") {
    const scenarioError = causes.scenarioError;
    if (scenarioError === undefined) throw new Error(`${code} requires a scenario error`);
    return Object.freeze({ code, message, scenarioError, coverageError: null });
  }
  if (code === "invalid-coverage") {
    const coverageError = causes.coverageError;
    if (coverageError === undefined) throw new Error("invalid-coverage requires a coverage error");
    return Object.freeze({ code, message, scenarioError: null, coverageError });
  }
  return Object.freeze({ code, message, scenarioError: null, coverageError: null });
}

function validPositiveLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function activeFromParsed<World extends JsonValue, Route extends string>(
  parsed: ReturnType<typeof parseDirectQuery<World, Route>>,
): Result<ActiveDirect<World, Route>, QueryError> {
  if (!parsed.ok) return parsed;
  if (parsed.value.kind === "active") return ok(parsed.value);
  return err({ code: "invalid-scenario", message: "Direct activation did not select a scenario" });
}

/**
 * Validate the product-owned world parser, scenarios, default activation, and
 * proof catalog once, then expose one fail-closed activation boundary.
 */
function tryDefineDirectUnchecked<World extends JsonValue, Route extends string>(
  input: DirectDefinitionInput<World, Route>,
): Result<DirectDefinition<World, Route>, DirectDefinitionError> {
  const parseWorld = input.parseWorld;
  const defaultScenarioInput = input.defaultScenario;
  const scenarioInputs = input.scenarios;
  const coverageInputs = input.coverage;
  const maxFixtureBytes = input.maxFixtureBytes ?? DEFAULT_MAX_FIXTURE_BYTES;
  const maxQueryBytes = input.maxQueryBytes ?? DEFAULT_MAX_QUERY_BYTES;
  if (!validPositiveLimit(maxFixtureBytes) || !validPositiveLimit(maxQueryBytes)) {
    return err(definitionError(
      "invalid-limits",
      "Direct query and fixture limits must be positive safe integers",
    ));
  }
  const requiredQueryBytes = maximumFixtureQueryBytes(maxFixtureBytes);
  if (!Number.isSafeInteger(requiredQueryBytes) || maxQueryBytes < requiredQueryBytes) {
    return err(definitionError(
      "invalid-limits",
      `Direct maxQueryBytes must be at least ${String(requiredQueryBytes)} to carry every bounded fixture`,
    ));
  }

  const scenarios = createScenarioCatalog(scenarioInputs, parseWorld);
  if (!scenarios.ok) {
    return err(definitionError("invalid-scenarios", scenarios.error.message, {
      scenarioError: scenarios.error,
    }));
  }
  const defaultScenario = scenarios.value.resolve(defaultScenarioInput);
  if (!defaultScenario.ok) {
    return err(definitionError("invalid-default-scenario", defaultScenario.error.message, {
      scenarioError: defaultScenario.error,
    }));
  }
  const coverage = createCoverageCatalog(coverageInputs, scenarios.value);
  if (!coverage.ok) {
    return err(definitionError("invalid-coverage", coverage.error.message, {
      coverageError: coverage.error,
    }));
  }

  const limits = Object.freeze({ maxFixtureBytes, maxQueryBytes });
  const fixtureOptions = Object.freeze({
    scenarios: scenarios.value,
    parseWorld,
    maxBytes: maxFixtureBytes,
  });
  const queryOptions = Object.freeze({
    ...fixtureOptions,
    maxQueryBytes,
  });
  const activateScenario = (
    scenario: unknown,
  ): Result<ActiveDirect<World, Route>, QueryError> => activateDirectScenario(
    scenario,
    scenarios.value,
  );
  const activate = (source: unknown): Result<ActiveDirect<World, Route>, QueryError> => {
    const parsed = parseDirectQuery(source, queryOptions);
    if (!parsed.ok || parsed.value.kind === "active") return activeFromParsed(parsed);
    return activateScenario(defaultScenario.value.id);
  };

  return ok(Object.freeze({
    defaultScenario: defaultScenario.value,
    scenarios: scenarios.value,
    coverage: coverage.value,
    parseWorld,
    limits,
    activate,
    activateScenario,
    parseFixture: (fixture: unknown) => parseFixtureEnvelope(fixture, fixtureOptions),
    parseFixtureJson: (source: unknown) => parseFixtureJson(source, fixtureOptions),
    createFixture: (fixture: FixtureCreateInput<World>) => createFixtureEnvelope(fixture, fixtureOptions),
    serializeFixture: (fixture: FixtureCreateInput<World>) => serializeFixtureJson(fixture, fixtureOptions),
  }));
}

/** Validate a typed dynamically assembled definition without throwing. */
export function tryDefineDirect<World extends JsonValue, Route extends string>(
  input: DirectDefinitionInput<World, Route>,
): Result<DirectDefinition<World, Route>, DirectDefinitionError> {
  try {
    return tryDefineDirectUnchecked(input);
  } catch (reason) {
    return err(definitionError(
      "invalid-options",
      renderUnknownReason(reason, "Direct definition options could not be inspected"),
    ));
  }
}

const DEFINITION_INPUT_KEYS = new Set([
  "coverage",
  "defaultScenario",
  "maxFixtureBytes",
  "maxQueryBytes",
  "parseWorld",
  "scenarios",
]);
const SCENARIO_INPUT_KEYS = new Set([
  "description",
  "id",
  "route",
  "runtime",
  "title",
  "world",
]);

/**
 * Parse a genuinely foreign definition value. Its world and route types remain
 * broad because unknown configuration cannot supply compile-time refinements.
 */
export function parseDirectDefinition(
  input: unknown,
): Result<DirectDefinition<JsonValue, string>, DirectDefinitionError> {
  try {
    if (!isRecord(input)) throw new Error("Direct definition must be an object");
    for (const key of Object.keys(input)) {
      if (!DEFINITION_INPUT_KEYS.has(key)) throw new Error(`Unknown Direct definition key: ${key}`);
    }
    const rawParser = input.parseWorld;
    if (typeof rawParser !== "function") throw new Error("Direct parseWorld must be a function");
    const parseWorld: WorldParser<JsonValue> = (candidate) => {
      const parsedCandidate: unknown = Reflect.apply(rawParser, undefined, [candidate]);
      const parsedJson = parseJsonValue(parsedCandidate);
      if (!parsedJson.ok) throw new Error(parsedJson.error.message);
      return parsedJson.value;
    };
    if (typeof input.defaultScenario !== "string") {
      throw new Error("Direct defaultScenario must be a string");
    }
    if (!Array.isArray(input.scenarios)) throw new Error("Direct scenarios must be an array");
    const scenarios: ScenarioDefinitionInput<JsonValue, string>[] = [];
    for (const [index, candidate] of input.scenarios.entries()) {
      if (!isRecord(candidate)) throw new Error(`Direct scenario ${String(index)} must be an object`);
      for (const key of Object.keys(candidate)) {
        if (!SCENARIO_INPUT_KEYS.has(key)) {
          throw new Error(`Unknown Direct scenario key at ${String(index)}: ${key}`);
        }
      }
      if (
        typeof candidate.id !== "string"
        || typeof candidate.title !== "string"
        || typeof candidate.route !== "string"
        || (candidate.description !== undefined && typeof candidate.description !== "string")
      ) {
        throw new Error(`Direct scenario ${String(index)} has an invalid shape`);
      }
      const world = parseJsonValue(candidate.world);
      if (!world.ok) throw new Error(`Direct scenario ${String(index)} world is invalid: ${world.error.message}`);
      const runtime = candidate.runtime === undefined
        ? undefined
        : parseLogicalRuntimeSnapshot(candidate.runtime);
      if (runtime !== undefined && !runtime.ok) {
        throw new Error(`Direct scenario ${String(index)} runtime is invalid: ${runtime.error.message}`);
      }
      scenarios.push({
        id: candidate.id,
        title: candidate.title,
        ...(candidate.description === undefined ? {} : { description: candidate.description }),
        route: candidate.route,
        world: world.value,
        ...(runtime === undefined ? {} : { runtime: runtime.value }),
      });
    }
    const coverage = parseCoverageCatalogSnapshot({
      schema: DIRECT_COVERAGE_SCHEMA,
      entries: input.coverage,
    });
    if (!coverage.ok) {
      return err(definitionError("invalid-coverage", coverage.error.message, {
        coverageError: coverage.error,
      }));
    }
    const maxFixtureBytes = input.maxFixtureBytes;
    const maxQueryBytes = input.maxQueryBytes;
    if (maxFixtureBytes !== undefined && typeof maxFixtureBytes !== "number") {
      throw new Error("Direct maxFixtureBytes must be a number");
    }
    if (maxQueryBytes !== undefined && typeof maxQueryBytes !== "number") {
      throw new Error("Direct maxQueryBytes must be a number");
    }
    return tryDefineDirectUnchecked({
      parseWorld,
      defaultScenario: input.defaultScenario,
      scenarios,
      coverage: coverage.value.entries,
      ...(maxFixtureBytes === undefined ? {} : { maxFixtureBytes }),
      ...(maxQueryBytes === undefined ? {} : { maxQueryBytes }),
    });
  } catch (reason) {
    return err(definitionError(
      "invalid-options",
      renderUnknownReason(reason, "Direct definition options could not be inspected"),
    ));
  }
}

/**
 * Define an authored Direct composition.
 *
 * Configuration failures are programming errors at this boundary, so this
 * concise path throws with the structured definition error as its cause. Use
 * `tryDefineDirect` for typed dynamic assembly and
 * `parseDirectDefinition` for a genuinely unknown value.
 */
export function defineDirect<
  World extends JsonValue,
  const Scenarios extends readonly {
    readonly id: string;
    readonly route: string;
  }[],
>(
  input: {
    readonly parseWorld: WorldParser<World>;
    readonly defaultScenario: NoInfer<Scenarios>[number]["id"];
    readonly scenarios: Scenarios & readonly ScenarioDefinitionInput<
      World,
      Scenarios[number]["route"]
    >[];
    readonly coverage: readonly CoverageEntryInput<NoInfer<Scenarios>[number]["id"]>[];
    readonly maxFixtureBytes?: number;
    readonly maxQueryBytes?: number;
  },
): DirectDefinition<World, Scenarios[number]["route"]> {
  const defined = tryDefineDirect(input);
  if (!defined.ok) {
    throw new Error(defined.error.message, { cause: defined.error });
  }
  return defined.value;
}
