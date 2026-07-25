import type { DirectDefinition } from "../core/definition.js";
import {
  createCoverageCatalogSnapshot,
  parseCoverageCatalogSnapshot,
  type CoverageCatalogSnapshot,
} from "../core/coverage.js";
import { parseScenarioId, type ScenarioId } from "../core/ids.js";
import {
  parseJsonValue,
  parseTaggedStableHash,
  stableHash,
  STABLE_HASH_ALGORITHM,
  tagStableHash,
  type JsonLimits,
  type TaggedStableHash,
} from "../core/json.js";
import type { JsonValue } from "../core/json-value.js";
import {
  FIXTURE_QUERY_KEY,
  SCENARIO_QUERY_KEY,
  type ActiveDirect,
} from "../core/query.js";
import { renderUnknownReason } from "../core/reason.js";
import { err, isRecord, ok, type Result } from "../core/result.js";
import { MAX_DIRECT_SCENARIOS } from "../core/scenario.js";

export const DIRECT_SESSION_MANIFEST_SCHEMA = "direct.session-manifest/v1" as const;
export const DIRECT_CATALOG_HASH_ALGORITHM = STABLE_HASH_ALGORITHM;
const DIRECT_SESSION_MANIFEST_JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxStringBytes: 16_777_216,
}) satisfies JsonLimits;

export type DirectCatalogHash = TaggedStableHash;
export type DirectSelectionHash = TaggedStableHash;

export interface DirectSessionManifestQueries {
  readonly scenario: typeof SCENARIO_QUERY_KEY;
  readonly fixture: typeof FIXTURE_QUERY_KEY;
}

export interface DirectSessionManifestScenario {
  readonly id: ScenarioId;
  readonly title: string;
  readonly description: string | null;
  readonly route: string;
}

export interface DirectSessionManifestActive {
  readonly source: "scenario" | "fixture";
  readonly scenario: ScenarioId;
  readonly route: string;
  readonly activationHash: TaggedStableHash;
  /**
   * Consistency fingerprint binding the public selection to activationHash.
   * It detects drift; it is not an authenticity or security proof.
   */
  readonly selectionHash: DirectSelectionHash;
}

/**
 * The exact JSON-safe discovery surface for one Direct session.
 *
 * It deliberately excludes worlds, logical runtimes, product actions, and
 * assertions. Agents can discover the public catalog without gaining another
 * path to product state or authority.
 */
export interface DirectSessionManifest {
  readonly schema: typeof DIRECT_SESSION_MANIFEST_SCHEMA;
  /** Deterministic drift fingerprint, not a security or authenticity proof. */
  readonly catalogHash: DirectCatalogHash;
  readonly queries: DirectSessionManifestQueries;
  readonly defaultScenario: ScenarioId;
  readonly active: DirectSessionManifestActive;
  /** Authored scenario order is preserved. */
  readonly scenarios: readonly DirectSessionManifestScenario[];
  readonly coverage: CoverageCatalogSnapshot;
}

export type DirectSessionManifestErrorCode =
  | "activation-hash-mismatch"
  | "catalog-hash-mismatch"
  | "duplicate-scenario"
  | "invalid-catalog-hash"
  | "invalid-manifest"
  | "invalid-selection-hash"
  | "route-mismatch"
  | "selection-hash-mismatch"
  | "unknown-coverage-scenario"
  | "unknown-scenario";

export interface DirectSessionManifestError {
  readonly code: DirectSessionManifestErrorCode;
  readonly message: string;
}

const MANIFEST_KEYS = new Set([
  "active",
  "catalogHash",
  "coverage",
  "defaultScenario",
  "queries",
  "scenarios",
  "schema",
]);
const QUERY_KEYS = new Set(["fixture", "scenario"]);
const ACTIVE_KEYS = new Set([
  "activationHash",
  "route",
  "scenario",
  "selectionHash",
  "source",
]);
const SCENARIO_KEYS = new Set([
  "description",
  "id",
  "route",
  "title",
]);

function manifestError(
  code: DirectSessionManifestErrorCode,
  message: string,
): DirectSessionManifestError {
  return Object.freeze({ code, message });
}

