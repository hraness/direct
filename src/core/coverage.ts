import { parseCoverageKey, parseScenarioId, type CoverageKey, type ScenarioId } from "./ids.js";
import { parseJsonValue } from "./json.js";
import { err, isRecord, ok, type Result } from "./result.js";

export const DIRECT_COVERAGE_SCHEMA = "direct.coverage/v2" as const;

export type CoverageMode = "fixture" | "mixed" | "direct";

type CoverageScenarioInput<Scenario extends string = string> = ScenarioId | Scenario;

interface CoverageEntryInputBase {
  readonly key: string;
  readonly claim: string;
}

export type CoverageEntryInput<Scenario extends string = string> =
  | (CoverageEntryInputBase & {
    readonly mode: "direct";
    readonly scenarios: readonly [];
  })
  | (CoverageEntryInputBase & {
    readonly mode: "fixture" | "mixed";
    readonly scenarios: readonly [CoverageScenarioInput<Scenario>, ...CoverageScenarioInput<Scenario>[]];
  });

interface CoverageEntryBase {
  readonly key: CoverageKey;
  readonly claim: string;
}

export type CoverageEntry =
  | (CoverageEntryBase & {
    readonly mode: "direct";
    readonly scenarios: readonly [];
  })
  | (CoverageEntryBase & {
    readonly mode: "fixture" | "mixed";
    readonly scenarios: readonly [ScenarioId, ...ScenarioId[]];
  });

export type CoverageErrorCode =
  | "duplicate-coverage"
  | "duplicate-expected-key"
  | "invalid-claim"
  | "invalid-coverage"
  | "invalid-mode"
  | "invalid-scenario"
  | "missing-coverage"
  | "unexpected-coverage"
  | "unknown-coverage"
  | "unknown-scenario";

export interface CoverageError {
  readonly code: CoverageErrorCode;
  readonly message: string;
  readonly keys: readonly string[];
}

export interface CoverageCatalog {
  readonly size: number;
  readonly keys: () => readonly CoverageKey[];
  readonly list: () => readonly CoverageEntry[];
  readonly get: (key: CoverageKey) => CoverageEntry | undefined;
  readonly resolve: (key: unknown) => Result<CoverageEntry, CoverageError>;
  readonly requireExactKeys: (expected: readonly (CoverageKey | string)[]) => Result<true, CoverageError>;
}

export interface CoverageCatalogSnapshot {
  readonly schema: typeof DIRECT_COVERAGE_SCHEMA;
  readonly entries: readonly CoverageEntry[];
}

export const EMPTY_COVERAGE_CATALOG_SNAPSHOT = Object.freeze({
  schema: DIRECT_COVERAGE_SCHEMA,
  entries: Object.freeze([]),
}) satisfies CoverageCatalogSnapshot;

function coverageError(code: CoverageErrorCode, message: string, keys: readonly string[] = []): CoverageError {
  return { code, message, keys };
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

const COVERAGE_ENTRY_KEYS = new Set(["key", "mode", "claim", "scenarios"]);
const COVERAGE_SNAPSHOT_KEYS = new Set(["schema", "entries"]);

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === "string");
}

/** Create the exact versioned JSON snapshot published to verification tooling. */
export function createCoverageCatalogSnapshot(
  catalog: CoverageCatalog,
): CoverageCatalogSnapshot {
  return Object.freeze({
    schema: DIRECT_COVERAGE_SCHEMA,
    entries: catalog.list(),
  });
}

