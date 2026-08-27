import {
  attestDirectBombadilTrace as attestTrace,
  runDirectBombadilFuzz as runFuzz,
} from "./bombadil-runner.js";
import type {
  DirectBombadilFuzzConfig,
  DirectBombadilFuzzResult,
} from "./bombadil-runner.js";

/** Host-side exact attestation for one bounded Bombadil 0.7.2 JSONL trace. */
export const attestDirectBombadilTrace: typeof attestTrace = attestTrace;

/** Runs one bounded local Bombadil campaign and preserves diagnostic artifacts. */
export function runDirectBombadilFuzz(
  config: DirectBombadilFuzzConfig,
  arguments_?: readonly string[],
): Promise<DirectBombadilFuzzResult> {
  return arguments_ === undefined ? runFuzz(config) : runFuzz(config, arguments_);
}

export type {
  DirectBombadilFuzzConfig,
  DirectBombadilFuzzResult,
  DirectBombadilServerConfig,
  DirectBombadilTraceAttestation,
  DirectBombadilTraceBinding,
} from "./bombadil-runner.js";
