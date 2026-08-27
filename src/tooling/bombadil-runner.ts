import { createReadStream } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

import {
  parseDirectProbeSnapshot,
  parseDirectSessionManifest,
} from "@hraness/direct/testing";
import {
  FIXTURE_QUERY_KEY,
  SCENARIO_QUERY_KEY,
} from "@hraness/direct";

import {
  acquireVerificationServer,
  canAutomaticallyStartLocalServer,
  createArtifactRun,
  normalizeRootHttpOrigin,
  renderUnknown,
  spawnVerificationServer,
  stopVerificationServer,
  tail,
  writeJsonAtomically,
  type ManagedVerificationServer,
  type ServerLease,
} from "./browser-verification.js";

const EXPECTED_BOMBADIL_VERSION = "0.7.2";
const DEFAULT_TIME_LIMIT_SECONDS = 20;
const MIN_TIME_LIMIT_SECONDS = 12;
const MAX_TIME_LIMIT_SECONDS = 300;
const DEFAULT_STARTUP_TIMEOUT_MS = 60_000;
const MAX_STARTUP_TIMEOUT_MS = 120_000;
const LOG_LIMIT = 24_000;
const ARTIFACT_SCHEMA = "direct.bombadil-run/v1";
const SCENARIO_PATTERN = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
const ARTIFACT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const QUERY_PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const PROTOTYPE_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const TRACE_MAX_BYTES = 64 * 1024 * 1024;
const TRACE_MAX_LINE_BYTES = 16 * 1024 * 1024;
const TRACE_MAX_LINES = 10_000;
const TRACE_MAX_SNAPSHOTS_PER_LINE = 4_096;
const RANDOM_RUN_OVERHEAD_MS = 30_000;
const REPLAY_WALL_CLOCK_TIMEOUT_MS = MAX_TIME_LIMIT_SECONDS * 1_000 + RANDOM_RUN_OVERHEAD_MS;
const PROCESS_TERMINATION_GRACE_MS = 5_000;
const MIN_PROCESS_OUTPUT_DRAIN_MS = 500;
const SERVER_OUTPUT_TIMEOUT_MS = 3_000;
const DIRECT_BROWSER_BRIDGE_SCHEMA = "direct.browser-bridge/v2";
const TRACE_LINE_KEYS = new Set(["action", "snapshots", "state", "timestamp", "violations"]);
const TRACE_SNAPSHOT_KEYS = new Set(["index", "name", "time", "value"]);
const DIRECT_OBSERVATION_KEYS = new Set([
  "activationHash",
  "activeRoute",
  "activeScenario",
  "activeSource",
  "bridgePresent",
  "bridgeSchema",
  "catalogHash",
  "contractValid",
  "isQuiescent",
  "manifest",
  "probe",
  "violations",
  "violationsValid",
]);

export interface DirectBombadilServerConfig {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly readinessPath?: `/${string}`;
  readonly startupTimeoutMs?: number;
}

export interface DirectBombadilFuzzConfig {
  readonly artifactName: string;
  readonly baseUrl: string;
  readonly entryPath?: `/${string}`;
  readonly expectedRoute: string;
  readonly label: string;
  readonly repositoryRoot: string;
  readonly scenario: string;
  readonly specificationPath: string;
  readonly targetQuery?: Readonly<Record<string, string>>;
  readonly server: DirectBombadilServerConfig;
}

export type DirectBombadilFuzzArguments =
  | { readonly kind: "help" }
  | {
      readonly kind: "run";
      readonly baseUrl: string;
      readonly replayPath: string | null;
      readonly timeLimitSeconds: number;
    };

export type DirectBombadilFuzzResult =
  | { readonly kind: "help" }
  | {
      readonly kind: "run";
      readonly artifactDirectory: string;
      readonly manifestPath: string;
      readonly status: "passed";
    };

export interface DirectBombadilInvocation {
  readonly abortSignal?: AbortSignal;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly outputPath: string;
  readonly targetUrl: string;
  readonly terminationGraceMs?: number;
  readonly wallClockTimeoutMs: number;
}

interface BombadilProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
  readonly termination: "aborted" | "timeout" | null;
}

interface TraceDirectObservation {
  readonly activationHash: string;
  readonly activeRoute: string;
  readonly activeScenario: string;
  readonly activeSource: string;
  readonly bridgePresent: boolean;
  readonly bridgeSchema: string;
  readonly catalogHash: string;
  readonly contractValid: boolean;
  readonly isQuiescent: boolean;
  readonly manifest: unknown;
  readonly probe: unknown;
  readonly violations: readonly number[];
  readonly violationsValid: boolean;
}

export interface DirectBombadilTraceBinding {
  readonly activationHash: string;
  readonly catalogHash: string;
  readonly route: string;
  readonly scenario: string;
  readonly source: "scenario" | "fixture";
}

export interface DirectBombadilTraceAttestation {
  readonly schema: "direct.bombadil-trace-attestation/v1";
  readonly catalogHash: string;
  readonly final: DirectBombadilTraceBinding & { readonly isQuiescent: true };
  readonly initial: DirectBombadilTraceBinding;
  readonly invalidObservationCount: number;
  readonly observationCount: number;
  readonly validObservationCount: number;
}

export interface DirectBombadilRunnerDependencies {
  readonly acquireServer: typeof acquireVerificationServer;
  readonly now: () => Date;
  readonly runBombadil: (
    invocation: DirectBombadilInvocation,
  ) => Promise<BombadilProcessResult>;
  readonly serverOutputTimeoutMs: number;
  readonly spawnServer: (options: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  }) => ManagedVerificationServer;
  readonly stopServer: typeof stopVerificationServer;
}

