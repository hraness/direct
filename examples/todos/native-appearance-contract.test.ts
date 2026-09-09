import { expect, test } from "bun:test";
import fc from "fast-check";
import {
  TODO_APPEARANCE_SCHEMA, TODO_STYLE_KEYS, admitTodoContext, assertTodoStable, assertTodoStaticCss,
  boundedTodoBatches, compareTodoAppearance, parseTodoAppearanceInput, parseTodoAppearanceSample,
  todoCasePath, parseTodoOwnedClose, withTodoCleanup,
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
test("runtime CSS observation rejects style injection, adopted sheets and foreign fields", () => {
  const valid = { styleNodes: 0, adoptedSheets: 0, mutations: [] };
  expect(() => assertTodoStaticCss(valid)).not.toThrow();
  for (const invalid of [{ ...valid, styleNodes: 1 }, { ...valid, adoptedSheets: 1 }, { ...valid, mutations: ["STYLE insertion"] }, { ...valid, extra: true }]) expect(() => assertTodoStaticCss(invalid)).toThrow();
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
