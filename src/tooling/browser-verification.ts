import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, isAbsolute, join } from "node:path";

import {
  captureVerificationOutput,
  copyVerificationOutputSnapshot,
  describeVerificationOutputFailure,
  type VerificationOutputSnapshot,
} from "./verification-output.js";

export type { VerificationOutputSnapshot, VerificationStreamSnapshot } from "./verification-output.js";

const DEFAULT_LOG_LIMIT = 12_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
const DEFAULT_REUSE_PROBE_INTERVAL_MS = 250;
const DEFAULT_STOP_TIMEOUT_MS = 3_000;
const MAX_RENDERED_ERROR_LENGTH = 4_096;
const MAX_ERROR_CAUSE_DEPTH = 8;

const LIGHTPANDA_SEMANTIC_COMMANDS = new Set([
  "back",
  "check",
  "click",
  "dblclick",
  "eval",
  "fill",
  "find",
  "focus",
  "forward",
  "get",
  "hover",
  "is",
  "keyboard",
  "open",
  "press",
  "pushstate",
  "read",
  "reload",
  "select",
  "snapshot",
  "type",
  "uncheck",
  "wait",
]);
const LIGHTPANDA_FORBIDDEN_EXPRESSION = /(?:getComputedStyle|(?:get|set)BoundingClientRect|(?:offset|client)(?:Width|Height|Top|Left)|inner(?:Width|Height)|matchMedia|(?:HTML)?Canvas|WebGL|WebGPU|toDataURL|natural(?:Width|Height)|document\.fonts|@page|\b(?:screenshot|pdf|download)\b)/i;

/**
 * Browser backends supported by the optional host tooling.
 *
 * Chromium remains the default and the authoritative backend for visual,
 * layout, media, and geometry evidence. Lightpanda is intentionally exposed
 * as an explicit opt-in for semantic checks and route crawls.
 */
export type AgentBrowserEngine = "chrome" | "lightpanda";

/**
 * Rejects browser commands that would claim visual, layout, media, or
 * download evidence from Lightpanda. The command-level boundary is
 * deliberately conservative; callers can still use `evaluate` for semantic
 * assertions, but must keep CSS/layout assertions on Chromium.
 */
export function assertLightpandaSemanticCommand(
  arguments_: readonly string[],
): void {
  const command = arguments_[0];
  if (command === undefined || !LIGHTPANDA_SEMANTIC_COMMANDS.has(command)) {
    throw new Error(
      `Lightpanda semantic verification does not support ${JSON.stringify(command ?? "<empty>")}; use Chromium for visual, layout, media, download, or multi-target evidence`,
    );
  }
  if (arguments_.includes("--new-tab")) {
    throw new Error(
      "Lightpanda semantic verification does not support multi-target commands; use Chromium for multi-tab evidence",
    );
  }
  if (command === "read" && arguments_.slice(1).some((argument) => !argument.startsWith("-"))) {
    throw new Error(
      "Lightpanda semantic verification reads the active tab only; use an allowlisted open command for navigation",
    );
  }
  if (command === "get" && ["box", "styles"].includes(arguments_[1] ?? "")) {
    throw new Error(
      "Lightpanda semantic verification does not support box or styles reads; use Chromium for layout and CSS evidence",
    );
  }
}

function assertLightpandaSemanticExpression(expression: string): void {
  if (LIGHTPANDA_FORBIDDEN_EXPRESSION.test(expression)) {
    throw new Error(
      "Lightpanda semantic verification does not support visual, layout, media, or download expressions; use Chromium for that evidence",
    );
  }
}

export type BrowserVerificationArguments =
  | { readonly kind: "help" }
  | { readonly kind: "run"; readonly baseUrl: string };

export interface AgentBrowser {
  readonly close: () => Promise<void>;
  readonly evaluate: (expression: string) => Promise<unknown>;
  readonly readBodyText: () => Promise<string>;
  readonly restart: () => Promise<void>;
  readonly run: (arguments_: readonly string[]) => Promise<unknown>;
}

export interface DirectBrowserManifest {
  readonly active: Readonly<{
    readonly activationHash: string;
    readonly route: string;
    readonly scenario: string;
    readonly source: "scenario" | "fixture";
  }>;
  readonly catalogHash: string;
  readonly coverage: unknown;
  readonly defaultScenario: unknown;
  readonly queries: unknown;
  readonly scenarios: unknown;
}

export interface DirectBrowserProbe {
  readonly activationHash: string;
}

export interface DirectBrowserContract<
  Manifest extends DirectBrowserManifest = DirectBrowserManifest,
  Probe extends DirectBrowserProbe = DirectBrowserProbe,
> {
  readonly manifest: Manifest;
  readonly probe: Probe;
}

export interface DirectBrowserContractExpectation {
  readonly source: "scenario" | "fixture";
  readonly scenario: string;
  readonly route: string;
}

interface DirectBrowserContractEnvelope {
  readonly bridgeSchema: unknown;
  readonly manifest: unknown;
  readonly probe: unknown;
}

type DirectBrowserParserResult<Value> =
  | Readonly<{ readonly ok: true; readonly value: Value }>
  | Readonly<{
    readonly error: Readonly<{ readonly message: string }>;
    readonly ok: false;
  }>;

export interface DirectBrowserProtocol<
  Manifest extends DirectBrowserManifest,
  Probe extends DirectBrowserProbe,
> {
  readonly bridgeSchema: string;
  readonly parseManifest: (input: unknown) => DirectBrowserParserResult<Manifest>;
  readonly parseProbe: (input: unknown) => DirectBrowserParserResult<Probe>;
}