interface ProcessSignalEmitter {
  readonly once: (
    signal: NodeJS.Signals,
    listener: (signal: NodeJS.Signals) => void,
  ) => unknown;
  readonly removeListener: (
    signal: NodeJS.Signals,
    listener: (signal: NodeJS.Signals) => void,
  ) => unknown;
}

interface ValidatedConfig extends DirectBombadilFuzzConfig {
  readonly artifactRoot: string;
  readonly baseUrl: string;
  readonly bombadilExecutable: string;
  readonly entryPath: `/${string}`;
  readonly port: string;
  readonly targetQuery: Readonly<Record<string, string>>;
  readonly server: DirectBombadilServerConfig & {
    readonly readinessPath: `/${string}`;
    readonly startupTimeoutMs: number;
  };
}

function readOptionValue(
  arguments_: readonly string[],
  index: number,
  option: string,
): { readonly index: number; readonly value: string } {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return { index: index + 1, value };
}

function parseTimeLimit(value: string): number {
  const match = /^([1-9][0-9]*)s$/u.exec(value);
  if (match === null) {
    throw new Error("--time-limit must be a whole number of seconds such as 20s");
  }
  const seconds = Number(match[1]);
  if (
    !Number.isSafeInteger(seconds)
    || seconds < MIN_TIME_LIMIT_SECONDS
    || seconds > MAX_TIME_LIMIT_SECONDS
  ) {
    throw new Error(
      `--time-limit must be between ${String(MIN_TIME_LIMIT_SECONDS)}s and ${String(MAX_TIME_LIMIT_SECONDS)}s`,
    );
  }
  return seconds;
}

function bombadilNativeBinary(repositoryRoot: string): string {
  let binary: string;
  if (process.platform === "darwin" && process.arch === "arm64") {
    binary = "bombadil-darwin-arm64";
  } else if (process.platform === "linux" && process.arch === "x64") {
    binary = "bombadil-linux-x64";
  } else if (process.platform === "linux" && process.arch === "arm64") {
    binary = "bombadil-linux-arm64";
  } else {
    throw new Error(`Bombadil 0.7.2 does not support ${process.platform}-${process.arch}`);
  }
  return join(
    repositoryRoot,
    "node_modules",
    "@antithesishq",
    "bombadil",
    "binaries",
    binary,
  );
}

function requireLocalRootHttpOrigin(value: string): string {
  const baseUrl = normalizeRootHttpOrigin(value);
  const url = new URL(baseUrl);
  if (!canAutomaticallyStartLocalServer(baseUrl)) {
    throw new Error("--base-url must use HTTP on 127.0.0.1 or localhost");
  }
  if (url.port === "") {
    throw new Error("--base-url must include an explicit local server port");
  }
  if (Number(url.port) < 1) {
    throw new Error("--base-url port must be between 1 and 65535");
  }
  return baseUrl;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function parseTraceDirectObservation(value: unknown): TraceDirectObservation {
  if (!isRecord(value) || !hasExactKeys(value, DIRECT_OBSERVATION_KEYS)) {
    throw new Error("Bombadil trace has an invalid named direct observation");
  }
  const stringKeys = [
    "activationHash",
    "activeRoute",
    "activeScenario",
    "activeSource",
    "bridgeSchema",
    "catalogHash",
  ] as const;
  for (const key of stringKeys) {
    if (typeof value[key] !== "string") {
      throw new Error(`Bombadil trace direct observation has an invalid ${key}`);
    }
  }
  const booleanKeys = [
    "bridgePresent",
    "contractValid",
    "isQuiescent",
    "violationsValid",
  ] as const;
  for (const key of booleanKeys) {
    if (typeof value[key] !== "boolean") {
      throw new Error(`Bombadil trace direct observation has an invalid ${key}`);
    }
  }
  if (
    !Array.isArray(value.violations)
    || !value.violations.every((candidate) =>
      typeof candidate === "number"
      && Number.isSafeInteger(candidate)
      && candidate >= 0
    )
  ) {
    throw new Error("Bombadil trace direct observation has invalid violation counters");
  }
  const activationHash = value.activationHash;
  const activeRoute = value.activeRoute;
  const activeScenario = value.activeScenario;
  const activeSource = value.activeSource;
  const bridgePresent = value.bridgePresent;
  const bridgeSchema = value.bridgeSchema;
  const catalogHash = value.catalogHash;
  const contractValid = value.contractValid;
  const isQuiescent = value.isQuiescent;
  const violationsValid = value.violationsValid;
  if (
    typeof activationHash !== "string"
    || typeof activeRoute !== "string"
    || typeof activeScenario !== "string"
    || typeof activeSource !== "string"
    || typeof bridgePresent !== "boolean"
    || typeof bridgeSchema !== "string"
    || typeof catalogHash !== "string"
    || typeof contractValid !== "boolean"
    || typeof isQuiescent !== "boolean"
    || typeof violationsValid !== "boolean"
  ) {
    throw new Error("Bombadil trace direct observation could not be narrowed");
  }
  return {
    activationHash,
    activeRoute,
    activeScenario,
    activeSource,
    bridgePresent,
    bridgeSchema,
    catalogHash,
    contractValid,
    isQuiescent,
    manifest: value.manifest,
    probe: value.probe,
    violations: value.violations,
    violationsValid,
  };
}

type ExactTraceDirectObservation = DirectBombadilTraceBinding & {
  readonly isQuiescent: boolean;
};

function exactTraceDirectObservation(
  observation: TraceDirectObservation,
): ExactTraceDirectObservation | null {
  if (!observation.bridgePresent) {
    if (
      observation.bridgeSchema !== ""
      || observation.manifest !== null
      || observation.probe !== null
      || observation.contractValid
      || observation.violationsValid
      || observation.isQuiescent
      || observation.activationHash !== ""
      || observation.activeRoute !== ""
      || observation.activeScenario !== ""
      || observation.activeSource !== ""
      || observation.catalogHash !== ""
      || observation.violations.length !== 0
    ) {
      throw new Error("Bombadil trace has a malformed bridge-absent Direct observation");
    }
    return null;
  }
  if (observation.bridgeSchema !== DIRECT_BROWSER_BRIDGE_SCHEMA) {
    throw new Error("Bombadil trace Direct bridge schema is invalid");
  }
  const manifest = parseDirectSessionManifest(observation.manifest);
  if (!manifest.ok) {
    throw new Error(`Bombadil trace Direct manifest is invalid: ${manifest.error.message}`);
  }
  const probe = parseDirectProbeSnapshot(observation.probe);
  if (!probe.ok) {
    throw new Error(`Bombadil trace Direct probe is invalid: ${probe.error.message}`);
  }
  if (manifest.value.active.activationHash !== probe.value.activationHash) {
    throw new Error("Bombadil trace Direct manifest and probe activation hashes differ");
  }
  const violationValues = Object.values(probe.value.violations);
  if (
    !observation.contractValid
    || !observation.violationsValid
    || observation.catalogHash !== manifest.value.catalogHash
    || observation.activationHash !== manifest.value.active.activationHash
    || observation.activeRoute !== manifest.value.active.route
    || observation.activeScenario !== manifest.value.active.scenario
    || observation.activeSource !== manifest.value.active.source
    || observation.isQuiescent !== probe.value.isQuiescent
    || observation.violations.length !== violationValues.length
    || observation.violations.some((value, index) => value !== violationValues[index])
  ) {
    throw new Error("Bombadil trace Direct summary does not match its exact manifest and probe");
  }
  return {
    activationHash: manifest.value.active.activationHash,
    catalogHash: manifest.value.catalogHash,
    route: manifest.value.active.route,
    scenario: manifest.value.active.scenario,
    source: manifest.value.active.source,
    isQuiescent: probe.value.isQuiescent,
  };
}

function parseTraceLine(line: string, lineNumber: number): TraceDirectObservation {
  let input: unknown;
  try {
    input = JSON.parse(line) as unknown;
  } catch {
    throw new Error(`Bombadil trace line ${String(lineNumber)} is not valid JSON`);
  }
  if (!isRecord(input) || !hasExactKeys(input, TRACE_LINE_KEYS)) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid 0.7.2 envelope`);
  }
  if (
    !Number.isSafeInteger(input.timestamp)
    || typeof input.timestamp !== "number"
    || input.timestamp < 0
    || !Array.isArray(input.snapshots)
    || input.snapshots.length > TRACE_MAX_SNAPSHOTS_PER_LINE
    || !Array.isArray(input.violations)
  ) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has invalid state fields`);
  }
  const snapshots = input.snapshots as unknown[];
  const directSnapshots = snapshots.filter((snapshot): snapshot is Readonly<Record<string, unknown>> =>
    isRecord(snapshot) && snapshot.name === "direct"
  );
  if (directSnapshots.length !== 1) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} must contain one named direct snapshot`);
  }
  const snapshot = directSnapshots[0];
  if (
    snapshot === undefined
    || !hasExactKeys(snapshot, TRACE_SNAPSHOT_KEYS)
    || !Number.isSafeInteger(snapshot.index)
    || !Number.isSafeInteger(snapshot.time)
    || (snapshot.index as number) < 0
    || (snapshot.time as number) < 0
  ) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid direct snapshot`);
  }
  return parseTraceDirectObservation(snapshot.value);
}