function exactKeys(
  input: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(input)) {
    if (!expected.has(key)) throw new Error(`Unknown ${label} key: ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(input, key)) throw new Error(`Missing ${label} key: ${key}`);
  }
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) {
      return true;
    }
  }
  return false;
}

function validText(value: string, maximum: number): boolean {
  return (
    value.trim().length > 0
    && value.length <= maximum
    && !hasControlCharacters(value)
  );
}

function validRoute(value: string): boolean {
  if (value.trim().length === 0 || value.length > 256) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function parseTaggedHash(value: unknown, label: string): TaggedStableHash {
  const parsed = parseTaggedStableHash(value);
  if (!parsed.ok) throw new Error(`${label}: ${parsed.error.message}`);
  return parsed.value;
}

interface DirectCatalogPayload {
  readonly queries: DirectSessionManifestQueries;
  readonly defaultScenario: ScenarioId;
  readonly scenarios: readonly DirectSessionManifestScenario[];
  readonly coverage: CoverageCatalogSnapshot;
}

type DirectSelectionPayload = Omit<DirectSessionManifestActive, "selectionHash">;

function selectionHash(
  payload: DirectSelectionPayload,
): Result<DirectSelectionHash, DirectSessionManifestError> {
  const hashed = stableHash(payload, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!hashed.ok) {
    return err(manifestError("invalid-manifest", hashed.error.message));
  }
  return ok(tagStableHash(hashed.value));
}

function catalogHash(
  payload: DirectCatalogPayload,
): Result<DirectCatalogHash, DirectSessionManifestError> {
  const hashed = stableHash(payload, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!hashed.ok) {
    return err(manifestError("invalid-manifest", hashed.error.message));
  }
  return ok(tagStableHash(hashed.value));
}

function parseManifestUnchecked(
  input: unknown,
): Result<DirectSessionManifest, DirectSessionManifestError> {
  const parsedJson = parseJsonValue(input, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!parsedJson.ok || !isRecord(parsedJson.value)) {
    return err(manifestError(
      "invalid-manifest",
      parsedJson.ok
        ? "Direct session manifest must be an object"
        : parsedJson.error.message,
    ));
  }
  const candidate = parsedJson.value;
  exactKeys(candidate, MANIFEST_KEYS, "Direct session manifest");
  if (candidate.schema !== DIRECT_SESSION_MANIFEST_SCHEMA) {
    throw new Error(
      `Direct session manifest schema must be ${DIRECT_SESSION_MANIFEST_SCHEMA}`,
    );
  }

  if (!isRecord(candidate.queries)) {
    throw new Error("Direct session manifest queries must be an object");
  }
  exactKeys(candidate.queries, QUERY_KEYS, "Direct session manifest queries");
  if (
    candidate.queries.scenario !== SCENARIO_QUERY_KEY
    || candidate.queries.fixture !== FIXTURE_QUERY_KEY
  ) {
    throw new Error("Direct session manifest query keys do not match Direct");
  }
  const queries: DirectSessionManifestQueries = Object.freeze({
    scenario: SCENARIO_QUERY_KEY,
    fixture: FIXTURE_QUERY_KEY,
  });

  const defaultScenario = parseScenarioId(candidate.defaultScenario);
  if (!defaultScenario.ok) {
    throw new Error(`Invalid default scenario: ${defaultScenario.error.message}`);
  }

  if (!Array.isArray(candidate.scenarios)) {
    throw new Error("Direct session manifest scenarios must be an array");
  }
  if (candidate.scenarios.length > MAX_DIRECT_SCENARIOS) {
    throw new Error(
      `Direct session manifests support at most ${String(MAX_DIRECT_SCENARIOS)} scenarios`,
    );
  }
  const scenarios: DirectSessionManifestScenario[] = [];
  const byId = new Map<ScenarioId, DirectSessionManifestScenario>();
  for (const [index, rawScenario] of candidate.scenarios.entries()) {
    if (!isRecord(rawScenario)) {
      throw new Error(`Direct session manifest scenario ${String(index)} must be an object`);
    }
    exactKeys(
      rawScenario,
      SCENARIO_KEYS,
      `Direct session manifest scenario ${String(index)}`,
    );
    const id = parseScenarioId(rawScenario.id);
    if (!id.ok) {
      throw new Error(
        `Invalid Direct session manifest scenario ${String(index)}: ${id.error.message}`,
      );
    }
    if (byId.has(id.value)) {
      return err(manifestError(
        "duplicate-scenario",
        `Duplicate Direct session manifest scenario: ${id.value}`,
      ));
    }
    if (typeof rawScenario.title !== "string" || !validText(rawScenario.title, 160)) {
      throw new Error(
        `Direct session manifest scenario ${id.value} title must contain 1-160 visible characters`,
      );
    }
    if (
      rawScenario.description !== null
      && (
        typeof rawScenario.description !== "string"
        || !validText(rawScenario.description, 2_000)
      )
    ) {
      throw new Error(
        `Direct session manifest scenario ${id.value} description must be null or contain 1-2000 visible characters`,
      );
    }
    if (typeof rawScenario.route !== "string" || !validRoute(rawScenario.route)) {
      throw new Error(
        `Direct session manifest scenario ${id.value} route must contain 1-256 visible characters`,
      );
    }
    const scenario: DirectSessionManifestScenario = Object.freeze({
      id: id.value,
      title: rawScenario.title,
      description: rawScenario.description,
      route: rawScenario.route,
    });
    scenarios.push(scenario);
    byId.set(id.value, scenario);
  }
  const frozenScenarios = Object.freeze(scenarios);

  if (!byId.has(defaultScenario.value)) {
    return err(manifestError(
      "unknown-scenario",
      `Direct session manifest default scenario is missing: ${defaultScenario.value}`,
    ));
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
    return err(manifestError(
      "unknown-scenario",
      `Direct session manifest active scenario is missing: ${activeScenario.value}`,
    ));
  }
  if (typeof candidate.active.route !== "string" || !validRoute(candidate.active.route)) {
    throw new Error("Direct session manifest active route is invalid");
  }
  if (candidate.active.route !== activeDefinition.route) {
    return err(manifestError(
      "route-mismatch",
      `Direct session manifest active route does not match scenario ${activeScenario.value}`,
    ));
  }
  const activationHash = parseTaggedHash(
    candidate.active.activationHash,
    "Direct session manifest activationHash",
  );
  let suppliedSelectionHash: DirectSelectionHash;
  try {
    suppliedSelectionHash = parseTaggedHash(
      candidate.active.selectionHash,
      "Direct session manifest selectionHash",
    );
  } catch (reason) {
    return err(manifestError(
      "invalid-selection-hash",
      renderUnknownReason(reason, "Direct session manifest selectionHash is invalid"),
    ));
  }
  const expectedSelectionHash = selectionHash({
    source: candidate.active.source,
    scenario: activeScenario.value,
    route: activeDefinition.route,
    activationHash,
  });
  if (!expectedSelectionHash.ok) return expectedSelectionHash;
  if (suppliedSelectionHash !== expectedSelectionHash.value) {
    return err(manifestError(
      "selection-hash-mismatch",
      "Direct session manifest selectionHash does not match its active selection",
    ));
  }
  const active: DirectSessionManifestActive = Object.freeze({
    source: candidate.active.source,
    scenario: activeScenario.value,
    route: activeDefinition.route,
    activationHash,
    selectionHash: expectedSelectionHash.value,
  });

  const coverage = parseCoverageCatalogSnapshot(
    candidate.coverage,
    DIRECT_SESSION_MANIFEST_JSON_LIMITS,
  );
  if (!coverage.ok) {
    throw new Error(coverage.error.message);
  }
  for (const entry of coverage.value.entries) {
    for (const scenario of entry.scenarios) {
      if (!byId.has(scenario)) {
        return err(manifestError(
          "unknown-coverage-scenario",
          `Coverage ${entry.key} cites unknown Direct session manifest scenario ${scenario}`,
        ));
      }
    }
  }

  let suppliedCatalogHash: DirectCatalogHash;
  try {
    const parsedHash = parseTaggedHash(
      candidate.catalogHash,
      "Direct session manifest catalogHash",
    );
    const separator = parsedHash.indexOf(":");
    suppliedCatalogHash =
      `${DIRECT_CATALOG_HASH_ALGORITHM}:${parsedHash.slice(separator + 1)}`;
  } catch (reason) {
    return err(manifestError(
      "invalid-catalog-hash",
      renderUnknownReason(reason, "Direct session manifest catalogHash is invalid"),
    ));
  }
  const expectedCatalogHash = catalogHash({
    queries,
    defaultScenario: defaultScenario.value,
    scenarios: frozenScenarios,
    coverage: coverage.value,
  });
  if (!expectedCatalogHash.ok) return expectedCatalogHash;
  if (suppliedCatalogHash !== expectedCatalogHash.value) {
    return err(manifestError(
      "catalog-hash-mismatch",
      "Direct session manifest catalogHash does not match its public catalog",
    ));
  }

  return ok(Object.freeze({
    schema: DIRECT_SESSION_MANIFEST_SCHEMA,
    catalogHash: expectedCatalogHash.value,
    queries,
    defaultScenario: defaultScenario.value,
    active,
    scenarios: frozenScenarios,
    coverage: coverage.value,
  }));
}

/** Parse, validate, clone, and freeze a foreign Direct discovery manifest. */
export function parseDirectSessionManifest(
  input: unknown,
): Result<DirectSessionManifest, DirectSessionManifestError> {
  try {
    return parseManifestUnchecked(input);
  } catch (reason) {
    return err(manifestError(
      "invalid-manifest",
      renderUnknownReason(reason, "Direct session manifest is invalid"),
    ));
  }
}

/**
 * Project a validated definition and activation into the driver-neutral
 * discovery manifest shared by browser and headless verification adapters.
 */
export function createDirectSessionManifest<
  World extends JsonValue,
  Route extends string,
>(
  definition: DirectDefinition<World, Route>,
  activation: ActiveDirect<World, Route>,
): Result<DirectSessionManifest, DirectSessionManifestError> {
  try {
    const activeScenario = definition.scenarios.get(activation.scenario);
    if (activeScenario === undefined) {
      return err(manifestError(
        "unknown-scenario",
        `Direct session activation is missing from its definition: ${activation.scenario}`,
      ));
    }
    if (activeScenario.route !== activation.route) {
      return err(manifestError(
        "route-mismatch",
        `Direct session activation route does not match scenario ${activation.scenario}`,
      ));
    }
    const activeIdentity = {
      source: activation.source,
      scenario: activation.scenario,
      route: activation.route,
      world: activation.world,
      runtime: activation.runtime,
    };
    const hashedActivation = stableHash(activeIdentity);
    if (!hashedActivation.ok) {
      return err(manifestError("invalid-manifest", hashedActivation.error.message));
    }
    const expectedActivationHash = tagStableHash(hashedActivation.value);
    if (activation.activationHash !== expectedActivationHash) {
      return err(manifestError(
        "activation-hash-mismatch",
        "Direct session activationHash does not identify its active state",
      ));
    }
    if (activation.source === "scenario") {
      const authoredHash = stableHash({
        source: activation.source,
        scenario: activeScenario.id,
        route: activeScenario.route,
        world: activeScenario.world,
        runtime: activeScenario.runtime,
      });
      if (!authoredHash.ok) {
        return err(manifestError("invalid-manifest", authoredHash.error.message));
      }
      if (tagStableHash(authoredHash.value) !== expectedActivationHash) {
        return err(manifestError(
          "activation-hash-mismatch",
          `Direct scenario activation does not match authored scenario ${activation.scenario}`,
        ));
      }
    }
    const scenarios = Object.freeze(definition.scenarios.list().map((scenario) =>
      Object.freeze({
        id: scenario.id,
        title: scenario.title,
        description: scenario.description,
        route: scenario.route,
      })
    ));
    const queries: DirectSessionManifestQueries = Object.freeze({
      scenario: SCENARIO_QUERY_KEY,
      fixture: FIXTURE_QUERY_KEY,
    });
    const coverage = createCoverageCatalogSnapshot(definition.coverage);
    const hash = catalogHash({
      queries,
      defaultScenario: definition.defaultScenario.id,
      scenarios,
      coverage,
    });
    if (!hash.ok) return hash;
    const activeSelectionHash = selectionHash({
      source: activation.source,
      scenario: activation.scenario,
      route: activation.route,
      activationHash: expectedActivationHash,
    });
    if (!activeSelectionHash.ok) return activeSelectionHash;
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
        selectionHash: activeSelectionHash.value,
      },
      scenarios,
      coverage,
    });
  } catch (reason) {
    return err(manifestError(
      "invalid-manifest",
      renderUnknownReason(reason, "Direct session manifest could not be created"),
    ));
  }
}
