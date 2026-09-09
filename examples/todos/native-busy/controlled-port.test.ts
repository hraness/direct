import { expect, test } from "bun:test";
import fc from "fast-check";
import { BUSY_FIXTURE_TODOS, createControlledTodoPort, parseBusyOutcome } from "./controlled-port.js";

test("busy activation requires one literal outcome and rejects duplicates/foreign keys", () => {
  expect(parseBusyOutcome("?outcome=success")).toBe("success");
  expect(parseBusyOutcome("?outcome=failure")).toBe("failure");
  for (const input of ["", "?outcome=success&outcome=success", "?extra=success", "?outcome=success&extra=1", "?outcome=unknown"]) expect(() => parseBusyOutcome(input)).toThrow();
});

test("real read and write promises stay pending until matching one-shot release", async () => {
  for (const outcome of ["success", "failure"] as const) {
    const fixture = createControlledTodoPort(outcome);
    expect(fixture.inspect().phase).toBe("created");
    let readSettled = false;
    const read = fixture.port.readTodos().then((todos) => { readSettled = true; return todos; });
    await Promise.resolve(); await Promise.resolve();
    expect(readSettled).toBe(false); expect(fixture.inspect().phase).toBe("read-pending");
    fixture.release({ operation: "read", ticket: 1 });
    expect(await read).toEqual(BUSY_FIXTURE_TODOS);
    expect(fixture.inspect().phase).toBe("ready");
    let writeSettled = false;
    const write = fixture.port.setCompleted("write-docs", true).then((todos) => { writeSettled = true; return { ok: true, todos }; }, (error: unknown) => { writeSettled = true; return { ok: false, error }; });
    await Promise.resolve(); await Promise.resolve();
    expect(writeSettled).toBe(false); expect(fixture.inspect().phase).toBe("write-pending");
    expect(fixture.inspect().requested).toEqual({ id: "write-docs", completed: true });
    expect(fixture.inspect().todos).toEqual(BUSY_FIXTURE_TODOS);
    fixture.release({ operation: "write", ticket: 2 });
    const result = await write;
    expect(result.ok).toBe(outcome === "success");
    expect(fixture.inspect().todos.map((todo) => todo.completed)).toEqual(outcome === "success" ? [true, true] : [false, true]);
    expect(fixture.inspect()).toMatchObject({ phase: "finished", readCalls: 1, writeCalls: 1, violations: 0 });
    fixture.dispose(); expect(fixture.inspect().phase).toBe("disposed");
  }
});

test("duplicate and out-of-order release never settle or replace the live operation", async () => {
  const fixture = createControlledTodoPort("success");
  expect(() => fixture.release({ operation: "read", ticket: 1 })).toThrow();
  const read = fixture.port.readTodos();
  let getterCalls = 0;
  const getterCommand = { get operation() { getterCalls += 1; return "read"; }, ticket: 1 };
  for (const command of [{ operation: "write", ticket: 2 }, { operation: "read", ticket: 2 }, { operation: "read", ticket: 1, extra: true }, null, getterCommand]) expect(() => fixture.release(command)).toThrow();
  expect(getterCalls).toBe(0);
  expect(fixture.inspect().phase).toBe("read-pending");
  fixture.release({ operation: "read", ticket: 1 }); await read;
  expect(() => fixture.release({ operation: "read", ticket: 1 })).toThrow();
  const write = fixture.port.setCompleted("write-docs", true);
  expect(() => fixture.release({ operation: "read", ticket: 1 })).toThrow();
  expect(fixture.inspect().phase).toBe("write-pending");
  fixture.release({ operation: "write", ticket: 2 }); await write;
  expect(() => fixture.release({ operation: "write", ticket: 2 })).toThrow();
});

test("concurrent writes and reads are rejected without renewing or resolving pending work", async () => {
  const fixture = createControlledTodoPort("success");
  const read = fixture.port.readTodos();
  await expect(fixture.port.readTodos()).rejects.toThrow("unexpected read");
  await expect(fixture.port.setCompleted("write-docs", true)).rejects.toThrow("unexpected or concurrent write");
  fixture.release({ operation: "read", ticket: 1 }); await read;
  const write = fixture.port.setCompleted("write-docs", true);
  await expect(fixture.port.setCompleted("scan-bundle", false)).rejects.toThrow("unexpected or concurrent write");
  expect(fixture.inspect().requested).toEqual({ id: "write-docs", completed: true });
  expect(fixture.inspect().phase).toBe("write-pending");
  fixture.release({ operation: "write", ticket: 2 });
  expect((await write).map((todo) => todo.completed)).toEqual([true, true]);
});

test("disposal rejects each admitted pending promise once and forbids later work", async () => {
  for (const operation of ["read", "write"] as const) {
    const fixture = createControlledTodoPort("success");
    const read = fixture.port.readTodos();
    let pending = read;
    if (operation === "write") { fixture.release({ operation: "read", ticket: 1 }); await read; pending = fixture.port.setCompleted("write-docs", true); }
    const settled = pending.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    fixture.dispose(); fixture.dispose();
    const result = await settled;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("disposed operation unexpectedly fulfilled");
    expect(result.error).toBeInstanceOf(Error);
    if (!(result.error instanceof Error)) throw new Error("disposed operation rejected without an Error");
    expect(result.error.message).toContain("disposed");
    await expect(fixture.port.readTodos()).rejects.toThrow();
    await expect(fixture.port.setCompleted("write-docs", true)).rejects.toThrow();
  }
});

test("read/write release law preserves exact requested update and immutable snapshots", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (completed, fails) => {
    const fixture = createControlledTodoPort(fails ? "failure" : "success");
    const read = fixture.port.readTodos(); fixture.release({ operation: "read", ticket: 1 }); await read;
    const snapshot = fixture.inspect();
    expect(Object.isFrozen(snapshot)).toBe(true); expect(Object.isFrozen(snapshot.todos)).toBe(true);
    expect(snapshot.todos.every(Object.isFrozen)).toBe(true);
    const write = fixture.port.setCompleted("write-docs", completed).then(() => true, () => false);
    fixture.release({ operation: "write", ticket: 2 }); expect(await write).toBe(!fails);
    expect(snapshot.todos).toEqual(BUSY_FIXTURE_TODOS);
    expect(fixture.inspect().todos).toEqual(BUSY_FIXTURE_TODOS.map((todo) => todo.id === "write-docs" && !fails ? { ...todo, completed } : todo));
    expect(fixture.inspect().violations).toBe(0);
  }), { numRuns: 40 });
});