/** Exact post-run proof over Bombadil 0.7.2's bounded JSONL trace. */
export async function attestDirectBombadilTrace(options: {
  readonly expectedRoute: string;
  readonly expectedScenario: string;
  readonly tracePath: string;
}): Promise<DirectBombadilTraceAttestation> {
  const metadata = await stat(options.tracePath).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.size === 0) {
    throw new Error("Bombadil did not produce a nonempty trace.jsonl");
  }
  if (metadata.size > TRACE_MAX_BYTES) {
    throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_BYTES)} bytes`);
  }

  const stream = createReadStream(options.tracePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let observationCount = 0;
  let invalidObservationCount = 0;
  let validObservationCount = 0;
  let initial: DirectBombadilTraceBinding | null = null;
  let final: ExactTraceDirectObservation | null = null;
  let finalWasInvalid = false;
  try {
    for await (const line of lines) {
      observationCount += 1;
      if (observationCount > TRACE_MAX_LINES) {
        throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_LINES)} lines`);
      }
      if (Buffer.byteLength(line, "utf8") > TRACE_MAX_LINE_BYTES) {
        throw new Error(`Bombadil trace line ${String(observationCount)} is too large`);
      }
      const observation = parseTraceLine(line, observationCount);
      const exact = exactTraceDirectObservation(observation);
      if (exact === null) {
        if (initial !== null) {
          throw new Error("Bombadil trace lost the Direct bridge after exact activation");
        }
        invalidObservationCount += 1;
        finalWasInvalid = true;
        continue;
      }
      validObservationCount += 1;
      final = exact;
      finalWasInvalid = false;
      if (initial === null) {
        if (
          exact.source !== "scenario"
          || exact.scenario !== options.expectedScenario
          || exact.route !== options.expectedRoute
        ) {
          throw new Error("Bombadil trace first valid Direct activation does not match the requested scenario and route");
        }
        initial = {
          activationHash: exact.activationHash,
          catalogHash: exact.catalogHash,
          route: exact.route,
          scenario: exact.scenario,
          source: exact.source,
        };
      }
      if (exact.source !== "scenario") {
        throw new Error("Bombadil trace left scenario activation during the run");
      }
      if (
        exact.scenario !== initial.scenario
        || exact.route !== initial.route
        || exact.activationHash !== initial.activationHash
      ) {
        throw new Error("Bombadil trace Direct activation changed during the run");
      }
      if (exact.catalogHash !== initial.catalogHash) {
        throw new Error("Bombadil trace Direct catalog changed during the run");
      }
      if (observation.violations.some((value) => value !== 0)) {
        throw new Error("Bombadil trace contains a nonzero Direct violation counter");
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (initial === null || final === null) {
    throw new Error("Bombadil trace never reached a valid Direct contract");
  }
  if (finalWasInvalid) {
    throw new Error("Bombadil trace ended without an installed valid Direct bridge");
  }
  if (!final.isQuiescent) {
    throw new Error("Bombadil trace final Direct observation is not quiescent");
  }
  return {
    schema: "direct.bombadil-trace-attestation/v1",
    catalogHash: initial.catalogHash,
    initial,
    final: {
      activationHash: final.activationHash,
      catalogHash: final.catalogHash,
      route: final.route,
      scenario: final.scenario,
      source: final.source,
      isQuiescent: true,
    },
    observationCount,
    invalidObservationCount,
    validObservationCount,
  };
}

