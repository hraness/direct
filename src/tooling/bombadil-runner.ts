import { createReadStream } from "node:fs";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

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
const TRACE_MAX_NAMED_SNAPSHOT_NAMES = 128;
const TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME = 1_024;
const TRACE_MAX_DISTINCT_URLS = 1_024;
const TRACE_MAX_PROPERTY_NAMES = 128;
const TRACE_MAX_CANONICAL_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const TRACE_MAX_JSON_DEPTH = 64;
const RANDOM_RUN_OVERHEAD_MS = 30_000;
const REPLAY_WALL_CLOCK_TIMEOUT_MS = MAX_TIME_LIMIT_SECONDS * 1_000 + RANDOM_RUN_OVERHEAD_MS;
const PROCESS_TERMINATION_GRACE_MS = 5_000;
const MIN_PROCESS_OUTPUT_DRAIN_MS = 500;
const SERVER_OUTPUT_TIMEOUT_MS = 3_000;
const DIRECT_BROWSER_BRIDGE_SCHEMA = "direct.browser-bridge/v2";
const TRACE_LINE_KEYS = new Set(["action", "snapshots", "state", "timestamp", "violations"]);
const TRACE_SNAPSHOT_KEYS = new Set(["index", "name", "time", "value"]);
const TRACE_STATE_KEYS = new Set([
  "hash_current",
  "hash_previous",
  "resources",
  "screenshot",
  "url",
]);
const TRACE_RESOURCE_KEYS = new Set([
  "documents",
  "dom_nodes",
  "js_event_listeners",
  "js_heap_total",
  "js_heap_used",
  "layout_objects",
  "script_duration",
  "task_duration",
  "thread_time",
  "timestamp",
]);
const TRACE_VIOLATION_KEYS = new Set(["name", "violation"]);
const TRACE_POINT_KEYS = new Set(["x", "y"]);
const TRACE_FINGERPRINT_KEYS = new Set([
  "accessible_name",
  "href",
  "id",
  "input_type",
  "name_attr",
  "placeholder",
  "role",
  "structural_path",
  "tag",
  "test_id",
  "text_content",
]);
const TRACE_CLICK_ACTION_KEYS = new Set(["fingerprint", "point"]);
const TRACE_DOUBLE_CLICK_ACTION_KEYS = new Set([
  "delay_millis",
  "fingerprint",
  "point",
]);
const TRACE_TYPE_TEXT_ACTION_KEYS = new Set(["delay_millis", "text"]);
const TRACE_PRESS_KEY_ACTION_KEYS = new Set(["code"]);
const TRACE_SCROLL_ACTION_KEYS = new Set(["distance", "origin"]);
const TRACE_FILE_INPUT_ACTION_KEYS = new Set(["files", "selector"]);
const TRACE_MOUSE_DRAG_ACTION_KEYS = new Set([
  "delay_millis",
  "from",
  "steps",
  "to",
]);
const TRACE_VIEWPORT_ACTION_KEYS = new Set(["height", "width"]);
const VIEWPORT_KEYS = new Set(["deviceScaleFactor", "height", "width"]);
const EXPLORATION_POLICY_KEYS = new Set([
  "minDistinctNamedSnapshotValues",
  "minNamedSnapshotChangesAfterActionKind",
  "minNamedSnapshotChangesAfterNonWait",
  "minNonWaitActions",
  "requireStableTargetUrl",
  "requiredActionKinds",
  "requiredNamedSnapshots",
]);
const DEFAULT_VIEWPORT_WIDTH = 1_024;
const DEFAULT_VIEWPORT_HEIGHT = 768;
const DEFAULT_DEVICE_SCALE_FACTOR = 2;
const SNAPSHOT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]*$/u;
const TARGET_TAG_PATTERN = /^[a-z][a-z0-9-]*$/u;
const ACTION_KINDS = [
  "Back",
  "Click",
  "DoubleClick",
  "Forward",
  "MouseDrag",
  "PressKey",
  "Reload",
  "ScrollDown",
  "ScrollUp",
  "SetFileInputFiles",
  "SetViewport",
  "TypeText",
  "Wait",
] as const;
const ACTION_KIND_SET = new Set<string>(ACTION_KINDS);
const UNIT_ACTION_KINDS = new Set<DirectBombadilActionKind>([
  "Back",
  "Forward",
  "Reload",
  "Wait",
]);
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

export type DirectBombadilActionKind = (typeof ACTION_KINDS)[number];

export interface DirectBombadilViewportConfig {
  readonly deviceScaleFactor?: number;
  readonly height?: number;
  readonly width?: number;
}

export interface DirectBombadilExplorationPolicy {
  readonly minDistinctNamedSnapshotValues?: Readonly<Record<string, number>>;
  readonly minNamedSnapshotChangesAfterActionKind?: Readonly<Record<
    string,
    Readonly<Partial<Record<DirectBombadilActionKind, number>>>
  >>;
  readonly minNamedSnapshotChangesAfterNonWait?: Readonly<Record<string, number>>;
  readonly minNonWaitActions?: number;
  readonly requireStableTargetUrl?: boolean;
  readonly requiredActionKinds?: readonly DirectBombadilActionKind[];
  readonly requiredNamedSnapshots?: readonly string[];
}

