import { parseScenarioId, type ScenarioId } from "./ids.js";
import { parseAndCloneWorld, type WorldParser } from "./json.js";
import type { JsonValue } from "./json-value.js";
import { err, ok, type Result } from "./result.js";
import {
  DEFAULT_LOGICAL_RUNTIME_SNAPSHOT,
  parseLogicalRuntimeSnapshot,
  type LogicalRuntimeSnapshot,
} from "./runtime.js";

/** Maximum scenarios retained by one definition and discovery manifest. */
export const MAX_DIRECT_SCENARIOS = 256 as const;

export interface ScenarioDefinitionInput<World extends JsonValue, Route extends string> {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly route: Route;
  readonly world: World;
  readonly runtime?: LogicalRuntimeSnapshot;
}

export interface ScenarioDefinition<World extends JsonValue, Route extends string> {
  readonly id: ScenarioId;
  readonly title: string;
  readonly description: string | null;
  readonly route: Route;
  readonly world: World;
  readonly runtime: LogicalRuntimeSnapshot;
}

export type ScenarioCatalogErrorCode =
  | "duplicate-scenario"
  | "invalid-description"
  | "invalid-route"
  | "invalid-runtime"
  | "invalid-scenario"
  | "invalid-title"
  | "invalid-world"
  | "too-many-scenarios"
  | "unknown-scenario";

export interface ScenarioCatalogError {
  readonly code: ScenarioCatalogErrorCode;
  readonly scenario: unknown;
  readonly message: string;
}

export interface ScenarioCatalog<World extends JsonValue, Route extends string> {
  readonly size: number;
  readonly list: () => readonly ScenarioDefinition<World, Route>[];
  readonly get: (id: ScenarioId) => ScenarioDefinition<World, Route> | undefined;
  readonly resolve: (id: unknown) => Result<ScenarioDefinition<World, Route>, ScenarioCatalogError>;
}

function validText(value: string, maximum: number): boolean {
  if (value.trim().length === 0 || value.length > maximum) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return false;
    }
  }
  return true;
}

function validRoute(value: string): boolean {
  if (value.trim().length === 0 || value.length > 256) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function scenarioError(code: ScenarioCatalogErrorCode, scenario: unknown, message: string): ScenarioCatalogError {
  return { code, scenario, message };
}

export function createScenarioCatalog<World extends JsonValue, Route extends string>(
  inputs: readonly ScenarioDefinitionInput<World, Route>[],
  parseWorld: WorldParser<World>,
): Result<ScenarioCatalog<World, Route>, ScenarioCatalogError> {
  if (inputs.length > MAX_DIRECT_SCENARIOS) {
    return err(scenarioError(
      "too-many-scenarios",
      inputs.length,
      `Direct definitions support at most ${String(MAX_DIRECT_SCENARIOS)} scenarios`,
    ));
  }
  const definitions: ScenarioDefinition<World, Route>[] = [];
  const byId = new Map<ScenarioId, ScenarioDefinition<World, Route>>();

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
    if (input.description !== undefined && !validText(input.description, 2_000)) {
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
      runtime: runtime.value,
    });
    definitions.push(definition);
    byId.set(id.value, definition);
  }

  const frozenDefinitions = Object.freeze(definitions);
  return ok(Object.freeze({
    size: frozenDefinitions.length,
    list: () => frozenDefinitions,
    get: (id: ScenarioId) => byId.get(id),
    resolve: (input: unknown) => {
      const id = parseScenarioId(input);
      if (!id.ok) {
        return err(scenarioError("invalid-scenario", input, id.error.message));
      }
      const definition = byId.get(id.value);
      return definition === undefined
        ? err(scenarioError("unknown-scenario", id.value, `Unknown scenario: ${id.value}`))
        : ok(definition);
    },
  }));
}
