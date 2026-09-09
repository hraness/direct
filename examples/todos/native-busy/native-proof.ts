import assert from "node:assert/strict";
import type { AgentBrowser } from "@hraness/direct/tooling/browser-verification";
import { exactRecord, withTodoCleanup } from "../native-appearance-contract.js";
import { BUSY_FIXTURE_SCHEMA, BUSY_FIXTURE_TODOS, type BusyOutcome } from "./controlled-port.js";

export type BusyPaintPhase = "read-pending" | "ready" | "write-pending" | "finished";
export const BUSY_PAINT_PHASES = ["read-pending", "ready", "write-pending", "finished"] as const;
export const BUSY_PAINT_PATH = "/native-busy/index.html";
const renderPaint = `(async () => { await document.fonts.ready; await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); return true; })()`;
const observationProgram = `(() => {
  const main = document.querySelector('main[aria-busy]');
  const inputs = [...document.querySelectorAll('input[type=checkbox]')];
  return {
    snapshot: window.__todoBusyFixture?.inspect() ?? null,
    width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
    busy: main?.getAttribute('aria-busy') ?? null,
    heading: main?.querySelector('h1')?.textContent ?? null,
    loading: main ? [...main.children].filter(node => node.tagName === 'P').map(node => node.textContent) : [],
    inputs: inputs.map(input => ({ checked: input.checked, disabled: input.disabled, title: input.closest('label')?.querySelector('span')?.textContent ?? null })),
    alerts: [...document.querySelectorAll('[role=alert] p')].map(node => node.textContent),
    bridge: Object.hasOwn(window, '__direct')
  };
})()`;

/** Bind controlled promises and the real component's semantic response in one
 * synchronous native sample. This never substitutes fixture state for DOM state. */
export function assertBusyPaintObservation(value: unknown, width: 1280 | 390, outcome: BusyOutcome, phase: BusyPaintPhase): void {
  assert.ok(width === 1280 || width === 390);
  assert.ok(outcome === "success" || outcome === "failure");
  assert.ok(BUSY_PAINT_PHASES.includes(phase));
  const record = exactRecord(value, ["snapshot", "width", "height", "dpr", "busy", "heading", "loading", "inputs", "alerts", "bridge"], "busy paint observation");
  const afterWrite = phase === "finished";
  const written = phase === "write-pending" || afterWrite;
  const completed = afterWrite && outcome === "success";
  const todos = BUSY_FIXTURE_TODOS.map(todo => todo.id === "write-docs" && completed ? { ...todo, completed: true } : { ...todo });
  assert.deepEqual(record.snapshot, {
    schema: BUSY_FIXTURE_SCHEMA, outcome, phase, readCalls: 1, writeCalls: written ? 1 : 0, violations: 0,
    requested: written ? { id: "write-docs", completed: true } : null, todos,
  });
  assert.equal(record.width, width); assert.equal(record.height, width === 1280 ? 900 : 844); assert.equal(record.dpr, 1);
  assert.equal(record.heading, "Today"); assert.equal(record.bridge, false);
  assert.equal(record.busy, phase === "read-pending" || phase === "write-pending" ? "true" : "false");
  assert.deepEqual(record.loading, phase === "read-pending" ? ["Loading todos…"] : []);
  assert.deepEqual(record.inputs, phase === "read-pending" ? [] : todos.map(todo => ({ checked: todo.completed, disabled: phase === "write-pending", title: todo.title })));
  assert.deepEqual(record.alerts, afterWrite && outcome === "failure" ? ["The controlled store rejected this change."] : []);
}

/** Caller owns the fresh context, source/build identities, bounded screenshots,
 * CSS/geometry comparison and final whole-browser/server collection. */
