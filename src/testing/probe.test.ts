import { describe, expect, test } from "bun:test";

import { operationId } from "../core/ids.js";
import { createDirectStore } from "../core/store.js";
import { parseTestWorld } from "../core/test-support.js";
import {
  DIRECT_PROBE_SCHEMA,
  MAX_DIRECT_PROBE_COUNTERS,
  createDirectProbe,
  parseDirectProbeSnapshot,
} from "./probe.js";

function storeFixture() {
  const store = createDirectStore({ count: 0, messages: [] }, parseTestWorld);
  if (!store.ok) throw new Error(store.error.message);
  return store.value;
}

function hostileThrownValue(): Error {
  return new Proxy(new Error("hostile"), {
    get: () => {
      throw new Error("hostile message getter");
    },
    getPrototypeOf: () => {
      throw new Error("hostile prototype");
    },
  });
}

describe("Direct probe", () => {
  test("parses the canonical wire snapshot and rejects inconsistent quiescence", () => {
    const probe = createDirectProbe({
      store: storeFixture(),
      activationHash: "wire-hash",
      pending: [{ name: "requests", read: () => 0 }],
      violations: [{ name: "network", read: () => 1 }],
      readRemainingWork: () => ({ scripts: 2 }),
    });
    if (!probe.ok) throw new Error(probe.error.message);
    const snapshot = probe.value.snapshot();
    if (!snapshot.ok) throw new Error(snapshot.error.message);

    expect(parseDirectProbeSnapshot(JSON.parse(JSON.stringify(snapshot.value)))).toEqual(snapshot);
    expect(parseDirectProbeSnapshot({
      ...snapshot.value,
      isQuiescent: false,
    })).toMatchObject({ ok: false, error: { code: "invalid-snapshot" } });
    expect(parseDirectProbeSnapshot({
      ...snapshot.value,
      surprise: true,
    })).toMatchObject({ ok: false, error: { code: "invalid-snapshot" } });
  });

  test("rejects snapshots impossible under store revision and generation conservation", () => {
    const base = {
      schema: DIRECT_PROBE_SCHEMA,
      activationHash: "wire-hash",
      generation: 1,
      revision: 0,
      activity: { active: 0, started: 0, settled: 0 },
      pending: {},
      violations: {},
      remainingWork: {},
      isQuiescent: true,
    };
    expect(parseDirectProbeSnapshot({
      ...base,
      activity: { active: 1, started: 1, settled: 0 },
      isQuiescent: false,
    })).toMatchObject({ ok: false, error: { code: "invalid-snapshot" } });
    expect(parseDirectProbeSnapshot({
      ...base,
      generation: 2,
    })).toMatchObject({ ok: false, error: { code: "invalid-snapshot" } });
  });

  test("captures validated options instead of retaining mutable caller configuration", () => {
    const store = storeFixture();
    const options = { store, activationHash: "captured-hash" };
    const probe = createDirectProbe(options);
    if (!probe.ok) throw new Error(probe.error.message);

    options.activationHash = "";
    const otherStore = storeFixture();
    const started = otherStore.beginActivity(otherStore.getSnapshot().generation, operationId("other-000001"));
    if (!started.ok) throw new Error(started.error.message);
    options.store = otherStore;

    const snapshot = probe.value.snapshot();
    expect(snapshot).toMatchObject({
      ok: true,
      value: { activationHash: "captured-hash", activity: { active: 0 } },
    });
    if (!snapshot.ok) throw new Error(snapshot.error.message);
    expect(parseDirectProbeSnapshot(snapshot.value)).toEqual(snapshot);
    expect(started.value.settle()).toMatchObject({ ok: true });
  });

  test("publishes a versioned JSON-safe snapshot with explicit quiescence gates", () => {
    const store = storeFixture();
    let pendingScripts = 1;
    let blockedNetwork = 2;
    const probe = createDirectProbe({
      store,
      activationHash: "fnv1a-64:0123456789abcdef",
      pending: [{ name: "scripts", read: () => pendingScripts }],
      violations: [{ name: "blockedNetwork", read: () => blockedNetwork }],
      readRemainingWork: () => ({ completions: 3 }),
    });
    if (!probe.ok) throw new Error(probe.error.message);

    const busy = probe.value.snapshot();
    expect(busy).toMatchObject({
      ok: true,
      value: {
        schema: DIRECT_PROBE_SCHEMA,
        pending: { scripts: 1 },
        violations: { blockedNetwork: 2 },
        remainingWork: { completions: 3 },
        isQuiescent: false,
      },
    });
    if (!busy.ok) throw new Error(busy.error.message);
    expect(JSON.parse(JSON.stringify(busy.value))).toEqual(busy.value);

    pendingScripts = 0;
    blockedNetwork = 9;
    expect(probe.value.isQuiescent()).toEqual({ ok: true, value: true });

    const generation = store.getSnapshot().generation;
    const lease = store.beginActivity(generation, operationId("probe-000001"));
    if (!lease.ok) throw new Error(lease.error.message);
    expect(probe.value.isQuiescent()).toEqual({ ok: true, value: false });
    lease.value.settle();
    expect(probe.value.isQuiescent()).toEqual({ ok: true, value: true });
  });

  test("rejects malformed names and validates dynamic reads", () => {
    const store = storeFixture();
    expect(createDirectProbe({
      store,
      activationHash: "hash",
      pending: [{ name: "Bad name", read: () => 0 }],
    })).toMatchObject({ ok: false, error: { code: "invalid-counter-name" } });

    const negative = createDirectProbe({
      store,
      activationHash: "hash",
      pending: [{ name: "requests", read: () => -1 }],
    });
    if (!negative.ok) throw new Error(negative.error.message);
    expect(negative.value.snapshot()).toMatchObject({
      ok: false,
      error: { code: "invalid-counter", counter: "requests" },
    });

    const invalidDiagnostics = createDirectProbe({
      store,
      activationHash: "hash",
      readRemainingWork: (() => ({ value: undefined })) as unknown as () => never,
    });
    if (!invalidDiagnostics.ok) throw new Error(invalidDiagnostics.error.message);
    expect(invalidDiagnostics.value.snapshot()).toMatchObject({
      ok: false,
      error: { code: "invalid-remaining-work" },
    });
  });

  test("rejects duplicate category names and invalid activation hashes", () => {
    const store = storeFixture();
    expect(createDirectProbe({ store, activationHash: "" })).toMatchObject({
      ok: false,
      error: { code: "invalid-activation-hash" },
    });
    expect(createDirectProbe({
      store,
      activationHash: null as unknown as string,
    })).toMatchObject({ ok: false, error: { code: "invalid-activation-hash" } });
    expect(createDirectProbe({
      store,
      activationHash: "hash",
      violations: [
        { name: "network", read: () => 0 },
        { name: "network", read: () => 1 },
      ],
    })).toMatchObject({ ok: false, error: { code: "duplicate-counter" } });
  });

  test("hostile counter and remaining-work rejections stay structured", () => {
    const store = storeFixture();
    const hostile = hostileThrownValue();
    const counterProbe = createDirectProbe({
      store,
      activationHash: "hostile-counter",
      pending: [{
        name: "hostile",
        read: () => {
          throw hostile;
        },
      }],
    });
    if (!counterProbe.ok) throw new Error(counterProbe.error.message);
    expect(counterProbe.value.snapshot()).toEqual({
      ok: false,
      error: {
        code: "probe-read-failed",
        message: "Failed to read hostile",
        counter: "hostile",
      },
    });

    const remainingProbe = createDirectProbe({
      store,
      activationHash: "hostile-remaining",
      readRemainingWork: () => {
        throw hostile;
      },
    });
    if (!remainingProbe.ok) throw new Error(remainingProbe.error.message);
    expect(remainingProbe.value.snapshot()).toEqual({
      ok: false,
      error: {
        code: "probe-read-failed",
        message: "Failed to read remaining work",
        counter: null,
      },
    });
  });

  test("contains asynchronous counter and remaining-work rejections", async () => {
    const store = storeFixture();
    const counterProbe = createDirectProbe({
      store,
      activationHash: "async-counter",
      pending: [{
        name: "requests",
        read: (() => Promise.reject(new Error("counter rejected"))) as unknown as () => number,
      }],
    });
    if (!counterProbe.ok) throw new Error(counterProbe.error.message);
    expect(counterProbe.value.snapshot()).toMatchObject({
      ok: false,
      error: { code: "asynchronous-read", counter: "requests" },
    });

    const remainingProbe = createDirectProbe({
      store,
      activationHash: "async-remaining",
      readRemainingWork: (() => Promise.reject(new Error("remaining rejected"))) as unknown as () => never,
    });
    if (!remainingProbe.ok) throw new Error(remainingProbe.error.message);
    expect(remainingProbe.value.snapshot()).toMatchObject({
      ok: false,
      error: { code: "asynchronous-read", counter: null },
    });
    await Promise.resolve();
  });

  test("rejects hostile counter definitions and the combined counter limit as Results", () => {
    const store = storeFixture();
    const hostile = Object.defineProperty({}, "name", {
      get: () => { throw new Error("name getter failed"); },
    });
    expect(createDirectProbe({
      store,
      activationHash: "hostile-source",
      pending: [hostile] as unknown as [],
    })).toMatchObject({ ok: false, error: { code: "invalid-counter-source" } });

    expect(createDirectProbe({
      store,
      activationHash: "too-many",
      pending: Array.from({ length: MAX_DIRECT_PROBE_COUNTERS + 1 }, (_, index) => ({
        name: `counter${String(index)}`,
        read: () => 0,
      })),
    })).toMatchObject({ ok: false, error: { code: "too-many-counters" } });
  });
});
