import { expect, test } from "bun:test";
import { assertBusyPaintObservation, BUSY_PAINT_PHASES, type BusyPaintPhase } from "./native-proof.js";
import { BUSY_FIXTURE_SCHEMA, BUSY_FIXTURE_TODOS, type BusyOutcome } from "./controlled-port.js";

function observation(width: 1280 | 390, outcome: BusyOutcome, phase: BusyPaintPhase) {
  const written = phase === "write-pending" || phase === "finished";
  const todos = BUSY_FIXTURE_TODOS.map(todo => todo.id === "write-docs" && phase === "finished" && outcome === "success" ? { ...todo, completed: true } : { ...todo });
  return {
    snapshot: { schema: BUSY_FIXTURE_SCHEMA, outcome, phase, readCalls: 1, writeCalls: written ? 1 : 0, violations: 0,
      requested: written ? { id: "write-docs", completed: true } : null, todos },
    width, height: width === 1280 ? 900 : 844, dpr: 1,
    busy: phase === "read-pending" || phase === "write-pending" ? "true" : "false", heading: "Today",
    loading: phase === "read-pending" ? ["Loading todos…"] : [],
    inputs: phase === "read-pending" ? [] : todos.map(todo => ({ checked: todo.completed, disabled: phase === "write-pending", title: todo.title })),
    alerts: phase === "finished" && outcome === "failure" ? ["The controlled store rejected this change."] : [], bridge: false,
  };
}

test("busy paint requires matching promises and native DOM at every finite viewport/outcome/phase", () => {
  for (const width of [1280, 390] as const) for (const outcome of ["success", "failure"] as const) for (const phase of BUSY_PAINT_PHASES) {
    const value = observation(width, outcome, phase);
    expect(() => assertBusyPaintObservation(value, width, outcome, phase)).not.toThrow();
    for (const changed of [
      { ...value, unknown: true }, { ...value, busy: value.busy === "true" ? "false" : "true" },
      { ...value, bridge: true }, { ...value, heading: "Fixture-only UI" }, { ...value, width: width + 1 },
      { ...value, dpr: 2 }, { ...value, snapshot: { ...value.snapshot, violations: 1 } },
      { ...value, snapshot: { ...value.snapshot, readCalls: 2 } },
      { ...value, snapshot: { ...value.snapshot, writeCalls: value.snapshot.writeCalls + 1 } },
      { ...value, snapshot: { ...value.snapshot, unexpected: true } },
    ]) expect(() => assertBusyPaintObservation(changed, width, outcome, phase)).toThrow();
  }
});

test("pending write proof rejects enabled controls, eager mutation and wrong requested work", () => {
  const value = observation(390, "success", "write-pending");
  for (const changed of [
    { ...value, inputs: value.inputs.map(input => ({ ...input, disabled: false })) },
    { ...value, inputs: value.inputs.map(input => ({ ...input, checked: true })) },
    { ...value, snapshot: { ...value.snapshot, requested: { id: "scan-bundle", completed: false } } },
    { ...value, snapshot: { ...value.snapshot, phase: "finished" } },
  ]) expect(() => assertBusyPaintObservation(changed, 390, "success", "write-pending")).toThrow();
  const failure = observation(390, "failure", "finished");
  expect(() => assertBusyPaintObservation({ ...failure, alerts: [] }, 390, "failure", "finished")).toThrow();
  expect(() => assertBusyPaintObservation(observation(390, "success", "finished"), 390, "failure", "finished")).toThrow();
});