export interface DirectBombadilExplorationSummary {
  readonly schema: "direct.bombadil-exploration-summary/v2";
  readonly trace: {
    readonly bytes: number;
    readonly lineCount: number;
    readonly sha256: string;
  };
  readonly actions: {
    readonly byKind: Readonly<Partial<Record<DirectBombadilActionKind, number>>>;
    readonly maxWaitStreak: number;
    readonly nonWaitCount: number;
    readonly targetTags: Readonly<Record<string, number>>;
    readonly total: number;
  };
  readonly urls: {
    readonly distinctFingerprintCount: number;
    readonly fingerprintSha256: readonly string[];
    readonly observationCount: number;
    readonly rawDistinctFingerprintCount: number;
    readonly rawFingerprintSha256: readonly string[];
    readonly rawObservationCount: number;
    readonly stableTarget: boolean;
  };
  readonly transitions: {
    readonly distinctNonNullHashCount: number;
    readonly nonNullHashCount: number;
    readonly rawDistinctNonNullHashCount: number;
    readonly rawNonNullHashCount: number;
  };
  readonly namedSnapshots: readonly {
    readonly changeAfterActionKind: Readonly<
      Partial<Record<DirectBombadilActionKind, number>>
    >;
    readonly changeAfterNonWaitCount: number;
    readonly distinctValueCount: number;
    readonly distinctValueSha256: readonly string[];
    readonly name: string;
    readonly observationCount: number;
  }[];
  readonly propertyViolations: {
    readonly byName: Readonly<Record<string, number>>;
    readonly total: number;
  };
  readonly resourceHighWaterMarks: {
    readonly documents: number;
    readonly domNodes: number;
    readonly jsEventListeners: number;
    readonly jsHeapTotalBytes: number;
    readonly jsHeapUsedBytes: number;
    readonly layoutObjects: number;
    readonly scriptDurationSeconds: number;
    readonly taskDurationSeconds: number;
    readonly threadTimeSeconds: number;
  };
  readonly policy: {
    readonly configured: boolean;
    readonly failures: readonly string[];
    readonly satisfied: boolean;
  };
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
  readonly explorationPolicy?: DirectBombadilExplorationPolicy;
  readonly viewport?: DirectBombadilViewportConfig;
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

export interface DirectBombadilFuzzCampaign {
  readonly config: DirectBombadilFuzzConfig;
  readonly id: string;
}

export type DirectBombadilFuzzMatrixResult =
  | { readonly kind: "help" }
  | {
      readonly kind: "matrix";
      readonly results: readonly {
        readonly campaignId: string;
        readonly result: Extract<DirectBombadilFuzzResult, { readonly kind: "run" }>;
      }[];
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

type ValidatedConfig = Omit<
  DirectBombadilFuzzConfig,
  "explorationPolicy" | "server" | "viewport"
> & {
  readonly artifactRoot: string;
  readonly baseUrl: string;
  readonly bombadilExecutable: string;
  readonly entryPath: `/${string}`;
  readonly explorationPolicy: ValidatedExplorationPolicy | null;
  readonly port: string;
  readonly targetQuery: Readonly<Record<string, string>>;
  readonly viewport: ValidatedViewport;
  readonly server: DirectBombadilServerConfig & {
    readonly readinessPath: `/${string}`;
    readonly startupTimeoutMs: number;
  };
};

interface ValidatedViewport {
  readonly deviceScaleFactor: number;
  readonly height: number;
  readonly width: number;
}

interface ValidatedExplorationPolicy {
  readonly minDistinctNamedSnapshotValues: Readonly<Record<string, number>>;
  readonly minNamedSnapshotChangesAfterActionKind: Readonly<Record<
    string,
    Readonly<Partial<Record<DirectBombadilActionKind, number>>>
  >>;
  readonly minNamedSnapshotChangesAfterNonWait: Readonly<Record<string, number>>;
  readonly minNonWaitActions: number;
  readonly requireStableTargetUrl: boolean;
  readonly requiredActionKinds: readonly DirectBombadilActionKind[];
  readonly requiredNamedSnapshots: readonly string[];
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

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
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

interface ParsedTraceAction {
  readonly kind: DirectBombadilActionKind;
  readonly targetTag: string | null;
}

interface ParsedTraceState {
  readonly currentHash: number | null;
  readonly resources: Readonly<Record<keyof typeof RESOURCE_FIELD_MAP, number>>;
  readonly url: URL;
}

interface ParsedTraceLine {
  readonly action: ParsedTraceAction | null;
  readonly directObservation: TraceDirectObservation;
  readonly namedSnapshots: readonly {
    readonly name: string;
    readonly valueSha256: string;
  }[];
  readonly propertyViolationNames: readonly string[];
  readonly state: ParsedTraceState;
}

const RESOURCE_FIELD_MAP = {
  documents: "documents",
  dom_nodes: "domNodes",
  js_event_listeners: "jsEventListeners",
  js_heap_total: "jsHeapTotalBytes",
  js_heap_used: "jsHeapUsedBytes",
  layout_objects: "layoutObjects",
  script_duration: "scriptDurationSeconds",
  task_duration: "taskDurationSeconds",
  thread_time: "threadTimeSeconds",
} as const;

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > TRACE_MAX_JSON_DEPTH) {
    throw new Error(`Bombadil named snapshot exceeds JSON depth ${String(TRACE_MAX_JSON_DEPTH)}`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Bombadil named snapshot has a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(",")}]`;
  }
  if (!isRecord(value)) throw new Error("Bombadil named snapshot is not JSON");
  const entries = Object.keys(value).sort(compareCodeUnits).map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`
  );
  return `{${entries.join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function namedSnapshotValueSha256(value: unknown): string {
  const canonical = canonicalJson(value);
  if (Buffer.byteLength(canonical, "utf8") > TRACE_MAX_CANONICAL_SNAPSHOT_BYTES) {
    throw new Error(
      `Bombadil named snapshot exceeds ${String(TRACE_MAX_CANONICAL_SNAPSHOT_BYTES)} canonical bytes`,
    );
  }
  return sha256(canonical);
}

function validTracePoint(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, TRACE_POINT_KEYS)
    && typeof value.x === "number"
    && Number.isFinite(value.x)
    && typeof value.y === "number"
    && Number.isFinite(value.y);
}

function parseTraceFingerprintTag(value: unknown, lineNumber: number): string {
  if (
    !isRecord(value)
    || !Object.keys(value).every((key) => TRACE_FINGERPRINT_KEYS.has(key))
  ) {
    throw new Error(
      `Bombadil trace line ${String(lineNumber)} has an invalid action target`,
    );
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (key !== "tag" && typeof candidate !== "string") {
      throw new Error(
        `Bombadil trace line ${String(lineNumber)} has an invalid action target`,
      );
    }
  }
  const tag = value.tag;
  if (
    typeof tag !== "string"
    || tag.length === 0
  ) {
    throw new Error(
      `Bombadil trace line ${String(lineNumber)} has an invalid action target tag`,
    );
  }
  if (
    typeof value.structural_path === "string"
    && Object.keys(value).some((key) => (
      key !== "tag" && key !== "structural_path"
    ))
  ) {
    throw new Error(
      `Bombadil trace line ${String(lineNumber)} has an invalid action target`,
    );
  }
  return tag.length <= 64 && TARGET_TAG_PATTERN.test(tag)
    ? tag
    : `sha256:${sha256(tag)}`;
}

function isSafeIntegerBetween(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= maximum;
}

function invalidTraceAction(lineNumber: number): never {
  throw new Error(
    `Bombadil trace line ${String(lineNumber)} has an invalid action`,
  );
}

function parseTraceAction(value: unknown, lineNumber: number): ParsedTraceAction | null {
  if (value === null) return null;
  if (typeof value === "string") {
    if (!ACTION_KIND_SET.has(value) || !UNIT_ACTION_KINDS.has(value as DirectBombadilActionKind)) {
      return invalidTraceAction(lineNumber);
    }
    return { kind: value as DirectBombadilActionKind, targetTag: null };
  }
  if (!isRecord(value) || Object.keys(value).length !== 1) {
    return invalidTraceAction(lineNumber);
  }
  const kind = Object.keys(value)[0];
  const payload = kind === undefined ? undefined : value[kind];
  if (
    kind === undefined
    || !ACTION_KIND_SET.has(kind)
    || UNIT_ACTION_KINDS.has(kind as DirectBombadilActionKind)
    || !isRecord(payload)
  ) {
    return invalidTraceAction(lineNumber);
  }
  const actionKind = kind as DirectBombadilActionKind;
  let targetTag: string | null = null;
  switch (actionKind) {
    case "Click":
      if (
        !hasExactKeys(payload, TRACE_CLICK_ACTION_KEYS)
        || !validTracePoint(payload.point)
      ) {
        return invalidTraceAction(lineNumber);
      }
      targetTag = parseTraceFingerprintTag(payload.fingerprint, lineNumber);
      break;
    case "DoubleClick":
      if (
        !hasExactKeys(payload, TRACE_DOUBLE_CLICK_ACTION_KEYS)
        || !isSafeIntegerBetween(payload.delay_millis, 0, 1_000)
        || !validTracePoint(payload.point)
      ) return invalidTraceAction(lineNumber);
      targetTag = parseTraceFingerprintTag(payload.fingerprint, lineNumber);
      break;
    case "TypeText":
      if (
        !hasExactKeys(payload, TRACE_TYPE_TEXT_ACTION_KEYS)
        || !isSafeIntegerBetween(payload.delay_millis, 0, Number.MAX_SAFE_INTEGER)
        || typeof payload.text !== "string"
      ) return invalidTraceAction(lineNumber);
      break;
    case "PressKey":
      if (
        !hasExactKeys(payload, TRACE_PRESS_KEY_ACTION_KEYS)
        || !isSafeIntegerBetween(payload.code, 0, 255)
      ) {
        return invalidTraceAction(lineNumber);
      }
      break;
    case "ScrollDown":
    case "ScrollUp":
      if (
        !hasExactKeys(payload, TRACE_SCROLL_ACTION_KEYS)
        || typeof payload.distance !== "number"
        || !Number.isFinite(payload.distance)
        || !validTracePoint(payload.origin)
      ) return invalidTraceAction(lineNumber);
      break;
    case "SetFileInputFiles":
      if (
        !hasExactKeys(payload, TRACE_FILE_INPUT_ACTION_KEYS)
        || typeof payload.selector !== "string"
        || !Array.isArray(payload.files)
        || !payload.files.every((file) => typeof file === "string")
      ) return invalidTraceAction(lineNumber);
      break;
    case "MouseDrag":
      if (
        !hasExactKeys(payload, TRACE_MOUSE_DRAG_ACTION_KEYS)
        || !isSafeIntegerBetween(payload.delay_millis, 0, 1_000)
        || !isSafeIntegerBetween(payload.steps, 1, 255)
        || !validTracePoint(payload.from)
        || !validTracePoint(payload.to)
      ) return invalidTraceAction(lineNumber);
      break;
    case "SetViewport":
      if (
        !hasExactKeys(payload, TRACE_VIEWPORT_ACTION_KEYS)
        || !isSafeIntegerBetween(payload.height, 1, 10_000)
        || !isSafeIntegerBetween(payload.width, 1, 10_000)
      ) return invalidTraceAction(lineNumber);
      break;
    default:
      return invalidTraceAction(lineNumber);
  }
  return { kind: actionKind, targetTag };
}

function parseNonNegativeFiniteNumber(
  value: unknown,
  lineNumber: number,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid ${field}`);
  }
  return value;
}

