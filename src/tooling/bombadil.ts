import {
  attestDirectBombadilTrace as attestTrace,
  runDirectBombadilFuzz as runFuzz,
  runDirectBombadilFuzzMatrix as runMatrix,
  summarizeDirectBombadilTrace as summarizeTrace,
} from "./bombadil-runner.js";
import type {
  DirectBombadilFuzzConfig,
  DirectBombadilFuzzCampaign,
  DirectBombadilFuzzMatrixResult,
  DirectBombadilFuzzResult,
} from "./bombadil-runner.js";

/** Host-side exact attestation for one bounded Bombadil 0.7.2 JSONL trace. */
export const attestDirectBombadilTrace: typeof attestTrace = attestTrace;

/** Derives bounded diagnostic navigation metadata without replacing the raw trace. */
export const summarizeDirectBombadilTrace: typeof summarizeTrace = summarizeTrace;

/** Runs one bounded local Bombadil campaign and preserves diagnostic artifacts. */
export function runDirectBombadilFuzz(
  config: DirectBombadilFuzzConfig,
  arguments_?: readonly string[],
): Promise<DirectBombadilFuzzResult> {
  return arguments_ === undefined ? runFuzz(config) : runFuzz(config, arguments_);
}

/** Runs a bounded product campaign matrix serially and selects one for replay. */
export function runDirectBombadilFuzzMatrix(
  campaigns: readonly DirectBombadilFuzzCampaign[],
  arguments_?: readonly string[],
): Promise<DirectBombadilFuzzMatrixResult> {
  return arguments_ === undefined ? runMatrix(campaigns) : runMatrix(campaigns, arguments_);
}

export type {
  DirectBombadilActionKind,
  DirectBombadilExplorationPolicy,
  DirectBombadilExplorationSummary,
  DirectBombadilFuzzCampaign,
  DirectBombadilFuzzConfig,
  DirectBombadilFuzzMatrixResult,
  DirectBombadilFuzzResult,
  DirectBombadilServerConfig,
  DirectBombadilTraceAttestation,
  DirectBombadilTraceBinding,
  DirectBombadilViewportConfig,
} from "./bombadil-runner.js";
