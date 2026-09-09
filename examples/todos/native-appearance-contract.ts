import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import { SCENARIO_QUERY_KEY } from "@hraness/direct";
import {
  parseDirectNamedLayoutSample,
  validateDirectNamedLayout,
  type DirectNamedLayoutSample,
} from "@hraness/direct/tooling/browser-verification";

export const TODO_APPEARANCE_SCHEMA = "direct.todo-appearance/v1";
export const TODO_APPEARANCE_BATCH_LIMIT = 8;
export const TODO_APPEARANCE_CASES = ["production", "todos.empty", "todos.populated", "todos.write-failure", "unknown", "duplicate"] as const;
export type TodoAppearanceCase = typeof TODO_APPEARANCE_CASES[number];
export const TODO_APPEARANCE_WIDTHS = [1280, 390] as const;
export const TODO_BREAKPOINT_WIDTHS = [519, 520, 521, 839, 840, 841] as const;
export const TODO_STYLE_KEYS = [
  "display", "position", "boxSizing", "flexDirection", "alignItems", "justifyContent", "gridTemplateColumns",
  "rowGap", "columnGap", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "marginTop", "marginRight", "marginBottom", "marginLeft", "borderTopWidth", "borderRightWidth",
  "borderBottomWidth", "borderLeftWidth", "borderTopStyle", "borderTopColor", "borderRadius",
  "backgroundColor", "color", "boxShadow", "fontFamily", "fontSize", "fontWeight", "lineHeight",
  "letterSpacing", "textTransform", "textDecorationLine", "overflowWrap", "appearance", "accentColor",
  "outlineStyle", "outlineWidth", "outlineColor", "outlineOffset",
  "opacity", "visibility", "overflowX", "overflowY", "cursor", "touchAction",
  "listStyleType", "listStylePosition", "textDecorationColor", "textDecorationStyle",
  "textDecorationThickness", "textUnderlineOffset", "borderRightColor", "borderBottomColor",
  "borderLeftColor", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
  "gridColumnStart", "gridColumnEnd", "minHeight", "minWidth", "fontStyle",
] as const;

export const todoFailureText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 4096);
/** Cleanup is attempted exactly once and cannot erase the primary failure. */
export async function withTodoCleanup<T>(work: () => Promise<T>, cleanup: () => Promise<void>): Promise<T> {
  let result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
  try { result = { ok: true, value: await work() }; }
  catch (error) { result = { ok: false, error }; }
  let collection: { readonly ok: true } | { readonly ok: false; readonly error: unknown };
  try { await cleanup(); collection = { ok: true }; }
  catch (error) { collection = { ok: false, error }; }
  if (!result.ok) {
    if (!collection.ok) throw new AggregateError([result.error, collection.error], `Primary: ${todoFailureText(result.error)}; cleanup: ${todoFailureText(collection.error)}`);
    throw result.error;
  }
  if (!collection.ok) throw collection.error;
  return result.value;
}
export function parseTodoOwnedClose(value: unknown, id: string): unknown {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "owned close response must be an object");
  assert.equal(Reflect.get(value, "id"), id, "owned close response identity mismatch");
  assert.equal(Reflect.get(value, "success"), true, "owned close failed");
  const data: unknown = Reflect.get(value, "data");
  assert.ok(data !== null && typeof data === "object" && !Array.isArray(data) && Reflect.get(data, "closed") === true, "whole-browser close rejected");
  return data;
}
export function assertTodoStaticCss(value: unknown): void {
  const evidence = exactRecord(value, ["styleNodes", "adoptedSheets", "mutations"], "runtime CSS observation");
  assert.deepEqual(evidence, { styleNodes: 0, adoptedSheets: 0, mutations: [] }, "runtime style injection or adopted stylesheet observed");
}

