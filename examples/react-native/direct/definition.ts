import { defineDirect } from "@hraness/direct";

import {
  createDeviceStatusDirectWorld,
  parseDeviceStatusDirectWorld,
} from "./world";

export type DeviceStatusDirectRoute = "/";
export type DeviceStatusViewport = "phone" | "tablet";

export const deviceStatusDirectDefinition = defineDirect({
  parseWorld: parseDeviceStatusDirectWorld,
  defaultScenario: "ios-ready",
  scenarios: [
    {
      id: "ios-ready",
      title: "iOS · light",
      description: "A deterministic iOS status succeeds in a phone frame.",
      route: "/",
      world: createDeviceStatusDirectWorld({
        device: {
          platform: "ios",
          colorScheme: "light",
          capturedAt: "2026-01-15T14:30:00.000Z",
        },
      }),
    },
    {
      id: "android-dark",
      title: "Android · dark",
      description: "A deterministic Android status succeeds in a tablet frame.",
      route: "/",
      world: createDeviceStatusDirectWorld({
        device: {
          platform: "android",
          colorScheme: "dark",
          capturedAt: "2026-01-15T14:31:00.000Z",
        },
      }),
    },
    {
      id: "inspection-failure",
      title: "Inspection failure",
      description: "The platform port rejects with a declared deterministic failure.",
      route: "/",
      world: createDeviceStatusDirectWorld({
        device: {
          platform: "ios",
          colorScheme: "light",
          capturedAt: "2026-01-15T14:32:00.000Z",
        },
        failure: "The deterministic device inspection is unavailable.",
      }),
    },
  ],
  coverage: [
    {
      key: "device.status.ready",
      mode: "fixture",
      claim: "The real React Native screen renders successful iOS and Android status values.",
      scenarios: ["ios-ready", "android-dark"],
    },
    {
      key: "device.status.failure",
      mode: "fixture",
      claim: "The real React Native screen renders a declared device-inspection failure.",
      scenarios: ["inspection-failure"],
    },
    {
      key: "native.platform.direct",
      mode: "direct",
      claim: "React Native platform detection, appearance state, layout, and device rendering require direct native evidence.",
      scenarios: [],
    },
  ],
});

export const deviceStatusScenarioMetadata: Readonly<Record<string, {
  readonly group: "Device" | "Failure";
  readonly viewport: DeviceStatusViewport;
}>> = Object.freeze({
  "ios-ready": Object.freeze({ group: "Device", viewport: "phone" }),
  "android-dark": Object.freeze({ group: "Device", viewport: "tablet" }),
  "inspection-failure": Object.freeze({ group: "Failure", viewport: "phone" }),
});