function parseDirectBrowserContractEnvelope(
  input: unknown,
): DirectBrowserContractEnvelope {
  try {
    if (
      typeof input !== "object"
      || input === null
      || Array.isArray(input)
      || Object.keys(input).length !== 3
      || !Object.hasOwn(input, "bridgeSchema")
      || !Object.hasOwn(input, "manifest")
      || !Object.hasOwn(input, "probe")
    ) {
      throw new Error("invalid");
    }
    return {
      bridgeSchema: Reflect.get(input, "bridgeSchema"),
      manifest: Reflect.get(input, "manifest"),
      probe: Reflect.get(input, "probe"),
    };
  } catch {
    throw new Error("Direct browser contract has an invalid envelope");
  }
}

function directCatalogIdentity(manifest: DirectBrowserManifest): string {
  return JSON.stringify({
    queries: manifest.queries,
    defaultScenario: manifest.defaultScenario,
    scenarios: manifest.scenarios,
  });
}

/**
 * Prove that independently loaded scenario pages expose one identical Direct
 * catalog, then return the single coverage snapshot bound to that catalog.
 */
export function bindDirectScenarioCatalog<Manifest extends DirectBrowserManifest>(
  manifests: readonly Manifest[],
): Manifest["coverage"] {
  const baseline = manifests[0];
  if (baseline === undefined) {
    throw new Error("Direct scenario verification requires at least one session manifest");
  }
  const baselineCoverage = JSON.stringify(baseline.coverage);
  const baselineCatalog = directCatalogIdentity(baseline);
  for (const [index, manifest] of manifests.entries()) {
    if (manifest.catalogHash !== baseline.catalogHash) {
      throw new Error(
        `Direct scenario ${String(index)} exposed catalog ${manifest.catalogHash} instead of ${baseline.catalogHash}`,
      );
    }
    if (JSON.stringify(manifest.coverage) !== baselineCoverage) {
      throw new Error(
        `Direct scenario ${String(index)} exposed different coverage for catalog ${baseline.catalogHash}`,
      );
    }
    if (directCatalogIdentity(manifest) !== baselineCatalog) {
      throw new Error(
        `Direct scenario ${String(index)} exposed different public metadata for catalog ${baseline.catalogHash}`,
      );
    }
  }
  return baseline.coverage;
}

/**
 * Bind post-interaction evidence to the exact catalog and activation sampled
 * before the interaction. Probe counters may advance; their session identity
 * may not.
 */
export function bindDirectBrowserContractEvidence<
  Manifest extends DirectBrowserManifest,
  Probe extends DirectBrowserProbe,
>(
  initial: DirectBrowserContract<Manifest, Probe>,
  final: DirectBrowserContract<Manifest, Probe>,
  retainedProbe: DirectBrowserProbe = final.probe,
): DirectBrowserContract<Manifest, Probe> {
  if (directCatalogIdentity(final.manifest) !== directCatalogIdentity(initial.manifest)) {
    throw new Error("Direct public catalog metadata changed during verification");
  }
  if (JSON.stringify(final.manifest.coverage) !== JSON.stringify(initial.manifest.coverage)) {
    throw new Error("Direct coverage changed during verification");
  }
  if (final.manifest.catalogHash !== initial.manifest.catalogHash) {
    throw new Error("Direct catalog hash changed during verification");
  }
  if (JSON.stringify(final.manifest.active) !== JSON.stringify(initial.manifest.active)) {
    throw new Error("Direct activation identity changed during verification");
  }
  if (
    initial.probe.activationHash !== initial.manifest.active.activationHash
    || final.probe.activationHash !== final.manifest.active.activationHash
    || retainedProbe.activationHash !== final.manifest.active.activationHash
  ) {
    throw new Error("Direct probe identity changed during verification");
  }
  return final;
}

/**
 * Read one atomic Direct bridge sample and bind its exact manifest, active
 * scenario, product route, and probe identity before product assertions run.
 */
export function createDirectBrowserContractReader<
  Manifest extends DirectBrowserManifest,
  Probe extends DirectBrowserProbe,
>(
  protocol: DirectBrowserProtocol<Manifest, Probe>,
): (
  browser: Pick<AgentBrowser, "evaluate">,
  expectation: DirectBrowserContractExpectation,
) => Promise<DirectBrowserContract<Manifest, Probe>> {
  return async (browser, expectation) => {
    const envelope = parseDirectBrowserContractEnvelope(
      await browser.evaluate(`(() => {
        const bridge = window.__direct;
        return {
          bridgeSchema: bridge?.schema,
          manifest: bridge?.manifest,
          probe: typeof bridge?.snapshot === "function" ? bridge.snapshot() : undefined,
        };
      })()`),
    );
    if (envelope.bridgeSchema !== protocol.bridgeSchema) {
      throw new Error(
        `Direct browser bridge schema must be ${protocol.bridgeSchema}`,
      );
    }
    const manifest = protocol.parseManifest(envelope.manifest);
    if (!manifest.ok) {
      throw new Error(`Direct session manifest is invalid: ${manifest.error.message}`);
    }
    const probe = protocol.parseProbe(envelope.probe);
    if (!probe.ok) {
      throw new Error(`Direct probe is invalid: ${probe.error.message}`);
    }
    if (manifest.value.active.source !== expectation.source) {
      throw new Error(
        `Direct activated from ${manifest.value.active.source} instead of ${expectation.source}`,
      );
    }
    if (String(manifest.value.active.scenario) !== expectation.scenario) {
      throw new Error(
        `Direct activated ${String(manifest.value.active.scenario)} instead of ${expectation.scenario}`,
      );
    }
    if (manifest.value.active.route !== expectation.route) {
      throw new Error(
        `Direct scenario ${expectation.scenario} activated route ${manifest.value.active.route} instead of ${expectation.route}`,
      );
    }
    if (manifest.value.active.activationHash !== probe.value.activationHash) {
      throw new Error(
        "Direct session manifest and probe identify different activations",
      );
    }
    return Object.freeze({
      manifest: manifest.value,
      probe: probe.value,
    });
  };
}