export function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label}: expected object`);
  assert.ok(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null, `${label}: plain object required`);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort(), `${label}: unexpected own fields`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label}: unexpected fields`);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert.ok(descriptor && "value" in descriptor && descriptor.enumerable, `${label}: ordinary data fields required`);
  }
  return value as Record<string, unknown>;
}
/** agent-browser 0.32.3 adds this metadata to every successful object payload. */
export function parseTodoDriverResult(value: unknown, bootstrap: boolean): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "driver result must be an object");
  const result = exactRecord(value, Object.keys(value), "agent-browser0.32.3 result");
  const lifecycle = exactRecord(result.lifecycle, ["reused", "launched", "relaunchedBrowser", "restartedBackground", "restoreStatus", "saveStatus", "effectiveLaunch"], "agent-browser0.32.3 lifecycle");
  const launch = exactRecord(lifecycle.effectiveLaunch, ["browserLaunched", "engine", "launchHash"], "agent-browser0.32.3 effective launch");
  assert.equal(lifecycle.reused, true);
  assert.equal(lifecycle.launched, bootstrap, "unexpected browser launch during owned batch");
  assert.equal(lifecycle.relaunchedBrowser, false, "browser relaunch forbidden");
  assert.equal(lifecycle.restartedBackground, false, "background restart forbidden");
  assert.equal(lifecycle.restoreStatus, "not_configured", "ambient browser state restoration forbidden");
  assert.equal(lifecycle.saveStatus, "not_attempted", "ambient browser state persistence forbidden");
  assert.equal(launch.browserLaunched, true);
  assert.equal(launch.engine, "chrome");
  // The native field is a u64, which JSON.parse may round. Raw stdout is retained;
  // this value is metadata, never an identity substitute for PID/start/argv custody.
  assert.ok(typeof launch.launchHash === "number" && Number.isInteger(launch.launchHash) && launch.launchHash >= 0 && launch.launchHash <= 2 ** 64, "bounded native launch hash metadata required");
  return Object.fromEntries(Object.entries(result).filter(([key]) => key !== "lifecycle"));
}
export interface TodoNativeTab { readonly tabId: string; readonly active: boolean; readonly url: string }
export function parseTodoNativeTabs(value: unknown): TodoNativeTab[] {
  const { tabs } = exactRecord(value, ["tabs"], "agent-browser0.32.3 tab list");
  assert.ok(Array.isArray(tabs) && tabs.length >= 1 && tabs.length <= 32, "bounded pinned tab inventory required");
  const rows = tabs.map((tab: unknown) => {
    const record = exactRecord(tab, ["tabId", "label", "title", "url", "type", "active"], "agent-browser0.32.3 tab");
    assert.ok(typeof record.tabId === "string" && /^t\d+$/u.test(record.tabId));
    assert.ok(typeof record.url === "string" && record.url.length <= 4096 && typeof record.active === "boolean");
    assert.ok(record.label === null || (typeof record.label === "string" && record.label.length <= 4096), "bounded nullable tab label required");
    assert.ok([record.title, record.type].every((field) => typeof field === "string" && field.length <= 4096), "bounded tab metadata required");
    return { tabId: record.tabId, active: record.active, url: record.url };
  });
  assert.equal(new Set(rows.map((row) => row.tabId)).size, rows.length);
  assert.equal(rows.filter((row) => row.active).length, 1);
  return rows;
}
export function assertTodoTabClosed(value: unknown, tabId: string): void {
  const record = exactRecord(value, ["tabId", "label", "closed"], "agent-browser0.32.3 tab close");
  assert.equal(record.tabId, tabId, "closed tab identity mismatch");
  assert.equal(record.closed, true);
  assert.ok(record.label === null || (typeof record.label === "string" && record.label.length <= 4096), "bounded nullable closed-tab label required");
}
function text(value: unknown, label: string): string {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/u.test(value), label);
  return value;
}
export function digest(value: unknown, length: 40 | 64, label: string): string {
  const parsed = text(value, label);
  assert.match(parsed, new RegExp(`^[a-f0-9]{${length}}$`, "u"), label);
  return parsed;
}
export function absolutePath(value: unknown, label: string): string {
  const parsed = text(value, label);
  assert.ok(isAbsolute(parsed) && parsed !== "/", label);
  assert.ok(parsed.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== ".."), label);
  return parsed;
}
export interface TodoBuildIdentity {
  readonly directory: string;
  /** SHA-256 of sorted JSON records [relative path, mode, byte length, SHA-256]. */
  readonly inventorySha256: string;
}
export interface TodoSourceIdentity {
  readonly repository: string;
  readonly commit: string;
  readonly tree: string;
  readonly lockSha256: string;
  readonly production: TodoBuildIdentity;
  readonly direct: TodoBuildIdentity;
}
export interface TodoAppearanceInput {
  readonly schema: typeof TODO_APPEARANCE_SCHEMA;
  readonly mode: "compare" | "canary";
  readonly baseline: TodoSourceIdentity;
  readonly current: TodoSourceIdentity;
  readonly browser: { readonly driver: string; readonly driverSha256: string; readonly executable: string; readonly executableSha256: string; readonly version: string };
  readonly artifactParent: string;
  readonly port: number;
  /** A separately rebuilt current artifact; the verifier never edits or builds it. */
  readonly canary: null | { readonly source: TodoSourceIdentity; readonly sample: string; readonly box: string; readonly property: string };
}
function parseBuild(value: unknown): TodoBuildIdentity {
  const record = exactRecord(value, ["directory", "inventorySha256"], "build");
  return { directory: absolutePath(record.directory, "build directory"), inventorySha256: digest(record.inventorySha256, 64, "build inventory") };
}
function parseSource(value: unknown): TodoSourceIdentity {
  const record = exactRecord(value, ["repository", "commit", "tree", "lockSha256", "production", "direct"], "source");
  return { repository: absolutePath(record.repository, "source repository"), commit: digest(record.commit, 40, "source commit"), tree: digest(record.tree, 40, "source tree"), lockSha256: digest(record.lockSha256, 64, "source lock"), production: parseBuild(record.production), direct: parseBuild(record.direct) };
}
export function parseTodoAppearanceInput(value: unknown): TodoAppearanceInput {
  const record = exactRecord(value, ["schema", "mode", "baseline", "current", "browser", "artifactParent", "port", "canary"], "appearance input");
  assert.equal(record.schema, TODO_APPEARANCE_SCHEMA);
  assert.ok(record.mode === "compare" || record.mode === "canary");
  const browser = exactRecord(record.browser, ["driver", "driverSha256", "executable", "executableSha256", "version"], "browser");
  assert.ok(typeof browser.version === "string" && /^\d+\.\d+\.\d+\.\d+$/u.test(browser.version), "exact four-component Chromium version required");
  assert.ok(typeof record.port === "number" && Number.isSafeInteger(record.port) && record.port >= 1024 && record.port <= 65535, "exact unprivileged loopback port required");
  let canary: TodoAppearanceInput["canary"] = null;
  if (record.mode === "canary") {
    const row = exactRecord(record.canary, ["source", "sample", "box", "property"], "canary");
    const property = text(row.property, "canary property");
    assert.ok(["x", "y", "width", "height", ...TODO_STYLE_KEYS].includes(property));
    canary = { source: parseSource(row.source), sample: text(row.sample, "canary sample"), box: text(row.box, "canary box"), property };
  } else assert.equal(record.canary, null, "comparison cannot admit a canary");
  return { schema: TODO_APPEARANCE_SCHEMA, mode: record.mode, baseline: parseSource(record.baseline), current: parseSource(record.current), browser: {
    driver: absolutePath(browser.driver, "driver"), driverSha256: digest(browser.driverSha256, 64, "driver digest"),
    executable: absolutePath(browser.executable, "browser executable"), executableSha256: digest(browser.executableSha256, 64, "browser digest"), version: text(browser.version, "browser version"),
  }, artifactParent: absolutePath(record.artifactParent, "private artifact parent"), port: record.port, canary };
}
export function todoCasePath(scenario: TodoAppearanceCase): string {
  if (scenario === "production") return "/";
  const query = new URLSearchParams();
  query.set(SCENARIO_QUERY_KEY, scenario === "unknown" ? "todos.not-declared" : scenario === "duplicate" ? "todos.empty" : scenario);
  if (scenario === "duplicate") query.append(SCENARIO_QUERY_KEY, "todos.populated");
  return `/direct/?${query.toString()}`;
}
export function boundedTodoBatches<T>(values: readonly T[]): readonly (readonly T[])[] {
  return Array.from({ length: Math.ceil(values.length / TODO_APPEARANCE_BATCH_LIMIT) }, (_, index) => values.slice(index * TODO_APPEARANCE_BATCH_LIMIT, (index + 1) * TODO_APPEARANCE_BATCH_LIMIT));
}
export function admitTodoContext(count: number): number {
  assert.ok(Number.isSafeInteger(count) && count >= 0 && count < TODO_APPEARANCE_BATCH_LIMIT, "ninth context rejected before launch");
  return count + 1;
}
export interface TodoAppearanceSample {
  readonly layout: DirectNamedLayoutSample;
  readonly styles: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly horizontalOverflow: number;
}
export function parseTodoAppearanceSample(value: unknown): TodoAppearanceSample {
  const row = exactRecord(value, ["layout", "styles", "horizontalOverflow"], "sample");
  const layout = parseDirectNamedLayoutSample(row.layout);
  assert.ok(layout.ok, "invalid named layout sample");
  const names = layout.value.boxes.map((box) => box.name);
  const rawStyles = exactRecord(row.styles, names, "styles");
  const styles: Record<string, Record<string, string>> = {};
  for (const name of names) {
    const raw = exactRecord(rawStyles[name], TODO_STYLE_KEYS, `style ${name}`);
    styles[name] = Object.fromEntries(TODO_STYLE_KEYS.map((key) => {
      assert.ok(typeof raw[key] === "string" && raw[key].length <= 1000, "bounded computed style required");
      return [key, raw[key]];
    }));
  }
  assert.ok(typeof row.horizontalOverflow === "number" && Number.isFinite(row.horizontalOverflow) && Math.abs(row.horizontalOverflow) <= 1e7);
  return { layout: layout.value, styles, horizontalOverflow: row.horizontalOverflow };
}
export interface TodoAppearanceDifference { readonly sample: string; readonly box: string; readonly property: string; readonly baseline: string | number; readonly current: string | number }
export function compareTodoAppearance(sample: string, baseline: TodoAppearanceSample, current: TodoAppearanceSample): TodoAppearanceDifference[] {
  assert.deepEqual(current.layout.viewport, baseline.layout.viewport, "comparison viewport changed");
  assert.deepEqual(current.layout.boxes.map((box) => box.name), baseline.layout.boxes.map((box) => box.name), "named element inventory changed");
  assert.ok(baseline.horizontalOverflow <= 1 && current.horizontalOverflow <= 1, "horizontal overflow");
  const differences: TodoAppearanceDifference[] = [];
  baseline.layout.boxes.forEach((old, index) => {
    const next = current.layout.boxes[index];
    assert.ok(next, "missing paired box");
    for (const property of ["x", "y", "width", "height"] as const) {
      if (Math.abs(old[property] - next[property]) > 1) differences.push({ sample, box: old.name, property, baseline: old[property], current: next[property] });
    }
    for (const property of TODO_STYLE_KEYS) {
      const before = baseline.styles[old.name]?.[property];
      const after = current.styles[old.name]?.[property];
      assert.ok(before !== undefined && after !== undefined, "missing paired presentation property");
      if (before !== after) differences.push({ sample, box: old.name, property, baseline: before, current: after });
    }
  });
  return differences;
}
export function assertTodoStable(first: TodoAppearanceSample, second: TodoAppearanceSample): void {
  assert.ok(first.horizontalOverflow <= 1 && second.horizontalOverflow <= 1, "horizontal overflow");
  const checked = validateDirectNamedLayout({ schema: "direct.named-layout-contract/v1", rules: first.layout.boxes.map((box) => ({ id: `stable-${box.name}`, kind: "stable" as const, box: box.name, tolerance: 0.5 })) }, [first.layout, second.layout]);
  assert.deepEqual(checked.violations, [], "layout did not settle");
  assert.deepEqual(first.styles, second.styles, "computed presentation did not settle");
}
