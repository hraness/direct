import { describe, expect, test } from "bun:test";

import {
  createDeviceStatusDirectWorld,
  parseDeviceStatusDirectWorld,
} from "./world";

describe("React Native Direct world", () => {
  test("parses and freezes an owned versioned world", () => {
    const world = createDeviceStatusDirectWorld({
      device: {
        platform: "ios",
        colorScheme: "dark",
        capturedAt: "2026-02-03T04:05:06.000Z",
      },
      delayMs: 25,
    });
    const roundTripped = parseDeviceStatusDirectWorld(
      JSON.parse(JSON.stringify(world)) as unknown,
    );

    expect(roundTripped).toEqual(world);
    expect(Object.isFrozen(roundTripped)).toBeTrue();
    expect(Object.isFrozen(roundTripped.device)).toBeTrue();
    expect(Object.isFrozen(roundTripped.inspection)).toBeTrue();
  });

  test("rejects unknown keys, unsupported versions, and noncanonical values", () => {
    expect(() => parseDeviceStatusDirectWorld({
      version: 1,
      device: {
        platform: "ios",
        colorScheme: "light",
        capturedAt: "2026-02-03T04:05:06.000Z",
      },
      inspection: { delayMs: 0, failure: null },
      extra: true,
    })).toThrow("unknown key");
    expect(() => parseDeviceStatusDirectWorld({
      version: 2,
      device: {},
      inspection: {},
    })).toThrow("version must be 1");
    expect(() => createDeviceStatusDirectWorld({
      device: {
        platform: "android",
        colorScheme: "light",
        capturedAt: "not-a-date",
      },
    })).toThrow("canonical ISO timestamp");
    expect(() => createDeviceStatusDirectWorld({
      device: {
        platform: "android",
        colorScheme: "dark",
        capturedAt: "2026-02-03T04:05:06.000Z",
      },
      delayMs: 10_001,
    })).toThrow("0 through 10000");
  });

  test("rejects accessors without invoking them", () => {
    let getterWasRead = false;
    const input: Record<string, unknown> = {
      version: 1,
      inspection: { delayMs: 0, failure: null },
    };
    Object.defineProperty(input, "device", {
      enumerable: true,
      get: () => {
        getterWasRead = true;
        return {};
      },
    });

    expect(() => parseDeviceStatusDirectWorld(input)).toThrow("data property");
    expect(getterWasRead).toBeFalse();
  });
});