export interface ManagedVerificationServer {
  readonly exited: Promise<unknown>;
  readonly exitCode: () => number | null;
  readonly killDescendants?: (timeoutMs: number) => void | Promise<void>;
  readonly output: Promise<string>;
  /** Detached diagnostics only; neither a snapshot nor leader exit proves EOF. */
  readonly outputSnapshot?: () => VerificationOutputSnapshot;
  readonly terminate: () => void;
  readonly kill: () => void;
}

export class VerificationServerOutputTimeoutError extends Error {
  readonly outputSnapshot: VerificationOutputSnapshot | undefined;
  readonly outputSnapshotFailure: string | undefined;

  constructor(stopTimeoutMs: number, server: Pick<ManagedVerificationServer, "outputSnapshot">) {
    super(`verification server output did not settle within ${stopTimeoutMs}ms after exit`);
    this.name = "VerificationServerOutputTimeoutError";
    let snapshot: VerificationOutputSnapshot | undefined;
    let snapshotFailure: string | undefined;
    try {
      const current = server.outputSnapshot?.();
      if (current !== undefined) snapshot = copyVerificationOutputSnapshot(current);
    } catch (error: unknown) {
      snapshotFailure = describeVerificationOutputFailure(error);
    }
    this.outputSnapshot = snapshot;
    this.outputSnapshotFailure = snapshotFailure;
    Object.defineProperties(this, {
      outputSnapshot: { writable: false, configurable: false },
      outputSnapshotFailure: { writable: false, configurable: false },
    });
  }
}

export type ServerLease =
  | { readonly source: "reused" }
  | { readonly source: "started"; readonly server: ManagedVerificationServer };

export interface ArtifactRun {
  readonly artifactRoot: string;
  readonly generatedAt: string;
  readonly manifestPath: string;
  readonly runDirectory: string;
}

/** Serializes explicit Chrome flags for agent-browser without a shell boundary. */
export function serializeAgentBrowserLaunchArguments(
  launchArguments: readonly string[],
): string {
  for (const argument of launchArguments) {
    if (!argument.startsWith("--") || argument.includes("\n") || argument.includes(",")) {
      throw new Error(`agent-browser launch arguments must be comma-free Chrome flags, received ${JSON.stringify(argument)}`);
    }
  }
  return launchArguments.join(",");
}

/**
 * Builds a fresh agent-browser process environment without inheriting an
 * attached browser, persistent profile, restored state, or ambient flags.
 */
export function isolatedAgentBrowserEnvironment(options: {
  readonly configPath: string;
  readonly defaultTimeoutMs: number;
  readonly cdpUrl?: string;
  readonly executablePath?: string;
  readonly idleTimeoutMs?: number;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly engine?: AgentBrowserEngine;
  readonly launchArguments?: readonly string[];
  readonly session: string;
}): Record<string, string | undefined> {
  const environment = { ...options.inheritedEnvironment };
  for (const variable of Object.keys(environment)) {
    if (variable.startsWith("AGENT_BROWSER_")) Reflect.deleteProperty(environment, variable);
  }
  return {
    ...environment,
    AGENT_BROWSER_CONFIG: options.configPath,
    AGENT_BROWSER_DEFAULT_TIMEOUT: String(options.defaultTimeoutMs),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(
      options.idleTimeoutMs ?? options.defaultTimeoutMs + 60_000,
    ),
    ...(options.launchArguments === undefined
      ? {}
      : { AGENT_BROWSER_ARGS: serializeAgentBrowserLaunchArguments(options.launchArguments) }),
    AGENT_BROWSER_NAMESPACE: options.session,
    AGENT_BROWSER_RESTORE_SAVE: "never",
    AGENT_BROWSER_SESSION: options.session,
    ...(options.cdpUrl === undefined ? {} : { AGENT_BROWSER_CDP: options.cdpUrl }),
    ...(options.engine === undefined ? {} : { AGENT_BROWSER_ENGINE: options.engine }),
    ...(options.executablePath === undefined
      ? {}
      : { AGENT_BROWSER_EXECUTABLE_PATH: options.executablePath }),
  };
}

/** Keeps the namespace-backed Unix socket path below macOS's 103-byte limit. */
export function boundedAgentBrowserSessionName(
  prefix: string,
  processId: number,
  nonce: string,
): string {
  const boundedPrefix = prefix
    .replaceAll(/[^a-zA-Z0-9_-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 6) || "verify";
  const boundedProcessId = Math.max(0, Math.trunc(processId)).toString(36).slice(-6);
  const boundedNonce = nonce.replaceAll(/[^a-zA-Z0-9]+/g, "").slice(0, 6) || "run";
  return `${boundedPrefix}-${boundedProcessId}-${boundedNonce}`;
}

/** Keeps diagnostics useful without repeating large browser programs or batches. */
export function renderAgentBrowserCommand(arguments_: readonly string[]): string {
  const [command, payload] = arguments_;
  if (command === "eval" && payload !== undefined) {
    return `${command} (${payload.length} character payload)`;
  }
  if (command === "batch") {
    return `${command} (${arguments_.slice(1).join("\n").length} character payload)`;
  }
  return arguments_.join(" ");
}

export const agentBrowserCloseProcessTimeoutMs = 10_000;

export function agentBrowserProcessTimeoutMs(
  arguments_: readonly string[],
  defaultTimeoutMs: number,
): number {
  const defaultProcessTimeoutMs = defaultTimeoutMs + 5_000;
  return arguments_[0] === "close"
    ? Math.min(defaultProcessTimeoutMs, agentBrowserCloseProcessTimeoutMs)
    : defaultProcessTimeoutMs;
}

function truncateRenderedError(value: string): string {
  if (value.length <= MAX_RENDERED_ERROR_LENGTH) return value;
  return `${value.slice(0, MAX_RENDERED_ERROR_LENGTH - 1)}…`;
}

function readForeignProperty(
  value: object | ((...arguments_: never[]) => unknown),
  key: PropertyKey,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: Reflect.get(value, key) };
  } catch {
    return { ok: false };
  }
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isNonArrayObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is readonly [string, ...string[]] {
  return isUnknownArray(value)
    && value.length > 0
    && value.every((entry) => typeof entry === "string");
}