function parseTraceState(value: unknown, lineNumber: number): ParsedTraceState {
  if (!isRecord(value) || !hasExactKeys(value, TRACE_STATE_KEYS)) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid browser state`);
  }
  if (typeof value.url !== "string" || value.url.length === 0 || value.url.length > 8_192) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid browser URL`);
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid browser URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid browser URL protocol`);
  }
  if (typeof value.screenshot !== "string" || value.screenshot.length > 8_192) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid screenshot path`);
  }
  for (const field of ["hash_previous", "hash_current"] as const) {
    const hash = value[field];
    if (hash !== null && (
      typeof hash !== "number"
      || !Number.isFinite(hash)
      || !Number.isInteger(hash)
      || hash < 0
    )) {
      throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid ${field}`);
    }
  }
  if (!isRecord(value.resources) || !hasExactKeys(value.resources, TRACE_RESOURCE_KEYS)) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has invalid browser resources`);
  }
  const resources: Record<string, number> = {};
  for (const field of Object.keys(RESOURCE_FIELD_MAP) as (keyof typeof RESOURCE_FIELD_MAP)[]) {
    resources[field] = parseNonNegativeFiniteNumber(
      value.resources[field],
      lineNumber,
      `resources.${field}`,
    );
  }
  parseNonNegativeFiniteNumber(value.resources.timestamp, lineNumber, "resources.timestamp");
  return {
    currentHash: value.hash_current as number | null,
    resources: resources as Readonly<Record<keyof typeof RESOURCE_FIELD_MAP, number>>,
    url,
  };
}