export function parseDirectBombadilFuzzArguments(
  arguments_: readonly string[],
  defaultBaseUrl: string,
): DirectBombadilFuzzArguments {
  let baseUrl = defaultBaseUrl;
  let timeLimitSeconds = DEFAULT_TIME_LIMIT_SECONDS;
  let replayPath: string | null = null;
  let receivedBaseUrl = false;
  let receivedTimeLimit = false;
  let receivedReplay = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") return { kind: "help" };

    if (argument === "--base-url" || argument.startsWith("--base-url=")) {
      if (receivedBaseUrl) throw new Error("--base-url may be provided only once");
      receivedBaseUrl = true;
      if (argument === "--base-url") {
        const next = readOptionValue(arguments_, index, "--base-url");
        baseUrl = next.value;
        index = next.index;
      } else {
        baseUrl = argument.slice("--base-url=".length);
      }
      continue;
    }

    if (argument === "--time-limit" || argument.startsWith("--time-limit=")) {
      if (receivedTimeLimit) throw new Error("--time-limit may be provided only once");
      receivedTimeLimit = true;
      let value: string;
      if (argument === "--time-limit") {
        const next = readOptionValue(arguments_, index, "--time-limit");
        value = next.value;
        index = next.index;
      } else {
        value = argument.slice("--time-limit=".length);
      }
      timeLimitSeconds = parseTimeLimit(value);
      continue;
    }

    if (argument === "--replay" || argument.startsWith("--replay=")) {
      if (receivedReplay) throw new Error("--replay may be provided only once");
      receivedReplay = true;
      if (argument === "--replay") {
        const next = readOptionValue(arguments_, index, "--replay");
        replayPath = next.value;
        index = next.index;
      } else {
        replayPath = argument.slice("--replay=".length);
      }
      if (replayPath.length === 0) throw new Error("--replay requires a value");
      continue;
    }

    throw new Error(`Unknown argument at position ${String(index + 1)}`);
  }

  if (receivedReplay && receivedTimeLimit) {
    throw new Error("--replay and --time-limit cannot be used together");
  }
  return {
    kind: "run",
    baseUrl: requireLocalRootHttpOrigin(baseUrl),
    replayPath,
    timeLimitSeconds,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function validateReadinessPath(value: string): asserts value is `/${string}` {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("server.readinessPath must be an origin-relative path");
  }
  const url = new URL(value, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1" || url.hash !== "") {
    throw new Error("server.readinessPath must stay on the server origin without a fragment");
  }
}

function validateEntryPath(value: string): asserts value is `/${string}` {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("entryPath must be an origin-relative path");
  }
  const url = new URL(value, "http://127.0.0.1");
  if (
    url.origin !== "http://127.0.0.1"
    || url.hash !== ""
    || url.search !== ""
    || url.pathname !== value
  ) {
    throw new Error("entryPath must be a normalized path without a query or fragment");
  }
}

function validateTargetQuery(value: unknown): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw new Error("targetQuery must be an object of string query parameters");
  }
  const entries = Object.entries(value);
  if (entries.length > 16) {
    throw new Error("targetQuery may contain at most 16 parameters");
  }
  const validated: Record<string, string> = {};
  for (const [name, queryValue] of [...entries].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    if (
      name.length === 0
      || name.length > 128
      || !QUERY_PARAMETER_NAME_PATTERN.test(name)
      || PROTOTYPE_PROPERTY_NAMES.has(name)
      || hasControlCharacters(name)
      || name === SCENARIO_QUERY_KEY
      || name === FIXTURE_QUERY_KEY
    ) {
      throw new Error("targetQuery contains an invalid or reserved parameter name");
    }
    if (
      typeof queryValue !== "string"
      || queryValue.length > 2_048
      || hasControlCharacters(queryValue)
    ) {
      throw new Error(`targetQuery ${name} must be a bounded string without control characters`);
    }
    validated[name] = queryValue;
  }
  return Object.freeze(validated);
}

