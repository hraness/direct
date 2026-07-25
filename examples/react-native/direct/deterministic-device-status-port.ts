import type { LogicalRuntime } from "@hraness/direct";
import type { DirectActivityScope } from "@hraness/direct/testing";

import {
  cloneDeviceStatus,
  DeviceStatusPortError,
  type DeviceStatus,
  type DeviceStatusPort,
} from "../src/device-status-port";
import type { DeviceStatusDirectWorld } from "./world";

export interface DeterministicDeviceStatusPort extends DeviceStatusPort {
  readonly dispose: () => undefined;
  readonly pendingOperations: () => number;
  readonly remainingWork: () => { readonly pendingOperations: number };
}

function workReason(error: { readonly message: string; readonly workError: unknown }): Error {
  return error.workError instanceof Error
    ? error.workError
    : new DeviceStatusPortError(error.message);
}

export function createDeterministicDeviceStatusPort(options: {
  readonly world: DeviceStatusDirectWorld;
  readonly activity: DirectActivityScope;
  readonly clock: LogicalRuntime;
  readonly signal: AbortSignal;
}): DeterministicDeviceStatusPort {
  let disposed = false;
  let pendingOperations = 0;

  const inspect = async (): Promise<DeviceStatus> => {
    if (disposed || options.signal.aborted) {
      throw new DeviceStatusPortError("The deterministic device status port is disposed.");
    }
    pendingOperations += 1;
    try {
      const result = await options.activity.run("device-inspection", async () => {
        const waited = await options.clock.wait(options.world.inspection.delayMs, options.signal);
        if (!waited.ok) throw new DeviceStatusPortError(waited.error.message);
        if (disposed || options.signal.aborted) {
          throw new DeviceStatusPortError("The deterministic device inspection was cancelled.");
        }
        if (options.world.inspection.failure !== null) {
          throw new DeviceStatusPortError(options.world.inspection.failure);
        }
        return cloneDeviceStatus(options.world.device);
      });
      if (!result.ok) throw workReason(result.error);
      return result.value;
    } finally {
      pendingOperations -= 1;
    }
  };

  return Object.freeze({
    dispose: () => {
      disposed = true;
      return undefined;
    },
    inspect,
    pendingOperations: () => pendingOperations,
    remainingWork: () => Object.freeze({ pendingOperations }),
  });
}