function renderUnknownAtDepth(value: unknown, seen: WeakSet<object>, depth: number): string {
  if (typeof value === "string") return truncateRenderedError(value);
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    if (seen.has(value)) return "[Circular]";
    if (depth >= MAX_ERROR_CAUSE_DEPTH) return "[Cause depth exceeded]";
    seen.add(value);

    const message = readForeignProperty(value, "message");
    if (message.ok && typeof message.value === "string") {
      const name = readForeignProperty(value, "name");
      const label = name.ok && typeof name.value === "string" && name.value.length > 0
        ? name.value
        : "Error";
      const cause = readForeignProperty(value, "cause");
      const renderedCause = cause.ok && cause.value !== undefined
        ? `; caused by ${renderUnknownAtDepth(cause.value, seen, depth + 1)}`
        : "";
      return truncateRenderedError(`${label}: ${message.value}${renderedCause}`);
    }
  }

  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) return truncateRenderedError(encoded);
  } catch {
    // Fall through to guarded coercion for cycles, proxies, and foreign toJSON hooks.
  }
  try {
    return truncateRenderedError(String(value));
  } catch {
    return "Unknown failure";
  }
}

/** Render foreign failures without trusting prototypes, getters, causes, or unbounded output. */
export function renderUnknown(value: unknown): string {
  return renderUnknownAtDepth(value, new WeakSet<object>(), 0);
}

export function tail(value: string, maximumLength = DEFAULT_LOG_LIMIT): string {
  return value.length <= maximumLength ? value : value.slice(-maximumLength);
}

export function normalizeRootHttpOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("--base-url must be an absolute HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--base-url must use http: or https:");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("--base-url cannot contain credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("--base-url must point to the server root without a query string or fragment");
  }
  return url.origin;
}

export function parseBaseUrlArguments(
  arguments_: readonly string[],
  defaultBaseUrl: string,
): BrowserVerificationArguments {
  let baseUrl = defaultBaseUrl;
  let receivedBaseUrl = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (argument === "--help" || argument === "-h") return { kind: "help" };
    if (argument.startsWith("--base-url=")) {
      if (receivedBaseUrl) throw new Error("--base-url may be provided only once");
      receivedBaseUrl = true;
      baseUrl = argument.slice("--base-url=".length);
      continue;
    }
    if (argument === "--base-url") {
      if (receivedBaseUrl) throw new Error("--base-url may be provided only once");
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--base-url requires a value");
      }
      receivedBaseUrl = true;
      baseUrl = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument at position ${String(index + 1)}`);
  }
  return { kind: "run", baseUrl: normalizeRootHttpOrigin(baseUrl) };
}

export function canAutomaticallyStartLocalServer(
  baseUrl: string,
  localHosts: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]),
): boolean {
  const url = new URL(normalizeRootHttpOrigin(baseUrl));
  return url.protocol === "http:" && localHosts.has(url.hostname);
}

export function parseAgentBrowserEnvelope(source: string): unknown {
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    throw new Error("agent-browser did not return one JSON document");
  }
  if (
    typeof input !== "object"
    || input === null
    || Array.isArray(input)
    || typeof Reflect.get(input, "success") !== "boolean"
    || !Object.hasOwn(input, "data")
    || !Object.hasOwn(input, "error")
  ) {
    throw new Error("agent-browser returned an invalid envelope");
  }
  if (!Reflect.get(input, "success")) {
    throw new Error(`agent-browser reported failure: ${renderUnknown(Reflect.get(input, "error"))}`);
  }
  return Reflect.get(input, "data");
}

export function parseAgentBrowserBatchEnvelope(source: string): readonly unknown[] {
  let input: unknown;
  try {
    input = JSON.parse(source) as unknown;
  } catch {
    throw new Error("agent-browser batch did not return one JSON document");
  }
  if (!isUnknownArray(input) || input.length === 0) {
    throw new Error("agent-browser batch returned an invalid envelope");
  }
  return input.map((entry, index) => {
    if (
      !isNonArrayObject(entry)
      || !Object.hasOwn(entry, "command")
      || !Object.hasOwn(entry, "success")
      || !Object.hasOwn(entry, "result")
      || !Object.hasOwn(entry, "error")
    ) {
      throw new Error(`agent-browser batch returned an invalid envelope at position ${String(index + 1)}`);
    }
    const command = readForeignProperty(entry, "command");
    const success = readForeignProperty(entry, "success");
    const result = readForeignProperty(entry, "result");
    const error = readForeignProperty(entry, "error");
    if (
      !command.ok
      || !isNonEmptyStringArray(command.value)
      || !success.ok
      || typeof success.value !== "boolean"
      || !result.ok
      || !error.ok
    ) {
      throw new Error(`agent-browser batch returned an invalid envelope at position ${String(index + 1)}`);
    }
    if (!success.value) {
      throw new Error(
        `agent-browser batch command ${String(index + 1)} (${renderAgentBrowserCommand(command.value)}) reported failure: ${renderUnknown(error.value)}`,
      );
    }
    return result.value;
  });
}

async function managedAgentBrowserExecutable(configPath: string): Promise<string> {
  const guidance = "Set executablePath in scripts/direct/agent-browser.verify.json to a provisioned Chrome for Testing or Playwright Chromium executable; run agent-browser install or playwright install chromium first. Installed auto-updating Chrome and automatic discovery are not supported.";
  let config: unknown;
  try {
    config = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot read browser configuration. ${guidance}`, { cause: error });
  }
  if (isNonArrayObject(config)) {
    for (const key of ["autoConnect", "cdp", "provider"]) {
      const value: unknown = Reflect.get(config, key);
      if (value !== undefined && value !== false && value !== null && value !== "") {
        throw new Error(`Owned browser configuration cannot select ${key}; browser attachment requires a separate explicit workflow.`);
      }
    }
    const engine: unknown = Reflect.get(config, "engine");
    if (engine !== undefined && engine !== "chrome") {
      throw new Error("Owned browser configuration requires the chrome engine");
    }
  }
  const selected = isNonArrayObject(config) ? Reflect.get(config, "executablePath") : undefined;
  if (typeof selected !== "string" || !isAbsolute(selected)) {
    throw new Error(guidance);
  }
  let executable: string;
  try {
    executable = await realpath(selected);
    if (!(await stat(executable)).isFile()) throw new Error("not a file");
    await access(executable, constants.X_OK);
  } catch (error) {
    throw new Error(`Browser executable is unavailable: ${selected}. ${guidance}`, { cause: error });
  }
  if (/(?:^|[/\\])Google Chrome(?: Beta| Dev| Canary)?\.app(?:[/\\]|$)/i.test(executable)) {
    throw new Error(`Installed Google Chrome cannot be used for automation: ${executable}. ${guidance}`);
  }
  let version: string;
  try {
    const result = await promisify(execFile)(executable, ["--version"], {
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 4_096,
      encoding: "utf8",
      windowsHide: true,
    });
    version = result.stdout.trim();
  } catch (error) {
    throw new Error(`Cannot identify browser executable: ${executable}. ${guidance}`, { cause: error });
  }
  // This identifies the automation distribution, not artifact provenance.
  if (!/^(?:Google Chrome for Testing|Chromium) \d+\.\d+\.\d+\.\d+(?:[ \t]+[^\r\n]+)?$/.test(version)) {
    throw new Error(`Unsupported browser ${JSON.stringify(version)} at ${executable}. ${guidance}`);
  }
  console.error(`Direct browser: ${version} (${executable})`);
  return executable;
}