export function validateDirectBombadilFuzzConfig(
  config: DirectBombadilFuzzConfig,
  baseUrlOverride?: string,
): ValidatedConfig {
  const repositoryRoot = resolve(config.repositoryRoot);
  if (!isAbsolute(config.repositoryRoot) || repositoryRoot !== config.repositoryRoot) {
    throw new Error("repositoryRoot must be an absolute normalized path");
  }
  if (!ARTIFACT_NAME_PATTERN.test(config.artifactName)) {
    throw new Error("artifactName must be a safe lowercase kebab identifier");
  }
  if (
    config.label.trim().length === 0
    || config.label.length > 160
    || hasControlCharacters(config.label)
  ) {
    throw new Error("label must contain 1-160 visible characters");
  }
  if (
    config.scenario.length > 120
    || !SCENARIO_PATTERN.test(config.scenario)
  ) {
    throw new Error("scenario must be a valid Direct scenario identifier");
  }
  if (
    config.expectedRoute.trim().length === 0
    || config.expectedRoute.length > 256
    || hasControlCharacters(config.expectedRoute)
  ) {
    throw new Error("expectedRoute must contain 1-256 visible characters");
  }

  const specificationPath = resolve(config.specificationPath);
  const serverCwd = resolve(config.server.cwd);
  if (!isAbsolute(config.specificationPath) || !isWithin(repositoryRoot, specificationPath)) {
    throw new Error("specificationPath must be an absolute path inside repositoryRoot");
  }
  if (!/\.[cm]?[jt]sx?$/u.test(specificationPath)) {
    throw new Error("specificationPath must name a JavaScript or TypeScript specification");
  }
  if (!isAbsolute(config.server.cwd) || !isWithin(repositoryRoot, serverCwd)) {
    throw new Error("server.cwd must be an absolute path inside repositoryRoot");
  }
  if (config.server.command.length === 0) {
    throw new Error("server.command must contain at least one argument");
  }
  if (config.server.command.filter((argument) => argument === "{port}").length !== 1) {
    throw new Error("server.command must contain exactly one literal {port} token");
  }
  for (const argument of config.server.command) {
    if (argument.length === 0 || argument.includes("\0")) {
      throw new Error("server.command arguments must be nonempty strings without null bytes");
    }
  }
  for (const [name, value] of Object.entries(config.server.env ?? {})) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new Error("server.env contains an invalid environment variable name");
    }
    if (value !== undefined && (typeof value !== "string" || value.includes("\0"))) {
      throw new Error(`server.env ${name} must be a string without null bytes`);
    }
  }

  const readinessPath = config.server.readinessPath ?? "/";
  validateReadinessPath(readinessPath);
  const entryPath = config.entryPath ?? "/";
  validateEntryPath(entryPath);
  const targetQuery = validateTargetQuery(config.targetQuery ?? {});
  const startupTimeoutMs = config.server.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(startupTimeoutMs)
    || startupTimeoutMs < 1_000
    || startupTimeoutMs > MAX_STARTUP_TIMEOUT_MS
  ) {
    throw new Error(
      `server.startupTimeoutMs must be an integer between 1000 and ${String(MAX_STARTUP_TIMEOUT_MS)}`,
    );
  }

  const baseUrl = requireLocalRootHttpOrigin(baseUrlOverride ?? config.baseUrl);
  const port = new URL(baseUrl).port;
  return {
    ...config,
    repositoryRoot,
    specificationPath,
    baseUrl,
    artifactRoot: join(repositoryRoot, "artifacts", "direct-bombadil", config.artifactName),
    bombadilExecutable: bombadilNativeBinary(repositoryRoot),
    entryPath,
    port,
    targetQuery,
    server: {
      ...config.server,
      cwd: serverCwd,
      readinessPath,
      startupTimeoutMs,
    },
  };
}

function resolveReplayPath(repositoryRoot: string, replayPath: string | null): string | null {
  if (replayPath === null) return null;
  const resolved = resolve(repositoryRoot, replayPath);
  if (!isWithin(repositoryRoot, resolved) || !resolved.endsWith(".jsonl")) {
    throw new Error("--replay must name a .jsonl trace inside repositoryRoot");
  }
  return resolved;
}

export function createDirectBombadilInvocation(options: {
  readonly baseUrl: string;
  readonly bombadilExecutable: string;
  readonly entryPath?: `/${string}`;
  readonly outputPath: string;
  readonly replayPath: string | null;
  readonly repositoryRoot: string;
  readonly scenario: string;
  readonly specificationPath: string;
  readonly targetQuery?: Readonly<Record<string, string>>;
  readonly timeLimitSeconds: number;
}): DirectBombadilInvocation {
  const target = new URL(options.entryPath ?? "/", `${options.baseUrl}/`);
  target.searchParams.set(SCENARIO_QUERY_KEY, options.scenario);
  for (const [name, value] of Object.entries(options.targetQuery ?? {})) {
    target.searchParams.set(name, value);
  }
  const command = [
    options.bombadilExecutable,
    "browser",
    "test",
    target.href,
    options.specificationPath,
    "--output-path",
    options.outputPath,
    "--headless",
    "--instrument-javascript=",
  ];
  if (options.replayPath === null) {
    command.push(
      "--exit-on-violation",
      "--time-limit",
      `${String(options.timeLimitSeconds)}s`,
    );
  } else {
    command.push("--reproduce", options.replayPath);
  }
  return {
    command,
    cwd: options.repositoryRoot,
    outputPath: options.outputPath,
    targetUrl: target.href,
    wallClockTimeoutMs: options.replayPath === null
      ? options.timeLimitSeconds * 1_000 + RANDOM_RUN_OVERHEAD_MS
      : REPLAY_WALL_CLOCK_TIMEOUT_MS,
  };
}

interface StreamCapture {
  readonly result: Promise<string>;
  readonly stop: () => void;
}

function captureStream(
  stream: ReadableStream<Uint8Array>,
  maximumLength = LOG_LIMIT,
): StreamCapture {
  let stopCapture!: () => void;
  const stopped = new Promise<void>((resolveStopped) => {
    stopCapture = resolveStopped;
  });
  const result = (async (): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = "";
    for (;;) {
      const next = await Promise.race([
        reader.read().then(
          (chunk) => ({ kind: "chunk" as const, chunk }),
          (error: unknown) => ({ kind: "error" as const, error }),
        ),
        stopped.then(() => ({ kind: "stopped" as const })),
      ]);
      if (next.kind === "stopped") {
        void reader.cancel().catch(() => undefined);
        return tail(`${output}${decoder.decode()}`, maximumLength);
      }
      if (next.kind === "error") throw next.error;
      if (next.chunk.done) return tail(`${output}${decoder.decode()}`, maximumLength);
      output = tail(
        `${output}${decoder.decode(next.chunk.value, { stream: true })}`,
        maximumLength,
      );
    }
  })();
  return { result, stop: stopCapture };
}