/** Parse an exact versioned coverage snapshot read from verification tooling. */
export function parseCoverageCatalogSnapshot(
  input: unknown,
): Result<CoverageCatalogSnapshot, CoverageError> {
  const parsed = parseJsonValue(input);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return err(coverageError(
      "invalid-coverage",
      parsed.ok ? "Coverage snapshot must be an object" : parsed.error.message,
    ));
  }
  for (const key of Object.keys(parsed.value)) {
    if (!COVERAGE_SNAPSHOT_KEYS.has(key)) {
      return err(coverageError("invalid-coverage", `Unknown coverage snapshot key: ${key}`));
    }
  }
  if (parsed.value.schema !== DIRECT_COVERAGE_SCHEMA) {
    return err(coverageError(
      "invalid-coverage",
      `Coverage snapshot schema must be ${DIRECT_COVERAGE_SCHEMA}`,
    ));
  }
  if (!Array.isArray(parsed.value.entries)) {
    return err(coverageError("invalid-coverage", "Coverage snapshot entries must be an array"));
  }
  const entries: CoverageEntryInput[] = [];
  for (const [index, candidate] of parsed.value.entries.entries()) {
    if (!isRecord(candidate)) {
      return err(coverageError("invalid-coverage", `Coverage entry ${String(index)} must be an object`));
    }
    for (const key of Object.keys(candidate)) {
      if (!COVERAGE_ENTRY_KEYS.has(key)) {
        return err(coverageError(
          "invalid-coverage",
          `Unknown coverage entry key at ${String(index)}: ${key}`,
        ));
      }
    }
    if (
      typeof candidate.key !== "string"
      || typeof candidate.claim !== "string"
      || (candidate.mode !== "fixture" && candidate.mode !== "mixed" && candidate.mode !== "direct")
      || !isStringArray(candidate.scenarios)
    ) {
      return err(coverageError(
        "invalid-coverage",
        `Coverage entry ${String(index)} has an invalid wire shape`,
      ));
    }
    if (candidate.mode === "direct") {
      if (candidate.scenarios.length > 0) {
        return err(coverageError(
          "invalid-mode",
          `Direct coverage ${candidate.key} cannot cite fixture scenarios`,
          [candidate.key],
        ));
      }
      entries.push({
        key: candidate.key,
        mode: candidate.mode,
        claim: candidate.claim,
        scenarios: [],
      });
    } else {
      const firstScenario = candidate.scenarios[0];
      if (typeof firstScenario !== "string") {
        return err(coverageError(
          "invalid-mode",
          `${candidate.mode} coverage ${candidate.key} must cite at least one scenario`,
          [candidate.key],
        ));
      }
      entries.push({
        key: candidate.key,
        mode: candidate.mode,
        claim: candidate.claim,
        scenarios: [firstScenario, ...candidate.scenarios.slice(1)],
      });
    }
  }
  const catalog = createCoverageCatalog(entries);
  return catalog.ok ? ok(createCoverageCatalogSnapshot(catalog.value)) : catalog;
}