function validateOwnedBrowserCommand(arguments_: readonly string[], nested = false): void {
  const command = arguments_[0];
  if (command === "connect" || arguments_.some((argument) => /^(?:--(?:executable-path|config|auto-connect|cdp|provider|engine)(?:=|$)|-p(?:=|$))/.test(argument))) {
    throw new Error("Owned browser selection must be selected through scripts/direct/agent-browser.verify.json; attachment requires a separate explicit workflow");
  }
  if (command === undefined || command.startsWith("-")) {
    throw new Error("run() requires a command first; the helper owns global browser options");
  }
  if (command === "batch") {
    if (nested) throw new Error("Nested browser batches are not supported; use separate run() calls");
    const commands = arguments_.slice(1).filter((argument) => argument !== "--bail");
    if (commands.length === 0) throw new Error("batch requires plain command strings");
    for (const entry of commands) {
      if (/["'\\]/.test(entry) || entry.trim().startsWith("[")) {
        throw new Error("batch accepts plain command strings only; use separate run() calls for quoted, escaped, JSON, or evaluation payloads");
      }
      validateOwnedBrowserCommand(entry.trim().split(/\s+/), true);
    }
  }
}

export function createAgentBrowser(options: {
  readonly cdpUrl?: string;
  readonly engine?: AgentBrowserEngine;
  readonly executablePath?: string;
  readonly repositoryRoot: string;
  readonly sessionPrefix: string;
  readonly defaultTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly launchArguments?: readonly string[];
}): AgentBrowser {
  if (options.engine !== undefined && options.engine !== "chrome" && options.engine !== "lightpanda") {
    throw new Error(`Unsupported agent-browser engine: ${JSON.stringify(options.engine)}`);
  }
  if (options.engine === "lightpanda" && options.executablePath === undefined) {
    throw new Error("Lightpanda agent-browser requires an explicit executablePath");
  }
  const binary = join(options.repositoryRoot, "node_modules/.bin/agent-browser");
  const createEnvironment = () => {
    const session = boundedAgentBrowserSessionName(
      options.sessionPrefix,
      process.pid,
      randomUUID(),
    );
    return isolatedAgentBrowserEnvironment({
      configPath: join(options.repositoryRoot, "scripts/direct/agent-browser.verify.json"),
      defaultTimeoutMs: options.defaultTimeoutMs ?? 35_000,
      ...(options.idleTimeoutMs === undefined
        ? {}
        : { idleTimeoutMs: options.idleTimeoutMs }),
      ...(options.cdpUrl === undefined ? {} : { cdpUrl: options.cdpUrl }),
      ...(options.engine === undefined ? {} : { engine: options.engine }),
      ...(options.executablePath === undefined
        ? {}
        : { executablePath: options.executablePath }),
      inheritedEnvironment: process.env,
      ...(options.launchArguments === undefined
        ? {}
        : { launchArguments: options.launchArguments }),
      session,
    });
  };
  let environment = createEnvironment();
  let used = false;
  let executable: Promise<string> | undefined;

  async function run(arguments_: readonly string[]): Promise<unknown> {
    validateOwnedBrowserCommand(arguments_);
    executable ??= options.engine === "lightpanda"
      ? Promise.resolve(options.executablePath as string)
      : managedAgentBrowserExecutable(join(options.repositoryRoot, "scripts/direct/agent-browser.verify.json"));
    environment.AGENT_BROWSER_EXECUTABLE_PATH = await executable;
    used = true;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? 35_000;
    const commandArguments = arguments_[0] === "wait" && !arguments_.includes("--timeout")
      ? [...arguments_, "--timeout", String(defaultTimeoutMs)]
      : arguments_;
    const command = Bun.spawn([process.execPath, binary, "--json", ...commandArguments], {
      cwd: options.repositoryRoot,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
    const commandTimeoutMs = agentBrowserProcessTimeoutMs(
      commandArguments,
      defaultTimeoutMs,
    );
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      command.kill();
      forceKillTimer = setTimeout(() => command.kill(9), 1_000);
    }, commandTimeoutMs);
    let stdout: string;
    let stderr: string;
    let exitCode: number;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
        command.exited,
      ]);
    } finally {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    }
    if (timedOut) {
      throw new Error(
        `agent-browser ${renderAgentBrowserCommand(commandArguments)} exceeded its ${commandTimeoutMs}ms process deadline`,
      );
    }
    if (exitCode !== 0) {
      throw new Error(
        `agent-browser ${renderAgentBrowserCommand(commandArguments)} exited with ${exitCode}: ${tail(stderr.trim() || stdout.trim())}`,
      );
    }
    return commandArguments[0] === "batch"
      ? parseAgentBrowserBatchEnvelope(stdout)
      : parseAgentBrowserEnvelope(stdout);
  }

  async function evaluate(expression: string): Promise<unknown> {
    const evaluation = await run(["eval", expression]);
    if (
      typeof evaluation !== "object"
      || evaluation === null
      || Array.isArray(evaluation)
      || !Object.hasOwn(evaluation, "result")
    ) {
      throw new Error("browser evaluation returned invalid data");
    }
    return Reflect.get(evaluation, "result");
  }

  async function readBodyText(): Promise<string> {
    const result = await evaluate("document.body?.innerText ?? ''");
    if (typeof result !== "string") throw new Error("body text evaluation did not return a string");
    return result;
  }

  async function close(): Promise<void> {
    if (!used) return;
    try {
      await run(["close"]);
    } catch (error) {
      if (!renderUnknown(error).includes("Failed to connect: No such file or directory")) {
        throw error;
      }
    } finally {
      used = false;
    }
  }

  async function restart(): Promise<void> {
    // A process deadline can leave the old daemon unable to answer `close`.
    // Its verifier-owned idle timeout still bounds that exact namespace, so
    // recovery must rotate even when synchronous cleanup cannot complete.
    try {
      await close();
    } catch {
      used = false;
    }
    environment = createEnvironment();
  }

  return { close, evaluate, readBodyText, restart, run };
}

