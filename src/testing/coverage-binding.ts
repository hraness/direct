import {
  createCoverageCatalogSnapshot,
  parseCoverageCatalogSnapshot,
  type CoverageCatalogSnapshot,
  type CoverageEntry,
  type CoverageError,
} from "../core/coverage.js";
import type { DirectDefinition } from "../core/definition.js";
import type { JsonValue } from "../core/json-value.js";
import { renderUnknownReason } from "../core/reason.js";
import { err, ok, type Result } from "../core/result.js";

export type CoverageBindingError =
  | {
    readonly code: "invalid-coverage";
    readonly message: string;
    readonly coverageError: CoverageError;
  }
  | {
    readonly code: "coverage-mismatch" | "invalid-definition";
    readonly message: string;
    readonly coverageError: null;
  };

function sameEntry(
  actual: CoverageEntry,
  expected: CoverageEntry,
): boolean {
  if (
    actual.key !== expected.key
    || actual.mode !== expected.mode
    || actual.claim !== expected.claim
    || actual.scenarios.length !== expected.scenarios.length
  ) return false;
  return actual.scenarios.every((scenario, index) => scenario === expected.scenarios[index]);
}

/** Parse a browser value and prove exact equality with an owned expected snapshot. */
export function parseExpectedCoverageCatalogSnapshot(
  input: unknown,
  expected: CoverageCatalogSnapshot,
): Result<CoverageCatalogSnapshot, CoverageBindingError> {
  const parsed = parseCoverageCatalogSnapshot(input);
  if (!parsed.ok) {
    return err(Object.freeze({
      code: "invalid-coverage",
      message: parsed.error.message,
      coverageError: parsed.error,
    }));
  }

  try {
    if (
      parsed.value.schema !== expected.schema
      || parsed.value.entries.length !== expected.entries.length
      || parsed.value.entries.some((entry, index) => {
        const expectedEntry = expected.entries[index];
        return expectedEntry === undefined || !sameEntry(entry, expectedEntry);
      })
    ) {
      return err(Object.freeze({
        code: "coverage-mismatch",
        message: "Published Direct coverage does not exactly match the authored definition",
        coverageError: null,
      }));
    }
  } catch (reason) {
    return err(Object.freeze({
      code: "invalid-definition",
      message: renderUnknownReason(reason, "Expected Direct coverage could not be inspected"),
      coverageError: null,
    }));
  }
  return ok(expected);
}

/**
 * Parse a browser-published coverage value and prove that it is the exact
 * snapshot authored by the definition running the verifier.
 */
export function parseDefinitionCoverageSnapshot<
  World extends JsonValue,
  Route extends string,
>(
  input: unknown,
  definition: Pick<DirectDefinition<World, Route>, "coverage">,
): Result<CoverageCatalogSnapshot, CoverageBindingError> {
  let expected: CoverageCatalogSnapshot;
  try {
    expected = createCoverageCatalogSnapshot(definition.coverage);
  } catch (reason) {
    return err(Object.freeze({
      code: "invalid-definition",
      message: renderUnknownReason(reason, "Direct definition coverage could not be inspected"),
      coverageError: null,
    }));
  }
  return parseExpectedCoverageCatalogSnapshot(input, expected);
}
