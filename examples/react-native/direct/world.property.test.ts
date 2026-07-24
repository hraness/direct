import { expect, test } from "bun:test";
import fc from "fast-check";

import {
  createDeviceStatusDirectWorld,
  parseDeviceStatusDirectWorld,
} from "./world";

test("valid React Native worlds round-trip through JSON", () => {
  fc.assert(fc.property(
    fc.constantFrom("android" as const, "ios" as const),
    fc.constantFrom("dark" as const, "light" as const),
    fc.integer({ min: 0, max: 4_102_444_800_000 }),
    fc.integer({ min: 0, max: 10_000 }),
    fc.option(fc.string({ minLength: 1, maxLength: 80 }).filter((value) => value.trim().length > 0), {
      nil: null,
    }),
    (platform, colorScheme, timestamp, delayMs, failure) => {
      const world = createDeviceStatusDirectWorld({
        device: {
          platform,
          colorScheme,
          capturedAt: new Date(timestamp).toISOString(),
        },
        delayMs,
        failure,
      });
      expect(parseDeviceStatusDirectWorld(
        JSON.parse(JSON.stringify(world)) as unknown,
      )).toEqual(world);
    },
  ), {
    interruptAfterTimeLimit: 10_000,
    markInterruptAsFailure: true,
    numRuns: 200,
  });
});