type LightpandaSemanticBrowserOptions = Omit<
  Parameters<typeof createAgentBrowser>[0],
  "cdpUrl" | "engine"
> & {
  /**
   * Keep this false only for compatibility experiments with an agent-browser
   * build that owns its Lightpanda process. The default owns a pinned
   * Lightpanda server so 1.0's CDP target lifecycle is explicit and bounded.
   */
  readonly manageProcess?: boolean;
};

async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolve());
  });
  const address = probe.address();
  if (address === null || typeof address === "string") {
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    throw new Error("could not allocate a Lightpanda CDP port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => error === undefined ? resolve() : reject(error));
  });
  return port;
}

async function startLightpandaServer(options: {
  readonly executablePath: string;
  readonly repositoryRoot: string;
  readonly startupTimeoutMs: number;
}): Promise<{ readonly cdpUrl: string; readonly server: ManagedVerificationServer }> {
  if (!isAbsolute(options.executablePath) || !(await Bun.file(options.executablePath).exists())) {
    throw new Error(`Lightpanda executable does not exist at an absolute pinned path: ${options.executablePath}`);
  }
  const port = await freeLoopbackPort();
  const cdpUrl = `http://127.0.0.1:${String(port)}`;
  const server = spawnVerificationServer({
    command: [
      options.executablePath,
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--disable-metrics",
      "--load-resources",
      "stylesheet",
      "--load-resources",
      "iframe",
      "--load-resources",
      "worker",
    ],
    cwd: options.repositoryRoot,
    detachedProcessGroup: true,
  });
  const timeoutMs = Math.max(5_000, Math.min(options.startupTimeoutMs, 15_000));
  const deadline = Date.now() + timeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (server.exitCode() !== null) break;
    try {
      const response = await fetch(`${cdpUrl}/json/version`, {
        signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
      });
      await response.body?.cancel();
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // The server is still binding its loopback CDP endpoint.
    }
    await Bun.sleep(50);
  }
  if (!ready) {
    const output = await stopVerificationServerWithOutput(server);
    throw new Error(
      `Lightpanda CDP server did not become ready within ${String(timeoutMs)}ms${output === "" ? "" : `: ${output}`}`,
    );
  }
  return { cdpUrl, server };
}

/**
 * Creates the guarded Lightpanda lane for DOM, text, metadata, and simple
 * JavaScript interaction checks. Commands outside that semantic subset fail
 * before they reach the browser, so a caller cannot accidentally treat a
 * screenshot, layout, media, download, or multi-target operation as proof.
 */