function signalProcessGroup(
  process_: ReturnType<typeof Bun.spawn>,
  signal: "SIGKILL" | "SIGTERM",
): void {
  try {
    process.kill(-process_.pid, signal);
  } catch {
    if (process_.exitCode === null) process_.kill(signal);
  }
}

async function terminateProcessGroup(
  process_: ReturnType<typeof Bun.spawn>,
  graceMs: number,
): Promise<void> {
  signalProcessGroup(process_, "SIGTERM");
  await Bun.sleep(graceMs);
  // The group may still contain descendants after its leader exits on TERM.
  signalProcessGroup(process_, "SIGKILL");
  await Promise.race([process_.exited.then(() => undefined), Bun.sleep(graceMs)]);
}

export async function runBombadilNativeProcess(
  invocation: DirectBombadilInvocation,
): Promise<BombadilProcessResult> {
  const process_ = Bun.spawn([...invocation.command], {
    cwd: invocation.cwd,
    detached: true,
    env: { ...process.env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<"timeout">((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout("timeout"), invocation.wallClockTimeoutMs);
  });
  const abortPromise = new Promise<"aborted">((resolveAbort) => {
    if (invocation.abortSignal === undefined) return;
    if (invocation.abortSignal.aborted) {
      resolveAbort("aborted");
      return;
    }
    abortListener = () => resolveAbort("aborted");
    invocation.abortSignal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const stdoutCapture = captureStream(process_.stdout);
    const stderrCapture = captureStream(process_.stderr);
    const outputPromise = Promise.all([stdoutCapture.result, stderrCapture.result]);
    const outcome = await Promise.race([
      process_.exited.then((exitCode) => ({ kind: "exited" as const, exitCode })),
      timeoutPromise.then(() => ({ kind: "timeout" as const })),
      abortPromise.then(() => ({ kind: "aborted" as const })),
    ]);
    const terminationGraceMs = invocation.terminationGraceMs
      ?? PROCESS_TERMINATION_GRACE_MS;
    if (outcome.kind === "exited") {
      // The native leader is done. Any member left in its group is stale and
      // may otherwise keep inherited output pipes open indefinitely.
      signalProcessGroup(process_, "SIGKILL");
    } else {
      await terminateProcessGroup(
        process_,
        terminationGraceMs,
      );
    }
    const outputSettled = await Promise.race([
      outputPromise.then(
        () => true,
        () => true,
      ),
      Bun.sleep(Math.max(terminationGraceMs, MIN_PROCESS_OUTPUT_DRAIN_MS)).then(() => false),
    ]);
    if (!outputSettled) {
      stdoutCapture.stop();
      stderrCapture.stop();
    }
    const [stdout, stderr] = await outputPromise;
    return {
      exitCode: outcome.kind === "exited" ? outcome.exitCode : process_.exitCode ?? 137,
      stderr,
      stdout,
      termination: outcome.kind === "exited" ? null : outcome.kind,
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortListener !== undefined) {
      invocation.abortSignal?.removeEventListener("abort", abortListener);
    }
  }
}

const defaultDependencies: DirectBombadilRunnerDependencies = {
  acquireServer: acquireVerificationServer,
  now: () => new Date(),
  runBombadil: runBombadilNativeProcess,
  serverOutputTimeoutMs: SERVER_OUTPUT_TIMEOUT_MS,
  spawnServer: spawnVerificationServer,
  stopServer: stopVerificationServer,
};

async function readServerOutputBounded(
  server: ManagedVerificationServer,
  timeoutMs: number,
): Promise<string> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<{ readonly kind: "timeout" }>((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      server.output.then(
        (output) => ({ kind: "output" as const, output }),
        (error: unknown) => ({ kind: "error" as const, error }),
      ),
      timeoutPromise,
    ]);
    if (outcome.kind === "timeout") {
      throw new Error(
        `Verification server output did not settle within ${String(timeoutMs)}ms after cleanup`,
      );
    }
    if (outcome.kind === "error") {
      throw outcome.error instanceof Error
        ? outcome.error
        : new Error(renderUnknown(outcome.error));
    }
    return tail(outcome.output, LOG_LIMIT);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function requireRegularFile(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error(`${label} does not exist at its configured path`);
  }
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
}

async function requireDirectory(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error(`${label} does not exist at its configured path`);
  }
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`);
}

async function resolveExistingRealPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    throw new Error(`${label} does not exist at its configured path`);
  }
}

async function resolveConfinedRealPath(options: {
  readonly candidate: string;
  readonly kind: "directory" | "file";
  readonly label: string;
  readonly repositoryRoot: string;
}): Promise<string> {
  const resolved = await resolveExistingRealPath(options.candidate, options.label);
  if (!isWithin(options.repositoryRoot, resolved)) {
    throw new Error(`${options.label} resolves outside repositoryRoot`);
  }
  if (options.kind === "directory") {
    await requireDirectory(resolved, options.label);
  } else {
    await requireRegularFile(resolved, options.label);
  }
  return resolved;
}

async function resolveDirectBombadilRealPaths(
  config: ValidatedConfig,
  replayPath: string | null,
): Promise<{ readonly config: ValidatedConfig; readonly replayPath: string | null }> {
  const repositoryRoot = await resolveExistingRealPath(
    config.repositoryRoot,
    "repositoryRoot",
  );
  await requireDirectory(repositoryRoot, "repositoryRoot");
  const specificationPath = await resolveConfinedRealPath({
    candidate: config.specificationPath,
    kind: "file",
    label: "specificationPath",
    repositoryRoot,
  });
  if (!/\.[cm]?[jt]sx?$/u.test(specificationPath)) {
    throw new Error("specificationPath must resolve to a JavaScript or TypeScript file");
  }
  const serverCwd = await resolveConfinedRealPath({
    candidate: config.server.cwd,
    kind: "directory",
    label: "server.cwd",
    repositoryRoot,
  });
  const resolvedReplayPath = replayPath === null
    ? null
    : await resolveConfinedRealPath({
      candidate: replayPath,
      kind: "file",
      label: "--replay",
      repositoryRoot,
    });
  if (resolvedReplayPath !== null && !resolvedReplayPath.endsWith(".jsonl")) {
    throw new Error("--replay must resolve to a .jsonl trace inside repositoryRoot");
  }
  return {
    config: {
      ...config,
      repositoryRoot,
      specificationPath,
      artifactRoot: join(
        repositoryRoot,
        "artifacts",
        "direct-bombadil",
        config.artifactName,
      ),
      bombadilExecutable: bombadilNativeBinary(repositoryRoot),
      server: { ...config.server, cwd: serverCwd },
    },
    replayPath: resolvedReplayPath,
  };
}

async function readExactBombadilVersion(repositoryRoot: string): Promise<string> {
  const packagePath = join(
    repositoryRoot,
    "node_modules",
    "@antithesishq",
    "bombadil",
    "package.json",
  );
  let input: unknown;
  try {
    input = JSON.parse(await readFile(packagePath, "utf8")) as unknown;
  } catch {
    throw new Error("The root Bombadil package metadata is missing or malformed");
  }
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || Reflect.get(input, "version") !== EXPECTED_BOMBADIL_VERSION
  ) {
    throw new Error(`The root Bombadil package must be exactly ${EXPECTED_BOMBADIL_VERSION}`);
  }
  return EXPECTED_BOMBADIL_VERSION;
}

function helpText(defaultBaseUrl: string): string {
  return [
    "Usage: bun fuzz-browser.ts [options]",
    "",
    `  --base-url <url>    Local server root (default: ${defaultBaseUrl})`,
    `  --time-limit <Ns>   Random exploration limit, 12-300s (default: ${String(DEFAULT_TIME_LIMIT_SECONDS)}s)`,
    "  --replay <trace>    Reproduce a repository-local trace.jsonl",
    "  -h, --help          Show this help",
  ].join("\n");
}

/** Runs one bounded diagnostic Bombadil campaign and always releases its server lease. */
export async function runDirectBombadilFuzz(
  config: DirectBombadilFuzzConfig,
  arguments_: readonly string[] = process.argv.slice(2),
  dependencyOverrides: Partial<DirectBombadilRunnerDependencies> = {},
): Promise<DirectBombadilFuzzResult> {
  const parsed = parseDirectBombadilFuzzArguments(arguments_, config.baseUrl);
  if (parsed.kind === "help") {
    process.stdout.write(`${helpText(config.baseUrl)}\n`);
    return { kind: "help" };
  }

  const lexicalConfig = validateDirectBombadilFuzzConfig(config, parsed.baseUrl);
  const lexicalReplayPath = resolveReplayPath(
    lexicalConfig.repositoryRoot,
    parsed.replayPath,
  );
  const resolvedPaths = await resolveDirectBombadilRealPaths(
    lexicalConfig,
    lexicalReplayPath,
  );
  const validated = resolvedPaths.config;
  const replayPath = resolvedPaths.replayPath;
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const generatedAt = dependencies.now();
  const artifactRun = await createArtifactRun({
    artifactRoot: validated.artifactRoot,
    generatedAt: generatedAt.toISOString(),
  });
  const outputPath = join(artifactRun.runDirectory, "bombadil");
  const tracePath = join(outputPath, "trace.jsonl");
  const abortController = new AbortController();
  const invocation = createDirectBombadilInvocation({
    baseUrl: validated.baseUrl,
    bombadilExecutable: validated.bombadilExecutable,
    entryPath: validated.entryPath,
    outputPath,
    replayPath,
    repositoryRoot: validated.repositoryRoot,
    scenario: validated.scenario,
    specificationPath: validated.specificationPath,
    targetQuery: validated.targetQuery,
    timeLimitSeconds: parsed.timeLimitSeconds,
  });
  const abortableInvocation = { ...invocation, abortSignal: abortController.signal };
  const serverCommand = validated.server.command.map((argument) =>
    argument === "{port}" ? validated.port : argument
  );

  let bombadilVersion: string | null = null;
  let lease: ServerLease | null = null;
  let ownedServer: ManagedVerificationServer | null = null;
  let processResult: BombadilProcessResult | null = null;
  let attestation: DirectBombadilTraceAttestation | null = null;
  let attestationFailure: unknown = null;
  let rawTracePath: string | null = null;
  let serverOutput = "";
  let serverOutputFailure: unknown = null;
  let failure: unknown = null;
  let interruptedSignal: NodeJS.Signals | null = null;
  const interrupt = (signal: NodeJS.Signals): void => {
    interruptedSignal ??= signal;
    abortController.abort();
    if (ownedServer?.exitCode() === null) ownedServer.terminate();
  };
  const interruptSignals = ["SIGINT", "SIGTERM"] as const;
  // @types/bun augments Node's process events and has changed this overload
  // across patch releases. Bind the stable signal subset used by this runner.
  const processSignals = process as unknown as ProcessSignalEmitter;
  for (const signal of interruptSignals) processSignals.once(signal, interrupt);
  try {
    try {
      await requireRegularFile(validated.bombadilExecutable, "The root Bombadil executable");
      bombadilVersion = await readExactBombadilVersion(validated.repositoryRoot);
      if (abortController.signal.aborted) throw new Error("Bombadil fuzzing was interrupted");

      lease = await dependencies.acquireServer({
        baseUrl: validated.baseUrl,
        label: validated.label,
        readinessPath: validated.server.readinessPath,
        reuseExistingLocalServer: false,
        startupTimeoutMs: validated.server.startupTimeoutMs,
        startServer: () => {
          ownedServer = dependencies.spawnServer({
            command: serverCommand,
            cwd: validated.server.cwd,
            ...(validated.server.env === undefined ? {} : { env: validated.server.env }),
          });
          return ownedServer;
        },
      });
      let processFailure: unknown = null;
      try {
        processResult = await dependencies.runBombadil(abortableInvocation);
      } catch (error) {
        processFailure = error;
      }
      const traceMetadata = await stat(tracePath).catch(() => null);
      if (traceMetadata?.isFile() === true && traceMetadata.size > 0) {
        rawTracePath = tracePath;
      }
      try {
        attestation = await attestDirectBombadilTrace({
          expectedRoute: validated.expectedRoute,
          expectedScenario: validated.scenario,
          tracePath,
        });
      } catch (error) {
        attestationFailure = error;
      }
      if (processFailure !== null) {
        throw processFailure instanceof Error
          ? processFailure
          : new Error(renderUnknown(processFailure));
      }
      if (processResult === null) throw new Error("Bombadil did not return a process result");
      if (processResult.termination === "timeout") {
        throw new Error(
          `Bombadil exceeded its ${String(invocation.wallClockTimeoutMs)}ms wall-clock limit`,
        );
      }
      if (processResult.termination === "aborted") {
        throw new Error("Bombadil process was interrupted");
      }
      if (processResult.exitCode !== 0) {
        throw new Error(`Bombadil exited with status ${String(processResult.exitCode)}`);
      }
      if (attestationFailure !== null) {
        throw attestationFailure instanceof Error
          ? attestationFailure
          : new Error(renderUnknown(attestationFailure));
      }
    } catch (error) {
      failure = error;
    }

    const serverToStop = lease?.source === "started" ? lease.server : ownedServer;
    if (serverToStop !== null) {
      try {
        await dependencies.stopServer(serverToStop);
      } catch (error) {
        failure ??= error;
      }
    }
    const serverAfterRun = ownedServer as ManagedVerificationServer | null;
    if (serverAfterRun !== null) {
      try {
        serverOutput = await readServerOutputBounded(
          serverAfterRun,
          dependencies.serverOutputTimeoutMs,
        );
      } catch (error) {
        serverOutputFailure = error;
        failure ??= error;
      }
    }
  } finally {
    for (const signal of interruptSignals) {
      processSignals.removeListener(signal, interrupt);
    }
  }
  const capturedSignal = interruptedSignal as NodeJS.Signals | null;
  if (capturedSignal !== null && failure === null) {
    failure = new Error(`Bombadil fuzzing was interrupted by ${capturedSignal}`);
  }

  const completedAt = dependencies.now();
  const status = failure === null ? "passed" : "failed";
  const logPath = join(artifactRun.runDirectory, "bombadil.log");
  const serverLogPath = join(artifactRun.runDirectory, "server.log");
  const record = {
    schema: ARTIFACT_SCHEMA,
    evidenceClass: "diagnostic-fuzz",
    artifactName: validated.artifactName,
    label: validated.label,
    status,
    generatedAt: generatedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - generatedAt.getTime()),
    scenario: validated.scenario,
    expectedRoute: validated.expectedRoute,
    baseUrl: validated.baseUrl,
    entryPath: validated.entryPath,
    targetQuery: validated.targetQuery,
    targetUrl: invocation.targetUrl,
    specificationPath: validated.specificationPath,
    replayPath,
    timeLimitSeconds: replayPath === null ? parsed.timeLimitSeconds : null,
    serverSource: lease?.source ?? null,
    bombadil: {
      version: bombadilVersion,
      executable: validated.bombadilExecutable,
      exitCode: processResult?.exitCode ?? null,
      termination: processResult?.termination ?? null,
      outputPath,
      rawTracePath,
      tracePath: attestation === null ? null : tracePath,
      logPath,
    },
    server: {
      logPath: serverLogPath,
      logPresent: serverOutput.length > 0,
      outputFailure: serverOutputFailure === null ? null : renderUnknown(serverOutputFailure),
    },
    attestation,
    attestationFailure: attestationFailure === null ? null : renderUnknown(attestationFailure),
    initialDirect: attestation?.initial ?? null,
    interruptedSignal: capturedSignal,
    failure: failure === null ? null : renderUnknown(failure),
  } as const;
  const log = [processResult?.stdout ?? "", processResult?.stderr ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
  try {
    await writeFile(logPath, `${log}${log.length > 0 ? "\n" : ""}`, "utf8");
    await writeFile(
      serverLogPath,
      `${serverOutput}${serverOutput.length > 0 ? "\n" : ""}`,
      "utf8",
    );
    await writeJsonAtomically(join(artifactRun.runDirectory, "run.json"), record);
    await writeJsonAtomically(artifactRun.manifestPath, record);

    const summary = `${status === "passed" ? "PASS" : "FAIL"} ${validated.label}; artifacts: ${artifactRun.runDirectory}; log: ${logPath}`;
    (status === "passed" ? process.stdout : process.stderr).write(`${summary}\n`);

    if (failure !== null) {
      throw failure instanceof Error ? failure : new Error(renderUnknown(failure));
    }
    return {
      kind: "run",
      artifactDirectory: artifactRun.runDirectory,
      manifestPath: artifactRun.manifestPath,
      status: "passed",
    };
  } finally {
    if (capturedSignal !== null) {
      process.kill(process.pid, capturedSignal);
    }
  }
}
