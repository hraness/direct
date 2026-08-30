import { EventEmitter } from "node:events";
import { constants as fileSystemConstants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";

import {
  parseDirectProbeSnapshot,
  parseDirectSessionManifest,
} from "@hraness/direct/testing";
import {
  FIXTURE_QUERY_KEY,
  SCENARIO_QUERY_KEY,
} from "@hraness/direct";
import { parseJsonValue } from "../core/json.js";
import { err, ok, type Result } from "../core/result.js";

import {
  acquireVerificationServer,
  canAutomaticallyStartLocalServer,
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
const ARTIFACT_RECEIPT_SCHEMA = "direct.bombadil-artifact-receipt/v1";
const ARTIFACT_SUMMARY_SCHEMA = "direct.bombadil-upload-summary/v1";
const MATRIX_RECEIPT_SCHEMA = "direct.bombadil-matrix-receipt/v1";
const MATRIX_SUMMARY_SCHEMA = "direct.bombadil-matrix-summary/v1";
const ARTIFACT_FAILURE_CODES = new Set<DirectBombadilArtifactFailureCode>([
  "artifact-policy",
  "configuration-rejected",
  "exploration-policy",
  "interrupted",
  "persistence",
  "process",
  "server",
  "trace-attestation",
  "writer-settlement",
  "unknown",
]);
const ARTIFACT_RECEIPT_KEYS = new Set([
  "completedAt",
  "diagnosticsRetained",
  "failureCode",
  "inventory",
  "mode",
  "policy",
  "runId",
  "schema",
  "status",
]);
const ARTIFACT_RECEIPT_INVENTORY_KEYS = new Set([
  "entryCount",
  "fileCount",
  "inventorySha256",
  "totalBytes",
]);
const ARTIFACT_POLICY_RECEIPT_KEYS = new Set([
  "maxDepth",
  "maxEntries",
  "maxFileBytes",
  "maxFiles",
  "maxPathBytes",
  "maxTotalBytes",
]);
const RUN_SUMMARY_KEYS = new Set([
  "artifactName",
  "attestation",
  "exploration",
  "failureCode",
  "scenario",
  "schema",
  "status",
]);
const RUN_SUMMARY_ATTESTATION_KEYS = new Set([
  "invalidObservationCount",
  "observationCount",
  "validObservationCount",
]);
const RUN_SUMMARY_EXPLORATION_KEYS = new Set([
  "actionCount",
  "nonWaitActionCount",
  "policySatisfied",
  "traceBytes",
  "traceLineCount",
  "traceSha256",
]);
const MATRIX_RECEIPT_KEYS = new Set([
  "campaigns",
  "completedAt",
  "failureCode",
  "mode",
  "omittedCampaignCount",
  "runId",
  "schema",
  "status",
]);
const MATRIX_CAMPAIGN_RECEIPT_KEYS = new Set([
  "campaignId",
  "index",
  "receipt",
  "status",
]);
const MATRIX_SUMMARY_KEYS = new Set([
  "campaigns",
  "failureCode",
  "schema",
  "status",
]);
const MATRIX_SUMMARY_CAMPAIGNS_KEYS = new Set([
  "failed",
  "notRun",
  "notSelected",
  "omitted",
  "passed",
  "rejected",
  "total",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const ARTIFACT_EVIDENCE_JSON_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 2_048,
  maxStringBytes: 64 * 1024,
});
const SCENARIO_PATTERN = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
const ARTIFACT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_ARTIFACT_IDENTIFIER_LENGTH = 80;
const MAX_MATRIX_CAMPAIGNS = 32;
const ARTIFACT_COORDINATION_ENVIRONMENT = "DIRECT_BOMBADIL_RUN_ID";
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
const ARTIFACT_MONITOR_INTERVAL_MS = 100;
const MAX_LIVE_CHROME_RENAME_RETRIES = 4;
const DEFAULT_ARTIFACT_MAX_ENTRIES = 4_096;
const DEFAULT_ARTIFACT_MAX_FILES = 2_048;
const DEFAULT_ARTIFACT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DEFAULT_ARTIFACT_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_ARTIFACT_MAX_DEPTH = 32;
const DEFAULT_ARTIFACT_MAX_PATH_BYTES = 4_096;
const MAX_ARTIFACT_ENTRIES = 16_384;
const MAX_ARTIFACT_FILES = 8_192;
const MAX_ARTIFACT_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ARTIFACT_DEPTH = 64;
const MAX_ARTIFACT_PATH_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ARTIFACT_PATH_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const PRIVATE_DIAGNOSTIC_EXTENSIONS = new Set([
  ".jpeg",
  ".jpg",
  ".json",
  ".jsonl",
  ".log",
  ".png",
  ".txt",
  ".webp",
]);
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

export interface DirectBombadilArtifactPolicy {
  readonly maxDepth?: number;
  readonly maxEntries?: number;
  readonly maxFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxPathBytes?: number;
  readonly maxTotalBytes?: number;
}

export type DirectBombadilUploadMode = "private-vetted" | "public-summary";

export interface DirectBombadilArtifactRunPlan {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly uploadMode?: DirectBombadilUploadMode;
}

export interface DirectBombadilFuzzRunOptions {
  readonly arguments?: readonly string[];
  readonly artifactRun?: DirectBombadilArtifactRunPlan;
}

export type DirectBombadilFuzzRunInput =
  | readonly string[]
  | DirectBombadilFuzzRunOptions;

export interface DirectBombadilMatrixRunOptions {
  readonly arguments?: readonly string[];
  readonly artifactRun?: Omit<DirectBombadilArtifactRunPlan, "uploadMode"> & {
    readonly uploadMode?: "public-summary";
  };
}

export type DirectBombadilMatrixRunInput =
  | readonly string[]
  | DirectBombadilMatrixRunOptions;

export type DirectBombadilArtifactFailureCode =
  | "artifact-policy"
  | "configuration-rejected"
  | "exploration-policy"
  | "interrupted"
  | "persistence"
  | "process"
  | "server"
  | "trace-attestation"
  | "writer-settlement"
  | "unknown";

export interface DirectBombadilArtifactReceipt {
  readonly schema: typeof ARTIFACT_RECEIPT_SCHEMA;
  readonly completedAt: string;
  readonly diagnosticsRetained: boolean;
  readonly failureCode: DirectBombadilArtifactFailureCode | null;
  readonly inventory: {
    readonly entryCount: number;
    readonly fileCount: number;
    readonly inventorySha256: string | null;
    readonly totalBytes: number;
  };
  readonly mode: DirectBombadilUploadMode;
  readonly policy: Required<DirectBombadilArtifactPolicy>;
  readonly runId: string;
  readonly status: "failed" | "passed" | "rejected";
}

export interface DirectBombadilArtifactParseError {
  readonly code: "invalid-bombadil-artifact-evidence";
  readonly message: string;
}

export interface DirectBombadilSanitizedRunSummary {
  readonly schema: typeof ARTIFACT_SUMMARY_SCHEMA;
  readonly artifactName: string;
  readonly attestation: null | {
    readonly invalidObservationCount: number;
    readonly observationCount: number;
    readonly validObservationCount: number;
  };
  readonly exploration: null | {
    readonly actionCount: number;
    readonly nonWaitActionCount: number;
    readonly policySatisfied: boolean;
    readonly traceBytes: number;
    readonly traceLineCount: number;
    readonly traceSha256: string;
  };
  readonly failureCode: DirectBombadilArtifactFailureCode | null;
  readonly scenario: string;
  readonly status: "failed" | "passed" | "rejected";
}

export type DirectBombadilMatrixCampaignStatus =
  | "failed"
  | "not-run"
  | "not-selected"
  | "passed"
  | "rejected";

export interface DirectBombadilMatrixCampaignReceiptEntry {
  readonly campaignId: string | null;
  readonly index: number;
  readonly receipt: string | null;
  readonly status: DirectBombadilMatrixCampaignStatus;
}

export interface DirectBombadilMatrixReceipt {
  readonly schema: typeof MATRIX_RECEIPT_SCHEMA;
  readonly campaigns: readonly DirectBombadilMatrixCampaignReceiptEntry[];
  readonly completedAt: string;
  readonly failureCode: DirectBombadilArtifactFailureCode | null;
  readonly mode: "public-summary";
  readonly omittedCampaignCount: number;
  readonly runId: string;
  readonly status: "failed" | "passed";
}

export interface DirectBombadilMatrixSummary {
  readonly schema: typeof MATRIX_SUMMARY_SCHEMA;
  readonly campaigns: {
    readonly failed: number;
    readonly notRun: number;
    readonly notSelected: number;
    readonly omitted: number;
    readonly passed: number;
    readonly rejected: number;
    readonly total: number;
  };
  readonly failureCode: DirectBombadilArtifactFailureCode | null;
  readonly status: "failed" | "passed";
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
  readonly artifactPolicy?: DirectBombadilArtifactPolicy;
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

type DirectBombadilFuzzExecutionResult =
  | Extract<DirectBombadilFuzzResult, { readonly kind: "help" }>
  | (Extract<DirectBombadilFuzzResult, { readonly kind: "run" }> & {
      readonly receiptPath: string;
      readonly uploadArtifactPath: string;
    });

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

type DirectBombadilFuzzMatrixExecutionResult =
  | Extract<DirectBombadilFuzzMatrixResult, { readonly kind: "help" }>
  | {
      readonly kind: "matrix";
      readonly receiptPath: string;
      readonly results: readonly {
        readonly campaignId: string;
        readonly result: Extract<DirectBombadilFuzzExecutionResult, { readonly kind: "run" }>;
      }[];
      readonly uploadArtifactPath: string;
    };

export interface DirectBombadilInvocation {
  readonly abortSignal?: AbortSignal;
  readonly artifactPolicy?: DirectBombadilArtifactPolicy;
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
  readonly beforeArtifactCommit?: () => Promise<void> | void;
  readonly createAbortController?: () => AbortController;
  readonly createRunId: () => string;
  readonly now: () => Date;
  readonly runBombadil: (
    invocation: DirectBombadilInvocation,
  ) => Promise<BombadilProcessResult>;
  readonly signalController: ProcessSignalController;
  readonly serverOutputTimeoutMs: number;
  readonly spawnServer: (options: {
    readonly command: readonly string[];
    readonly cwd: string;
    readonly detachedProcessGroup?: boolean;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly omitEnvironment?: readonly string[];
  }) => ManagedVerificationServer;
  readonly stopServer: typeof stopVerificationServer;
}

const PROCESS_INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"] as const;
type ProcessInterruptSignal = (typeof PROCESS_INTERRUPT_SIGNALS)[number];

interface ProcessSignalEmitter {
  readonly once: (
    signal: ProcessInterruptSignal,
    listener: (signal: ProcessInterruptSignal) => void,
  ) => unknown;
  readonly removeListener: (
    signal: ProcessInterruptSignal,
    listener: (signal: ProcessInterruptSignal) => void,
  ) => unknown;
}

interface ProcessSignalController extends ProcessSignalEmitter {
  readonly forward: (signal: ProcessInterruptSignal) => void;
}

type ValidatedConfig = Omit<
  DirectBombadilFuzzConfig,
  "artifactPolicy" | "explorationPolicy" | "server" | "viewport"
> & {
  readonly artifactPolicy: ValidatedArtifactPolicy;
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

type ValidatedArtifactPolicy = Required<DirectBombadilArtifactPolicy>;

interface ArtifactInventoryFile {
  readonly device: bigint;
  readonly inode: bigint;
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
}

interface ArtifactInventory {
  readonly directories: readonly string[];
  readonly entryCount: number;
  readonly files: readonly ArtifactInventoryFile[];
  readonly fileCount: number;
  readonly inventorySha256: string;
  readonly totalBytes: number;
}

interface LiveChromeDownloadIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly phase: "complete" | "partial";
}

interface LiveChromeDownloadScanContext {
  readonly currentAccountedFiles: Map<string, number>;
  readonly currentDirectories: Set<string>;
  readonly cleanBaselineEstablished: boolean;
  readonly currentPartials: Set<string>;
  readonly currentUnobservedCompletions: Set<string>;
  readonly next: Map<string, LiveChromeDownloadIdentity>;
  readonly previous: ReadonlyMap<string, LiveChromeDownloadIdentity>;
  readonly previousHasPartial: boolean;
}

interface ArtifactUploadSessionBase {
  readonly finalDirectory: string;
  readonly mode: DirectBombadilUploadMode;
  readonly receiptPath: string;
  readonly runId: string;
}

interface AtomicArtifactUploadSession extends ArtifactUploadSessionBase {
  readonly publication: "atomic-leaf";
  readonly stagingDirectory: string;
}

interface DeferredArtifactUploadSession extends ArtifactUploadSessionBase {
  readonly deferredPayload: { value: SanitizedRunUploadPayload | null };
  readonly publication: "deferred";
}

type ArtifactUploadSession = AtomicArtifactUploadSession | DeferredArtifactUploadSession;

interface SanitizedRunUploadPayload {
  readonly receipt: DirectBombadilArtifactReceipt;
  readonly summary: DirectBombadilSanitizedRunSummary;
}

interface ExpectedUploadFile {
  readonly relativePath: string;
  readonly sha256: string;
  readonly size: number;
}

interface NormalizedFuzzRunOptions {
  readonly arguments: readonly string[];
  readonly artifactRun: DirectBombadilArtifactRunPlan | null;
}

class BombadilArtifactPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "BombadilArtifactPolicyError";
  }
}

class LiveChromeDownloadRenameRetry extends Error {
  public constructor(
    public readonly completion: Readonly<{
      device: bigint;
      inode: bigint;
      runId: string;
      size: number;
      unobserved: boolean;
    }>,
  ) {
    super("Chrome download renamed during live artifact inspection");
    this.name = "LiveChromeDownloadRenameRetry";
  }
}

class BombadilWriterSettlementError extends Error {
  public constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "BombadilWriterSettlementError";
  }
}

class BombadilPersistenceError extends AggregateError {
  public constructor(message: string, errors: readonly unknown[]) {
    super(errors, message, { cause: errors[0] });
    this.name = "BombadilPersistenceError";
  }
}

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

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
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

function boundedArtifactInteger(options: {
  readonly label: string;
  readonly maximum: number;
  readonly value: number | undefined;
  readonly defaultValue: number;
}): number {
  const value = options.value ?? options.defaultValue;
  if (!Number.isSafeInteger(value) || value < 1 || value > options.maximum) {
    throw new Error(`${options.label} must be an integer between 1 and ${String(options.maximum)}`);
  }
  return value;
}

function validateArtifactPolicy(
  input: DirectBombadilArtifactPolicy | undefined,
): ValidatedArtifactPolicy {
  const value = input ?? {};
  return Object.freeze({
    maxDepth: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_DEPTH,
      label: "artifactPolicy.maxDepth",
      maximum: MAX_ARTIFACT_DEPTH,
      value: value.maxDepth,
    }),
    maxEntries: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_ENTRIES,
      label: "artifactPolicy.maxEntries",
      maximum: MAX_ARTIFACT_ENTRIES,
      value: value.maxEntries,
    }),
    maxFileBytes: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      label: "artifactPolicy.maxFileBytes",
      maximum: MAX_ARTIFACT_FILE_BYTES,
      value: value.maxFileBytes,
    }),
    maxFiles: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_FILES,
      label: "artifactPolicy.maxFiles",
      maximum: MAX_ARTIFACT_FILES,
      value: value.maxFiles,
    }),
    maxPathBytes: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_PATH_BYTES,
      label: "artifactPolicy.maxPathBytes",
      maximum: MAX_ARTIFACT_PATH_BYTES,
      value: value.maxPathBytes,
    }),
    maxTotalBytes: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_TOTAL_BYTES,
      label: "artifactPolicy.maxTotalBytes",
      maximum: MAX_ARTIFACT_TOTAL_BYTES,
      value: value.maxTotalBytes,
    }),
  });
}

function normalizeFuzzRunOptions(
  input: DirectBombadilFuzzRunInput | DirectBombadilMatrixRunInput | undefined,
): NormalizedFuzzRunOptions {
  if (input === undefined || isReadonlyStringArray(input)) {
    return {
      arguments: Object.freeze([...(input ?? [])]),
      artifactRun: null,
    };
  }
  const options: DirectBombadilFuzzRunOptions | DirectBombadilMatrixRunOptions = input;
  const artifactRun = options.artifactRun;
  if (!isRecord(options)) throw new Error("Bombadil run options must be an object or argument array");
  const keys = Object.keys(options);
  if (keys.some((key) => key !== "arguments" && key !== "artifactRun")) {
    throw new Error("Bombadil run options contain an unknown field");
  }
  const arguments_ = options.arguments ?? [];
  if (!isReadonlyStringArray(arguments_)) {
    throw new Error("Bombadil run options arguments must be a string array");
  }
  return {
    arguments: Object.freeze([...arguments_]),
    artifactRun: artifactRun ?? null,
  };
}

function validateArtifactRunPlan(
  input: DirectBombadilArtifactRunPlan,
): DirectBombadilArtifactRunPlan & { readonly uploadMode: DirectBombadilUploadMode } {
  const repositoryRoot = resolve(input.repositoryRoot);
  if (!isAbsolute(input.repositoryRoot) || repositoryRoot !== input.repositoryRoot) {
    throw new Error("artifactRun.repositoryRoot must be an absolute normalized path");
  }
  if (!UUID_PATTERN.test(input.runId)) {
    throw new Error("artifactRun.runId must be a lowercase RFC 4122 UUID");
  }
  const uploadMode = input.uploadMode ?? "public-summary";
  if (uploadMode !== "public-summary" && uploadMode !== "private-vetted") {
    throw new Error("artifactRun.uploadMode must be public-summary or private-vetted");
  }
  return Object.freeze({ repositoryRoot, runId: input.runId, uploadMode });
}

function isBoundedArtifactIdentifier(value: string): boolean {
  return value.length <= MAX_ARTIFACT_IDENTIFIER_LENGTH
    && ARTIFACT_NAME_PATTERN.test(value);
}

function isBoundedScenarioIdentifier(value: string): boolean {
  return value.length <= 120 && SCENARIO_PATTERN.test(value);
}

function requireEvidenceRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw new Error(`${label} must contain exactly its documented fields`);
  }
  return value;
}

function requireEvidenceInteger(
  value: unknown,
  label: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a nonnegative safe integer no greater than ${String(maximum)}`);
  }
  return value as number;
}

function requireEvidencePositiveInteger(
  value: unknown,
  label: string,
  maximum: number,
): number {
  const parsed = requireEvidenceInteger(value, label, maximum);
  if (parsed === 0) throw new Error(`${label} must be greater than zero`);
  return parsed;
}

function requireEvidenceSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requireEvidenceTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function parseEvidenceFailureCode(
  value: unknown,
  label: string,
): DirectBombadilArtifactFailureCode | null {
  if (value === null) return null;
  if (typeof value !== "string" || !ARTIFACT_FAILURE_CODES.has(
    value as DirectBombadilArtifactFailureCode,
  )) {
    throw new Error(`${label} is not a known Bombadil failure code`);
  }
  return value as DirectBombadilArtifactFailureCode;
}

function requireEvidenceStatus(
  value: unknown,
  label: string,
): "failed" | "passed" | "rejected" {
  if (value !== "failed" && value !== "passed" && value !== "rejected") {
    throw new Error(`${label} must be failed, passed, or rejected`);
  }
  return value;
}

function requireFailureStatusConsistency(
  status: "failed" | "passed" | "rejected",
  failureCode: DirectBombadilArtifactFailureCode | null,
  label: string,
): void {
  if ((status === "passed") !== (failureCode === null)) {
    throw new Error(`${label} status and failureCode are inconsistent`);
  }
  if (status === "rejected" && failureCode !== "configuration-rejected") {
    throw new Error(`${label} rejected status requires configuration-rejected`);
  }
}

function parseArtifactReceiptUnchecked(input: unknown): DirectBombadilArtifactReceipt {
  const value = requireEvidenceRecord(input, ARTIFACT_RECEIPT_KEYS, "Bombadil receipt");
  if (value.schema !== ARTIFACT_RECEIPT_SCHEMA) {
    throw new Error("Bombadil receipt schema is unsupported");
  }
  const completedAt = requireEvidenceTimestamp(value.completedAt, "Bombadil receipt completedAt");
  if (typeof value.diagnosticsRetained !== "boolean") {
    throw new Error("Bombadil receipt diagnosticsRetained must be boolean");
  }
  const failureCode = parseEvidenceFailureCode(value.failureCode, "Bombadil receipt failureCode");
  const status = requireEvidenceStatus(value.status, "Bombadil receipt status");
  requireFailureStatusConsistency(status, failureCode, "Bombadil receipt");
  if (value.mode !== "private-vetted" && value.mode !== "public-summary") {
    throw new Error("Bombadil receipt mode is unsupported");
  }
  if (value.diagnosticsRetained && value.mode !== "private-vetted") {
    throw new Error("Public Bombadil receipts cannot retain diagnostics");
  }
  if (typeof value.runId !== "string" || !UUID_PATTERN.test(value.runId)) {
    throw new Error("Bombadil receipt runId must be a lowercase RFC 4122 UUID");
  }
  const rawPolicy = requireEvidenceRecord(
    value.policy,
    ARTIFACT_POLICY_RECEIPT_KEYS,
    "Bombadil receipt policy",
  );
  const policy = Object.freeze({
    maxDepth: requireEvidencePositiveInteger(
      rawPolicy.maxDepth,
      "Bombadil receipt policy.maxDepth",
      MAX_ARTIFACT_DEPTH,
    ),
    maxEntries: requireEvidencePositiveInteger(
      rawPolicy.maxEntries,
      "Bombadil receipt policy.maxEntries",
      MAX_ARTIFACT_ENTRIES,
    ),
    maxFileBytes: requireEvidencePositiveInteger(
      rawPolicy.maxFileBytes,
      "Bombadil receipt policy.maxFileBytes",
      MAX_ARTIFACT_FILE_BYTES,
    ),
    maxFiles: requireEvidencePositiveInteger(
      rawPolicy.maxFiles,
      "Bombadil receipt policy.maxFiles",
      MAX_ARTIFACT_FILES,
    ),
    maxPathBytes: requireEvidencePositiveInteger(
      rawPolicy.maxPathBytes,
      "Bombadil receipt policy.maxPathBytes",
      MAX_ARTIFACT_PATH_BYTES,
    ),
    maxTotalBytes: requireEvidencePositiveInteger(
      rawPolicy.maxTotalBytes,
      "Bombadil receipt policy.maxTotalBytes",
      MAX_ARTIFACT_TOTAL_BYTES,
    ),
  });
  const rawInventory = requireEvidenceRecord(
    value.inventory,
    ARTIFACT_RECEIPT_INVENTORY_KEYS,
    "Bombadil receipt inventory",
  );
  const entryCount = requireEvidenceInteger(
    rawInventory.entryCount,
    "Bombadil receipt inventory.entryCount",
    policy.maxEntries,
  );
  const fileCount = requireEvidenceInteger(
    rawInventory.fileCount,
    "Bombadil receipt inventory.fileCount",
    policy.maxFiles,
  );
  const totalBytes = requireEvidenceInteger(
    rawInventory.totalBytes,
    "Bombadil receipt inventory.totalBytes",
    policy.maxTotalBytes,
  );
  if (fileCount > entryCount) {
    throw new Error("Bombadil receipt inventory.fileCount cannot exceed entryCount");
  }
  if (fileCount === 0 && totalBytes !== 0) {
    throw new Error("Bombadil receipt inventory bytes require at least one file");
  }
  const inventorySha256 = rawInventory.inventorySha256 === null
    ? null
    : requireEvidenceSha256(
        rawInventory.inventorySha256,
        "Bombadil receipt inventory.inventorySha256",
      );
  if (
    (entryCount === 0 && (fileCount !== 0 || totalBytes !== 0 || inventorySha256 !== null))
    || (entryCount > 0 && inventorySha256 === null)
  ) {
    throw new Error("Bombadil receipt empty-inventory fields are inconsistent");
  }
  if (
    (status === "passed" && (entryCount === 0 || fileCount === 0 || totalBytes === 0))
    || (status === "passed" && value.mode === "private-vetted" && !value.diagnosticsRetained)
    || (failureCode === "interrupted" && value.diagnosticsRetained)
    || (failureCode === "configuration-rejected" && status !== "rejected")
    || (
      failureCode === "writer-settlement"
      && (value.diagnosticsRetained || entryCount !== 0 || fileCount !== 0 || totalBytes !== 0)
    )
    || (
      status === "rejected"
      && (value.diagnosticsRetained || entryCount !== 0 || fileCount !== 0 || totalBytes !== 0)
    )
  ) {
    throw new Error("Bombadil receipt terminal state and retained evidence are inconsistent");
  }
  return Object.freeze({
    schema: ARTIFACT_RECEIPT_SCHEMA,
    completedAt,
    diagnosticsRetained: value.diagnosticsRetained,
    failureCode,
    inventory: Object.freeze({ entryCount, fileCount, inventorySha256, totalBytes }),
    mode: value.mode,
    policy,
    runId: value.runId,
    status,
  });
}

function parseRunSummaryUnchecked(input: unknown): DirectBombadilSanitizedRunSummary {
  const value = requireEvidenceRecord(input, RUN_SUMMARY_KEYS, "Bombadil run summary");
  if (value.schema !== ARTIFACT_SUMMARY_SCHEMA) {
    throw new Error("Bombadil run summary schema is unsupported");
  }
  if (typeof value.artifactName !== "string" || !isBoundedArtifactIdentifier(value.artifactName)) {
    throw new Error("Bombadil run summary artifactName is invalid");
  }
  if (typeof value.scenario !== "string" || !isBoundedScenarioIdentifier(value.scenario)) {
    throw new Error("Bombadil run summary scenario is invalid");
  }
  const failureCode = parseEvidenceFailureCode(
    value.failureCode,
    "Bombadil run summary failureCode",
  );
  const status = requireEvidenceStatus(value.status, "Bombadil run summary status");
  requireFailureStatusConsistency(status, failureCode, "Bombadil run summary");
  let attestation: DirectBombadilSanitizedRunSummary["attestation"] = null;
  if (value.attestation !== null) {
    const raw = requireEvidenceRecord(
      value.attestation,
      RUN_SUMMARY_ATTESTATION_KEYS,
      "Bombadil run summary attestation",
    );
    const observationCount = requireEvidenceInteger(
      raw.observationCount,
      "Bombadil run summary attestation.observationCount",
      TRACE_MAX_LINES,
    );
    const invalidObservationCount = requireEvidenceInteger(
      raw.invalidObservationCount,
      "Bombadil run summary attestation.invalidObservationCount",
      observationCount,
    );
    const validObservationCount = requireEvidenceInteger(
      raw.validObservationCount,
      "Bombadil run summary attestation.validObservationCount",
      observationCount,
    );
    if (invalidObservationCount + validObservationCount !== observationCount) {
      throw new Error("Bombadil run summary attestation counts do not reconcile");
    }
    if (observationCount === 0 || validObservationCount === 0) {
      throw new Error("Bombadil run summary attestation must contain a valid observation");
    }
    attestation = Object.freeze({
      invalidObservationCount,
      observationCount,
      validObservationCount,
    });
  }
  let exploration: DirectBombadilSanitizedRunSummary["exploration"] = null;
  if (value.exploration !== null) {
    const raw = requireEvidenceRecord(
      value.exploration,
      RUN_SUMMARY_EXPLORATION_KEYS,
      "Bombadil run summary exploration",
    );
    const traceLineCount = requireEvidenceInteger(
      raw.traceLineCount,
      "Bombadil run summary exploration.traceLineCount",
      TRACE_MAX_LINES,
    );
    const actionCount = requireEvidenceInteger(
      raw.actionCount,
      "Bombadil run summary exploration.actionCount",
      traceLineCount,
    );
    const nonWaitActionCount = requireEvidenceInteger(
      raw.nonWaitActionCount,
      "Bombadil run summary exploration.nonWaitActionCount",
      actionCount,
    );
    if (typeof raw.policySatisfied !== "boolean") {
      throw new Error("Bombadil run summary exploration.policySatisfied must be boolean");
    }
    exploration = Object.freeze({
      actionCount,
      nonWaitActionCount,
      policySatisfied: raw.policySatisfied,
      traceBytes: requireEvidenceInteger(
        raw.traceBytes,
        "Bombadil run summary exploration.traceBytes",
        TRACE_MAX_BYTES,
      ),
      traceLineCount,
      traceSha256: requireEvidenceSha256(
        raw.traceSha256,
        "Bombadil run summary exploration.traceSha256",
      ),
    });
    if (exploration.traceBytes === 0 || exploration.traceLineCount === 0) {
      throw new Error("Bombadil run summary exploration trace must be nonempty");
    }
  }
  if (
    status === "passed"
    && (
      attestation === null
      || attestation.observationCount === 0
      || attestation.validObservationCount === 0
      || exploration === null
      || !exploration.policySatisfied
      || attestation.observationCount !== exploration.traceLineCount
    )
  ) {
    throw new Error("A passed Bombadil run summary requires attested policy-satisfying evidence");
  }
  if (
    attestation !== null
    && exploration !== null
    && attestation.observationCount !== exploration.traceLineCount
  ) {
    throw new Error("Bombadil run summary trace counts do not reconcile");
  }
  if (status === "rejected" && (attestation !== null || exploration !== null)) {
    throw new Error("A rejected Bombadil run summary cannot claim trace evidence");
  }
  if (failureCode === "configuration-rejected" && status !== "rejected") {
    throw new Error("A configuration-rejected Bombadil run summary must be rejected");
  }
  if (failureCode === "writer-settlement" && (attestation !== null || exploration !== null)) {
    throw new Error("A writer-settlement Bombadil run summary cannot claim trace evidence");
  }
  return Object.freeze({
    schema: ARTIFACT_SUMMARY_SCHEMA,
    artifactName: value.artifactName,
    attestation,
    exploration,
    failureCode,
    scenario: value.scenario,
    status,
  });
}

function parseMatrixReceiptUnchecked(input: unknown): DirectBombadilMatrixReceipt {
  const value = requireEvidenceRecord(input, MATRIX_RECEIPT_KEYS, "Bombadil matrix receipt");
  if (value.schema !== MATRIX_RECEIPT_SCHEMA || value.mode !== "public-summary") {
    throw new Error("Bombadil matrix receipt schema or mode is unsupported");
  }
  const completedAt = requireEvidenceTimestamp(
    value.completedAt,
    "Bombadil matrix receipt completedAt",
  );
  const failureCode = parseEvidenceFailureCode(
    value.failureCode,
    "Bombadil matrix receipt failureCode",
  );
  if (value.status !== "failed" && value.status !== "passed") {
    throw new Error("Bombadil matrix receipt status must be failed or passed");
  }
  requireFailureStatusConsistency(value.status, failureCode, "Bombadil matrix receipt");
  if (typeof value.runId !== "string" || !UUID_PATTERN.test(value.runId)) {
    throw new Error("Bombadil matrix receipt runId must be a lowercase RFC 4122 UUID");
  }
  if (!Array.isArray(value.campaigns) || value.campaigns.length > MAX_MATRIX_CAMPAIGNS) {
    throw new Error("Bombadil matrix receipt campaigns exceed the bounded matrix size");
  }
  const campaignIds = new Set<string>();
  const campaigns = value.campaigns.map((inputCampaign, index) => {
    const campaign = requireEvidenceRecord(
      inputCampaign,
      MATRIX_CAMPAIGN_RECEIPT_KEYS,
      `Bombadil matrix receipt campaign ${String(index)}`,
    );
    if (campaign.index !== index) {
      throw new Error("Bombadil matrix receipt campaign indices must be ordered and contiguous");
    }
    const campaignId = campaign.campaignId;
    if (
      campaignId !== null
      && (
        typeof campaignId !== "string"
        || !isBoundedArtifactIdentifier(campaignId)
        || campaignIds.has(campaignId)
      )
    ) {
      throw new Error("Bombadil matrix receipt campaign IDs must be unique bounded identifiers");
    }
    if (campaignId !== null) campaignIds.add(campaignId);
    if (
      campaign.status !== "failed"
      && campaign.status !== "not-run"
      && campaign.status !== "not-selected"
      && campaign.status !== "passed"
      && campaign.status !== "rejected"
    ) {
      throw new Error("Bombadil matrix receipt campaign status is unsupported");
    }
    const expectedReceipt = campaignId === null
      ? null
      : `campaigns/${campaignId}/receipt.json`;
    if (
      campaign.receipt !== null
      && (typeof campaign.receipt !== "string" || campaign.receipt !== expectedReceipt)
    ) {
      throw new Error("Bombadil matrix child receipt path is not canonical");
    }
    if (
      ((campaign.status === "not-run" || campaign.status === "not-selected")
        && campaign.receipt !== null)
      || (campaign.status === "passed" && campaign.receipt !== expectedReceipt)
      || (campaignId === null && (campaign.status !== "rejected" || campaign.receipt !== null))
    ) {
      throw new Error("Bombadil matrix child terminal state is inconsistent");
    }
    return Object.freeze({
      campaignId,
      index,
      receipt: campaign.receipt as string | null,
      status: campaign.status,
    });
  });
  const omittedCampaignCount = requireEvidenceInteger(
    value.omittedCampaignCount,
    "Bombadil matrix receipt omittedCampaignCount",
  );
  if (
    value.status === "passed"
    && (
      omittedCampaignCount !== 0
      || !campaigns.some((campaign) => campaign.status === "passed")
      || campaigns.some((campaign) =>
        campaign.status === "failed"
        || campaign.status === "not-run"
        || campaign.status === "rejected"
      )
    )
  ) {
    throw new Error("A passed Bombadil matrix receipt has a nonterminal child");
  }
  return Object.freeze({
    schema: MATRIX_RECEIPT_SCHEMA,
    campaigns: Object.freeze(campaigns),
    completedAt,
    failureCode,
    mode: "public-summary",
    omittedCampaignCount,
    runId: value.runId,
    status: value.status,
  });
}

function parseMatrixSummaryUnchecked(input: unknown): DirectBombadilMatrixSummary {
  const value = requireEvidenceRecord(input, MATRIX_SUMMARY_KEYS, "Bombadil matrix summary");
  if (value.schema !== MATRIX_SUMMARY_SCHEMA) {
    throw new Error("Bombadil matrix summary schema is unsupported");
  }
  const failureCode = parseEvidenceFailureCode(
    value.failureCode,
    "Bombadil matrix summary failureCode",
  );
  if (value.status !== "failed" && value.status !== "passed") {
    throw new Error("Bombadil matrix summary status must be failed or passed");
  }
  requireFailureStatusConsistency(value.status, failureCode, "Bombadil matrix summary");
  const rawCampaigns = requireEvidenceRecord(
    value.campaigns,
    MATRIX_SUMMARY_CAMPAIGNS_KEYS,
    "Bombadil matrix summary campaigns",
  );
  const total = requireEvidenceInteger(
    rawCampaigns.total,
    "Bombadil matrix summary campaigns.total",
    MAX_MATRIX_CAMPAIGNS,
  );
  const campaigns = Object.freeze({
    failed: requireEvidenceInteger(rawCampaigns.failed, "Bombadil matrix summary failed", total),
    notRun: requireEvidenceInteger(rawCampaigns.notRun, "Bombadil matrix summary notRun", total),
    notSelected: requireEvidenceInteger(
      rawCampaigns.notSelected,
      "Bombadil matrix summary notSelected",
      total,
    ),
    omitted: requireEvidenceInteger(rawCampaigns.omitted, "Bombadil matrix summary omitted"),
    passed: requireEvidenceInteger(rawCampaigns.passed, "Bombadil matrix summary passed", total),
    rejected: requireEvidenceInteger(rawCampaigns.rejected, "Bombadil matrix summary rejected", total),
    total,
  });
  if (
    campaigns.failed
      + campaigns.notRun
      + campaigns.notSelected
      + campaigns.passed
      + campaigns.rejected
      !== campaigns.total
  ) {
    throw new Error("Bombadil matrix summary campaign counts do not reconcile");
  }
  if (
    value.status === "passed"
    && (
      campaigns.failed !== 0
      || campaigns.notRun !== 0
      || campaigns.rejected !== 0
      || campaigns.omitted !== 0
      || campaigns.passed === 0
    )
  ) {
    throw new Error("A passed Bombadil matrix summary contains unsuccessful campaigns");
  }
  return Object.freeze({
    schema: MATRIX_SUMMARY_SCHEMA,
    campaigns,
    failureCode,
    status: value.status,
  });
}

function artifactEvidenceError(error: unknown): DirectBombadilArtifactParseError {
  return Object.freeze({
    code: "invalid-bombadil-artifact-evidence",
    message: renderUnknown(error),
  });
}

function cloneArtifactEvidence(input: unknown): unknown {
  const parsed = parseJsonValue(input, ARTIFACT_EVIDENCE_JSON_LIMITS);
  if (!parsed.ok) {
    throw new Error(`Bombadil artifact evidence is not bounded inert JSON: ${parsed.error.message}`);
  }
  return parsed.value;
}

/** Parse, clone, and freeze a foreign sanitized Bombadil run receipt. */
export function parseDirectBombadilArtifactReceipt(
  input: unknown,
): Result<DirectBombadilArtifactReceipt, DirectBombadilArtifactParseError> {
  try {
    return ok(parseArtifactReceiptUnchecked(cloneArtifactEvidence(input)));
  } catch (error) {
    return err(artifactEvidenceError(error));
  }
}

/** Parse, clone, and freeze a foreign sanitized Bombadil run summary. */
export function parseDirectBombadilSanitizedRunSummary(
  input: unknown,
): Result<DirectBombadilSanitizedRunSummary, DirectBombadilArtifactParseError> {
  try {
    return ok(parseRunSummaryUnchecked(cloneArtifactEvidence(input)));
  } catch (error) {
    return err(artifactEvidenceError(error));
  }
}

/** Parse, clone, and freeze a foreign sanitized Bombadil matrix receipt. */
export function parseDirectBombadilMatrixReceipt(
  input: unknown,
): Result<DirectBombadilMatrixReceipt, DirectBombadilArtifactParseError> {
  try {
    return ok(parseMatrixReceiptUnchecked(cloneArtifactEvidence(input)));
  } catch (error) {
    return err(artifactEvidenceError(error));
  }
}

/** Parse, clone, and freeze a foreign sanitized Bombadil matrix summary. */
export function parseDirectBombadilMatrixSummary(
  input: unknown,
): Result<DirectBombadilMatrixSummary, DirectBombadilArtifactParseError> {
  try {
    return ok(parseMatrixSummaryUnchecked(cloneArtifactEvidence(input)));
  } catch (error) {
    return err(artifactEvidenceError(error));
  }
}

/** Resolve the lexically validated exact upload leaf for an `if: always()` caller. */
export function resolveDirectBombadilUploadLeaf(
  input: DirectBombadilArtifactRunPlan,
): string {
  const plan = validateArtifactRunPlan(input);
  return join(plan.repositoryRoot, "artifacts", "direct-bombadil-upload", plan.runId);
}

async function requireSafeDirectory(path: string, label: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new BombadilArtifactPolicyError(`${label} does not exist`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BombadilArtifactPolicyError(`${label} must be a non-symlink directory`);
  }
}

async function ensureSafeDirectoryChain(
  repositoryRoot: string,
  parts: readonly string[],
): Promise<string> {
  await requireSafeDirectory(repositoryRoot, "repositoryRoot");
  let current = repositoryRoot;
  for (const part of parts) {
    if (!ARTIFACT_PATH_PART_PATTERN.test(part) || part === "." || part === "..") {
      throw new BombadilArtifactPolicyError("Artifact directory contains an unsafe path component");
    }
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
    await requireSafeDirectory(current, `Artifact directory ${part}`);
    const resolved = await realpath(current);
    if (!isWithin(repositoryRoot, resolved) || resolved !== current) {
      throw new BombadilArtifactPolicyError("Artifact directory escaped repositoryRoot");
    }
  }
  return current;
}

async function createExclusiveDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new BombadilArtifactPolicyError(`${label} already exists`);
    }
    throw error;
  }
  await requireSafeDirectory(path, label);
}

async function createBombadilArtifactRun(options: {
  readonly artifactName: string;
  readonly repositoryRoot: string;
  readonly runId: string;
}): Promise<{
  readonly artifactRoot: string;
  readonly manifestPath: string;
  readonly runDirectory: string;
}> {
  if (!UUID_PATTERN.test(options.runId)) {
    throw new BombadilArtifactPolicyError("Bombadil raw artifact run ID must be a UUID");
  }
  const artifactRoot = await ensureSafeDirectoryChain(options.repositoryRoot, [
    "artifacts",
    "direct-bombadil",
    options.artifactName,
  ]);
  const runDirectory = join(artifactRoot, options.runId);
  await createExclusiveDirectory(runDirectory, "Bombadil artifact run leaf");
  return {
    artifactRoot,
    manifestPath: join(artifactRoot, "manifest.json"),
    runDirectory,
  };
}

async function prepareArtifactUploadSession(
  planInput: DirectBombadilArtifactRunPlan,
): Promise<AtomicArtifactUploadSession> {
  const plan = validateArtifactRunPlan(planInput);
  let repositoryRoot: string | null;
  try {
    repositoryRoot = await realpath(plan.repositoryRoot);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw new BombadilArtifactPolicyError(
        `artifactRun.repositoryRoot could not be proven safe: ${renderUnknown(error)}`,
      );
    }
    repositoryRoot = null;
  }
  if (repositoryRoot === null || repositoryRoot !== plan.repositoryRoot) {
    throw new BombadilArtifactPolicyError(
      "artifactRun.repositoryRoot must resolve to its exact configured directory",
    );
  }
  const root = await ensureSafeDirectoryChain(repositoryRoot, [
    "artifacts",
    "direct-bombadil-upload",
  ]);
  const finalDirectory = join(root, plan.runId);
  let finalMetadata;
  try {
    finalMetadata = await lstat(finalDirectory);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw new BombadilArtifactPolicyError(
        `Bombadil upload run leaf could not be inspected: ${renderUnknown(error)}`,
      );
    }
    finalMetadata = null;
  }
  if (finalMetadata !== null) {
    throw new BombadilArtifactPolicyError("Bombadil upload run leaf already exists");
  }
  const stagingDirectory = join(root, `.staging-${plan.runId}`);
  return {
    finalDirectory,
    mode: plan.uploadMode,
    publication: "atomic-leaf",
    receiptPath: join(finalDirectory, "receipt.json"),
    runId: plan.runId,
    stagingDirectory,
  };
}

async function requireArtifactUploadLeafAbsent(
  session: AtomicArtifactUploadSession,
): Promise<void> {
  let existing;
  try {
    existing = await lstat(session.finalDirectory);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw new BombadilArtifactPolicyError(
        `Bombadil upload run leaf could not be inspected: ${renderUnknown(error)}`,
      );
    }
    existing = null;
  }
  if (existing !== null) {
    throw new BombadilArtifactPolicyError("Bombadil upload run leaf appeared before publication");
  }
}

async function commitArtifactUploadSession(
  session: AtomicArtifactUploadSession,
): Promise<void> {
  // The validated staging tree becomes immutable evidence at this dispatch.
  // Nothing fallible may run after the atomic rename.
  await rename(session.stagingDirectory, session.finalDirectory);
}

function validateArtifactRelativePath(
  relativePath: string,
  policy: ValidatedArtifactPolicy,
): readonly string[] {
  const parts = relativePath.split("/");
  if (
    relativePath.length === 0
    || relativePath.includes("\\")
    || Buffer.byteLength(relativePath, "utf8") > policy.maxPathBytes
    || parts.length > policy.maxDepth
    || parts.some((part) =>
      part === ""
      || part === "."
      || part === ".."
      || part.startsWith(".")
      || !ARTIFACT_PATH_PART_PATTERN.test(part)
    )
  ) {
    throw new BombadilArtifactPolicyError(`Bombadil emitted unsafe artifact path ${relativePath}`);
  }
  return parts;
}

function artifactOutputFileIsAllowed(relativePath: string): boolean {
  return relativePath === "trace.jsonl"
    || PRIVATE_DIAGNOSTIC_EXTENSIONS.has(extname(relativePath).toLowerCase());
}

function parseLiveChromeDownloadPartial(relativePath: string): string | null {
  const prefix = "downloads/";
  const suffix = ".crdownload";
  if (!relativePath.startsWith(prefix) || !relativePath.endsWith(suffix)) return null;
  const runId = relativePath.slice(prefix.length, -suffix.length);
  return UUID_PATTERN.test(runId) ? runId : null;
}

function parseLiveChromeDownloadCompletion(relativePath: string): string | null {
  const prefix = "downloads/";
  if (!relativePath.startsWith(prefix)) return null;
  const runId = relativePath.slice(prefix.length);
  return UUID_PATTERN.test(runId) ? runId : null;
}

function sameLiveChromeDownloadIdentity(
  left: Readonly<{ readonly device: bigint; readonly inode: bigint }>,
  right: Readonly<{ readonly device: bigint; readonly inode: bigint }>,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function requireMatchingLiveChromeDownloadIdentity(
  existing: Readonly<{ readonly device: bigint; readonly inode: bigint }> | undefined,
  completion: Readonly<{ readonly device: bigint; readonly inode: bigint }>,
  relativePath: string,
): void {
  if (existing === undefined || sameLiveChromeDownloadIdentity(existing, completion)) return;
  throw new BombadilArtifactPolicyError(
    `Bombadil Chrome download completion ${relativePath} changed inode identity`,
  );
}

/** @internal Exercise scan-atomic completion identity reconciliation. */
export function requireMatchingLiveChromeDownloadIdentityForTest(options: {
  readonly completion: Readonly<{ readonly device: bigint; readonly inode: bigint }>;
  readonly existing?: Readonly<{ readonly device: bigint; readonly inode: bigint }>;
  readonly relativePath: string;
}): void {
  requireMatchingLiveChromeDownloadIdentity(
    options.existing,
    options.completion,
    options.relativePath,
  );
}

function mayAdmitUnobservedChromeDownloadCompletion(
  context: LiveChromeDownloadScanContext,
  runId: string,
): boolean {
  if (
    !context.cleanBaselineEstablished
    || context.previousHasPartial
  ) {
    return false;
  }
  context.currentUnobservedCompletions.add(runId);
  return true;
}

function sameBigIntFileMetadata(
  left: Readonly<{ dev: bigint; ino: bigint; size: bigint; ctimeNs: bigint; mtimeNs: bigint }>,
  right: Readonly<{ dev: bigint; ino: bigint; size: bigint; ctimeNs: bigint; mtimeNs: bigint }>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs;
}

async function withClosedArtifactHandle<Value>(
  handle: Readonly<{ close: () => Promise<void> }>,
  operation: () => Promise<Value>,
): Promise<Value> {
  let value: Value | undefined;
  let operationFailure: unknown = null;
  try {
    value = await operation();
  } catch (error) {
    operationFailure = error;
  }
  let closeFailure: unknown = null;
  try {
    await handle.close();
  } catch (error) {
    closeFailure = error;
  }
  if (operationFailure !== null) {
    if (closeFailure !== null) {
      throw new AggregateError(
        [operationFailure, closeFailure],
        "Bombadil artifact operation and descriptor cleanup both failed",
        { cause: operationFailure },
      );
    }
    throw operationFailure;
  }
  if (closeFailure !== null) throw closeFailure;
  return value as Value;
}

async function hashBoundRegularFile(options: {
  readonly expected: BigIntStats;
  readonly path: string;
  readonly policy: ValidatedArtifactPolicy;
  readonly relativePath: string;
}): Promise<ArtifactInventoryFile> {
  const flags = fileSystemConstants.O_RDONLY
    | fileSystemConstants.O_NOFOLLOW
    | fileSystemConstants.O_NONBLOCK;
  const handle = await open(options.path, flags);
  return await withClosedArtifactHandle(handle, async () => {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || !options.expected.isFile()
      || options.expected.nlink !== 1n
      || !sameBigIntFileMetadata(before, options.expected)
    ) {
      throw new BombadilArtifactPolicyError(
        `Bombadil artifact ${options.relativePath} changed identity before inspection`,
      );
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size > options.policy.maxFileBytes) {
      throw new BombadilArtifactPolicyError(
        `Bombadil artifact ${options.relativePath} exceeds the per-file byte quota`,
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.length, size - offset);
      const read = await handle.read(buffer, 0, length, offset);
      if (read.bytesRead === 0) {
        throw new BombadilArtifactPolicyError(
          `Bombadil artifact ${options.relativePath} changed while inspected`,
        );
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameBigIntFileMetadata(before, after)) {
      throw new BombadilArtifactPolicyError(
        `Bombadil artifact ${options.relativePath} changed while inspected`,
      );
    }
    return {
      device: before.dev,
      inode: before.ino,
      relativePath: options.relativePath,
      sha256: hash.digest("hex"),
      size,
    };
  });
}

async function readBoundRegularFileBytes(options: {
  readonly expected?: ArtifactInventoryFile;
  readonly label: string;
  readonly maximumBytes: number;
  readonly path: string;
}): Promise<Buffer> {
  const flags = fileSystemConstants.O_RDONLY
    | fileSystemConstants.O_NOFOLLOW
    | fileSystemConstants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(options.path, flags);
  } catch {
    throw new BombadilArtifactPolicyError(`${options.label} is not an openable regular file`);
  }
  try {
    return await withClosedArtifactHandle(handle, async () => {
      const before = await handle.stat({ bigint: true });
      const size = Number(before.size);
      if (
        !before.isFile()
        || before.nlink !== 1n
        || !Number.isSafeInteger(size)
        || size < 1
        || size > options.maximumBytes
      ) {
        throw new BombadilArtifactPolicyError(`${options.label} is not a bounded regular file`);
      }
      if (
        options.expected !== undefined
        && (
          before.dev !== options.expected.device
          || before.ino !== options.expected.inode
          || size !== options.expected.size
        )
      ) {
        throw new BombadilArtifactPolicyError(`${options.label} changed after inventory`);
      }
      const bytes = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const read = await handle.read(bytes, offset, size - offset, offset);
        if (read.bytesRead === 0) {
          throw new BombadilArtifactPolicyError(`${options.label} changed while being read`);
        }
        offset += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (!sameBigIntFileMetadata(before, after)) {
        throw new BombadilArtifactPolicyError(`${options.label} changed while being read`);
      }
      if (
        options.expected !== undefined
        && sha256(bytes) !== options.expected.sha256
      ) {
        throw new BombadilArtifactPolicyError(`${options.label} hash changed after inventory`);
      }
      return bytes;
    });
  } catch (error) {
    throw error instanceof BombadilArtifactPolicyError
      ? error
      : new BombadilArtifactPolicyError(
          `${options.label} could not be read safely: ${renderUnknown(error)}`,
        );
  }
}

function decodeTraceLines(bytes: Uint8Array): readonly string[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Bombadil trace is not valid UTF-8");
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

async function scanBombadilArtifactTree(options: {
  readonly allowTransientEntryAbsence?: boolean;
  readonly allowLiveChromeDownloadTransients?: boolean;
  readonly afterEntryInspect?: (absolutePath: string) => Promise<void> | void;
  readonly beforeDirectoryOpen?: (absolutePath: string) => Promise<void> | void;
  readonly beforeEntryInspect?: (absolutePath: string) => Promise<void> | void;
  readonly beforeLiveChromeDownloadCompletionProbe?: (
    absolutePath: string,
  ) => Promise<void> | void;
  readonly hashFiles: boolean;
  readonly liveChromeDownloadScan?: LiveChromeDownloadScanContext;
  readonly policy: ValidatedArtifactPolicy;
  readonly root: string;
  readonly rootMayBeAbsent?: boolean;
}): Promise<ArtifactInventory> {
  if (options.allowLiveChromeDownloadTransients === true && options.hashFiles) {
    throw new BombadilArtifactPolicyError(
      "Live Chrome download transients cannot enter an authoritative artifact inventory",
    );
  }
  if (
    options.liveChromeDownloadScan !== undefined
    && (options.allowLiveChromeDownloadTransients !== true || options.hashFiles)
  ) {
    throw new BombadilArtifactPolicyError(
      "Chrome download provenance is restricted to unhashed live artifact scans",
    );
  }
  let rootMetadata: BigIntStats | null;
  try {
    rootMetadata = await lstat(options.root, { bigint: true });
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw new BombadilArtifactPolicyError(
        `Bombadil output root could not be inspected: ${renderUnknown(error)}`,
      );
    }
    rootMetadata = null;
  }
  if (rootMetadata === null) {
    if (options.rootMayBeAbsent === true) {
      return {
        directories: Object.freeze([]),
        entryCount: 0,
        files: Object.freeze([]),
        fileCount: 0,
        inventorySha256: sha256(""),
        totalBytes: 0,
      };
    }
    throw new BombadilArtifactPolicyError("Bombadil output directory does not exist");
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new BombadilArtifactPolicyError("Bombadil output root must be a non-symlink directory");
  }
  const directories: string[] = [];
  const files: ArtifactInventoryFile[] = [];
  let entryCount = 0;
  let totalBytes = 0;
  const pending: Array<{ readonly absolutePath: string; readonly relativePath: string }> = [{
    absolutePath: options.root,
    relativePath: "",
  }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    await options.beforeDirectoryOpen?.(current.absolutePath);
    const directory = await opendir(current.absolutePath).catch((error: unknown) => {
      if (
        options.allowTransientEntryAbsence === true
        && isRecord(error)
        && error.code === "ENOENT"
      ) {
        throw error;
      }
      throw new BombadilArtifactPolicyError(
        `Bombadil artifact directory could not be opened safely: ${renderUnknown(error)}`,
      );
    });
    try {
      await withClosedArtifactHandle(directory, async () => {
        while (true) {
          const entry = await directory.read();
          if (entry === null) break;
          const relativePath = current.relativePath === ""
            ? entry.name
            : `${current.relativePath}/${entry.name}`;
          validateArtifactRelativePath(relativePath, options.policy);
          entryCount += 1;
          if (entryCount > options.policy.maxEntries) {
            throw new BombadilArtifactPolicyError("Bombadil artifact entry quota was exceeded");
          }
          const absolutePath = join(current.absolutePath, entry.name);
          await options.beforeEntryInspect?.(absolutePath);
          let metadata: BigIntStats;
          try {
            metadata = await lstat(absolutePath, { bigint: true });
          } catch (error) {
            const partialRunId = parseLiveChromeDownloadPartial(relativePath);
            if (
              options.allowTransientEntryAbsence !== true
              || options.liveChromeDownloadScan === undefined
              || partialRunId === null
              || !isRecord(error)
              || error.code !== "ENOENT"
            ) {
              throw error;
            }
            const completionRelativePath = `downloads/${partialRunId}`;
            validateArtifactRelativePath(completionRelativePath, options.policy);
            const completionPath = join(current.absolutePath, partialRunId);
            let completionMetadata: BigIntStats;
            try {
              await options.beforeLiveChromeDownloadCompletionProbe?.(completionPath);
              completionMetadata = await lstat(completionPath, { bigint: true });
            } catch (completionError) {
              if (isRecord(completionError) && completionError.code === "ENOENT") {
                // Preserve the original readdir-to-lstat absence only when
                // the exact completion sibling is also absent.
                throw error;
              }
              throw completionError;
            }
            const previous = options.liveChromeDownloadScan.previous.get(partialRunId);
            if (completionMetadata.isSymbolicLink()) {
              throw new BombadilArtifactPolicyError(
                `Bombadil emitted a symbolic link at ${completionRelativePath}`,
              );
            }
            if (!completionMetadata.isFile() || completionMetadata.nlink !== 1n) {
              throw new BombadilArtifactPolicyError(
                `Bombadil emitted a non-regular or multiply-linked file at ${completionRelativePath}`,
              );
            }
            const completionSize = Number(completionMetadata.size);
            if (
              !Number.isSafeInteger(completionSize)
              || completionSize > options.policy.maxFileBytes
            ) {
              throw new BombadilArtifactPolicyError(
                `Bombadil artifact ${completionRelativePath} exceeds the per-file byte quota`,
              );
            }
            if (
              previous === undefined
              && !mayAdmitUnobservedChromeDownloadCompletion(
                options.liveChromeDownloadScan,
                partialRunId,
              )
            ) {
              throw new BombadilArtifactPolicyError(
                `Bombadil Chrome download completion ${completionRelativePath} lacks live partial provenance`,
              );
            }
            if (previous !== undefined && previous.phase !== "partial") {
              throw new BombadilArtifactPolicyError(
                `Bombadil Chrome download ${completionRelativePath} reversed its live lifecycle`,
              );
            }
            if (
              previous !== undefined
              && !sameLiveChromeDownloadIdentity(previous, {
                device: completionMetadata.dev,
                inode: completionMetadata.ino,
              })
            ) {
              throw new BombadilArtifactPolicyError(
                `Bombadil Chrome download completion ${completionRelativePath} changed inode identity`,
              );
            }
            // The directory iterator described the old partial name. Discard
            // this incoherent scan after proving the exact sibling rename;
            // the next whole scan applies all aggregate quotas and advances
            // the monitor-owned lineage.
            throw new LiveChromeDownloadRenameRetry({
              device: completionMetadata.dev,
              inode: completionMetadata.ino,
              runId: partialRunId,
              size: completionSize,
              unobserved: previous === undefined,
            });
          }
          if (metadata.isSymbolicLink()) {
            throw new BombadilArtifactPolicyError(
              `Bombadil emitted a symbolic link at ${relativePath}`,
            );
          }
          const liveChromeDownloadPartial = parseLiveChromeDownloadPartial(
            relativePath,
          );
          const liveChromeDownloadCompletion = parseLiveChromeDownloadCompletion(
            relativePath,
          );
          if (metadata.isDirectory()) {
            if (
              liveChromeDownloadPartial !== null
              || (
                options.liveChromeDownloadScan !== undefined
                && liveChromeDownloadCompletion !== null
              )
            ) {
              throw new BombadilArtifactPolicyError(
                `Bombadil emitted a directory at Chrome download path ${relativePath}`,
              );
            }
            directories.push(relativePath);
            options.liveChromeDownloadScan?.currentDirectories.add(relativePath);
            pending.push({ absolutePath, relativePath });
            continue;
          }
          if (!metadata.isFile() || metadata.nlink !== 1n) {
            throw new BombadilArtifactPolicyError(
              `Bombadil emitted a non-regular or multiply-linked file at ${relativePath}`,
            );
          }
          const liveIdentity = {
            device: metadata.dev,
            inode: metadata.ino,
          };
          let liveRunId: string | null = null;
          if (
            options.allowLiveChromeDownloadTransients === true
            && liveChromeDownloadPartial !== null
          ) {
            const previous = options.liveChromeDownloadScan?.previous.get(
              liveChromeDownloadPartial,
            );
            if (previous !== undefined) {
              if (previous.phase !== "partial") {
                throw new BombadilArtifactPolicyError(
                  `Bombadil Chrome download ${relativePath} reversed its live lifecycle`,
                );
              }
              if (!sameLiveChromeDownloadIdentity(previous, liveIdentity)) {
                throw new BombadilArtifactPolicyError(
                  `Bombadil Chrome download partial ${relativePath} changed inode identity`,
                );
              }
            }
            options.liveChromeDownloadScan?.currentPartials.add(
              liveChromeDownloadPartial,
            );
            liveRunId = liveChromeDownloadPartial;
          } else if (
            options.liveChromeDownloadScan !== undefined
            && liveChromeDownloadCompletion !== null
          ) {
            const previous = options.liveChromeDownloadScan.previous.get(
              liveChromeDownloadCompletion,
            );
            if (
              previous === undefined
              && !mayAdmitUnobservedChromeDownloadCompletion(
                options.liveChromeDownloadScan,
                liveChromeDownloadCompletion,
              )
            ) {
              throw new BombadilArtifactPolicyError(
                `Bombadil Chrome download completion ${relativePath} lacks live partial provenance`,
              );
            }
            if (
              previous !== undefined
              && !sameLiveChromeDownloadIdentity(previous, liveIdentity)
            ) {
              throw new BombadilArtifactPolicyError(
                `Bombadil Chrome download completion ${relativePath} changed inode identity`,
              );
            }
            liveRunId = liveChromeDownloadCompletion;
          }
          if (
            !artifactOutputFileIsAllowed(relativePath)
            && liveRunId === null
          ) {
            throw new BombadilArtifactPolicyError(
              `Bombadil emitted a file outside the artifact allowlist at ${relativePath}`,
            );
          }
          if (files.length + 1 > options.policy.maxFiles) {
            throw new BombadilArtifactPolicyError("Bombadil artifact file quota was exceeded");
          }
          const fileSize = Number(metadata.size);
          if (!Number.isSafeInteger(fileSize) || fileSize > options.policy.maxFileBytes) {
            throw new BombadilArtifactPolicyError(
              `Bombadil artifact ${relativePath} exceeds the per-file byte quota`,
            );
          }
          totalBytes += fileSize;
          if (!Number.isSafeInteger(totalBytes) || totalBytes > options.policy.maxTotalBytes) {
            throw new BombadilArtifactPolicyError(
              "Bombadil aggregate artifact byte quota was exceeded",
            );
          }
          if (options.liveChromeDownloadScan !== undefined) {
            options.liveChromeDownloadScan.currentAccountedFiles.set(
              relativePath,
              fileSize,
            );
          }
          files.push(options.hashFiles
            ? await hashBoundRegularFile({
                expected: metadata,
                path: absolutePath,
                policy: options.policy,
                relativePath,
              })
            : {
                device: 0n,
                inode: 0n,
                relativePath,
                sha256: "",
                size: fileSize,
              });
          if (liveRunId !== null) {
            const liveChromeDownload = options.liveChromeDownloadScan;
            if (liveChromeDownload !== undefined) {
              const alreadyKnown = liveChromeDownload.next.has(liveRunId);
              if (!alreadyKnown && liveChromeDownload.next.size >= options.policy.maxFiles) {
                throw new BombadilArtifactPolicyError(
                  "Bombadil live download provenance quota was exceeded",
                );
              }
              liveChromeDownload.next.set(liveRunId, {
                ...liveIdentity,
                phase: liveChromeDownloadCompletion === null ? "partial" : "complete",
              });
            }
          }
          await options.afterEntryInspect?.(absolutePath);
        }
      });
    } catch (error) {
      if (error instanceof LiveChromeDownloadRenameRetry) throw error;
      if (
        options.allowTransientEntryAbsence === true
        && isRecord(error)
        && error.code === "ENOENT"
      ) {
        throw error;
      }
      throw error instanceof BombadilArtifactPolicyError
        ? error
        : new BombadilArtifactPolicyError(
            `Bombadil artifact directory could not be inspected safely: ${renderUnknown(error)}`,
          );
    }
  }
  if (
    options.liveChromeDownloadScan !== undefined
    && options.liveChromeDownloadScan.currentPartials.size > 0
    && options.liveChromeDownloadScan.currentUnobservedCompletions.size > 0
  ) {
    throw new BombadilArtifactPolicyError(
      "Bombadil Chrome download completion lacks live partial provenance across the current scan",
    );
  }
  let finalRootMetadata: BigIntStats;
  try {
    finalRootMetadata = await lstat(options.root, { bigint: true });
  } catch (error) {
    throw new BombadilArtifactPolicyError(
      `Bombadil output root could not be revalidated: ${renderUnknown(error)}`,
    );
  }
  if (
    !finalRootMetadata.isDirectory()
    || finalRootMetadata.isSymbolicLink()
    || finalRootMetadata.dev !== rootMetadata.dev
    || finalRootMetadata.ino !== rootMetadata.ino
  ) {
    throw new BombadilArtifactPolicyError("Bombadil output root changed during inspection");
  }
  directories.sort(compareCodeUnits);
  files.sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath));
  const inventorySha256 = sha256([
    ...directories.map((directory) => `D\0${directory}\n`),
    ...files.map((file) =>
      `F\0${file.relativePath}\0${String(file.size)}\0${file.sha256}\n`
    ),
  ].join(""));
  return {
    directories: Object.freeze(directories),
    entryCount,
    files: Object.freeze(files),
    fileCount: files.length,
    inventorySha256,
    totalBytes,
  };
}

async function scanLiveBombadilArtifactTree(options: {
  readonly abortSignal?: AbortSignal;
  readonly afterLiveChromeDownloadRenameRetry?: (
    absolutePath: string,
  ) => Promise<void> | void;
  readonly cleanBaselineEstablished: boolean;
  readonly afterEntryInspect?: (absolutePath: string) => Promise<void> | void;
  readonly beforeDirectoryOpen?: (absolutePath: string) => Promise<void> | void;
  readonly beforeEntryInspect?: (absolutePath: string) => Promise<void> | void;
  readonly beforeLiveChromeDownloadCompletionProbe?: (
    absolutePath: string,
  ) => Promise<void> | void;
  readonly outputPath: string;
  readonly policy: ValidatedArtifactPolicy;
  readonly previous: ReadonlyMap<string, LiveChromeDownloadIdentity>;
}): Promise<ReadonlyMap<string, LiveChromeDownloadIdentity>> {
  const carriedCompletions = new Map<string, Readonly<{
    device: bigint;
    inode: bigint;
    size: number;
    unobserved: boolean;
  }>>();
  const carriedDirectories = new Set<string>();
  const carriedFiles = new Map<string, number>();
  let previous = options.previous;
  for (let retryCount = 0; retryCount < MAX_LIVE_CHROME_RENAME_RETRIES; retryCount += 1) {
    if (options.abortSignal?.aborted === true) return previous;
    const currentPartials = new Set<string>();
    const currentUnobservedCompletions = new Set<string>();
    const currentAccountedFiles = new Map<string, number>();
    const currentDirectories = new Set<string>();
    const next = new Map<string, LiveChromeDownloadIdentity>(previous);
    let inventory: ArtifactInventory;
    try {
      inventory = await scanBombadilArtifactTree({
        ...(options.afterEntryInspect === undefined
          ? {}
          : { afterEntryInspect: options.afterEntryInspect }),
        allowTransientEntryAbsence: true,
        allowLiveChromeDownloadTransients: true,
        ...(options.beforeDirectoryOpen === undefined
          ? {}
          : { beforeDirectoryOpen: options.beforeDirectoryOpen }),
        ...(options.beforeEntryInspect === undefined
          ? {}
          : { beforeEntryInspect: options.beforeEntryInspect }),
        ...(options.beforeLiveChromeDownloadCompletionProbe === undefined
          ? {}
          : {
              beforeLiveChromeDownloadCompletionProbe:
                options.beforeLiveChromeDownloadCompletionProbe,
            }),
        hashFiles: false,
        liveChromeDownloadScan: {
          currentAccountedFiles,
          currentDirectories,
          cleanBaselineEstablished: options.cleanBaselineEstablished,
          currentPartials,
          currentUnobservedCompletions,
          next,
          previous,
          previousHasPartial: [...previous.values()]
            .some((identity) => identity.phase === "partial"),
        },
        policy: options.policy,
        root: options.outputPath,
        rootMayBeAbsent: true,
      });
    } catch (error) {
      if (!(error instanceof LiveChromeDownloadRenameRetry)) throw error;
      const observedOtherUnprovenCompletion = [...currentUnobservedCompletions]
        .some((runId) => runId !== error.completion.runId);
      if (currentPartials.size > 0 || observedOtherUnprovenCompletion) {
        throw new BombadilArtifactPolicyError(
          "Bombadil Chrome download completion lacks live partial provenance across the current scan",
        );
      }
      for (const directory of currentDirectories) carriedDirectories.add(directory);
      for (const [relativePath, size] of currentAccountedFiles) {
        carriedFiles.set(
          relativePath,
          Math.max(carriedFiles.get(relativePath) ?? 0, size),
        );
      }
      const retained = carriedCompletions.get(error.completion.runId);
      const currentIdentity = next.get(error.completion.runId);
      requireMatchingLiveChromeDownloadIdentity(
        currentIdentity,
        error.completion,
        `downloads/${error.completion.runId}`,
      );
      requireMatchingLiveChromeDownloadIdentity(
        retained,
        error.completion,
        `downloads/${error.completion.runId}`,
      );
      if (
        retained === undefined
        && carriedCompletions.size >= options.policy.maxFiles
      ) {
        throw new BombadilArtifactPolicyError(
          "Bombadil live download provenance quota was exceeded",
        );
      }
      carriedCompletions.set(error.completion.runId, {
        device: error.completion.device,
        inode: error.completion.inode,
        size: Math.max(retained?.size ?? 0, error.completion.size),
        unobserved: retained?.unobserved === true || error.completion.unobserved,
      });
      const completionRelativePath = `downloads/${error.completion.runId}`;
      carriedFiles.set(
        completionRelativePath,
        Math.max(carriedFiles.get(completionRelativePath) ?? 0, error.completion.size),
      );
      const carriedTotalBytes = [...carriedFiles.values()]
        .reduce((total, size) => total + size, 0);
      if (carriedFiles.size > options.policy.maxFiles) {
        throw new BombadilArtifactPolicyError("Bombadil artifact file quota was exceeded");
      }
      if (carriedFiles.size + carriedDirectories.size > options.policy.maxEntries) {
        throw new BombadilArtifactPolicyError("Bombadil artifact entry quota was exceeded");
      }
      if (carriedTotalBytes > options.policy.maxTotalBytes) {
        throw new BombadilArtifactPolicyError(
          "Bombadil aggregate artifact byte quota was exceeded",
        );
      }
      const retryPrevious = new Map(previous);
      if (
        !retryPrevious.has(error.completion.runId)
        && retryPrevious.size >= options.policy.maxFiles
      ) {
        throw new BombadilArtifactPolicyError(
          "Bombadil live download provenance quota was exceeded",
        );
      }
      retryPrevious.set(error.completion.runId, {
        device: error.completion.device,
        inode: error.completion.inode,
        phase: "complete",
      });
      previous = retryPrevious;
      await options.afterLiveChromeDownloadRenameRetry?.(
        join(options.outputPath, "downloads", error.completion.runId),
      );
      if (options.abortSignal?.aborted === true) return previous;
      continue;
    }
    if (
      currentPartials.size > 0
      && [...carriedCompletions.values()].some((completion) => completion.unobserved)
    ) {
      throw new BombadilArtifactPolicyError(
        "Bombadil Chrome download completion lacks live partial provenance across the current scan",
      );
    }
    let absentCarriedFileCount = 0;
    let absentCarriedEntryCount = 0;
    let absentCarriedTotalBytes = 0;
    const inventoryFilesByPath = new Map(
      inventory.files.map((file) => [file.relativePath, file.size] as const),
    );
    const inventoryDirectories = new Set(inventory.directories);
    for (const [relativePath, carriedSize] of carriedFiles) {
      const retainedSize = inventoryFilesByPath.get(relativePath);
      if (retainedSize === undefined) {
        absentCarriedFileCount += 1;
        absentCarriedEntryCount += 1;
        absentCarriedTotalBytes += carriedSize;
      } else {
        absentCarriedTotalBytes += Math.max(0, carriedSize - retainedSize);
      }
    }
    for (const directory of carriedDirectories) {
      if (!inventoryDirectories.has(directory)) absentCarriedEntryCount += 1;
    }
    if (inventory.fileCount + absentCarriedFileCount > options.policy.maxFiles) {
      throw new BombadilArtifactPolicyError("Bombadil artifact file quota was exceeded");
    }
    if (inventory.entryCount + absentCarriedEntryCount > options.policy.maxEntries) {
      throw new BombadilArtifactPolicyError("Bombadil artifact entry quota was exceeded");
    }
    if (inventory.totalBytes + absentCarriedTotalBytes > options.policy.maxTotalBytes) {
      throw new BombadilArtifactPolicyError(
        "Bombadil aggregate artifact byte quota was exceeded",
      );
    }
    return next;
  }
  throw new BombadilArtifactPolicyError(
    "Bombadil Chrome download rename activity did not settle safely",
  );
}

/** @internal Exercise transient versus authoritative artifact scans in package tests. */
export async function inspectBombadilArtifactTreeForTest(options: {
  readonly allowTransientEntryAbsence?: boolean;
  readonly allowLiveChromeDownloadTransients?: boolean;
  readonly beforeDirectoryOpen?: (absolutePath: string) => Promise<void> | void;
  readonly beforeEntryInspect?: (absolutePath: string) => Promise<void> | void;
  readonly hashFiles: boolean;
  readonly policy: DirectBombadilArtifactPolicy;
  readonly root: string;
}): Promise<void> {
  await scanBombadilArtifactTree({
    ...options,
    policy: validateArtifactPolicy(options.policy),
  });
}

/** @internal Exercise successive live-monitor scans without exposing provenance. */
export async function monitorBombadilArtifactTreeForTest(options: {
  readonly abortSignal?: AbortSignal;
  readonly cleanBaselineEstablished?: boolean;
  readonly policy: DirectBombadilArtifactPolicy;
  readonly root: string;
  readonly scans: readonly {
    readonly afterLiveChromeDownloadRenameRetry?: (
      absolutePath: string,
    ) => Promise<void> | void;
    readonly afterEntryInspect?: (absolutePath: string) => Promise<void> | void;
    readonly beforeDirectoryOpen?: (absolutePath: string) => Promise<void> | void;
    readonly beforeEntryInspect?: (absolutePath: string) => Promise<void> | void;
    readonly beforeLiveChromeDownloadCompletionProbe?: (
      absolutePath: string,
    ) => Promise<void> | void;
    readonly beforeScan?: () => Promise<void> | void;
  }[];
}): Promise<void> {
  const policy = validateArtifactPolicy(options.policy);
  let provenance: ReadonlyMap<string, LiveChromeDownloadIdentity> = new Map();
  if (options.cleanBaselineEstablished === true) {
    const baseline = await scanBombadilArtifactTree({
      hashFiles: false,
      policy,
      root: options.root,
      rootMayBeAbsent: true,
    });
    if (baseline.entryCount !== 0) {
      throw new BombadilArtifactPolicyError(
        "Bombadil output must be absent or empty before the live artifact epoch",
      );
    }
  }
  for (const scan of options.scans) {
    if (options.abortSignal?.aborted === true) break;
    await scan.beforeScan?.();
    try {
      provenance = await scanLiveBombadilArtifactTree({
        ...(options.abortSignal === undefined
          ? {}
          : { abortSignal: options.abortSignal }),
        ...(scan.afterLiveChromeDownloadRenameRetry === undefined
          ? {}
          : {
              afterLiveChromeDownloadRenameRetry:
                scan.afterLiveChromeDownloadRenameRetry,
            }),
        ...(scan.afterEntryInspect === undefined
          ? {}
          : { afterEntryInspect: scan.afterEntryInspect }),
        ...(scan.beforeDirectoryOpen === undefined
          ? {}
          : { beforeDirectoryOpen: scan.beforeDirectoryOpen }),
        ...(scan.beforeEntryInspect === undefined
          ? {}
          : { beforeEntryInspect: scan.beforeEntryInspect }),
        ...(scan.beforeLiveChromeDownloadCompletionProbe === undefined
          ? {}
          : {
              beforeLiveChromeDownloadCompletionProbe:
                scan.beforeLiveChromeDownloadCompletionProbe,
            }),
        outputPath: options.root,
        policy,
        previous: provenance,
        cleanBaselineEstablished: options.cleanBaselineEstablished === true,
      });
    } catch (error) {
      if (
        error instanceof LiveChromeDownloadRenameRetry
        || (isRecord(error) && error.code === "ENOENT")
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function ensureSafeChildDirectories(
  root: string,
  parts: readonly string[],
): Promise<string> {
  await requireSafeDirectory(root, "Bombadil upload staging root");
  let current = root;
  for (const part of parts) {
    if (!ARTIFACT_PATH_PART_PATTERN.test(part) || part.startsWith(".")) {
      throw new BombadilArtifactPolicyError("Bombadil upload path contains an unsafe component");
    }
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
    await requireSafeDirectory(current, "Bombadil upload directory");
    const resolved = await realpath(current);
    if (!isWithin(root, resolved) || resolved !== current) {
      throw new BombadilArtifactPolicyError("Bombadil upload directory escaped staging root");
    }
  }
  return current;
}

async function writeExclusiveBytes(path: string, bytes: Uint8Array): Promise<void> {
  const flags = fileSystemConstants.O_WRONLY
    | fileSystemConstants.O_CREAT
    | fileSystemConstants.O_EXCL
    | fileSystemConstants.O_NOFOLLOW;
  const handle = await open(path, flags, 0o600);
  await withClosedArtifactHandle(handle, async () => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (written.bytesWritten === 0) throw new Error("Exclusive artifact write made no progress");
      offset += written.bytesWritten;
    }
    await handle.sync();
  });
}

async function writeExpectedJson(
  root: string,
  relativePath: string,
  value: unknown,
): Promise<ExpectedUploadFile> {
  const parts = relativePath.split("/");
  const fileName = parts.pop();
  if (fileName === undefined || !ARTIFACT_PATH_PART_PATTERN.test(fileName)) {
    throw new BombadilArtifactPolicyError("Sanitized upload path is invalid");
  }
  const directory = await ensureSafeChildDirectories(root, parts);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  await writeExclusiveBytes(join(directory, fileName), bytes);
  return {
    relativePath,
    sha256: sha256(bytes),
    size: bytes.byteLength,
  };
}

function expectedUploadDirectories(
  files: readonly ExpectedUploadFile[],
): readonly string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.relativePath.split("/");
    parts.pop();
    for (let index = 1; index <= parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return Object.freeze([...directories].sort(compareCodeUnits));
}

async function validateExpectedUploadTree(
  root: string,
  expectedInput: readonly ExpectedUploadFile[],
): Promise<void> {
  const expected = [...expectedInput].sort((left, right) =>
    compareCodeUnits(left.relativePath, right.relativePath)
  );
  if (new Set(expected.map((file) => file.relativePath)).size !== expected.length) {
    throw new BombadilArtifactPolicyError("Sanitized upload contains duplicate file paths");
  }
  const directories = expectedUploadDirectories(expected);
  const maximumPathBytes = Math.max(
    1,
    ...expected.map((file) => Buffer.byteLength(file.relativePath, "utf8")),
  );
  const inventory = await scanBombadilArtifactTree({
    hashFiles: true,
    policy: {
      maxDepth: Math.max(1, ...expected.map((file) => file.relativePath.split("/").length)),
      maxEntries: Math.max(1, expected.length + directories.length),
      maxFileBytes: Math.max(1, ...expected.map((file) => file.size)),
      maxFiles: Math.max(1, expected.length),
      maxPathBytes: maximumPathBytes,
      maxTotalBytes: Math.max(1, expected.reduce((total, file) => total + file.size, 0)),
    },
    root,
  });
  if (
    inventory.directories.length !== directories.length
    || inventory.directories.some((directory, index) => directory !== directories[index])
    || inventory.files.length !== expected.length
    || inventory.files.some((file, index) => {
      const wanted = expected[index];
      return wanted === undefined
        || file.relativePath !== wanted.relativePath
        || file.sha256 !== wanted.sha256
        || file.size !== wanted.size;
    })
  ) {
    throw new BombadilArtifactPolicyError(
      "Sanitized upload tree differs from its exact expected inventory",
    );
  }
}

async function copyVerifiedArtifactFile(options: {
  readonly destinationRoot: string;
  readonly file: ArtifactInventoryFile;
  readonly sourceRoot: string;
}): Promise<void> {
  const parts = options.file.relativePath.split("/");
  const fileName = parts.pop();
  if (fileName === undefined) throw new BombadilArtifactPolicyError("Artifact copy path is empty");
  const destinationDirectory = await ensureSafeChildDirectories(
    options.destinationRoot,
    parts,
  );
  const destinationPath = join(destinationDirectory, fileName);
  const sourcePath = join(options.sourceRoot, ...options.file.relativePath.split("/"));
  const sourceFlags = fileSystemConstants.O_RDONLY
    | fileSystemConstants.O_NOFOLLOW
    | fileSystemConstants.O_NONBLOCK;
  const destinationFlags = fileSystemConstants.O_WRONLY
    | fileSystemConstants.O_CREAT
    | fileSystemConstants.O_EXCL
    | fileSystemConstants.O_NOFOLLOW;
  const source = await open(sourcePath, sourceFlags);
  let destination: Awaited<ReturnType<typeof open>> | null = null;
  let copyFailure: unknown = null;
  try {
    const before = await source.stat({ bigint: true });
    if (
      !before.isFile()
      || before.nlink !== 1n
      || before.dev !== options.file.device
      || before.ino !== options.file.inode
      || Number(before.size) !== options.file.size
    ) {
      throw new BombadilArtifactPolicyError(
        `Bombadil artifact ${options.file.relativePath} changed before private copy`,
      );
    }
    destination = await open(destinationPath, destinationFlags, 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < options.file.size) {
      const read = await source.read(
        buffer,
        0,
        Math.min(buffer.length, options.file.size - offset),
        offset,
      );
      if (read.bytesRead === 0) {
        throw new BombadilArtifactPolicyError(
          `Bombadil artifact ${options.file.relativePath} changed during private copy`,
        );
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      let writtenOffset = 0;
      while (writtenOffset < read.bytesRead) {
        const written = await destination.write(
          buffer,
          writtenOffset,
          read.bytesRead - writtenOffset,
          offset + writtenOffset,
        );
        if (written.bytesWritten === 0) throw new Error("Private artifact copy made no progress");
        writtenOffset += written.bytesWritten;
      }
      offset += read.bytesRead;
    }
    await destination.sync();
    const after = await source.stat({ bigint: true });
    if (
      !sameBigIntFileMetadata(before, after)
      || hash.digest("hex") !== options.file.sha256
    ) {
      throw new BombadilArtifactPolicyError(
        `Bombadil artifact ${options.file.relativePath} changed during private copy`,
      );
    }
  } catch (error) {
    copyFailure = error;
    await rm(destinationPath, { force: true }).catch(() => undefined);
  }
  let closeFailure: unknown = null;
  try {
    await closeBombadilArtifactCopyHandles(destination, source);
  } catch (error) {
    closeFailure = error;
  }
  if (copyFailure !== null) {
    if (closeFailure !== null) {
      throw new AggregateError(
        [copyFailure, closeFailure],
        "Bombadil artifact copy and descriptor cleanup both failed",
        { cause: copyFailure },
      );
    }
    throw copyFailure;
  }
  if (closeFailure !== null) throw closeFailure;
}

/** @internal Close both descriptor-bound copy handles even when one close fails. */
export async function closeBombadilArtifactCopyHandles(
  destination: Readonly<{ close: () => Promise<void> }> | null,
  source: Readonly<{ close: () => Promise<void> }>,
): Promise<void> {
  const failures: unknown[] = [];
  if (destination !== null) {
    try {
      await destination.close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await source.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Both Bombadil artifact copy descriptors failed to close");
  }
}

function emptyArtifactInventory(): ArtifactInventory {
  return {
    directories: Object.freeze([]),
    entryCount: 0,
    files: Object.freeze([]),
    fileCount: 0,
    inventorySha256: sha256(""),
    totalBytes: 0,
  };
}

function artifactFailureCode(error: unknown): DirectBombadilArtifactFailureCode {
  if (error instanceof BombadilPersistenceError) return "persistence";
  if (error instanceof BombadilWriterSettlementError) return "writer-settlement";
  if (error instanceof BombadilArtifactPolicyError) return "artifact-policy";
  const message = renderUnknown(error);
  if (message.includes("interrupted") || message.includes("SIGINT") || message.includes("SIGTERM")) {
    return "interrupted";
  }
  if (message.includes("exploration policy")) return "exploration-policy";
  if (message.includes("trace") || message.includes("Direct contract")) return "trace-attestation";
  if (message.includes("server") || message.includes("reachable")) return "server";
  if (message.includes("Bombadil")) return "process";
  return "unknown";
}

function failureAsError(error: unknown): Error {
  return error instanceof Error ? error : new Error(renderUnknown(error));
}

function combinePersistenceFailure(
  primary: unknown,
  persistence: unknown,
  message = "Bombadil persistence also failed",
): BombadilPersistenceError {
  return new BombadilPersistenceError(
    `${renderUnknown(primary)}; ${message}`,
    [primary, persistence],
  );
}

async function publishFailureAndThrow(
  primary: unknown,
  publish: () => Promise<void>,
): Promise<never> {
  try {
    await publish();
  } catch (persistence) {
    throw combinePersistenceFailure(
      primary,
      persistence,
      "sanitized Bombadil receipt publication also failed",
    );
  }
  throw failureAsError(primary);
}

function createArtifactReceipt(options: {
  readonly completedAt: Date;
  readonly diagnosticsRetained: boolean;
  readonly failureCode: DirectBombadilArtifactFailureCode | null;
  readonly inventory: ArtifactInventory;
  readonly policy: ValidatedArtifactPolicy;
  readonly session: ArtifactUploadSession;
  readonly status: "failed" | "passed" | "rejected";
}): DirectBombadilArtifactReceipt {
  return Object.freeze({
    schema: ARTIFACT_RECEIPT_SCHEMA,
    completedAt: options.completedAt.toISOString(),
    diagnosticsRetained: options.diagnosticsRetained,
    failureCode: options.failureCode,
    inventory: Object.freeze({
      entryCount: options.inventory.entryCount,
      fileCount: options.inventory.fileCount,
      inventorySha256: options.inventory.entryCount === 0
        ? null
        : options.inventory.inventorySha256,
      totalBytes: options.inventory.totalBytes,
    }),
    mode: options.session.mode,
    policy: options.policy,
    runId: options.session.runId,
    status: options.status,
  });
}

function createSanitizedRunSummary(options: {
  readonly artifactName: string;
  readonly attestation: DirectBombadilTraceAttestation | null;
  readonly explorationSummary: DirectBombadilExplorationSummary | null;
  readonly failureCode: DirectBombadilArtifactFailureCode | null;
  readonly scenario: string;
  readonly status: "failed" | "passed" | "rejected";
}): DirectBombadilSanitizedRunSummary {
  return Object.freeze({
    schema: ARTIFACT_SUMMARY_SCHEMA,
    artifactName: options.artifactName,
    scenario: options.scenario,
    status: options.status,
    failureCode: options.failureCode,
    attestation: options.attestation === null
      ? null
      : Object.freeze({
          invalidObservationCount: options.attestation.invalidObservationCount,
          observationCount: options.attestation.observationCount,
          validObservationCount: options.attestation.validObservationCount,
        }),
    exploration: options.explorationSummary === null
      ? null
      : Object.freeze({
          actionCount: options.explorationSummary.actions.total,
          nonWaitActionCount: options.explorationSummary.actions.nonWaitCount,
          policySatisfied: options.explorationSummary.policy.satisfied,
          traceBytes: options.explorationSummary.trace.bytes,
          traceLineCount: options.explorationSummary.trace.lineCount,
          traceSha256: options.explorationSummary.trace.sha256,
        }),
  });
}

async function resetUploadStaging(session: AtomicArtifactUploadSession): Promise<void> {
  await rm(session.stagingDirectory, { force: true, recursive: true });
  await createExclusiveDirectory(session.stagingDirectory, "Bombadil upload staging leaf");
}

async function withOwnedUploadStaging<Value>(
  session: AtomicArtifactUploadSession,
  operation: () => Promise<Value>,
): Promise<Value> {
  await createExclusiveDirectory(session.stagingDirectory, "Bombadil upload staging leaf");
  try {
    return await operation();
  } catch (error) {
    try {
      await rm(session.stagingDirectory, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Bombadil upload staging operation and cleanup both failed",
        { cause: error },
      );
    }
    throw error;
  }
}

async function publishRunUpload(options: {
  readonly abortSignal?: AbortSignal;
  readonly artifactName: string;
  readonly beforeCommitCheck?: (() => Promise<void> | void) | undefined;
  readonly attestation: DirectBombadilTraceAttestation | null;
  readonly completedAt: Date;
  readonly explorationSummary: DirectBombadilExplorationSummary | null;
  readonly failure: unknown;
  readonly failureCode?: DirectBombadilArtifactFailureCode;
  readonly inventory: ArtifactInventory;
  readonly interruptedSignal?: () => ProcessInterruptSignal | null;
  readonly localOutputPath: string;
  readonly policy: ValidatedArtifactPolicy;
  readonly privateDiagnosticsAllowed: boolean;
  readonly scenario: string;
  readonly serverLog: string;
  readonly processLog: string;
  readonly session: ArtifactUploadSession;
  readonly status: "failed" | "passed" | "rejected";
}): Promise<{
  readonly failure: unknown;
  readonly receipt: DirectBombadilArtifactReceipt;
}> {
  let failure = options.failure;
  let failureCode = failure === null
    ? null
    : options.failureCode ?? artifactFailureCode(failure);
  let status = options.status;
  const observeInterruption = (): boolean => {
    if (failure !== null || options.abortSignal?.aborted !== true) return false;
    const signal = options.interruptedSignal?.() ?? null;
    failure = new Error(
      signal === null
        ? "Bombadil fuzzing was interrupted"
        : `Bombadil fuzzing was interrupted by ${signal}`,
    );
    failureCode = "interrupted";
    status = "failed";
    return true;
  };
  observeInterruption();
  if (options.session.publication === "deferred" && options.session.mode !== "public-summary") {
    throw new BombadilArtifactPolicyError(
      "Bombadil matrices support public-summary uploads only",
    );
  }
  if (options.session.publication === "deferred") {
    const receipt = createArtifactReceipt({
      completedAt: options.completedAt,
      diagnosticsRetained: false,
      failureCode,
      inventory: options.inventory,
      policy: options.policy,
      session: options.session,
      status,
    });
    const summary = createSanitizedRunSummary({
      artifactName: options.artifactName,
      attestation: options.attestation,
      explorationSummary: options.explorationSummary,
      failureCode,
      scenario: options.scenario,
      status,
    });
    if (options.session.deferredPayload.value !== null) {
      throw new BombadilArtifactPolicyError("Bombadil deferred upload state is invalid");
    }
    options.session.deferredPayload.value = Object.freeze({ receipt, summary });
    return { failure, receipt };
  }
  const session = options.session;
  return await withOwnedUploadStaging(session, async () => {
  const expectedFiles: ExpectedUploadFile[] = [];
  let diagnosticsRetained = false;
  if (
    session.mode === "private-vetted"
    && options.privateDiagnosticsAllowed
    && failureCode !== "interrupted"
  ) {
    try {
      const diagnosticsRoot = await ensureSafeChildDirectories(
        session.stagingDirectory,
        ["diagnostics", "bombadil-output"],
      );
      for (const file of options.inventory.files) {
        await copyVerifiedArtifactFile({
          destinationRoot: diagnosticsRoot,
          file,
          sourceRoot: options.localOutputPath,
        });
        expectedFiles.push({
          relativePath: `diagnostics/bombadil-output/${file.relativePath}`,
          sha256: file.sha256,
          size: file.size,
        });
      }
      const controlledLogs = await ensureSafeChildDirectories(
        session.stagingDirectory,
        ["diagnostics", "host"],
      );
      const processLogBytes = Buffer.from(options.processLog, "utf8");
      const serverLogBytes = Buffer.from(options.serverLog, "utf8");
      await writeExclusiveBytes(join(controlledLogs, "bombadil.log"), processLogBytes);
      await writeExclusiveBytes(join(controlledLogs, "server.log"), serverLogBytes);
      expectedFiles.push(
        {
          relativePath: "diagnostics/host/bombadil.log",
          sha256: sha256(processLogBytes),
          size: processLogBytes.byteLength,
        },
        {
          relativePath: "diagnostics/host/server.log",
          sha256: sha256(serverLogBytes),
          size: serverLogBytes.byteLength,
        },
      );
      diagnosticsRetained = true;
    } catch (error) {
      const persistence = new BombadilPersistenceError(
        "Bombadil private diagnostics could not be persisted",
        [error],
      );
      failure = failure === null
        ? persistence
        : combinePersistenceFailure(failure, persistence);
      failureCode = "persistence";
      status = "failed";
      await resetUploadStaging(session);
      expectedFiles.length = 0;
    }
  }
  const stageSanitizedPayload = async (): Promise<DirectBombadilArtifactReceipt> => {
    const receipt = createArtifactReceipt({
      completedAt: options.completedAt,
      diagnosticsRetained,
      failureCode,
      inventory: options.inventory,
      policy: options.policy,
      session,
      status,
    });
    const summary = createSanitizedRunSummary({
      artifactName: options.artifactName,
      attestation: options.attestation,
      explorationSummary: options.explorationSummary,
      failureCode,
      scenario: options.scenario,
      status,
    });
    expectedFiles.push(
      await writeExpectedJson(session.stagingDirectory, "summary.json", summary),
      await writeExpectedJson(session.stagingDirectory, "receipt.json", receipt),
    );
    await validateExpectedUploadTree(session.stagingDirectory, expectedFiles);
    return receipt;
  };
  let receipt = await stageSanitizedPayload();
  await options.beforeCommitCheck?.();
  await requireArtifactUploadLeafAbsent(session);
  if (observeInterruption()) {
    diagnosticsRetained = false;
    await resetUploadStaging(session);
    expectedFiles.length = 0;
    receipt = await stageSanitizedPayload();
    await requireArtifactUploadLeafAbsent(session);
  }
  // Signals observed after this synchronous check belong to the caller after
  // terminal publication has begun. The immutable rename remains uninterruptible.
  await commitArtifactUploadSession(session);
  return { failure, receipt };
  });
}

type MatrixCampaignTerminalStatus = DirectBombadilMatrixCampaignStatus;
type MatrixCampaignReceiptEntry = DirectBombadilMatrixCampaignReceiptEntry;

interface MatrixSanitizedChild {
  readonly campaignId: string;
  readonly payload: SanitizedRunUploadPayload;
}

async function publishMatrixUpload(options: {
  readonly abortSignal?: AbortSignal;
  readonly beforeCommitCheck?: (() => Promise<void> | void) | undefined;
  readonly campaigns: readonly MatrixCampaignReceiptEntry[];
  readonly children: readonly MatrixSanitizedChild[];
  readonly completedAt: Date;
  readonly failure: unknown;
  readonly failureCode?: DirectBombadilArtifactFailureCode;
  readonly interruptedSignal?: () => ProcessInterruptSignal | null;
  readonly omittedCampaignCount?: number;
  readonly session: AtomicArtifactUploadSession;
}): Promise<{ readonly failure: unknown }> {
  const uploadMode = options.session.mode;
  if (uploadMode !== "public-summary") {
    throw new BombadilArtifactPolicyError("Bombadil matrix upload session must be public-summary");
  }
  let failure = options.failure;
  let failureCode = failure === null
    ? null
    : options.failureCode ?? artifactFailureCode(failure);
  let status: "failed" | "passed" = failure === null ? "passed" : "failed";
  const observeInterruption = (): boolean => {
    if (failure !== null || options.abortSignal?.aborted !== true) return false;
    const signal = options.interruptedSignal?.() ?? null;
    failure = new Error(
      signal === null
        ? "Bombadil matrix was interrupted"
        : `Bombadil matrix was interrupted by ${signal}`,
    );
    failureCode = "interrupted";
    status = "failed";
    return true;
  };
  observeInterruption();
  return await withOwnedUploadStaging(options.session, async () => {
  const counts = new Map<MatrixCampaignTerminalStatus, number>();
  for (const campaign of options.campaigns) {
    counts.set(campaign.status, (counts.get(campaign.status) ?? 0) + 1);
  }
  const expectedFiles: ExpectedUploadFile[] = [];
  const stageMatrixPayload = async (): Promise<void> => {
    const receipt: DirectBombadilMatrixReceipt = Object.freeze({
      schema: MATRIX_RECEIPT_SCHEMA,
      completedAt: options.completedAt.toISOString(),
      failureCode,
      mode: uploadMode,
      runId: options.session.runId,
      status,
      omittedCampaignCount: options.omittedCampaignCount ?? 0,
      campaigns: Object.freeze(options.campaigns.map((campaign) => Object.freeze(campaign))),
    });
    const summary: DirectBombadilMatrixSummary = Object.freeze({
      schema: MATRIX_SUMMARY_SCHEMA,
      failureCode,
      status,
      campaigns: Object.freeze({
        failed: counts.get("failed") ?? 0,
        notRun: counts.get("not-run") ?? 0,
        notSelected: counts.get("not-selected") ?? 0,
        passed: counts.get("passed") ?? 0,
        rejected: counts.get("rejected") ?? 0,
        total: options.campaigns.length,
        omitted: options.omittedCampaignCount ?? 0,
      }),
    });
    for (const child of options.children) {
      expectedFiles.push(
        await writeExpectedJson(
          options.session.stagingDirectory,
          `campaigns/${child.campaignId}/summary.json`,
          child.payload.summary,
        ),
        await writeExpectedJson(
          options.session.stagingDirectory,
          `campaigns/${child.campaignId}/receipt.json`,
          child.payload.receipt,
        ),
      );
    }
    expectedFiles.push(
      await writeExpectedJson(options.session.stagingDirectory, "summary.json", summary),
      await writeExpectedJson(options.session.stagingDirectory, "receipt.json", receipt),
    );
    await validateExpectedUploadTree(options.session.stagingDirectory, expectedFiles);
  };
  await stageMatrixPayload();
  await options.beforeCommitCheck?.();
  await requireArtifactUploadLeafAbsent(options.session);
  if (observeInterruption()) {
    await resetUploadStaging(options.session);
    expectedFiles.length = 0;
    await stageMatrixPayload();
    await requireArtifactUploadLeafAbsent(options.session);
  }
  // The atomic rename is the matrix terminal-publication boundary.
  await commitArtifactUploadSession(options.session);
  return { failure };
  });
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

interface ParsedTraceEnvelope {
  readonly action: unknown;
  readonly snapshots: readonly unknown[];
  readonly state: unknown;
  readonly timestamp: number;
  readonly violations: readonly unknown[];
}

interface ParsedDirectTraceObservation {
  readonly observation: TraceDirectObservation;
  readonly value: unknown;
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

function canonicalJson(
  value: unknown,
  depth = 0,
  maximumDepth = TRACE_MAX_JSON_DEPTH,
): string {
  if (depth > maximumDepth) {
    throw new Error(`Bombadil named snapshot exceeds JSON depth ${String(maximumDepth)}`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Bombadil named snapshot has a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1, maximumDepth)).join(",")}]`;
  }
  if (!isRecord(value)) throw new Error("Bombadil named snapshot is not JSON");
  const entries = Object.keys(value).sort(compareCodeUnits).map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1, maximumDepth)}`
  );
  return `{${entries.join(",")}}`;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function namedSnapshotValueSha256(
  value: unknown,
  options: {
    readonly maximumBytes?: number;
    readonly maximumDepth?: number;
  } = {},
): string {
  const maximumBytes = options.maximumBytes ?? TRACE_MAX_CANONICAL_SNAPSHOT_BYTES;
  const canonical = canonicalJson(
    value,
    0,
    options.maximumDepth ?? TRACE_MAX_JSON_DEPTH,
  );
  if (Buffer.byteLength(canonical, "utf8") > maximumBytes) {
    throw new Error(
      `Bombadil named snapshot exceeds ${String(maximumBytes)} canonical bytes`,
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

function parseTraceEnvelope(line: string, lineNumber: number): ParsedTraceEnvelope {
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
  return {
    action: input.action,
    snapshots: input.snapshots as unknown[],
    state: input.state,
    timestamp: input.timestamp,
    violations: input.violations,
  };
}

function parseDirectTraceObservation(
  envelope: ParsedTraceEnvelope,
  lineNumber: number,
): ParsedDirectTraceObservation {
  const directSnapshots = envelope.snapshots.filter(
    (snapshot): snapshot is Readonly<Record<string, unknown>> =>
      isRecord(snapshot) && snapshot.name === "direct",
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
  return {
    observation: parseTraceDirectObservation(snapshot.value),
    value: snapshot.value,
  };
}

function parseDirectTraceLine(line: string, lineNumber: number): TraceDirectObservation {
  return parseDirectTraceObservation(parseTraceEnvelope(line, lineNumber), lineNumber).observation;
}

function parseTraceLine(
  line: string,
  lineNumber: number,
  strictDiagnosticSnapshotNames: ReadonlySet<string>,
): ParsedTraceLine {
  const envelope = parseTraceEnvelope(line, lineNumber);
  const state = parseTraceState(envelope.state, lineNumber);
  const action = parseTraceAction(envelope.action, lineNumber);
  const snapshots = envelope.snapshots;
  const direct = parseDirectTraceObservation(envelope, lineNumber);
  const namedSnapshots: Array<{ readonly name: string; readonly valueSha256: string }> = [{
    name: "direct",
    valueSha256: namedSnapshotValueSha256(direct.value, {
      maximumBytes: TRACE_MAX_LINE_BYTES,
      maximumDepth: TRACE_MAX_JSON_DEPTH + 4,
    }),
  }];
  const diagnosticSnapshotValues = new Map<string, unknown[]>();
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
    if (snapshotValue.name === null || snapshotValue.name === "direct") continue;
    let name: string;
    try {
      name = validateSnapshotName(
        snapshotValue.name,
        `Bombadil trace line ${String(lineNumber)} snapshot name`,
      );
    } catch (error) {
      if (strictDiagnosticSnapshotNames.has(snapshotValue.name)) throw error;
      continue;
    }
    const values = diagnosticSnapshotValues.get(name) ?? [];
    values.push(snapshotValue.value);
    diagnosticSnapshotValues.set(name, values);
  }
  for (const [name, values] of diagnosticSnapshotValues) {
    if (values.length !== 1) {
      if (strictDiagnosticSnapshotNames.has(name)) {
        throw new Error(`Bombadil trace line ${String(lineNumber)} repeats named snapshot ${name}`);
      }
      continue;
    }
    try {
      namedSnapshots.push({
        name,
        valueSha256: namedSnapshotValueSha256(values[0]),
      });
    } catch (error) {
      if (strictDiagnosticSnapshotNames.has(name)) throw error;
    }
  }
  const propertyViolationNames: string[] = [];
  for (const violation of envelope.violations) {
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
    directObservation: direct.observation,
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
  const traceBytes = await readBoundRegularFileBytes({
    label: "Bombadil trace.jsonl",
    maximumBytes: TRACE_MAX_BYTES,
    path: options.tracePath,
  });
  return attestDirectBombadilTraceBytes({ ...options, traceBytes });
}

function attestDirectBombadilTraceBytes(options: {
  readonly expectedRoute: string;
  readonly expectedScenario: string;
  readonly traceBytes: Uint8Array;
}): DirectBombadilTraceAttestation {
  const lines = decodeTraceLines(options.traceBytes);
  let observationCount = 0;
  let invalidObservationCount = 0;
  let validObservationCount = 0;
  let initial: DirectBombadilTraceBinding | null = null;
  let final: ExactTraceDirectObservation | null = null;
  let finalWasInvalid = false;
  for (const line of lines) {
      observationCount += 1;
      if (observationCount > TRACE_MAX_LINES) {
        throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_LINES)} lines`);
      }
      if (Buffer.byteLength(line, "utf8") > TRACE_MAX_LINE_BYTES) {
        throw new Error(`Bombadil trace line ${String(observationCount)} is too large`);
      }
      const observation = parseDirectTraceLine(line, observationCount);
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
  const traceBytes = await readBoundRegularFileBytes({
    label: "Bombadil trace.jsonl",
    maximumBytes: TRACE_MAX_BYTES,
    path: options.tracePath,
  });
  return summarizeDirectBombadilTraceBytes({ ...options, traceBytes });
}