function parseTraceLine(line: string, lineNumber: number): ParsedTraceLine {
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
  const state = parseTraceState(input.state, lineNumber);
  const action = parseTraceAction(input.action, lineNumber);
  const snapshots = input.snapshots as unknown[];
  const namedSnapshots: Array<{ readonly name: string; readonly valueSha256: string }> = [];
  const namedSnapshotNames = new Set<string>();
  for (const snapshotValue of snapshots) {
    if (
      !isRecord(snapshotValue)
      || !hasExactKeys(snapshotValue, TRACE_SNAPSHOT_KEYS)
      || !Number.isSafeInteger(snapshotValue.index)
      || !Number.isSafeInteger(snapshotValue.time)
      || (snapshotValue.index as number) < 0
      || (snapshotValue.time as number) < 0
      || (snapshotValue.name !== null && typeof snapshotValue.name !== "string")
    ) {
      throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid snapshot`);
    }
    if (snapshotValue.name !== null) {
      const name = validateSnapshotName(
        snapshotValue.name,
        `Bombadil trace line ${String(lineNumber)} snapshot name`,
      );
      if (namedSnapshotNames.has(name)) {
        throw new Error(`Bombadil trace line ${String(lineNumber)} repeats named snapshot ${name}`);
      }
      namedSnapshotNames.add(name);
      namedSnapshots.push({
        name,
        valueSha256: namedSnapshotValueSha256(snapshotValue.value),
      });
    }
  }
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
  const propertyViolationNames: string[] = [];
  for (const violation of input.violations) {
    if (!isRecord(violation) || !hasExactKeys(violation, TRACE_VIOLATION_KEYS)) {
      throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid property violation`);
    }
    propertyViolationNames.push(validateSnapshotName(
      violation.name,
      `Bombadil trace line ${String(lineNumber)} property violation name`,
    ));
    if (!isRecord(violation.violation) || Object.keys(violation.violation).length !== 1) {
      throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid property violation`);
    }
  }
  return {
    action,
    directObservation: parseTraceDirectObservation(snapshot.value),
    namedSnapshots,
    propertyViolationNames,
    state,
  };
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
      const observation = parseTraceLine(line, observationCount).directObservation;
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

function sortedCountRecord<K extends string>(
  values: ReadonlyMap<K, number>,
): Readonly<Partial<Record<K, number>>> {
  return Object.freeze(Object.fromEntries(
    [...values.entries()].sort(([left], [right]) => compareCodeUnits(left, right)),
  ) as Partial<Record<K, number>>);
}

/**
 * Derives bounded diagnostic exploration metadata from the raw Bombadil trace.
 * The hashes and counts are navigation aids, not Direct coverage evidence.
 */
export async function summarizeDirectBombadilTrace(options: {
  readonly explorationPolicy?: DirectBombadilExplorationPolicy;
  readonly targetUrl: string;
  readonly tracePath: string;
}): Promise<DirectBombadilExplorationSummary> {
  const metadata = await stat(options.tracePath).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.size === 0) {
    throw new Error("Bombadil did not produce a nonempty trace.jsonl");
  }
  if (metadata.size > TRACE_MAX_BYTES) {
    throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_BYTES)} bytes`);
  }
  let targetUrl: URL;
  try {
    targetUrl = new URL(options.targetUrl);
  } catch {
    throw new Error("targetUrl must be an absolute URL");
  }
  const policy = validateExplorationPolicy(options.explorationPolicy);
  const actionCounts = new Map<DirectBombadilActionKind, number>();
  const targetTags = new Map<string, number>();
  const urlFingerprints = new Set<string>();
  const rawUrlFingerprints = new Set<string>();
  const transitionHashes = new Set<string>();
  const rawTransitionHashes = new Set<string>();
  const snapshots = new Map<string, {
    readonly changeAfterActionKind: Map<DirectBombadilActionKind, number>;
    changeAfterNonWaitCount: number;
    lastObservationIndex: number | null;
    lastValueSha256: string | null;
    observationCount: number;
    readonly values: Set<string>;
  }>();
  const propertyViolations = new Map<string, number>();
  const resources = {
    documents: 0,
    domNodes: 0,
    jsEventListeners: 0,
    jsHeapTotalBytes: 0,
    jsHeapUsedBytes: 0,
    layoutObjects: 0,
    scriptDurationSeconds: 0,
    taskDurationSeconds: 0,
    threadTimeSeconds: 0,
  };
  let lineCount = 0;
  let totalActions = 0;
  let nonWaitCount = 0;
  let waitStreak = 0;
  let maxWaitStreak = 0;
  let nonNullHashCount = 0;
  let rawNonNullHashCount = 0;
  let policyObservationCount = 0;
  let previousObservationWasExact = false;
  let stableTarget = true;
  const stream = createReadStream(options.tracePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      lineCount += 1;
      if (lineCount > TRACE_MAX_LINES) {
        throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_LINES)} lines`);
      }
      if (Buffer.byteLength(line, "utf8") > TRACE_MAX_LINE_BYTES) {
        throw new Error(`Bombadil trace line ${String(lineCount)} is too large`);
      }
      const parsed = parseTraceLine(line, lineCount);
      const rawRelativeUrl =
        `${parsed.state.url.pathname}${parsed.state.url.search}${parsed.state.url.hash}`;
      rawUrlFingerprints.add(sha256(rawRelativeUrl));
      if (rawUrlFingerprints.size > TRACE_MAX_DISTINCT_URLS) {
        throw new Error(
          `Bombadil trace exceeds ${String(TRACE_MAX_DISTINCT_URLS)} distinct raw URL fingerprints`,
        );
      }
      if (parsed.state.currentHash !== null) {
        rawNonNullHashCount += 1;
        rawTransitionHashes.add(String(parsed.state.currentHash));
      }
      for (const name of parsed.propertyViolationNames) {
        if (!propertyViolations.has(name) && propertyViolations.size >= TRACE_MAX_PROPERTY_NAMES) {
          throw new Error(
            `Bombadil trace exceeds ${String(TRACE_MAX_PROPERTY_NAMES)} property names`,
          );
        }
        propertyViolations.set(name, (propertyViolations.get(name) ?? 0) + 1);
      }
      for (const [sourceName, outputName] of Object.entries(RESOURCE_FIELD_MAP)) {
        resources[outputName] = Math.max(
          resources[outputName],
          parsed.state.resources[sourceName as keyof typeof RESOURCE_FIELD_MAP],
        );
      }
      const currentObservationIsExact =
        exactTraceDirectObservation(parsed.directObservation) !== null;
      if (!currentObservationIsExact) {
        previousObservationWasExact = false;
        continue;
      }
      policyObservationCount += 1;
      const actionFollowsExactObservation = previousObservationWasExact;
      const recordedActionKind = actionFollowsExactObservation
        ? parsed.action?.kind ?? null
        : null;

      if (actionFollowsExactObservation && parsed.action !== null) {
        totalActions += 1;
        actionCounts.set(parsed.action.kind, (actionCounts.get(parsed.action.kind) ?? 0) + 1);
        if (parsed.action.kind === "Wait") {
          waitStreak += 1;
          maxWaitStreak = Math.max(maxWaitStreak, waitStreak);
        } else {
          nonWaitCount += 1;
          waitStreak = 0;
        }
        if (parsed.action.targetTag !== null) {
          if (!targetTags.has(parsed.action.targetTag) && targetTags.size >= 128) {
            throw new Error("Bombadil trace exceeds 128 distinct action target tags");
          }
          targetTags.set(
            parsed.action.targetTag,
            (targetTags.get(parsed.action.targetTag) ?? 0) + 1,
          );
        }
      } else if (actionFollowsExactObservation) {
        waitStreak = 0;
      }

      const relativeUrl = `${parsed.state.url.pathname}${parsed.state.url.search}${parsed.state.url.hash}`;
      urlFingerprints.add(sha256(relativeUrl));
      if (urlFingerprints.size > TRACE_MAX_DISTINCT_URLS) {
        throw new Error(
          `Bombadil trace exceeds ${String(TRACE_MAX_DISTINCT_URLS)} distinct URL fingerprints`,
        );
      }
      stableTarget &&= parsed.state.url.href === targetUrl.href;
      if (parsed.state.currentHash !== null) {
        nonNullHashCount += 1;
        transitionHashes.add(String(parsed.state.currentHash));
      }

      for (const snapshot of parsed.namedSnapshots) {
        let entry = snapshots.get(snapshot.name);
        if (entry === undefined) {
          if (snapshots.size >= TRACE_MAX_NAMED_SNAPSHOT_NAMES) {
            throw new Error(
              `Bombadil trace exceeds ${String(TRACE_MAX_NAMED_SNAPSHOT_NAMES)} named snapshots`,
            );
          }
          entry = {
            changeAfterActionKind: new Map<DirectBombadilActionKind, number>(),
            changeAfterNonWaitCount: 0,
            lastObservationIndex: null,
            lastValueSha256: null,
            observationCount: 0,
            values: new Set<string>(),
          };
          snapshots.set(snapshot.name, entry);
        }
        const changedAfterRecordedAction =
          recordedActionKind !== null
          && entry.lastObservationIndex === policyObservationCount - 1
          && entry.lastValueSha256 !== null
          && entry.lastValueSha256 !== snapshot.valueSha256;
        if (changedAfterRecordedAction) {
          entry.changeAfterActionKind.set(
            recordedActionKind,
            (entry.changeAfterActionKind.get(recordedActionKind) ?? 0) + 1,
          );
        }
        if (changedAfterRecordedAction && recordedActionKind !== "Wait") {
          entry.changeAfterNonWaitCount += 1;
        }
        entry.lastObservationIndex = policyObservationCount;
        entry.lastValueSha256 = snapshot.valueSha256;
        entry.observationCount += 1;
        entry.values.add(snapshot.valueSha256);
        if (entry.values.size > TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME) {
          throw new Error(
            `Bombadil trace named snapshot ${snapshot.name} exceeds ${String(TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME)} distinct values`,
          );
        }
      }
      previousObservationWasExact = true;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (lineCount === 0) throw new Error("Bombadil did not produce a nonempty trace.jsonl");

  const policyFailures: string[] = [];
  if (policy !== null) {
    if (nonWaitCount < policy.minNonWaitActions) {
      policyFailures.push("minimum non-Wait action count was not reached");
    }
    for (const kind of policy.requiredActionKinds) {
      if ((actionCounts.get(kind) ?? 0) === 0) {
        policyFailures.push(`required action kind ${kind} was not observed`);
      }
    }
    for (const name of policy.requiredNamedSnapshots) {
      if (!snapshots.has(name)) {
        policyFailures.push(`required named snapshot ${name} was not observed`);
      }
    }
    for (const [name, minimum] of Object.entries(policy.minDistinctNamedSnapshotValues)) {
      if ((snapshots.get(name)?.values.size ?? 0) < minimum) {
        policyFailures.push(`named snapshot ${name} did not reach its distinct-value minimum`);
      }
    }
    for (const [name, minimum] of Object.entries(
      policy.minNamedSnapshotChangesAfterNonWait,
    )) {
      if ((snapshots.get(name)?.changeAfterNonWaitCount ?? 0) < minimum) {
        policyFailures.push(
          `named snapshot ${name} did not reach its post-non-Wait change minimum`,
        );
      }
    }
    for (const [name, minimumByKind] of Object.entries(
      policy.minNamedSnapshotChangesAfterActionKind,
    )) {
      for (const [kind, minimum] of Object.entries(minimumByKind) as [
        DirectBombadilActionKind,
        number,
      ][]) {
        if ((snapshots.get(name)?.changeAfterActionKind.get(kind) ?? 0) < minimum) {
          policyFailures.push(
            `named snapshot ${name} did not reach its post-${kind} change minimum`,
          );
        }
      }
    }
    if (policy.requireStableTargetUrl && !stableTarget) {
      policyFailures.push("the browser did not remain on the exact target URL");
    }
  }
  const traceBytes = await readFile(options.tracePath);
  return Object.freeze({
    schema: "direct.bombadil-exploration-summary/v2",
    trace: Object.freeze({
      bytes: metadata.size,
      lineCount,
      sha256: sha256(traceBytes),
    }),
    actions: Object.freeze({
      byKind: sortedCountRecord(actionCounts),
      maxWaitStreak,
      nonWaitCount,
      targetTags: sortedCountRecord(targetTags) as Readonly<Record<string, number>>,
      total: totalActions,
    }),
    urls: Object.freeze({
      distinctFingerprintCount: urlFingerprints.size,
      fingerprintSha256: Object.freeze([...urlFingerprints].sort(compareCodeUnits)),
      observationCount: policyObservationCount,
      rawDistinctFingerprintCount: rawUrlFingerprints.size,
      rawFingerprintSha256: Object.freeze(
        [...rawUrlFingerprints].sort(compareCodeUnits),
      ),
      rawObservationCount: lineCount,
      stableTarget,
    }),
    transitions: Object.freeze({
      distinctNonNullHashCount: transitionHashes.size,
      nonNullHashCount,
      rawDistinctNonNullHashCount: rawTransitionHashes.size,
      rawNonNullHashCount,
    }),
    namedSnapshots: Object.freeze([...snapshots.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([name, entry]) => Object.freeze({
        changeAfterActionKind: sortedCountRecord(entry.changeAfterActionKind),
        changeAfterNonWaitCount: entry.changeAfterNonWaitCount,
        distinctValueCount: entry.values.size,
        distinctValueSha256: Object.freeze([...entry.values].sort(compareCodeUnits)),
        name,
        observationCount: entry.observationCount,
      }))),
    propertyViolations: Object.freeze({
      byName: sortedCountRecord(propertyViolations) as Readonly<Record<string, number>>,
      total: [...propertyViolations.values()].reduce((total, value) => total + value, 0),
    }),
    resourceHighWaterMarks: Object.freeze(resources),
    policy: Object.freeze({
      configured: policy !== null,
      failures: Object.freeze(policyFailures),
      satisfied: policyFailures.length === 0,
    }),
  });
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
    compareCodeUnits(left, right)
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

function validateSnapshotName(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 128
    || !SNAPSHOT_NAME_PATTERN.test(value)
    || PROTOTYPE_PROPERTY_NAMES.has(value)
    || hasControlCharacters(value)
  ) {
    throw new Error(`${label} must be a safe bounded snapshot name`);
  }
  return value;
}

function validateViewport(value: unknown): ValidatedViewport {
  if (value === undefined) {
    return Object.freeze({
      deviceScaleFactor: DEFAULT_DEVICE_SCALE_FACTOR,
      height: DEFAULT_VIEWPORT_HEIGHT,
      width: DEFAULT_VIEWPORT_WIDTH,
    });
  }
  if (!isRecord(value) || !Object.keys(value).every((key) => VIEWPORT_KEYS.has(key))) {
    throw new Error("viewport must contain only width, height, and deviceScaleFactor");
  }
  const validateDimension = (name: "height" | "width", input: unknown): number => {
    if (
      typeof input !== "number"
      || !Number.isSafeInteger(input)
      || input < 1
      || input > 65_535
    ) {
      throw new Error(`viewport.${name} must be an integer between 1 and 65535`);
    }
    return input;
  };
  const width = validateDimension("width", value.width ?? DEFAULT_VIEWPORT_WIDTH);
  const height = validateDimension("height", value.height ?? DEFAULT_VIEWPORT_HEIGHT);
  const deviceScaleFactor = value.deviceScaleFactor ?? DEFAULT_DEVICE_SCALE_FACTOR;
  if (
    typeof deviceScaleFactor !== "number"
    || !Number.isFinite(deviceScaleFactor)
    || deviceScaleFactor < 0.1
    || deviceScaleFactor > 10
  ) {
    throw new Error("viewport.deviceScaleFactor must be a finite number between 0.1 and 10");
  }
  return Object.freeze({ deviceScaleFactor, height, width });
}

function validateSnapshotMinimumMap(options: {
  readonly label: string;
  readonly maximum: number;
  readonly value: unknown;
}): Readonly<Record<string, number>> {
  if (!isRecord(options.value) || Object.keys(options.value).length > 32) {
    throw new Error(`${options.label} must be a bounded object`);
  }
  const validated: Record<string, number> = {};
  for (const [rawName, minimum] of Object.entries(options.value).sort(([left], [right]) =>
    compareCodeUnits(left, right)
  )) {
    const name = validateSnapshotName(rawName, `${options.label} key`);
    if (
      typeof minimum !== "number"
      || !Number.isSafeInteger(minimum)
      || minimum < 1
      || minimum > options.maximum
    ) {
      throw new Error(
        `${options.label} ${name} must be an integer between 1 and ${String(options.maximum)}`,
      );
    }
    validated[name] = minimum;
  }
  return Object.freeze(validated);
}

function validateSnapshotActionMinimumMap(options: {
  readonly label: string;
  readonly value: unknown;
}): Readonly<Record<
  string,
  Readonly<Partial<Record<DirectBombadilActionKind, number>>>
>> {
  if (!isRecord(options.value) || Object.keys(options.value).length > 32) {
    throw new Error(`${options.label} must be a bounded object`);
  }
  const validated: Record<
    string,
    Readonly<Partial<Record<DirectBombadilActionKind, number>>>
  > = {};
  for (const [rawName, rawMinimumByKind] of Object.entries(options.value)
    .sort(([left], [right]) => compareCodeUnits(left, right))) {
    const name = validateSnapshotName(rawName, `${options.label} key`);
    if (
      !isRecord(rawMinimumByKind)
      || Object.keys(rawMinimumByKind).length === 0
      || Object.keys(rawMinimumByKind).length > ACTION_KINDS.length
    ) {
      throw new Error(`${options.label} ${name} must be a bounded action map`);
    }
    const minimumByKind: Partial<Record<DirectBombadilActionKind, number>> = {};
    for (const [rawKind, minimum] of Object.entries(rawMinimumByKind)
      .sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (!ACTION_KIND_SET.has(rawKind)) {
        throw new Error(`${options.label} ${name} contains an unknown action kind`);
      }
      if (
        typeof minimum !== "number"
        || !Number.isSafeInteger(minimum)
        || minimum < 1
        || minimum > TRACE_MAX_LINES
      ) {
        throw new Error(
          `${options.label} ${name}.${rawKind} must be an integer between 1 and ${String(TRACE_MAX_LINES)}`,
        );
      }
      minimumByKind[rawKind as DirectBombadilActionKind] = minimum;
    }
    validated[name] = Object.freeze(minimumByKind);
  }
  return Object.freeze(validated);
}

function validateExplorationPolicy(
  value: unknown,
): ValidatedExplorationPolicy | null {
  if (value === undefined) return null;
  if (
    !isRecord(value)
    || !Object.keys(value).every((key) => EXPLORATION_POLICY_KEYS.has(key))
  ) {
    throw new Error("explorationPolicy contains an unknown field");
  }
  const minNonWaitActions = value.minNonWaitActions ?? 0;
  if (
    typeof minNonWaitActions !== "number"
    || !Number.isSafeInteger(minNonWaitActions)
    || minNonWaitActions < 0
    || minNonWaitActions > TRACE_MAX_LINES
  ) {
    throw new Error(
      `explorationPolicy.minNonWaitActions must be an integer between 0 and ${String(TRACE_MAX_LINES)}`,
    );
  }
  const requiredActionKindsInput = value.requiredActionKinds ?? [];
  if (!Array.isArray(requiredActionKindsInput) || requiredActionKindsInput.length > ACTION_KINDS.length) {
    throw new Error("explorationPolicy.requiredActionKinds must be a bounded array");
  }
  const requiredActionKinds = [...requiredActionKindsInput];
  if (
    !requiredActionKinds.every((kind): kind is DirectBombadilActionKind =>
      typeof kind === "string" && ACTION_KIND_SET.has(kind)
    )
    || new Set(requiredActionKinds).size !== requiredActionKinds.length
  ) {
    throw new Error("explorationPolicy.requiredActionKinds contains an unknown or duplicate kind");
  }
  requiredActionKinds.sort(compareCodeUnits);

  const requiredNamedSnapshotsInput = value.requiredNamedSnapshots ?? [];
  if (!Array.isArray(requiredNamedSnapshotsInput) || requiredNamedSnapshotsInput.length > 32) {
    throw new Error("explorationPolicy.requiredNamedSnapshots must be a bounded array");
  }
  const requiredNamedSnapshots = requiredNamedSnapshotsInput.map((name) =>
    validateSnapshotName(name, "explorationPolicy.requiredNamedSnapshots entry")
  );
  if (new Set(requiredNamedSnapshots).size !== requiredNamedSnapshots.length) {
    throw new Error("explorationPolicy.requiredNamedSnapshots contains a duplicate name");
  }
  requiredNamedSnapshots.sort(compareCodeUnits);

  const minDistinctNamedSnapshotValues = validateSnapshotMinimumMap({
    label: "explorationPolicy.minDistinctNamedSnapshotValues",
    maximum: TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME,
    value: value.minDistinctNamedSnapshotValues ?? {},
  });
  const minNamedSnapshotChangesAfterActionKind =
    validateSnapshotActionMinimumMap({
      label: "explorationPolicy.minNamedSnapshotChangesAfterActionKind",
      value: value.minNamedSnapshotChangesAfterActionKind ?? {},
    });
  const minNamedSnapshotChangesAfterNonWait = validateSnapshotMinimumMap({
    label: "explorationPolicy.minNamedSnapshotChangesAfterNonWait",
    maximum: TRACE_MAX_LINES,
    value: value.minNamedSnapshotChangesAfterNonWait ?? {},
  });
  const requireStableTargetUrl = value.requireStableTargetUrl ?? false;
  if (typeof requireStableTargetUrl !== "boolean") {
    throw new Error("explorationPolicy.requireStableTargetUrl must be a boolean");
  }
  return Object.freeze({
    minDistinctNamedSnapshotValues,
    minNamedSnapshotChangesAfterActionKind,
    minNamedSnapshotChangesAfterNonWait,
    minNonWaitActions,
    requireStableTargetUrl,
    requiredActionKinds: Object.freeze(requiredActionKinds),
    requiredNamedSnapshots: Object.freeze(requiredNamedSnapshots),
  });
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
  const viewport = validateViewport(config.viewport);
  const explorationPolicy = validateExplorationPolicy(config.explorationPolicy);
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
    explorationPolicy,
    port,
    targetQuery,
    viewport,
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
  readonly viewport?: DirectBombadilViewportConfig;
}): DirectBombadilInvocation {
  const viewport = validateViewport(options.viewport);
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
    "--width",
    String(viewport.width),
    "--height",
    String(viewport.height),
    "--device-scale-factor",
    String(viewport.deviceScaleFactor),
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

function parseMatrixCampaignArgument(arguments_: readonly string[]): {
  readonly arguments: readonly string[];
  readonly campaignId: string | null;
  readonly help: boolean;
} {
  const forwarded: string[] = [];
  let campaignId: string | null = null;
  let help = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") help = true;
    if (argument === "--campaign" || argument.startsWith("--campaign=")) {
      if (campaignId !== null) throw new Error("--campaign may be provided only once");
      if (argument === "--campaign") {
        const next = readOptionValue(arguments_, index, "--campaign");
        campaignId = next.value;
        index = next.index;
      } else {
        campaignId = argument.slice("--campaign=".length);
      }
      if (campaignId.length === 0) throw new Error("--campaign requires a value");
      continue;
    }
    forwarded.push(argument);
  }
  return { arguments: Object.freeze(forwarded), campaignId, help };
}

function validateCampaignMatrix(
  campaigns: readonly DirectBombadilFuzzCampaign[],
): readonly DirectBombadilFuzzCampaign[] {
  if (campaigns.length === 0 || campaigns.length > 32) {
    throw new Error("Bombadil campaign matrix must contain 1-32 campaigns");
  }
  const ids = new Set<string>();
  for (const campaign of campaigns) {
    if (!ARTIFACT_NAME_PATTERN.test(campaign.id) || ids.has(campaign.id)) {
      throw new Error("Bombadil campaign IDs must be unique lowercase kebab identifiers");
    }
    ids.add(campaign.id);
  }
  return campaigns;
}

/** Runs a bounded product-owned campaign matrix serially. */
export async function runDirectBombadilFuzzMatrix(
  campaignsInput: readonly DirectBombadilFuzzCampaign[],
  arguments_: readonly string[] = process.argv.slice(2),
  dependencyOverrides: Partial<DirectBombadilRunnerDependencies> = {},
): Promise<DirectBombadilFuzzMatrixResult> {
  const campaigns = validateCampaignMatrix(campaignsInput);
  const parsed = parseMatrixCampaignArgument(arguments_);
  if (parsed.help) {
    process.stdout.write(`${[
      helpText(campaigns[0]?.config.baseUrl ?? ""),
      "  --campaign <id>   Run one campaign; required with --replay",
      "",
      `Campaigns: ${campaigns.map((campaign) => campaign.id).join(", ")}`,
    ].join("\n")}\n`);
    return { kind: "help" };
  }
  const selected = parsed.campaignId === null
    ? campaigns
    : campaigns.filter((campaign) => campaign.id === parsed.campaignId);
  if (selected.length === 0) {
    throw new Error(`Unknown Bombadil campaign ${parsed.campaignId ?? ""}`);
  }
  if (
    parsed.campaignId === null
    && parsed.arguments.some((argument) =>
      argument === "--replay" || argument.startsWith("--replay=")
    )
  ) {
    throw new Error("--replay requires exactly one --campaign in matrix mode");
  }
  const results: Array<{
    readonly campaignId: string;
    readonly result: Extract<DirectBombadilFuzzResult, { readonly kind: "run" }>;
  }> = [];
  for (const campaign of selected) {
    const result = await runDirectBombadilFuzz(
      campaign.config,
      parsed.arguments,
      dependencyOverrides,
    );
    if (result.kind !== "run") {
      throw new Error("Bombadil campaign unexpectedly returned help during matrix execution");
    }
    results.push({ campaignId: campaign.id, result });
  }
  return { kind: "matrix", results: Object.freeze(results) };
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
    viewport: validated.viewport,
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
  let explorationSummary: DirectBombadilExplorationSummary | null = null;
  let explorationSummaryFailure: unknown = null;
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
      try {
        explorationSummary = await summarizeDirectBombadilTrace({
          ...(validated.explorationPolicy === null
            ? {}
            : { explorationPolicy: validated.explorationPolicy }),
          targetUrl: invocation.targetUrl,
          tracePath,
        });
      } catch (error) {
        explorationSummaryFailure = error;
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
      if (explorationSummaryFailure !== null) {
        throw explorationSummaryFailure instanceof Error
          ? explorationSummaryFailure
          : new Error(renderUnknown(explorationSummaryFailure));
      }
      if (explorationSummary?.policy.satisfied !== true) {
        throw new Error(
          `Bombadil exploration policy was not satisfied: ${explorationSummary?.policy.failures.join("; ") ?? "summary unavailable"}`,
        );
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
  const explorationSummaryPath = join(
    artifactRun.runDirectory,
    "exploration-summary.json",
  );
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
    viewport: validated.viewport,
    explorationPolicy: validated.explorationPolicy,
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
    explorationSummary,
    explorationSummaryPath: explorationSummary === null ? null : explorationSummaryPath,
    explorationSummaryFailure: explorationSummaryFailure === null
      ? null
      : renderUnknown(explorationSummaryFailure),
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
    if (explorationSummary !== null) {
      await writeJsonAtomically(explorationSummaryPath, explorationSummary);
    }
    await writeJsonAtomically(join(artifactRun.runDirectory, "run.json"), record);
    await writeJsonAtomically(artifactRun.manifestPath, record);

    const exploration = explorationSummary === null
      ? "exploration=unavailable"
      : [
          `nonWait=${String(explorationSummary.actions.nonWaitCount)}`,
          `maxWaitStreak=${String(explorationSummary.actions.maxWaitStreak)}`,
          `namedChanges=${explorationSummary.namedSnapshots
            .map((snapshot) => `${snapshot.name}:${String(snapshot.changeAfterNonWaitCount)}`)
            .join(",") || "none"}`,
          `policy=${explorationSummary.policy.satisfied ? "satisfied" : "failed"}`,
        ].join("; ");
    const summary = [
      `${status === "passed" ? "PASS" : "FAIL"} ${validated.label}`,
      exploration,
      `artifacts: ${artifactRun.runDirectory}`,
      `log: ${logPath}`,
    ].join("; ");
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