export function createCoverageCatalog<Scenario extends string = string>(
  inputs: readonly CoverageEntryInput<Scenario>[],
  scenarios?: { readonly get: (id: ScenarioId) => unknown },
): Result<CoverageCatalog, CoverageError> {
  const entries: CoverageEntry[] = [];
  const byKey = new Map<CoverageKey, CoverageEntry>();

  for (const input of inputs) {
    const key = parseCoverageKey(input.key);
    if (!key.ok) {
      return err(coverageError("invalid-coverage", key.error.message, [String(input.key)]));
    }
    if (byKey.has(key.value)) {
      return err(coverageError("duplicate-coverage", `Duplicate coverage key: ${key.value}`, [key.value]));
    }
    if (
      input.claim.trim().length === 0
      || input.claim.length > 1_000
      || hasControlCharacters(input.claim)
    ) {
      return err(coverageError("invalid-claim", `Coverage ${key.value} needs a 1-1000 character claim`, [key.value]));
    }
    if (input.mode !== "fixture" && input.mode !== "mixed" && input.mode !== "direct") {
      return err(coverageError("invalid-mode", `Coverage ${key.value} has an unknown proof mode`, [key.value]));
    }
    if (input.mode === "direct" && input.scenarios.length > 0) {
      return err(coverageError("invalid-mode", `Direct coverage ${key.value} cannot cite fixture scenarios`, [key.value]));
    }
    if (input.mode !== "direct" && input.scenarios.length === 0) {
      return err(coverageError("invalid-mode", `${input.mode} coverage ${key.value} must cite at least one scenario`, [key.value]));
    }

    const scenarioIds: ScenarioId[] = [];
    const seenScenarios = new Set<ScenarioId>();
    for (const candidate of input.scenarios) {
      const id = parseScenarioId(candidate);
      if (!id.ok) {
        return err(coverageError("invalid-scenario", id.error.message, [String(candidate)]));
      }
      if (seenScenarios.has(id.value)) {
        return err(coverageError("invalid-scenario", `Coverage ${key.value} repeats scenario ${id.value}`, [id.value]));
      }
      if (scenarios !== undefined && scenarios.get(id.value) === undefined) {
        return err(coverageError("unknown-scenario", `Coverage ${key.value} cites unknown scenario ${id.value}`, [id.value]));
      }
      seenScenarios.add(id.value);
      scenarioIds.push(id.value);
    }

    let entry: CoverageEntry;
    if (input.mode === "direct") {
      const scenarios: readonly [] = Object.freeze([]);
      entry = Object.freeze({
        key: key.value,
        mode: input.mode,
        claim: input.claim,
        scenarios,
      } satisfies CoverageEntry);
    } else {
      const firstScenarioId = scenarioIds[0];
      if (firstScenarioId === undefined) {
        return err(coverageError(
          "invalid-mode",
          `${input.mode} coverage ${key.value} must cite at least one scenario`,
          [key.value],
        ));
      }
      const scenarios: readonly [ScenarioId, ...ScenarioId[]] = Object.freeze([
        firstScenarioId,
        ...scenarioIds.slice(1),
      ]);
      entry = Object.freeze({
        key: key.value,
        mode: input.mode,
        claim: input.claim,
        scenarios,
      } satisfies CoverageEntry);
    }
    entries.push(entry);
    byKey.set(key.value, entry);
  }

  const frozenEntries = Object.freeze(entries);
  const keys = Object.freeze(frozenEntries.map((entry) => entry.key));
  const catalog: CoverageCatalog = {
    size: frozenEntries.length,
    keys: () => keys,
    list: () => frozenEntries,
    get: (key: CoverageKey) => byKey.get(key),
    resolve: (input: unknown) => {
      const key = parseCoverageKey(input);
      if (!key.ok) {
        return err(coverageError("invalid-coverage", key.error.message, [String(input)]));
      }
      const entry = byKey.get(key.value);
      return entry === undefined
        ? err(coverageError("unknown-coverage", `Unknown coverage key: ${key.value}`, [key.value]))
        : ok(entry);
    },
    requireExactKeys: (expected: readonly (CoverageKey | string)[]) => {
      const expectedKeys: CoverageKey[] = [];
      const seen = new Set<CoverageKey>();
      for (const candidate of expected) {
        const parsed = parseCoverageKey(candidate);
        if (!parsed.ok) {
          return err(coverageError("invalid-coverage", parsed.error.message, [String(candidate)]));
        }
        if (seen.has(parsed.value)) {
          return err(coverageError("duplicate-expected-key", `Expected coverage repeats ${parsed.value}`, [parsed.value]));
        }
        seen.add(parsed.value);
        expectedKeys.push(parsed.value);
      }
      const missing = expectedKeys.filter((key) => !byKey.has(key));
      if (missing.length > 0) {
        return err(coverageError("missing-coverage", `Missing coverage keys: ${missing.join(", ")}`, missing));
      }
      const unexpected = keys.filter((key) => !seen.has(key));
      if (unexpected.length > 0) {
        return err(coverageError("unexpected-coverage", `Unexpected coverage keys: ${unexpected.join(", ")}`, unexpected));
      }
      return ok<true>(true);
    },
  };
  return ok(Object.freeze(catalog));
}
