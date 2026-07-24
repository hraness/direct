import type { DirectSession } from "@cclrte/direct/testing";
import { installDirectBrowser } from "@cclrte/direct/web";

import {
  type DeviceStatusDirectRoute,
} from "./definition";
import {
  createDeviceStatusDirectSession,
  type DeviceStatusDirectHarness,
} from "./session";
import type { DeviceStatusDirectWorld } from "./world";

export type DeviceStatusSession = DirectSession<
  DeviceStatusDirectWorld,
  DeviceStatusDirectRoute,
  DeviceStatusDirectHarness
>;

export interface MountedDeviceStatusDirect {
  readonly session: DeviceStatusSession;
  readonly dispose: () => void;
}

export interface DeviceStatusDirectMountError {
  readonly message: string;
}

export type DeviceStatusDirectMountResult =
  | { readonly ok: true; readonly value: MountedDeviceStatusDirect }
  | { readonly ok: false; readonly error: DeviceStatusDirectMountError };

/** Own one complete browser installation so React effect replay can replace it safely. */
export function mountDeviceStatusDirect(
  source: string,
): DeviceStatusDirectMountResult {
  const created = createDeviceStatusDirectSession(source);
  if (!created.ok) {
    return Object.freeze({
      ok: false,
      error: Object.freeze({ message: created.error.message }),
    });
  }

  const session = created.value;
  const browser = installDirectBrowser({
    session,
    firewall: { onBlocked: session.harness.recordBlockedNetworkRequest },
  });
  if (!browser.ok) {
    session.dispose();
    return Object.freeze({
      ok: false,
      error: Object.freeze({ message: browser.error.message }),
    });
  }

  return Object.freeze({
    ok: true,
    value: Object.freeze({ session, dispose: session.dispose }),
  });
}
