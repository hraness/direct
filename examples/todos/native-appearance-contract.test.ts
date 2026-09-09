import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  TODO_APPEARANCE_SCHEMA, TODO_STYLE_KEYS, TODO_NATIVE_PARK_PATH, todoNativeParkUrl, todoNativeParkResponse, admitTodoContext, assertTodoStable, assertTodoStaticCss,
  boundedTodoBatches, compareTodoAppearance, parseTodoAppearanceInput, parseTodoAppearanceSample,
  todoCasePath, parseTodoDriverResult, parseTodoEvaluation, parseTodoNativeTabs, assertTodoTabClosed, assertTodoParkedTabs, assertTodoConsole, parseTodoOwnedClose, withTodoCleanup, exactRecord,
} from "./native-appearance-contract.js";

const build = { directory: "/tmp/owned-build", inventorySha256: "a".repeat(64) };
const source = { repository: "/tmp/source", commit: "a".repeat(40), tree: "b".repeat(40), lockSha256: "c".repeat(64), production: build, direct: build };
const input = {
  schema: TODO_APPEARANCE_SCHEMA, mode: "compare", baseline: source, current: source,
  browser: { driver: "/tmp/driver", driverSha256: "d".repeat(64), executable: "/tmp/browser", executableSha256: "e".repeat(64), version: "152.0.7977.64" },
  artifactParent: "/tmp/private-receipts", port: 5519, canary: null,
};
function sample(x = 20) {
  return { layout: { schema: "direct.named-layout-sample/v1", viewport: { width: 390, height: 844 }, boxes: [{ name: "heading", x, y: 20, width: 200, height: 70 }] }, styles: { heading: Object.fromEntries(TODO_STYLE_KEYS.map((key) => [key, "normal"])) }, horizontalOverflow: 0 };
}
test("native input is an explicit artifact comparison, never a server URL or an implicit output", () => {
  expect(parseTodoAppearanceInput(input).current).toEqual(source);
  for (const candidate of [null, { ...input, extra: true }, { ...input, port: 80 }, { ...input, port: 2.5 }, { ...input, artifactParent: "/" }, { ...input, artifactParent: "https://example.com" }, { ...input, current: { ...source, production: { ...build, directory: "/tmp/../other" } } }, { ...input, browser: { ...input.browser, driverSha256: "latest" } }]) {
    expect(() => parseTodoAppearanceInput(candidate)).toThrow();
  }
});
test("native cleanup runs once and preserves primary, cleanup, and combined failure identities", async () => {
  for (const primaryFails of [false, true]) for (const cleanupFails of [false, true]) {
    const primary = new Error("primary"), cleanup = new Error("cleanup"), order: string[] = [];
    const result = withTodoCleanup(async () => { order.push("work"); if (primaryFails) throw primary; return 42; }, async () => { order.push("cleanup"); if (cleanupFails) throw cleanup; });
    if (primaryFails && cleanupFails) {
      const failure: unknown = await result.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) throw new Error("both failures missing");
      expect(failure.errors).toEqual([primary, cleanup]);
    } else if (primaryFails || cleanupFails) await expect(result).rejects.toBe(primaryFails ? primary : cleanup);
    else expect(await result).toBe(42);
    expect(order).toEqual(["work", "cleanup"]);
  }
});
test("no-respawn close response binds the exact request and true whole-browser closure", () => {
  const response = { id: "exact-request", success: true, data: { closed: true } };
  expect(parseTodoOwnedClose(response, "exact-request")).toEqual({ closed: true });
  for (const invalid of [null, { ...response, id: "foreign" }, { ...response, success: false }, { ...response, data: null }, { ...response, data: { closed: false } }]) expect(() => parseTodoOwnedClose(invalid, "exact-request")).toThrow();
});
const lifecycle = {
  effectiveLaunch: { browserLaunched: true, engine: "chrome", launchHash: 685897992864875800 },
  launched: false, relaunchedBrowser: false, restartedBackground: false,
  restoreStatus: "not_configured", reused: true, saveStatus: "not_attempted",
};
const nativeTab = { active: true, label: null, tabId: "t1", title: "about:blank", type: "page", url: "about:blank" };
test("pinned native response separates validated lifecycle from nullable tab metadata", () => {
  const response = { lifecycle, tabs: [nativeTab] };
  expect(parseTodoNativeTabs(parseTodoDriverResult(response, false))).toEqual([{ tabId: "t1", active: true, url: "about:blank" }]);
  expect(response.lifecycle).toBe(lifecycle);
  expect(parseTodoNativeTabs({ tabs: [{ ...nativeTab, label: "scenario" }] })).toHaveLength(1);
  expect(parseTodoDriverResult({ lifecycle: { ...lifecycle, launched: true }, launched: true }, true)).toEqual({ launched: true });
  // The rounded u64 metadata is deliberately not required to be a safe integer.
  expect(Number.isSafeInteger(lifecycle.effectiveLaunch.launchHash)).toBe(false);
  for (const payload of [{ result: { completed: true } }, { tabId: "t2", total: 2 }]) {
    expect(exactRecord(parseTodoDriverResult({ lifecycle, ...payload }, false), Object.keys(payload), "payload")).toEqual(payload);
    expect(() => exactRecord(parseTodoDriverResult({ lifecycle, ...payload, foreign: true }, false), Object.keys(payload), "payload")).toThrow();
  }
});
test("lifecycle rejects missing, malformed, restored or restarted driver state", () => {
  for (const candidate of [null, {}, { ...lifecycle, foreign: true }, { ...lifecycle, reused: false }, { ...lifecycle, launched: true }, { ...lifecycle, relaunchedBrowser: true }, { ...lifecycle, restartedBackground: true }, { ...lifecycle, restoreStatus: "restored" }, { ...lifecycle, saveStatus: "saved" }, { ...lifecycle, effectiveLaunch: null }, { ...lifecycle, effectiveLaunch: { ...lifecycle.effectiveLaunch, engine: "firefox" } }, { ...lifecycle, effectiveLaunch: { ...lifecycle.effectiveLaunch, browserLaunched: false } }]) {
    expect(() => parseTodoDriverResult({ lifecycle: candidate, result: 1 }, false)).toThrow();
  }
  for (const launchHash of [null, "685897992864875797", -1, 0.5, Infinity, NaN, 2 ** 65]) expect(() => parseTodoDriverResult({ lifecycle: { ...lifecycle, effectiveLaunch: { ...lifecycle.effectiveLaunch, launchHash } }, result: 1 }, false)).toThrow();
  expect(() => parseTodoDriverResult({ result: 1 }, false)).toThrow();
  expect(() => parseTodoDriverResult({ lifecycle, result: 1 }, true)).toThrow();
  expect(() => parseTodoDriverResult(Object.defineProperty({ result: 1 }, "lifecycle", { enumerable: true, get: () => lifecycle }), false)).toThrow();
  expect(() => parseTodoDriverResult({ lifecycle, result: 1, [Symbol("foreign")]: true }, false)).toThrow();
});
test("native evaluation binds its full URL to the exact owned loopback origin", () => {
  const origin = "http://127.0.0.1:5519/direct/?scenario=todos.empty";
  const result = { width: 390, nested: [null, false, 1] };
  expect(parseTodoEvaluation(parseTodoDriverResult({ lifecycle, origin, result }, false), 5519)).toBe(result);
  for (const result of [null, false, 0, "text", [1, 2]]) expect(parseTodoEvaluation({ origin, result }, 5519)).toBe(result);
  for (const invalid of [null, { result }, { origin }, { origin, result, extra: true },
    ...["about:blank", "", "https://127.0.0.1:5519/", "http://localhost:5519/", "http://127.0.0.1:5520/", "http://user:pass@127.0.0.1:5519/", "http://127.1:5519/", "http://127.0.0.1:5519/\n", "http://127.0.0.1:5519/" + "x".repeat(4096)].map((origin) => ({ origin, result }))]) {
    expect(() => parseTodoEvaluation(invalid, 5519)).toThrow();
  }
  for (const port of [80, NaN, 5519.5, 65536]) expect(() => parseTodoEvaluation({ origin, result }, port)).toThrow();
});
test("tab inventory and close preserve exact identities, shape and bounds", () => {
  for (const tabs of [[], Array.from({ length: 33 }, (_, index) => ({ ...nativeTab, tabId: `t${index}`, active: index === 0 })), [nativeTab, nativeTab], [{ ...nativeTab, active: false }], [{ ...nativeTab, label: 1 }], [{ ...nativeTab, label: "x".repeat(4097) }], [{ ...nativeTab, foreign: true }], [{ ...nativeTab, tabId: "foreign" }], [{ ...nativeTab, title: null }]]) expect(() => parseTodoNativeTabs({ tabs })).toThrow();
  expect(() => parseTodoNativeTabs({ lifecycle, tabs: [nativeTab] })).toThrow();
  for (const label of [null, "scenario"]) expect(() => assertTodoTabClosed({ tabId: "t2", label, closed: true }, "t2")).not.toThrow();
  for (const closed of [{ tabId: "t3", label: null, closed: true }, { tabId: "t2", label: null, closed: false }, { tabId: "t2", closed: true }, { tabId: "t2", label: 1, closed: true }, { tabId: "t2", label: null, closed: true, foreign: true }]) expect(() => assertTodoTabClosed(closed, "t2")).toThrow();
});
test("parking preserves the same bounded isolated contexts without claiming disposal", () => {
  const before = [{ tabId: "t1", active: false, url: "about:blank" }, { tabId: "t2", active: true, url: "http://127.0.0.1:5519/" }];
  const parked = before.map((tab, index) => ({ ...tab, url: index === 0 ? "about:blank" : todoNativeParkUrl(5519) }));
  expect(() => assertTodoParkedTabs(before, parked, "t2", 1, 5519)).not.toThrow();
  for (const after of [parked.slice(0, 1), [...parked, { tabId: "t3", active: false, url: "about:blank" }], before,
    parked.map((tab, index) => index === 0 ? { ...tab, tabId: "t9" } : tab), parked.map((tab) => ({ ...tab, active: !tab.active })),
    ...["about:blank", todoNativeParkUrl(5520), todoNativeParkUrl(5519) + "?extra=1", "https://example.com/__todo_native_park"].map((url) => parked.map((tab, index) => index === 0 ? tab : { ...tab, url }))]) expect(() => assertTodoParkedTabs(before, after, "t2", 1, 5519)).toThrow();
  for (const contexts of [0, 2, 9, NaN, 1.5]) expect(() => assertTodoParkedTabs(before, parked, "t2", contexts, 5519)).toThrow();
  expect(() => assertTodoParkedTabs(before, parked, "t1", 1, 5519)).toThrow();
  expect(() => assertTodoParkedTabs(before.map((tab) => ({ ...tab, url: todoNativeParkUrl(5519) })), parked, "t2", 1, 5519)).toThrow();
});
test("parking document is a finite scriptless sandbox at the exact owned loopback port", async () => {
  expect(todoNativeParkUrl(5519)).toBe("http://127.0.0.1:5519" + TODO_NATIVE_PARK_PATH);
  for (const port of [80, NaN, 5519.5, 65536]) expect(() => todoNativeParkUrl(port)).toThrow();
  const response = todoNativeParkResponse();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(await response.text()).toBe('<!doctype html><html><head><meta charset="utf-8"><title>Verification parking</title></head><body></body></html>');
});
test("runtime CSS observation rejects style injection, adopted sheets and foreign fields", () => {
  const valid = { styleNodes: 0, adoptedSheets: 0, mutations: [] };
  expect(() => assertTodoStaticCss(valid)).not.toThrow();
  for (const invalid of [{ ...valid, styleNodes: 1 }, { ...valid, adoptedSheets: 1 }, { ...valid, mutations: ["STYLE insertion"] }, { ...valid, extra: true }]) expect(() => assertTodoStaticCss(invalid)).toThrow();
});
test("native console accepts only its pinned finite payload and rejects errors", () => {
  for (const messages of [[], [{ type: "log", text: "" }], [{ type: "warning", text: "retained", args: [{ type: "string", value: "retained" }] }]]) expect(() => assertTodoConsole({ messages })).not.toThrow();
  for (const messages of [null, [null], [{ type: "log" }], [{ type: "log", text: 1 }], [{ type: "error", text: "failure" }], [{ type: "log", text: "", args: {} }], [{ type: "log", text: "", args: [] }], [{ type: "log", text: "", extra: true }], Array.from({ length: 129 }, () => ({ type: "log", text: "" }))]) expect(() => assertTodoConsole({ messages })).toThrow();
});
test("canary execution requires an exact separately rebuilt artifact and named expected difference", () => {
  expect(() => parseTodoAppearanceInput({ ...input, mode: "canary" })).toThrow();
  const canary = { source, sample: "todos.populated-390/initial", box: "heading", property: "fontSize" };
  expect(parseTodoAppearanceInput({ ...input, mode: "canary", canary }).canary).toEqual(canary);
  expect(() => parseTodoAppearanceInput({ ...input, canary })).toThrow();
  expect(() => parseTodoAppearanceInput({ ...input, mode: "canary", canary: { ...canary, property: "anything" } })).toThrow();
});
test("the ninth context is rejected before window creation; every batch preserves order", () => {
  expect(admitTodoContext(7)).toBe(8);
  for (const count of [8, 9, -1, 1.5, Infinity]) expect(() => admitTodoContext(count)).toThrow();
  fc.assert(fc.property(fc.array(fc.integer(), { maxLength: 100 }), (values) => {
    const batches = boundedTodoBatches(values);
    expect(batches.flat()).toEqual(values);
    expect(batches.every((batch) => batch.length > 0 && batch.length <= 8)).toBe(true);
  }), { numRuns: 50 });
});
test("activation cases use the exported reserved query key and retain explicit malformed input", () => {
  expect(todoCasePath("production")).toBe("/");
  expect(todoCasePath("todos.empty")).toContain("todos.empty");
  const malformed = new URL(todoCasePath("duplicate"), "http://127.0.0.1:5519");
  expect([...malformed.searchParams.values()]).toEqual(["todos.empty", "todos.populated"]);
  expect(todoCasePath("unknown")).toContain("todos.not-declared");
});
test("presentation parser rejects foreign/missing/nonfinite observations", () => {
  expect(parseTodoAppearanceSample(sample()).layout.boxes).toHaveLength(1);
  for (const value of [{ ...sample(), extra: 1 }, { ...sample(), styles: {} }, { ...sample(), horizontalOverflow: NaN }, { ...sample(), styles: { heading: {} } }]) expect(() => parseTodoAppearanceSample(value)).toThrow();
});
test("the comparison detects one-pixel-plus geometry and exact computed presentation changes", () => {
  const baseline = parseTodoAppearanceSample(sample());
  expect(compareTodoAppearance("row", baseline, parseTodoAppearanceSample(sample(20.5)))).toEqual([]);
  expect(compareTodoAppearance("row", baseline, parseTodoAppearanceSample(sample(22)))).toEqual([{ sample: "row", box: "heading", property: "x", baseline: 20, current: 22 }]);
  const changed = sample();
  changed.styles.heading.color = "rgb(255, 0, 0)";
  expect(compareTodoAppearance("row", baseline, parseTodoAppearanceSample(changed))).toEqual([{ sample: "row", box: "heading", property: "color", baseline: "normal", current: "rgb(255, 0, 0)" }]);
  expect(() => assertTodoStable(baseline, parseTodoAppearanceSample(sample(22)))).toThrow();
  expect(() => compareTodoAppearance("row", baseline, parseTodoAppearanceSample({ ...sample(), horizontalOverflow: 10 }))).toThrow();
});
test("descendant-only paint changes cannot hide behind identical parent geometry", () => {
  const fixture = sample();
  fixture.layout.boxes.push({ name: "scenario-description0", x: 24, y: 28, width: 120, height: 18 });
  const styles = { ...fixture.styles, "scenario-description0": Object.fromEntries(TODO_STYLE_KEYS.map((key) => [key, key === "opacity" ? "0.72" : "normal"])) };
  const before = parseTodoAppearanceSample({ ...fixture, styles });
  const after = parseTodoAppearanceSample({ ...fixture, styles: { ...styles, "scenario-description0": { ...styles["scenario-description0"], opacity: "0" } } });
  expect(compareTodoAppearance("child", before, after)).toEqual([{ sample: "child", box: "scenario-description0", property: "opacity", baseline: "0.72", current: "0" }]);
});
