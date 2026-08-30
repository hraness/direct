import { extract } from "@antithesishq/bombadil";
import type {
  Cell,
  JSON as BombadilJson,
} from "@antithesishq/bombadil";
import type {
  State as BombadilBrowserState,
} from "@antithesishq/bombadil/browser";

import { isUtf8ByteLengthAtMost } from "./utf8-byte-boundary.js";

const MAX_NAMED_SNAPSHOT_CANONICAL_BYTES = 2 * 1024 * 1024;
const MAX_NAMED_SNAPSHOT_JSON_DEPTH = 64;
const SNAPSHOT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]*$/u;
const RESERVED_SNAPSHOT_NAMES = new Set([
  "direct",
  "__proto__",
  "constructor",
  "prototype",
]);

function cloneNamedSnapshotJson(
  value: unknown,
  depth = 0,
  ancestors: WeakSet<object> = new WeakSet<object>(),
): BombadilJson | undefined {
  if (depth > MAX_NAMED_SNAPSHOT_JSON_DEPTH) return undefined;
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  if (ancestors.has(value)) return undefined;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const cloned: BombadilJson[] = [];
      for (const entry of value) {
        const child = cloneNamedSnapshotJson(entry, depth + 1, ancestors);
        if (child === undefined) return undefined;
        cloned.push(child);
      }
      return cloned;
    }
    const clonedEntries: [string, BombadilJson][] = [];
    for (const key of Object.keys(value)) {
      const child = cloneNamedSnapshotJson(
        Reflect.get(value, key),
        depth + 1,
        ancestors,
      );
      if (child === undefined) return undefined;
      clonedEntries.push([key, child]);
    }
    return Object.fromEntries(clonedEntries) as BombadilJson;
  } finally {
    ancestors.delete(value);
  }
}

function boundedNamedSnapshotJson(value: unknown): BombadilJson | undefined {
  const cloned = cloneNamedSnapshotJson(value);
  if (cloned === undefined) return undefined;
  const source = JSON.stringify(cloned);
  return isUtf8ByteLengthAtMost(
    source,
    MAX_NAMED_SNAPSHOT_CANONICAL_BYTES,
  )
    ? cloned
    : undefined;
}

/**
 * Creates a named, bounded JSON extractor that fails closed to an explicit
 * fallback when a page getter throws or returns non-JSON or oversized data.
 */
export function createDirectBombadilNamedSnapshot<T extends BombadilJson>(options: {
  readonly fallback: T;
  readonly name: string;
  readonly read: (state: BombadilBrowserState) => unknown;
  readonly validate: (value: BombadilJson) => value is T;
}): Cell<T> {
  if (
    options.name.length === 0
    || options.name.length > 128
    || !SNAPSHOT_NAME_PATTERN.test(options.name)
    || RESERVED_SNAPSHOT_NAMES.has(options.name)
  ) {
    throw new Error(
      "Bombadil snapshot name must be a safe, unreserved 1-128 character identifier",
    );
  }
  const validate = (value: unknown): T | undefined => {
    const owned = boundedNamedSnapshotJson(value);
    return owned !== undefined && options.validate(owned) ? owned : undefined;
  };
  let fallback: T | undefined;
  try {
    fallback = validate(options.fallback);
  } catch {
    fallback = undefined;
  }
  if (fallback === undefined) {
    throw new Error(
      "Bombadil snapshot fallback must be bounded JSON accepted by validate",
    );
  }
  return extract<BombadilBrowserState, T>((state) => {
    try {
      return validate(options.read(state)) ?? fallback;
    } catch {
      return fallback;
    }
  }).named(options.name);
}
