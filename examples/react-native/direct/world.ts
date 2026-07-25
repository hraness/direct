import type { JsonValue } from "@hraness/direct";

import {
  type DeviceColorScheme,
  type DevicePlatform,
  type DeviceStatus,
} from "../src/device-status-port";

export type DeviceStatusDirectWorld = {
  readonly [key: string]: JsonValue;
  readonly version: 1;
  readonly device: {
    readonly [key: string]: JsonValue;
    readonly platform: DevicePlatform;
    readonly colorScheme: DeviceColorScheme;
    readonly capturedAt: string;
  };
  readonly inspection: {
    readonly [key: string]: JsonValue;
    readonly delayMs: number;
    readonly failure: string | null;
  };
};

const WORLD_KEYS = new Set(["version", "device", "inspection"]);
const DEVICE_KEYS = new Set(["platform", "colorScheme", "capturedAt"]);
const INSPECTION_KEYS = new Set(["delayMs", "failure"]);

function exactRecord(
  input: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must have a JSON object prototype.`);
  }
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      throw new Error(`${label} has an unknown key: ${String(key)}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label}.${key} must be an enumerable data property.`);
    }
    record[key] = descriptor.value;
  }
  return record;
}

function parsePlatform(input: unknown): DevicePlatform {
  if (input !== "android" && input !== "ios") {
    throw new Error("Device status platform must be android or ios.");
  }
  return input;
}

function parseColorScheme(input: unknown): DeviceColorScheme {
  if (input !== "dark" && input !== "light") {
    throw new Error("Device status colorScheme must be dark or light.");
  }
  return input;
}

function parseTimestamp(input: unknown): string {
  if (typeof input !== "string" || input.length > 40) {
    throw new Error("Device status capturedAt must be a bounded ISO timestamp.");
  }
  const timestamp = new Date(input);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== input) {
    throw new Error("Device status capturedAt must be a canonical ISO timestamp.");
  }
  return input;
}

function parseFailure(input: unknown): string | null {
  if (input === null) return null;
  if (typeof input !== "string" || input.trim().length === 0 || input.length > 200) {
    throw new Error("Device inspection failure must be null or 1-200 visible characters.");
  }
  return input;
}

export function parseDeviceStatusDirectWorld(input: unknown): DeviceStatusDirectWorld {
  const world = exactRecord(input, WORLD_KEYS, "React Native Direct world");
  if (world.version !== 1) throw new Error("React Native Direct world version must be 1.");

  const device = exactRecord(world.device, DEVICE_KEYS, "React Native Direct device");
  const inspection = exactRecord(
    world.inspection,
    INSPECTION_KEYS,
    "React Native Direct inspection",
  );
  if (
    typeof inspection.delayMs !== "number"
    || !Number.isSafeInteger(inspection.delayMs)
    || inspection.delayMs < 0
    || inspection.delayMs > 10_000
  ) {
    throw new Error("Device inspection delayMs must be a safe integer from 0 through 10000.");
  }
  const ownedDevice = Object.freeze({
    platform: parsePlatform(device.platform),
    colorScheme: parseColorScheme(device.colorScheme),
    capturedAt: parseTimestamp(device.capturedAt),
  }) satisfies DeviceStatusDirectWorld["device"];

  return Object.freeze({
    version: 1,
    device: ownedDevice,
    inspection: Object.freeze({
      delayMs: inspection.delayMs,
      failure: parseFailure(inspection.failure),
    }),
  });
}

export function createDeviceStatusDirectWorld(input: {
  readonly device: DeviceStatus;
  readonly delayMs?: number;
  readonly failure?: string | null;
}): DeviceStatusDirectWorld {
  return parseDeviceStatusDirectWorld({
    version: 1,
    device: input.device,
    inspection: {
      delayMs: input.delayMs ?? 120,
      failure: input.failure ?? null,
    },
  });
}
