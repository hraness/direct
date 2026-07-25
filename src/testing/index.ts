import {
  parseCoverageCatalogSnapshot as parseCoverageCatalogSnapshotCore,
} from "../core/coverage.js";

/** Parse an exact coverage snapshot, including `window.__direct.manifest.coverage`. */
export function parseCoverageCatalogSnapshot(
  input: unknown,
): ReturnType<typeof parseCoverageCatalogSnapshotCore> {
  return parseCoverageCatalogSnapshotCore(input);
}
export type {
  CoverageCatalogSnapshot,
  CoverageEntry,
  CoverageError,
} from "../core/coverage.js";
export * from "./activity.js";
export * from "./coverage-binding.js";
export * from "./evidence.js";
export * from "./manifest.js";
export * from "./probe.js";
export * from "./session.js";
export * from "./scripted-transport.js";
