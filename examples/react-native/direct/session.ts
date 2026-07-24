import { createDirectSession } from "@cclrte/direct/testing";

import type { DeviceStatusPort } from "../src/device-status-port";
import {
  deviceStatusDirectDefinition,
} from "./definition";
import { createDeterministicDeviceStatusPort } from "./deterministic-device-status-port";

export interface DeviceStatusDirectHarness {
  readonly port: DeviceStatusPort;
  readonly pendingOperations: () => number;
  readonly blockedNetworkRequests: () => number;
  readonly recordBlockedNetworkRequest: () => void;
  readonly remainingWork: () => {
    readonly deviceStatus: { readonly pendingOperations: number };
    readonly blockedNetworkRequests: number;
  };
}

export function createDeviceStatusDirectSession(source: string) {
  return createDirectSession({
    definition: deviceStatusDirectDefinition,
    activation: { kind: "query", source },
    create: (context): DeviceStatusDirectHarness => {
      const port = createDeterministicDeviceStatusPort({
        world: context.world,
        activity: context.activity,
        clock: context.clock,
        signal: context.signal,
      });
      context.onDispose(port.dispose);
      let blockedNetworkRequests = 0;
      return Object.freeze({
        port,
        pendingOperations: port.pendingOperations,
        blockedNetworkRequests: () => blockedNetworkRequests,
        recordBlockedNetworkRequest: () => {
          blockedNetworkRequests += 1;
        },
        remainingWork: () => Object.freeze({
          deviceStatus: port.remainingWork(),
          blockedNetworkRequests,
        }),
      });
    },
    observe: (harness) => ({
      pending: [{ name: "deviceInspections", read: harness.pendingOperations }],
      violations: [{ name: "blockedNetworkRequests", read: harness.blockedNetworkRequests }],
      readRemainingWork: harness.remainingWork,
    }),
  });
}