export function createLightpandaSemanticBrowser(
  options: LightpandaSemanticBrowserOptions,
): AgentBrowser {
  if (options.executablePath === undefined || options.executablePath.length === 0) {
    throw new Error(
      "Lightpanda semantic verification requires an explicit pinned executablePath",
    );
  }
  const executablePath = options.executablePath;
  const manageProcess = options.manageProcess ?? true;
  if (!manageProcess) {
    const browser = createAgentBrowser({ ...options, engine: "lightpanda" });
    return {
      close: () => browser.close(),
      evaluate: async (expression) => {
        assertLightpandaSemanticExpression(expression);
        return browser.evaluate(expression);
      },
      readBodyText: () => browser.readBodyText(),
      restart: () => browser.restart(),
      run: async (arguments_) => {
        assertLightpandaSemanticCommand(arguments_);
        return browser.run(arguments_);
      },
    };
  }

  let browserPromise: Promise<AgentBrowser> | undefined;
  let server: ManagedVerificationServer | undefined;
  async function browser(): Promise<AgentBrowser> {
    if (browserPromise !== undefined) return browserPromise;
    browserPromise = (async () => {
      const started = await startLightpandaServer({
        executablePath,
        repositoryRoot: options.repositoryRoot,
        startupTimeoutMs: options.defaultTimeoutMs ?? 35_000,
      });
      server = started.server;
      return createAgentBrowser({
        ...options,
        cdpUrl: started.cdpUrl,
        engine: "lightpanda",
      });
    })().catch(async (error) => {
      browserPromise = undefined;
      if (server !== undefined) {
        await stopVerificationServer(server).catch(() => {});
        server = undefined;
      }
      throw error;
    });
    return browserPromise;
  }
  async function closeOwnedBrowser(): Promise<void> {
    let failure: unknown;
    if (browserPromise !== undefined) {
      try {
        await (await browserPromise).close();
      } catch (error) {
        failure = error;
      }
    }
    browserPromise = undefined;
    if (server !== undefined) {
      try {
        await stopVerificationServer(server);
      } catch (error) {
        failure ??= error;
      }
      server = undefined;
    }
    if (failure !== undefined) throw failure;
  }
  return {
    close: closeOwnedBrowser,
    evaluate: async (expression) => {
      assertLightpandaSemanticExpression(expression);
      return (await browser()).evaluate(expression);
    },
    readBodyText: async () => (await browser()).readBodyText(),
    restart: async () => {
      await closeOwnedBrowser();
    },
    run: async (arguments_) => {
      assertLightpandaSemanticCommand(arguments_);
      return (await browser()).run(arguments_);
    },
  };
}

