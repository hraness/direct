import {
  attestDirectBombadilTrace as attestTrace,
  parseDirectBombadilArtifactReceipt as parseArtifactReceipt,
  parseDirectBombadilMatrixReceipt as parseMatrixReceipt,
  parseDirectBombadilMatrixSummary as parseMatrixSummary,
  parseDirectBombadilSanitizedRunSummary as parseRunSummary,
  resolveDirectBombadilUploadLeaf as resolveUploadLeaf,
  runDirectBombadilFuzz as runFuzz,
  runDirectBombadilFuzzMatrix as runMatrix,
  summarizeDirectBombadilTrace as summarizeTrace,
} from "./bombadil-runner.js";
import type {
  DirectBombadilFuzzCampaign,
  DirectBombadilFuzzConfig,
  DirectBombadilFuzzMatrixResult,
  DirectBombadilFuzzResult,
  DirectBombadilFuzzRunInput,
  DirectBombadilMatrixRunInput,
} from "./bombadil-runner.js";

/** Host-side exact attestation for one bounded Bombadil 0.7.2 JSONL trace. */
export const attestDirectBombadilTrace: typeof attestTrace = attestTrace;

/** Derives bounded diagnostic navigation metadata without replacing the raw trace. */
export const summarizeDirectBombadilTrace: typeof summarizeTrace = summarizeTrace;

/** Parse, clone, and freeze a foreign sanitized Bombadil run receipt. */
export const parseDirectBombadilArtifactReceipt: typeof parseArtifactReceipt = parseArtifactReceipt;

/** Parse, clone, and freeze a foreign sanitized Bombadil run summary. */
export const parseDirectBombadilSanitizedRunSummary: typeof parseRunSummary = parseRunSummary;

/** Parse, clone, and freeze a foreign sanitized Bombadil matrix receipt. */
export const parseDirectBombadilMatrixReceipt: typeof parseMatrixReceipt = parseMatrixReceipt;

/** Parse, clone, and freeze a foreign sanitized Bombadil matrix summary. */
export const parseDirectBombadilMatrixSummary: typeof parseMatrixSummary = parseMatrixSummary;

/** Resolve the exact precomputed upload leaf used by failure-safe CI upload steps. */
export const resolveDirectBombadilUploadLeaf: typeof resolveUploadLeaf = resolveUploadLeaf;

/** Runs one bounded local Bombadil campaign and preserves diagnostic artifacts. */
export function runDirectBombadilFuzz(
  config: DirectBombadilFuzzConfig,
  argumentsOrOptions?: DirectBombadilFuzzRunInput,
): Promise<DirectBombadilFuzzResult> {
  return argumentsOrOptions === undefined
    ? runFuzz(config)
    : runFuzz(config, argumentsOrOptions);
}

/** Runs a bounded product campaign matrix serially and selects one for replay. */
export function runDirectBombadilFuzzMatrix(
  campaigns: readonly DirectBombadilFuzzCampaign[],
  argumentsOrOptions?: DirectBombadilMatrixRunInput,
): Promise<DirectBombadilFuzzMatrixResult> {
  return argumentsOrOptions === undefined
    ? runMatrix(campaigns)
    : runMatrix(campaigns, argumentsOrOptions);
}

export type {
  DirectBombadilActionKind,
  DirectBombadilArtifactFailureCode,
  DirectBombadilArtifactParseError,
  DirectBombadilArtifactPolicy,
  DirectBombadilArtifactReceipt,
  DirectBombadilArtifactRunPlan,
  DirectBombadilExplorationPolicy,
  DirectBombadilExplorationSummary,
  DirectBombadilFuzzCampaign,
  DirectBombadilFuzzConfig,
  DirectBombadilFuzzMatrixResult,
  DirectBombadilFuzzResult,
  DirectBombadilFuzzRunInput,
  DirectBombadilFuzzRunOptions,
  DirectBombadilMatrixCampaignReceiptEntry,
  DirectBombadilMatrixCampaignStatus,
  DirectBombadilMatrixReceipt,
  DirectBombadilMatrixRunInput,
  DirectBombadilMatrixRunOptions,
  DirectBombadilMatrixSummary,
  DirectBombadilSanitizedRunSummary,
  DirectBombadilServerConfig,
  DirectBombadilTraceAttestation,
  DirectBombadilTraceBinding,
  DirectBombadilToolchainBuildContract,
  DirectBombadilToolchainConfig,
  DirectBombadilUploadMode,
  DirectBombadilViewportConfig,
} from "./bombadil-runner.js";