function summarizeDirectBombadilTraceBytes(options: {
  readonly explorationPolicy?: DirectBombadilExplorationPolicy;
  readonly targetUrl: string;
  readonly traceBytes: Uint8Array;
}): DirectBombadilExplorationSummary {
  let targetUrl: URL;
  try {
    targetUrl = new URL(options.targetUrl);
  } catch {
    throw new Error("targetUrl must be an absolute URL");
  }
  const policy = validateExplorationPolicy(options.explorationPolicy);
  const strictDiagnosticSnapshotNames = explorationPolicySnapshotNames(policy);
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
  let trackedUnrelatedSnapshotNameCount = 0;
  const unrelatedSnapshotNameLimit = Math.max(
    0,
    TRACE_MAX_NAMED_SNAPSHOT_NAMES - strictDiagnosticSnapshotNames.size,
  );
  const lines = decodeTraceLines(options.traceBytes);
  for (const line of lines) {
      lineCount += 1;
      if (lineCount > TRACE_MAX_LINES) {
        throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_LINES)} lines`);
      }
      if (Buffer.byteLength(line, "utf8") > TRACE_MAX_LINE_BYTES) {
        throw new Error(`Bombadil trace line ${String(lineCount)} is too large`);
      }
      const parsed = parseTraceLine(line, lineCount, strictDiagnosticSnapshotNames);
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
          const isStrictSnapshot = snapshot.name === "direct"
            || strictDiagnosticSnapshotNames.has(snapshot.name);
          if (!isStrictSnapshot && trackedUnrelatedSnapshotNameCount >= unrelatedSnapshotNameLimit) {
            continue;
          }
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
          if (!isStrictSnapshot) trackedUnrelatedSnapshotNameCount += 1;
        }
        if (
          !entry.values.has(snapshot.valueSha256)
          && entry.values.size >= TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME
        ) {
          if (
            snapshot.name === "direct"
            || strictDiagnosticSnapshotNames.has(snapshot.name)
          ) {
            throw new Error(
              `Bombadil trace named snapshot ${snapshot.name} exceeds ${String(TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME)} distinct values`,
            );
          }
          continue;
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
      }
      previousObservationWasExact = true;
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
  return Object.freeze({
    schema: "direct.bombadil-exploration-summary/v2",
    trace: Object.freeze({
      bytes: options.traceBytes.byteLength,
      lineCount,
      sha256: sha256(options.traceBytes),
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

function explorationPolicySnapshotNames(
  policy: ValidatedExplorationPolicy | null,
): ReadonlySet<string> {
  const names = new Set<string>(["direct"]);
  if (policy === null) return names;
  for (const name of policy.requiredNamedSnapshots) names.add(name);
  for (const name of Object.keys(policy.minDistinctNamedSnapshotValues)) names.add(name);
  for (const name of Object.keys(policy.minNamedSnapshotChangesAfterNonWait)) names.add(name);
  for (const name of Object.keys(policy.minNamedSnapshotChangesAfterActionKind)) names.add(name);
  return names;
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
  const validated: ValidatedExplorationPolicy = Object.freeze({
    minDistinctNamedSnapshotValues,
    minNamedSnapshotChangesAfterActionKind,
    minNamedSnapshotChangesAfterNonWait,
    minNonWaitActions,
    requireStableTargetUrl,
    requiredActionKinds: Object.freeze(requiredActionKinds),
    requiredNamedSnapshots: Object.freeze(requiredNamedSnapshots),
  });
  if (explorationPolicySnapshotNames(validated).size > TRACE_MAX_NAMED_SNAPSHOT_NAMES) {
    throw new Error(
      `explorationPolicy may reference at most ${String(TRACE_MAX_NAMED_SNAPSHOT_NAMES - 1)} distinct non-Direct snapshots`,
    );
  }
  return validated;
}

export function validateDirectBombadilFuzzConfig(
  config: DirectBombadilFuzzConfig,
  baseUrlOverride?: string,
): ValidatedConfig {
  const repositoryRoot = resolve(config.repositoryRoot);
  if (!isAbsolute(config.repositoryRoot) || repositoryRoot !== config.repositoryRoot) {
    throw new Error("repositoryRoot must be an absolute normalized path");
  }
  if (!isBoundedArtifactIdentifier(config.artifactName)) {
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
    !isBoundedScenarioIdentifier(config.scenario)
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
  const artifactPolicy = validateArtifactPolicy(config.artifactPolicy);
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
    artifactPolicy,
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
  signal: "SIGKILL",
): void {
  try {
    process.kill(-process_.pid, signal);
    return;
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") throw error;
    if (process_.exitCode === null) process_.kill(signal);
  }
}

function processGroupMayExist(processId: number): boolean {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") return false;
    // EPERM does not prove absence. Keep polling the already-killed group;
    // settlement must never authorize a second signal from a failed probe.
    if (isRecord(error) && error.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(
  processId: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupMayExist(processId)) {
    if (Date.now() >= deadline) {
      throw new Error(`Bombadil process group ${String(processId)} survived cleanup`);
    }
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

async function waitForBombadilLeaderExit(
  process_: ReturnType<typeof Bun.spawn>,
  timeoutMs: number,
): Promise<void> {
  if (process_.exitCode !== null) return;
  const exited = await Promise.race([
    process_.exited.then(() => true),
    Bun.sleep(timeoutMs).then(() => false),
  ]);
  if (!exited && process_.exitCode === null) {
    throw new Error(`Bombadil process ${String(process_.pid)} survived cleanup`);
  }
}

async function settleBombadilProcessGroup(options: {
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly timeoutMs: number;
}): Promise<void> {
  try {
    signalProcessGroup(options.process, "SIGKILL");
    await waitForBombadilLeaderExit(options.process, options.timeoutMs);
    await waitForProcessGroupExit(options.process.pid, options.timeoutMs);
  } catch (error) {
    throw new BombadilWriterSettlementError(
      `Bombadil process group ${String(options.process.pid)} did not settle safely`,
      error,
    );
  }
}

async function establishCleanBombadilArtifactBaseline(options: {
  readonly beforeInspect?: () => Promise<void> | void;
  readonly outputPath: string;
  readonly policy: ValidatedArtifactPolicy;
}): Promise<void> {
  let baseline: ArtifactInventory;
  try {
    await options.beforeInspect?.();
    baseline = await scanBombadilArtifactTree({
      hashFiles: false,
      policy: options.policy,
      root: options.outputPath,
      rootMayBeAbsent: true,
    });
  } catch (error) {
    throw new BombadilArtifactPolicyError(
      `Bombadil output must be absent or empty before the live artifact epoch: ${renderUnknown(error)}`,
    );
  }
  if (baseline.entryCount !== 0) {
    throw new BombadilArtifactPolicyError(
      "Bombadil output must be absent or empty before the live artifact epoch",
    );
  }
}

async function monitorBombadilArtifactTree(options: {
  readonly abortSignal: AbortSignal;
  readonly outputPath: string;
  readonly policy: ValidatedArtifactPolicy;
}): Promise<void> {
  let provenance: ReadonlyMap<string, LiveChromeDownloadIdentity> = new Map();
  while (!options.abortSignal.aborted) {
    try {
      provenance = await scanLiveBombadilArtifactTree({
        abortSignal: options.abortSignal,
        cleanBaselineEstablished: true,
        outputPath: options.outputPath,
        policy: options.policy,
        previous: provenance,
      });
    } catch (error) {
      if (
        error instanceof LiveChromeDownloadRenameRetry
        || (isRecord(error) && error.code === "ENOENT")
      ) {
        // A live producer may atomically replace or remove an entry. The final
        // stopped-process scan is authoritative; polling only bounds growth.
      } else {
        throw error instanceof BombadilArtifactPolicyError
          ? error
          : new BombadilArtifactPolicyError("Bombadil artifact monitor could not inspect output");
      }
    }
    await Bun.sleep(ARTIFACT_MONITOR_INTERVAL_MS);
  }
}

function abortedBombadilProcessResult(): BombadilProcessResult {
  return {
    exitCode: 137,
    stderr: "",
    stdout: "",
    termination: "aborted",
  };
}

async function runBombadilNativeProcessInternal(
  invocation: DirectBombadilInvocation,
  hooks: Readonly<{
    beforeArtifactBaselineInspect?: () => Promise<void> | void;
  }> = {},
): Promise<BombadilProcessResult> {
  const artifactPolicy = validateArtifactPolicy(invocation.artifactPolicy);
  if (invocation.abortSignal?.aborted === true) {
    return abortedBombadilProcessResult();
  }
  await establishCleanBombadilArtifactBaseline({
    ...(hooks.beforeArtifactBaselineInspect === undefined
      ? {}
      : { beforeInspect: hooks.beforeArtifactBaselineInspect }),
    outputPath: invocation.outputPath,
    policy: artifactPolicy,
  });
  if (invocation.abortSignal?.aborted === true) {
    return abortedBombadilProcessResult();
  }
  const childEnvironment: Record<string, string | undefined> = Object.fromEntries(
    Object.entries({
      ...process.env,
      NO_COLOR: "1",
    }).filter(([name]) => name !== ARTIFACT_COORDINATION_ENVIRONMENT),
  );
  const process_ = Bun.spawn([...invocation.command], {
    cwd: invocation.cwd,
    detached: true,
    env: childEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const monitorAbortController = new AbortController();
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
    const artifactMonitor = monitorBombadilArtifactTree({
      abortSignal: monitorAbortController.signal,
      outputPath: invocation.outputPath,
      policy: artifactPolicy,
    }).then(
      () => ({ kind: "monitor-stopped" as const }),
      (error: unknown) => ({ kind: "artifact-policy" as const, error }),
    );
    const outcome = await Promise.race([
      process_.exited.then((exitCode) => ({ kind: "exited" as const, exitCode })),
      timeoutPromise.then(() => ({ kind: "timeout" as const })),
      abortPromise.then(() => ({ kind: "aborted" as const })),
      artifactMonitor,
    ]);
    if (outcome.kind === "monitor-stopped") {
      throw new BombadilArtifactPolicyError("Bombadil artifact monitor stopped unexpectedly");
    }
    const terminationGraceMs = invocation.terminationGraceMs
      ?? PROCESS_TERMINATION_GRACE_MS;
    try {
      await settleBombadilProcessGroup({
        process: process_,
        timeoutMs: terminationGraceMs,
      });
    } catch (error) {
      stdoutCapture.stop();
      stderrCapture.stop();
      throw error;
    }
    let finalArtifactFailure: unknown = null;
    try {
      await scanBombadilArtifactTree({
        hashFiles: false,
        policy: artifactPolicy,
        root: invocation.outputPath,
        rootMayBeAbsent: true,
      });
    } catch (error) {
      finalArtifactFailure = error instanceof BombadilArtifactPolicyError
        ? error
        : new BombadilArtifactPolicyError(
            `Bombadil final artifact inventory could not be proven safe: ${renderUnknown(error)}`,
          );
    }
    monitorAbortController.abort();
    const finalMonitorOutcome = await artifactMonitor;
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
    if (outcome.kind === "artifact-policy") {
      throw outcome.error instanceof BombadilArtifactPolicyError
        ? outcome.error
        : new BombadilArtifactPolicyError("Bombadil artifact policy was violated");
    }
    if (finalMonitorOutcome.kind === "artifact-policy") {
      throw finalMonitorOutcome.error instanceof BombadilArtifactPolicyError
        ? finalMonitorOutcome.error
        : new BombadilArtifactPolicyError("Bombadil artifact policy was violated");
    }
    if (finalArtifactFailure !== null) {
      throw finalArtifactFailure instanceof BombadilArtifactPolicyError
        ? finalArtifactFailure
        : new BombadilArtifactPolicyError("Bombadil artifact policy was violated");
    }
    return {
      exitCode: outcome.kind === "exited" ? outcome.exitCode : process_.exitCode ?? 137,
      stderr,
      stdout,
      termination: outcome.kind === "exited" ? null : outcome.kind,
    };
  } finally {
    monitorAbortController.abort();
    if (timeout !== undefined) clearTimeout(timeout);
    if (abortListener !== undefined) {
      invocation.abortSignal?.removeEventListener("abort", abortListener);
    }
  }
}

export async function runBombadilNativeProcess(
  invocation: DirectBombadilInvocation,
): Promise<BombadilProcessResult> {
  return await runBombadilNativeProcessInternal(invocation);
}

/** @internal Exercise cancellation while the pre-spawn artifact baseline is pending. */
export async function runBombadilNativeProcessForTest(
  invocation: DirectBombadilInvocation,
  hooks: Readonly<{
    beforeArtifactBaselineInspect: () => Promise<void> | void;
  }>,
): Promise<BombadilProcessResult> {
  return await runBombadilNativeProcessInternal(invocation, hooks);
}

const processEvents: EventEmitter = process;

const defaultDependencies: DirectBombadilRunnerDependencies = {
  acquireServer: acquireVerificationServer,
  createAbortController: () => new AbortController(),
  createRunId: randomUUID,
  now: () => new Date(),
  runBombadil: runBombadilNativeProcess,
  signalController: {
    forward: (signal) => process.kill(process.pid, signal),
    once: (signal, listener) => processEvents.once(signal, listener),
    removeListener: (signal, listener) => processEvents.removeListener(signal, listener),
  },
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
  if (campaigns.length === 0 || campaigns.length > MAX_MATRIX_CAMPAIGNS) {
    throw new Error(
      `Bombadil campaign matrix must contain 1-${String(MAX_MATRIX_CAMPAIGNS)} campaigns`,
    );
  }
  const ids = new Set<string>();
  for (const campaign of campaigns) {
    if (!isBoundedArtifactIdentifier(campaign.id) || ids.has(campaign.id)) {
      throw new Error("Bombadil campaign IDs must be unique lowercase kebab identifiers");
    }
    ids.add(campaign.id);
  }
  return campaigns;
}

/** Runs a bounded product-owned campaign matrix serially. */
export async function runDirectBombadilFuzzMatrix(
  campaignsInput: readonly DirectBombadilFuzzCampaign[],
  input: DirectBombadilMatrixRunInput = process.argv.slice(2),
  dependencyOverrides: Partial<DirectBombadilRunnerDependencies> = {},
): Promise<DirectBombadilFuzzMatrixExecutionResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const normalizedOptions = normalizeFuzzRunOptions(input);
  if (normalizedOptions.arguments.some((argument) => argument === "--help" || argument === "-h")) {
    const campaigns = validateCampaignMatrix(campaignsInput);
    parseMatrixCampaignArgument(normalizedOptions.arguments);
    process.stdout.write(`${[
      helpText(campaigns[0]?.config.baseUrl ?? ""),
      "  --campaign <id>   Run one campaign; required with --replay",
      "",
      `Campaigns: ${campaigns.map((campaign) => campaign.id).join(", ")}`,
    ].join("\n")}\n`);
    return { kind: "help" };
  }
  const matrixAbortController = dependencies.createAbortController?.() ?? new AbortController();
  let interruptedSignal: ProcessInterruptSignal | null = null;
  const interrupt = (signal: ProcessInterruptSignal): void => {
    interruptedSignal ??= signal;
    matrixAbortController.abort();
  };
  const processSignals = dependencies.signalController;
  for (const signal of PROCESS_INTERRUPT_SIGNALS) processSignals.once(signal, interrupt);
  const releaseSignalHandlers = (): void => {
    for (const signal of PROCESS_INTERRUPT_SIGNALS) {
      processSignals.removeListener(signal, interrupt);
    }
  };
  let invalidMatrixUploadMode: boolean;
  let matrixPlan: DirectBombadilArtifactRunPlan;
  let uploadSession: AtomicArtifactUploadSession;
  try {
    const firstRepositoryRoot = campaignsInput[0]?.config.repositoryRoot;
    if (normalizedOptions.artifactRun === null && firstRepositoryRoot === undefined) {
      throw new Error(
        `Bombadil campaign matrix must contain 1-${String(MAX_MATRIX_CAMPAIGNS)} campaigns`,
      );
    }
    const requestedMatrixPlan = normalizedOptions.artifactRun ?? {
      repositoryRoot: await realpath(resolve(firstRepositoryRoot ?? "")),
      runId: dependencies.createRunId(),
      uploadMode: "public-summary" as const,
    };
    const requestedMatrixUploadMode = (
      requestedMatrixPlan as { readonly uploadMode?: unknown }
    ).uploadMode ?? "public-summary";
    invalidMatrixUploadMode = requestedMatrixUploadMode !== "public-summary";
    matrixPlan = {
      repositoryRoot: requestedMatrixPlan.repositoryRoot,
      runId: requestedMatrixPlan.runId,
      uploadMode: "public-summary",
    };
    uploadSession = await prepareArtifactUploadSession(matrixPlan);
  } catch (error) {
    releaseSignalHandlers();
    const signalToForward = interruptedSignal as ProcessInterruptSignal | null;
    if (signalToForward !== null) processSignals.forward(signalToForward);
    throw error;
  }
  try {
    let campaigns: readonly DirectBombadilFuzzCampaign[];
    let parsed: ReturnType<typeof parseMatrixCampaignArgument>;
    let selected: readonly DirectBombadilFuzzCampaign[];
    try {
      if (invalidMatrixUploadMode) {
        throw new Error("Bombadil matrices support public-summary uploads only");
      }
      campaigns = validateCampaignMatrix(campaignsInput);
      parsed = parseMatrixCampaignArgument(normalizedOptions.arguments);
      selected = parsed.campaignId === null
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
      for (const campaign of selected) {
        if (interruptedSignal !== null) throw new Error("Bombadil matrix was interrupted");
        const campaignArguments = parseDirectBombadilFuzzArguments(
          parsed.arguments,
          campaign.config.baseUrl,
        );
        if (campaignArguments.kind !== "run") {
          throw new Error("Bombadil matrix campaign unexpectedly entered help mode");
        }
        const lexicalConfig = validateDirectBombadilFuzzConfig(
          campaign.config,
          campaignArguments.baseUrl,
        );
        const resolvedPaths = await resolveDirectBombadilRealPaths(
          lexicalConfig,
          resolveReplayPath(lexicalConfig.repositoryRoot, campaignArguments.replayPath),
        );
        if (resolvedPaths.config.repositoryRoot !== matrixPlan.repositoryRoot) {
          throw new BombadilArtifactPolicyError(
            "Every Bombadil matrix campaign must share artifactRun.repositoryRoot",
          );
        }
      }
    } catch (error) {
      const boundedCampaigns = campaignsInput.slice(0, MAX_MATRIX_CAMPAIGNS);
      const retainedCampaignIds = new Set<string>();
      const entries = boundedCampaigns.map((campaign, index): MatrixCampaignReceiptEntry => {
        const boundedCampaignId = isBoundedArtifactIdentifier(campaign.id) ? campaign.id : null;
        const campaignId = boundedCampaignId !== null && !retainedCampaignIds.has(boundedCampaignId)
          ? boundedCampaignId
          : null;
        if (campaignId !== null) retainedCampaignIds.add(campaignId);
        return {
          campaignId,
          index,
          receipt: null,
          status: "rejected",
        };
      });
      return await publishFailureAndThrow(error, async () => {
        await publishMatrixUpload({
          abortSignal: matrixAbortController.signal,
          beforeCommitCheck: dependencies.beforeArtifactCommit,
          campaigns: entries,
          children: [],
          completedAt: dependencies.now(),
          failure: error,
          failureCode: interruptedSignal === null ? "configuration-rejected" : "interrupted",
          interruptedSignal: () => interruptedSignal,
          omittedCampaignCount: Math.max(0, campaignsInput.length - entries.length),
          session: uploadSession,
        });
      });
    }

    const results: Array<{
      readonly campaignId: string;
      readonly result: Extract<DirectBombadilFuzzExecutionResult, { readonly kind: "run" }>;
    }> = [];
    const entries: MatrixCampaignReceiptEntry[] = campaigns.map((campaign, index) => ({
      campaignId: campaign.id,
      index,
      receipt: null,
      status: selected.includes(campaign) ? "not-run" : "not-selected",
    }));
    const children: MatrixSanitizedChild[] = [];
    let executionFailure: unknown = null;
    let executionFailureCode: DirectBombadilArtifactFailureCode | undefined;
    for (const campaign of selected) {
      if (interruptedSignal !== null) {
        executionFailure = new Error("Bombadil matrix was interrupted");
        break;
      }
      const campaignIndex = campaigns.indexOf(campaign);
      const deferredPayload = { value: null as SanitizedRunUploadPayload | null };
      const childSession: DeferredArtifactUploadSession = {
        deferredPayload,
        finalDirectory: join(uploadSession.finalDirectory, "campaigns", campaign.id),
        mode: uploadSession.mode,
        publication: "deferred",
        receiptPath: join(
          uploadSession.finalDirectory,
          "campaigns",
          campaign.id,
          "receipt.json",
        ),
        runId: uploadSession.runId,
      };
      try {
        const result = await runDirectBombadilFuzzInternal(
          campaign.config,
          parsed.arguments,
          dependencyOverrides,
          {
            abortSignal: matrixAbortController.signal,
            forwardSignal: false,
            interruptedSignal: () => interruptedSignal,
            plan: matrixPlan,
            session: childSession,
          },
        );
        if (result.kind !== "run" || deferredPayload.value === null) {
          throw new Error("Bombadil campaign did not finalize its sanitized receipt");
        }
        children.push({ campaignId: campaign.id, payload: deferredPayload.value });
        results.push({ campaignId: campaign.id, result });
        entries[campaignIndex] = {
          campaignId: campaign.id,
          index: campaignIndex,
          receipt: `campaigns/${campaign.id}/receipt.json`,
          status: "passed",
        };
      } catch (error) {
        executionFailure = error;
        const childPayload = deferredPayload.value;
        if (childPayload !== null) {
          children.push({ campaignId: campaign.id, payload: childPayload });
          executionFailureCode = childPayload.receipt.failureCode ?? undefined;
        }
        entries[campaignIndex] = {
          campaignId: campaign.id,
          index: campaignIndex,
          receipt: childPayload === null
            ? null
            : `campaigns/${campaign.id}/receipt.json`,
          status: childPayload?.receipt.status === "rejected" ? "rejected" : "failed",
        };
        break;
      }
    }
    if (executionFailure === null && interruptedSignal !== null) {
      executionFailure = new Error("Bombadil matrix was interrupted");
      executionFailureCode = "interrupted";
    }
    if (executionFailure !== null) {
      await publishFailureAndThrow(executionFailure, async () => {
        await publishMatrixUpload({
          abortSignal: matrixAbortController.signal,
          beforeCommitCheck: dependencies.beforeArtifactCommit,
          campaigns: entries,
          children,
          completedAt: dependencies.now(),
          failure: executionFailure,
          ...(executionFailureCode === undefined ? {} : { failureCode: executionFailureCode }),
          interruptedSignal: () => interruptedSignal,
          session: uploadSession,
        });
      });
    }
    const published = await publishMatrixUpload({
      abortSignal: matrixAbortController.signal,
      beforeCommitCheck: dependencies.beforeArtifactCommit,
      campaigns: entries,
      children,
      completedAt: dependencies.now(),
      failure: null,
      interruptedSignal: () => interruptedSignal,
      session: uploadSession,
    });
    if (published.failure !== null) throw failureAsError(published.failure);
    return {
      kind: "matrix",
      receiptPath: uploadSession.receiptPath,
      results: Object.freeze(results),
      uploadArtifactPath: uploadSession.finalDirectory,
    };
  } finally {
    releaseSignalHandlers();
    const signalToForward = interruptedSignal as ProcessInterruptSignal | null;
    if (signalToForward !== null) processSignals.forward(signalToForward);
  }
}

function throwIfBombadilRunAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("Bombadil fuzzing was interrupted");
}

function terminateAbortedOwnedServer(
  signal: AbortSignal,
  server: ManagedVerificationServer,
): void {
  if (!signal.aborted) return;
  if (server.exitCode() === null) server.terminate();
  throwIfBombadilRunAborted(signal);
}

/** Runs one bounded diagnostic Bombadil campaign and always releases its server lease. */
async function runDirectBombadilFuzzInternal(
  config: DirectBombadilFuzzConfig,
  input: DirectBombadilFuzzRunInput = process.argv.slice(2),
  dependencyOverrides: Partial<DirectBombadilRunnerDependencies> = {},
  preparedUpload?: Readonly<{
    readonly abortSignal?: AbortSignal;
    readonly forwardSignal?: boolean;
    readonly interruptedSignal?: () => ProcessInterruptSignal | null;
    readonly plan: DirectBombadilArtifactRunPlan;
    readonly session: ArtifactUploadSession;
  }>,
): Promise<DirectBombadilFuzzExecutionResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const normalizedOptions = normalizeFuzzRunOptions(input);
  if (normalizedOptions.arguments.some((argument) => argument === "--help" || argument === "-h")) {
    parseDirectBombadilFuzzArguments(normalizedOptions.arguments, config.baseUrl);
    process.stdout.write(`${helpText(config.baseUrl)}\n`);
    return { kind: "help" };
  }
  const abortController = dependencies.createAbortController?.() ?? new AbortController();
  let interruptedSignal: ProcessInterruptSignal | null = null;
  let ownedServer: ManagedVerificationServer | null = null;
  const interrupt = (signal: ProcessInterruptSignal): void => {
    interruptedSignal ??= signal;
    abortController.abort();
    if (ownedServer?.exitCode() === null) ownedServer.terminate();
  };
  // @types/bun augments Node's process events and has changed this overload
  // across patch releases. Bind the stable signal subset used by this runner.
  const processSignals = dependencies.signalController;
  for (const signal of PROCESS_INTERRUPT_SIGNALS) processSignals.once(signal, interrupt);
  const abortFromPreparedMatrix = (): void => {
    interruptedSignal ??= preparedUpload?.interruptedSignal?.() ?? null;
    abortController.abort();
    if (ownedServer?.exitCode() === null) ownedServer.terminate();
  };
  if (preparedUpload?.abortSignal !== undefined) {
    if (preparedUpload.abortSignal.aborted) abortFromPreparedMatrix();
    else preparedUpload.abortSignal.addEventListener("abort", abortFromPreparedMatrix, { once: true });
  }
  try {
  const generatedAt = dependencies.now();
  const artifactPlan = preparedUpload?.plan ?? normalizedOptions.artifactRun ?? {
    repositoryRoot: await realpath(resolve(config.repositoryRoot)),
    runId: dependencies.createRunId(),
    uploadMode: "public-summary" as const,
  };
  const uploadSession = preparedUpload?.session
    ?? await prepareArtifactUploadSession(artifactPlan);
  let parsed: Extract<DirectBombadilFuzzArguments, { readonly kind: "run" }>;
  let validated: ValidatedConfig;
  let replayPath: string | null;
  try {
    throwIfBombadilRunAborted(abortController.signal);
    const parsedInput = parseDirectBombadilFuzzArguments(
      normalizedOptions.arguments,
      config.baseUrl,
    );
    if (parsedInput.kind !== "run") {
      throw new Error("Bombadil help was not handled before artifact allocation");
    }
    parsed = parsedInput;
    const lexicalConfig = validateDirectBombadilFuzzConfig(config, parsed.baseUrl);
    const lexicalReplayPath = resolveReplayPath(
      lexicalConfig.repositoryRoot,
      parsed.replayPath,
    );
    const resolvedPaths = await resolveDirectBombadilRealPaths(
      lexicalConfig,
      lexicalReplayPath,
    );
    validated = resolvedPaths.config;
    replayPath = resolvedPaths.replayPath;
    throwIfBombadilRunAborted(abortController.signal);
    if (validated.repositoryRoot !== resolve(artifactPlan.repositoryRoot)) {
      throw new BombadilArtifactPolicyError(
        "artifactRun.repositoryRoot must equal the campaign repositoryRoot",
      );
    }
  } catch (error) {
    const policy = (() => {
      try {
        return validateArtifactPolicy(config.artifactPolicy);
      } catch {
        return validateArtifactPolicy(undefined);
      }
    })();
    return await publishFailureAndThrow(error, async () => {
      await publishRunUpload({
        abortSignal: abortController.signal,
        artifactName: isBoundedArtifactIdentifier(config.artifactName)
          ? config.artifactName
          : "rejected",
        beforeCommitCheck: dependencies.beforeArtifactCommit,
        attestation: null,
        completedAt: dependencies.now(),
        explorationSummary: null,
        failure: error,
        failureCode: abortController.signal.aborted
          ? "interrupted"
          : "configuration-rejected",
        inventory: emptyArtifactInventory(),
        interruptedSignal: () => interruptedSignal,
        localOutputPath: config.repositoryRoot,
        policy,
        privateDiagnosticsAllowed: false,
        processLog: "",
        scenario: isBoundedScenarioIdentifier(config.scenario) ? config.scenario : "rejected",
        serverLog: "",
        session: uploadSession,
        status: abortController.signal.aborted ? "failed" : "rejected",
      });
    });
  }
  let artifactRun: Awaited<ReturnType<typeof createBombadilArtifactRun>>;
  try {
    throwIfBombadilRunAborted(abortController.signal);
    artifactRun = await createBombadilArtifactRun({
      artifactName: validated.artifactName,
      repositoryRoot: validated.repositoryRoot,
      runId: dependencies.createRunId(),
    });
    throwIfBombadilRunAborted(abortController.signal);
  } catch (error) {
    return await publishFailureAndThrow(error, async () => {
      await publishRunUpload({
        abortSignal: abortController.signal,
        artifactName: validated.artifactName,
        beforeCommitCheck: dependencies.beforeArtifactCommit,
        attestation: null,
        completedAt: dependencies.now(),
        explorationSummary: null,
        failure: error,
        inventory: emptyArtifactInventory(),
        interruptedSignal: () => interruptedSignal,
        localOutputPath: validated.repositoryRoot,
        policy: validated.artifactPolicy,
        privateDiagnosticsAllowed: false,
        processLog: "",
        scenario: validated.scenario,
        serverLog: "",
        session: uploadSession,
        status: "failed",
      });
    });
  }
  const outputPath = join(artifactRun.runDirectory, "bombadil");
  const tracePath = join(outputPath, "trace.jsonl");
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
  const abortableInvocation = {
    ...invocation,
    abortSignal: abortController.signal,
    artifactPolicy: validated.artifactPolicy,
  };
  const serverCommand = validated.server.command.map((argument) =>
    argument === "{port}" ? validated.port : argument
  );

  let bombadilVersion: string | null = null;
  let lease: ServerLease | null = null;
  let processResult: BombadilProcessResult | null = null;
  let attestation: DirectBombadilTraceAttestation | null = null;
  let attestationFailure: unknown = null;
  let explorationSummary: DirectBombadilExplorationSummary | null = null;
  let explorationSummaryFailure: unknown = null;
  let artifactInventory = emptyArtifactInventory();
  let artifactInventoryVetted = false;
  let rawTracePath: string | null = null;
  let serverOutput = "";
  let serverOutputFailure: unknown = null;
  let failure: unknown = null;
  let writersSettled = true;
  {
    try {
      await requireRegularFile(validated.bombadilExecutable, "The root Bombadil executable");
      bombadilVersion = await readExactBombadilVersion(validated.repositoryRoot);
      throwIfBombadilRunAborted(abortController.signal);

      try {
        lease = await dependencies.acquireServer({
          abortSignal: abortController.signal,
          baseUrl: validated.baseUrl,
          label: validated.label,
          readinessPath: validated.server.readinessPath,
          reuseExistingLocalServer: false,
          startupTimeoutMs: validated.server.startupTimeoutMs,
          startServer: () => {
            throwIfBombadilRunAborted(abortController.signal);
            ownedServer = dependencies.spawnServer({
              command: serverCommand,
              cwd: validated.server.cwd,
              detachedProcessGroup: true,
              ...(validated.server.env === undefined ? {} : { env: validated.server.env }),
              omitEnvironment: [ARTIFACT_COORDINATION_ENVIRONMENT],
            });
            terminateAbortedOwnedServer(abortController.signal, ownedServer);
            return ownedServer;
          },
        });
      } catch (error) {
        if (abortController.signal.aborted) throwIfBombadilRunAborted(abortController.signal);
        throw error;
      }
      if (abortController.signal.aborted) {
        const acquiredOwnedServer = ownedServer as ManagedVerificationServer | null;
        if (acquiredOwnedServer?.exitCode() === null) acquiredOwnedServer.terminate();
        throwIfBombadilRunAborted(abortController.signal);
      }
      let processFailure: unknown = null;
      try {
        processResult = await dependencies.runBombadil(abortableInvocation);
      } catch (error) {
        processFailure = error;
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
    } catch (error) {
      if (error instanceof BombadilWriterSettlementError) writersSettled = false;
      failure = error;
    }

    const serverToStop = lease?.source === "started" ? lease.server : ownedServer;
    if (serverToStop !== null) {
      try {
        await dependencies.stopServer(serverToStop);
      } catch (error) {
        writersSettled = false;
        failure = new BombadilWriterSettlementError(
          "Bombadil server writers were not proven absent",
          failure === null
            ? error
            : new AggregateError([failure, error], "Bombadil run and server cleanup both failed"),
        );
      }
    }
    const serverAfterRun = ownedServer as ManagedVerificationServer | null;
    if (serverAfterRun !== null && writersSettled) {
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
    if (writersSettled) {
      try {
        try {
          artifactInventory = await scanBombadilArtifactTree({
            hashFiles: true,
            policy: validated.artifactPolicy,
            root: outputPath,
          });
        } catch (error) {
          throw error instanceof BombadilArtifactPolicyError
            ? error
            : new BombadilArtifactPolicyError(
                `Bombadil artifact inventory could not be proven safe: ${renderUnknown(error)}`,
              );
        }
        artifactInventoryVetted = true;
        const trace = artifactInventory.files.find((file) => file.relativePath === "trace.jsonl");
        if (trace === undefined || trace.size === 0) {
          const missingTrace = new BombadilArtifactPolicyError(
            "Bombadil did not produce a retained nonempty trace.jsonl",
          );
          attestationFailure = missingTrace;
          throw missingTrace;
        }
        rawTracePath = tracePath;
        const traceBytes = await readBoundRegularFileBytes({
          expected: trace,
          label: "Bombadil trace.jsonl",
          maximumBytes: TRACE_MAX_BYTES,
          path: tracePath,
        });
        try {
          attestation = attestDirectBombadilTraceBytes({
            expectedRoute: validated.expectedRoute,
            expectedScenario: validated.scenario,
            traceBytes,
          });
        } catch (error) {
          attestationFailure = error;
        }
        try {
          explorationSummary = summarizeDirectBombadilTraceBytes({
            ...(validated.explorationPolicy === null
              ? {}
              : { explorationPolicy: validated.explorationPolicy }),
            targetUrl: invocation.targetUrl,
            traceBytes,
          });
        } catch (error) {
          explorationSummaryFailure = error;
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
        failure ??= error;
      }
    } else {
      artifactInventory = emptyArtifactInventory();
      failure ??= new BombadilWriterSettlementError(
        "Bombadil writers were not proven absent; artifact inspection was suppressed",
        new Error("writer settlement unavailable"),
      );
    }
  }
  const signalAfterRun = interruptedSignal as ProcessInterruptSignal | null;
  if (signalAfterRun !== null && failure === null) {
    failure = new Error(`Bombadil fuzzing was interrupted by ${signalAfterRun}`);
  }

  const logPath = join(artifactRun.runDirectory, "bombadil.log");
  const serverLogPath = join(artifactRun.runDirectory, "server.log");
  const explorationSummaryPath = join(
    artifactRun.runDirectory,
    "exploration-summary.json",
  );
  const log = [processResult?.stdout ?? "", processResult?.stderr ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");
    try {
      await writeExclusiveBytes(
        logPath,
        Buffer.from(`${log}${log.length > 0 ? "\n" : ""}`, "utf8"),
      );
      await writeExclusiveBytes(
        serverLogPath,
        Buffer.from(`${serverOutput}${serverOutput.length > 0 ? "\n" : ""}`, "utf8"),
      );
      if (explorationSummary !== null) {
        await writeJsonAtomically(explorationSummaryPath, explorationSummary);
      }
    } catch (error) {
      const persistence = new BombadilPersistenceError(
        "Bombadil local diagnostic logs could not be persisted",
        [error],
      );
      failure = failure === null
        ? persistence
        : combinePersistenceFailure(failure, persistence);
    }

    let completedAt = dependencies.now();
    const createRecord = (): unknown => ({
      schema: ARTIFACT_SCHEMA,
      evidenceClass: "diagnostic-fuzz",
      artifactName: validated.artifactName,
      label: validated.label,
      status: failure === null ? "passed" : "failed",
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
      artifactPolicy: validated.artifactPolicy,
      artifactInventory: {
        entryCount: artifactInventory.entryCount,
        fileCount: artifactInventory.fileCount,
        inventorySha256: artifactInventory.inventorySha256,
        totalBytes: artifactInventory.totalBytes,
        files: artifactInventory.files.map((file) => ({
          path: file.relativePath,
          sha256: file.sha256,
          size: file.size,
        })),
      },
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
      interruptedSignal: interruptedSignal as ProcessInterruptSignal | null,
      failure: failure === null ? null : renderUnknown(failure),
    });
    const runRecordPath = join(artifactRun.runDirectory, "run.json");
    try {
      await writeJsonAtomically(runRecordPath, createRecord());
    } catch (error) {
      const persistence = new BombadilPersistenceError(
        "Bombadil local run record could not be persisted",
        [error],
      );
      failure = failure === null
        ? persistence
        : combinePersistenceFailure(failure, persistence);
    }

    const failureBeforeUpload = failure;
    const signalBeforeUpload = interruptedSignal as ProcessInterruptSignal | null;
    if (signalBeforeUpload !== null && failure === null) {
      failure = new Error(`Bombadil fuzzing was interrupted by ${signalBeforeUpload}`);
    }
    let published: Awaited<ReturnType<typeof publishRunUpload>>;
    try {
      published = await publishRunUpload({
        abortSignal: abortController.signal,
        artifactName: validated.artifactName,
        beforeCommitCheck: dependencies.beforeArtifactCommit,
        attestation,
        completedAt,
        explorationSummary,
        failure,
        inventory: artifactInventory,
        interruptedSignal: () => interruptedSignal,
        localOutputPath: outputPath,
        policy: validated.artifactPolicy,
        privateDiagnosticsAllowed: writersSettled && artifactInventoryVetted,
        processLog: `${log}${log.length > 0 ? "\n" : ""}`,
        scenario: validated.scenario,
        serverLog: `${serverOutput}${serverOutput.length > 0 ? "\n" : ""}`,
        session: uploadSession,
        status: failure === null ? "passed" : "failed",
      });
    } catch (persistence) {
      if (failure === null) throw persistence;
      throw combinePersistenceFailure(
        failure,
        persistence,
        "sanitized Bombadil receipt publication also failed",
      );
    }
    failure = published.failure;
    completedAt = dependencies.now();
    if (failure !== failureBeforeUpload) {
      await writeJsonAtomically(runRecordPath, createRecord()).catch(() => undefined);
    }
    // The rolling pointer is only a local convenience. The exclusive UUID leaf
    // and its receipt are the authoritative upload identity.
    await writeJsonAtomically(artifactRun.manifestPath, createRecord()).catch(() => undefined);

    const status = failure === null ? "passed" : "failed";
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
      receiptPath: uploadSession.receiptPath,
      status: "passed",
      uploadArtifactPath: uploadSession.finalDirectory,
    };
  } finally {
    preparedUpload?.abortSignal?.removeEventListener("abort", abortFromPreparedMatrix);
    for (const signal of PROCESS_INTERRUPT_SIGNALS) {
      processSignals.removeListener(signal, interrupt);
    }
    const signalToForward = interruptedSignal as ProcessInterruptSignal | null;
    if (signalToForward !== null && preparedUpload?.forwardSignal !== false) {
      processSignals.forward(signalToForward);
    }
  }
}

export async function runDirectBombadilFuzz(
  config: DirectBombadilFuzzConfig,
  input: DirectBombadilFuzzRunInput = process.argv.slice(2),
  dependencyOverrides: Partial<DirectBombadilRunnerDependencies> = {},
): Promise<DirectBombadilFuzzExecutionResult> {
  return await runDirectBombadilFuzzInternal(config, input, dependencyOverrides);
}