function verificationProcessGroupExists(processId: number): boolean {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM leaves group absence unproven, so poll until ESRCH or timeout.
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

async function waitForVerificationProcessGroupExit(
  processId: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (verificationProcessGroupExists(processId)) {
    if (Date.now() >= deadline) {
      throw new Error(`verification server process group ${String(processId)} survived cleanup`);
    }
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}

export function spawnVerificationServer(options: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly detachedProcessGroup?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly logLimit?: number;
  readonly omitEnvironment?: readonly string[];
}): ManagedVerificationServer {
  const detachedProcessGroup = options.detachedProcessGroup ?? false;
  const omittedEnvironment = new Set(options.omitEnvironment ?? []);
  const environment: Record<string, string | undefined> = Object.fromEntries(
    Object.entries({ ...process.env, ...options.env }).filter(
      ([name]) => !omittedEnvironment.has(name),
    ),
  );
  const process_ = Bun.spawn([...options.command], {
    cwd: options.cwd,
    detached: detachedProcessGroup,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
  const stdout = captureVerificationOutput(process_.stdout, logLimit);
  const stderr = captureVerificationOutput(process_.stderr, logLimit);
  const output = Promise.all([
    stdout.output,
    stderr.output,
  ]).then(([stdout, stderr]) => tail(`${stdout}\n${stderr}`.trim(), logLimit));

  const signal = (value: "SIGKILL" | "SIGTERM"): void => {
    if (detachedProcessGroup) {
      try {
        process.kill(-process_.pid, value);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        // The group may already be gone; fall back to the leader only while it lives.
      }
    }
    if (process_.exitCode === null) process_.kill(value);
  };

  return {
    exited: process_.exited,
    exitCode: () => process_.exitCode,
    ...(detachedProcessGroup
      ? {
          killDescendants: async (timeoutMs: number): Promise<void> => {
            signal("SIGKILL");
            await waitForVerificationProcessGroupExit(process_.pid, timeoutMs);
          },
        }
      : {}),
    output,
    outputSnapshot: () => Object.freeze({ schema: "direct.verification-output/v1",
      stdout: stdout.snapshot(), stderr: stderr.snapshot() }),
    terminate: () => signal("SIGTERM"),
    kill: () => signal("SIGKILL"),
  };
}

export async function runVerificationCommand(options: {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly label: string;
  readonly timeoutMs: number;
}): Promise<string> {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("verification command timeout must be a finite positive duration");
  }
  const command = spawnVerificationServer({
    command: options.command,
    cwd: options.cwd,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    command.exited.then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), options.timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (!completed) {
    const output = tail(await stopVerificationServerWithOutput(command));
    const message = `${options.label} exceeded its ${options.timeoutMs}ms deadline`;
    throw new Error(output === "" ? message : `${message}:\n${output}`);
  }
  const exitCode = command.exitCode();
  const output = tail(await stopVerificationServerWithOutput(command));
  if (exitCode !== 0) {
    throw new Error(`${options.label} exited with ${String(exitCode)}:\n${output}`);
  }
  return output;
}

type BoundedSettlement<Value> =
  | { readonly settled: false }
  | { readonly settled: true; readonly value: Value };

async function settleWithin<Value>(
  promise: Promise<Value>,
  timeoutMs: number,
): Promise<BoundedSettlement<Value>> {
  return await Promise.race([
    promise.then((value) => ({ settled: true, value }) as const),
    Bun.sleep(timeoutMs).then(() => ({ settled: false }) as const),
  ]);
}

export async function serverIsReachable(
  baseUrl: string,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  readinessPath = "/",
): Promise<boolean> {
  if (!readinessPath.startsWith("/") || readinessPath.startsWith("//")) {
    throw new Error(`readinessPath must be an origin-relative path, received ${JSON.stringify(readinessPath)}`);
  }
  const probeUrl = new URL(readinessPath, `${normalizeRootHttpOrigin(baseUrl)}/`);
  if (probeUrl.hash !== "") throw new Error("readinessPath cannot contain a fragment");
  try {
    const response = await fetch(probeUrl, {
      signal: AbortSignal.timeout(probeTimeoutMs),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}

async function stopVerificationServerWithOutput(
  server: ManagedVerificationServer,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
): Promise<string> {
  if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs < 0) {
    throw new Error("verification server stop timeout must be a finite nonnegative duration");
  }
  if (server.exitCode() === null) server.terminate();
  const stopped = await settleWithin(server.exited, stopTimeoutMs);
  if (!stopped.settled) {
    server.kill();
    const killed = await settleWithin(server.exited, stopTimeoutMs);
    if (!killed.settled) {
      throw new Error(
        `verification server did not exit within ${stopTimeoutMs}ms after SIGKILL`,
      );
    }
  }
  // A detached leader can exit before descendants close inherited output pipes.
  // Reap only a process group that the verifier explicitly owns.
  await server.killDescendants?.(stopTimeoutMs);
  const output = await settleWithin(server.output, stopTimeoutMs);
  if (!output.settled) {
    throw new VerificationServerOutputTimeoutError(stopTimeoutMs, server);
  }
  return output.value;
}

export async function stopVerificationServer(
  server: ManagedVerificationServer,
  stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS,
): Promise<void> {
  await stopVerificationServerWithOutput(server, stopTimeoutMs);
}

function verificationServerAcquisitionAbortError(): Error {
  return new Error("Verification server acquisition was aborted");
}

function throwIfVerificationServerAcquisitionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw verificationServerAcquisitionAbortError();
}

async function waitForVerificationServerAcquisitionStep<Value>(
  promise: Promise<Value>,
  signal: AbortSignal | undefined,
): Promise<Value> {
  if (signal === undefined) return await promise;
  throwIfVerificationServerAcquisitionAborted(signal);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(verificationServerAcquisitionAbortError());
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  let value: Value;
  try {
    value = await Promise.race([promise, aborted]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  }
  throwIfVerificationServerAcquisitionAborted(signal);
  return value;
}

export async function acquireVerificationServer(options: {
  readonly abortSignal?: AbortSignal;
  readonly baseUrl: string;
  readonly label: string;
  readonly localHosts?: ReadonlySet<string>;
  readonly pollIntervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly reuseProbeIntervalMs?: number;
  readonly reuseExistingLocalServer?: boolean;
  readonly readinessPath?: `/${string}`;
  readonly startServer: () => ManagedVerificationServer;
  readonly startupTimeoutMs: number;
  readonly isReachable?: (
    baseUrl: string,
    probeTimeoutMs: number,
    readinessPath: string,
  ) => boolean | Promise<boolean>;
}): Promise<ServerLease> {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const readinessPath = options.readinessPath ?? "/";
  const isReachable = options.isReachable ?? serverIsReachable;
  const canStartLocally = canAutomaticallyStartLocalServer(
    options.baseUrl,
    options.localHosts,
  );
  throwIfVerificationServerAcquisitionAborted(options.abortSignal);
  if (await waitForVerificationServerAcquisitionStep(
    Promise.resolve(isReachable(options.baseUrl, probeTimeoutMs, readinessPath)),
    options.abortSignal,
  )) {
    if (canStartLocally && options.reuseExistingLocalServer === false) {
      throw new Error(
        `A local server is already reachable at ${options.baseUrl}; `
        + "verification will not reuse a server whose worktree ownership is unknown",
      );
    }
    // A verifier-owned command can exit before its child listener has finished
    // shutting down. Require the listener to survive a bounded interval before
    // another verifier trusts it as independently managed infrastructure.
    await waitForVerificationServerAcquisitionStep(
      Bun.sleep(options.reuseProbeIntervalMs ?? DEFAULT_REUSE_PROBE_INTERVAL_MS),
      options.abortSignal,
    );
    if (await waitForVerificationServerAcquisitionStep(
      Promise.resolve(isReachable(options.baseUrl, probeTimeoutMs, readinessPath)),
      options.abortSignal,
    )) {
      throwIfVerificationServerAcquisitionAborted(options.abortSignal);
      return { source: "reused" };
    }
  }
  if (!canStartLocally) {
    throw new Error(
      `No server is reachable at ${options.baseUrl}; automatic startup is limited to local HTTP URLs`,
    );
  }

  throwIfVerificationServerAcquisitionAborted(options.abortSignal);
  const server = options.startServer();
  let exitedWithCode: number | null = null;
  try {
    const deadline = Date.now() + options.startupTimeoutMs;
    while (Date.now() < deadline) {
      const exitCode = server.exitCode();
      if (exitCode !== null) {
        exitedWithCode = exitCode;
        break;
      }
      if (await waitForVerificationServerAcquisitionStep(
        Promise.resolve(isReachable(options.baseUrl, probeTimeoutMs, readinessPath)),
        options.abortSignal,
      )) {
        throwIfVerificationServerAcquisitionAborted(options.abortSignal);
        return { source: "started", server };
      }
      await waitForVerificationServerAcquisitionStep(
        Bun.sleep(options.pollIntervalMs ?? 200),
        options.abortSignal,
      );
    }
  } catch (error) {
    await stopVerificationServer(server);
    throw error;
  }
  if (exitedWithCode !== null) {
    const output = tail(await stopVerificationServerWithOutput(server));
    throw new Error(`${options.label} exited with ${exitedWithCode}:\n${output}`);
  }
  const timeoutMessage = `${options.label} did not become reachable at ${new URL(readinessPath, `${options.baseUrl}/`).href} within ${options.startupTimeoutMs}ms`;
  const output = tail(await stopVerificationServerWithOutput(server));
  throw new Error(output === "" ? timeoutMessage : `${timeoutMessage}:\n${output}`);
}

export async function createArtifactRun(options: {
  readonly artifactRoot: string;
  readonly generatedAt?: string;
  readonly processId?: number;
}): Promise<ArtifactRun> {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const processId = options.processId ?? process.pid;
  const runId = `${generatedAt.replaceAll(/[^0-9A-Za-z]/gu, "-")}-${processId}`;
  const runDirectory = join(options.artifactRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  return {
    artifactRoot: options.artifactRoot,
    generatedAt,
    manifestPath: join(options.artifactRoot, "manifest.json"),
    runDirectory,
  };
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporaryPath = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