export async function proveBusyPaintCase(
  browser: Pick<AgentBrowser, "run" | "evaluate">,
  baseUrl: string,
  width: 1280 | 390,
  outcome: BusyOutcome,
  observe: (phase: BusyPaintPhase) => Promise<void>,
): Promise<void> {
  const origin = new URL(baseUrl);
  assert.equal(origin.hostname, "127.0.0.1"); assert.equal(origin.protocol, "http:");
  assert.ok(Number(origin.port) >= 1024 && Number(origin.port) <= 65535);
  assert.equal(origin.href, `${origin.origin}/`);
  assert.ok(width === 1280 || width === 390); assert.ok(outcome === "success" || outcome === "failure");
  const sample = async (phase: BusyPaintPhase) => {
    // Pending operations must remain pending while fonts and two frames settle.
    // Deliberately do not invoke the settled/quiescent appearance helper.
    await browser.evaluate(renderPaint);
    assertBusyPaintObservation(await browser.evaluate(observationProgram), width, outcome, phase);
  };
  const waitForPhase = async (phase: BusyPaintPhase) => {
    const busy = phase === "read-pending" || phase === "write-pending";
    await browser.run(["wait", "--fn", `window.__todoBusyFixture?.inspect().phase === ${JSON.stringify(phase)} && document.querySelector('main[aria-busy]')?.getAttribute('aria-busy') === '${String(busy)}'`, "--timeout", "15000"]);
    await sample(phase);
  };
  await browser.run(["set", "viewport", String(width), width === 1280 ? "900" : "844", "1"]);
  await browser.run(["set", "media", "light", "reduced-motion"]);
  await browser.run(["open", `${origin.origin}${BUSY_PAINT_PATH}?outcome=${outcome}`]);
  await waitForPhase("read-pending"); await observe("read-pending"); await sample("read-pending");
  await browser.evaluate("window.__todoBusyFixture.release({operation:'read',ticket:1}); true");
  await waitForPhase("ready"); await observe("ready");
  let focused = false;
  for (let attempt = 0; attempt < 24; attempt++) {
    if (await browser.evaluate("document.activeElement === document.querySelector('input[type=checkbox]')") === true) { focused = true; break; }
    await browser.run(["press", "Tab"]);
  }
  assert.equal(focused, true, "first real checkbox not reached through native keyboard");
  assert.equal(await browser.evaluate(`(() => {
    const input = document.querySelector('input[type=checkbox]');
    if (!(input instanceof HTMLInputElement) || input.disabled || !input.matches(':focus-visible')) return false;
    const style = getComputedStyle(input), rect = input.getBoundingClientRect();
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)' &&
      rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight &&
      document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2) === input;
  })()`), true, "native focus must be visible, uncovered and in the viewport");
  await browser.run(["press", "Space"]);
  await waitForPhase("write-pending"); await observe("write-pending"); await sample("write-pending");
  const point = exactRecord(await browser.evaluate(`(() => {
    const input = document.querySelector('input[type=checkbox]');
    if (!(input instanceof HTMLInputElement) || !input.disabled) throw new Error('real disabled input required');
    const rect = input.getBoundingClientRect(), x = Math.round(rect.x + rect.width / 2), y = Math.round(rect.y + rect.height / 2);
    if (rect.width <= 0 || rect.height <= 0 || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || document.elementFromPoint(x,y) !== input) throw new Error('disabled input is not natively hittable');
    return {x,y};
  })()`), ["x", "y"], "disabled native input point");
  assert.ok(typeof point.x === "number" && Number.isSafeInteger(point.x) && typeof point.y === "number" && Number.isSafeInteger(point.y));
  await browser.run(["mouse", "move", String(point.x), String(point.y)]);
  // Pinned driver mouse down/up sends real pointer input. Never force-enable the
  // control or invoke its port/change handler directly to simulate rejection.
  await withTodoCleanup(() => browser.run(["mouse", "down", "left"]), async () => { await browser.run(["mouse", "up", "left"]); });
  await sample("write-pending");
  await browser.evaluate("window.__todoBusyFixture.release({operation:'write',ticket:2}); true");
  await waitForPhase("finished"); await observe("finished"); await sample("finished");
}
