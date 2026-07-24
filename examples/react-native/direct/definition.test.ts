import { describe, expect, test } from "bun:test";
import { SCENARIO_QUERY_KEY } from "@cclrte/direct";

import { deviceStatusDirectDefinition } from "./definition";
import { createDeviceStatusDirectSession } from "./session";

describe("React Native Direct definition", () => {
  test("activates the default and every stable scenario", () => {
    expect(deviceStatusDirectDefinition.activate("")).toMatchObject({
      ok: true,
      value: { scenario: "ios-ready", route: "/" },
    });
    expect(deviceStatusDirectDefinition.activate(
      `?${SCENARIO_QUERY_KEY}=android-dark`,
    )).toMatchObject({
      ok: true,
      value: { scenario: "android-dark", world: { device: { platform: "android" } } },
    });
    expect(deviceStatusDirectDefinition.activate(
      `?${SCENARIO_QUERY_KEY}=missing`,
    )).toMatchObject({ ok: false, error: { code: "unknown-scenario" } });
  });

  test("keeps fixture and direct coverage exact", () => {
    expect(deviceStatusDirectDefinition.coverage.requireExactKeys([
      "device.status.ready",
      "device.status.failure",
      "native.platform.direct",
    ])).toEqual({ ok: true, value: true });

    const created = createDeviceStatusDirectSession("");
    if (!created.ok) throw new Error(created.error.message);
    const snapshot = created.value.coverage;
    expect(snapshot.entries.at(-1)).toMatchObject({
      key: "native.platform.direct",
      mode: "direct",
      scenarios: [],
    });
    created.value.dispose();
  });
});
