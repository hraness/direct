// @bun
// src/tooling/bombadil-runner.ts
import { constants as fileSystemConstants } from "fs";
import {
  lstat,
  mkdir as mkdir2,
  open,
  opendir,
  readFile,
  realpath,
  rename as rename2,
  rmdir,
  rm as rm2,
  stat,
  unlink
} from "fs/promises";
import { extname, isAbsolute, join as join2, relative, resolve } from "path";
import process2 from "process";
import { createHash, randomUUID as randomUUID2 } from "crypto";

// src/core/result.ts
function ok(value) {
  return { ok: true, value };
}
function err(error) {
  return { ok: false, error };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/core/ids.ts
var IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
var MAX_IDENTIFIER_LENGTH = 120;
function parseIdentifier(input, kind) {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_IDENTIFIER_LENGTH || !IDENTIFIER_PATTERN.test(input)) {
    return err({
      code: "invalid-identifier",
      kind,
      value: input,
      message: `${kind} identifiers must be 1-${MAX_IDENTIFIER_LENGTH} lowercase ASCII characters with separated alphanumeric segments`
    });
  }
  return ok(input);
}
function parseScenarioId(input) {
  const parsed = parseIdentifier(input, "scenario");
  return parsed.ok ? ok(parsed.value) : parsed;
}
function parseCoverageKey(input) {
  const parsed = parseIdentifier(input, "coverage");
  return parsed.ok ? ok(parsed.value) : parsed;
}

// src/core/reason.ts
function renderUnknownReason(reason, fallback = "Unknown failure") {
  try {
    if (typeof reason === "object" && reason !== null || typeof reason === "function") {
      const message = Reflect.get(reason, "message");
      if (typeof message === "string")
        return message;
    }
  } catch {}
  try {
    return String(reason);
  } catch {
    return fallback;
  }
}

// src/core/json.ts
var DEFAULT_JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 1e5,
  maxStringBytes: 1048576
});
var PARSED_JSON_OPTIONS = Object.freeze({
  freeze: false,
  normalizeNegativeZero: false,
  objectPrototype: "null",
  sortObjectKeys: false
});
var CLONED_JSON_OPTIONS = Object.freeze({
  freeze: false,
  normalizeNegativeZero: true,
  objectPrototype: "ordinary",
  sortObjectKeys: true
});
var FROZEN_CLONED_JSON_OPTIONS = Object.freeze({
  freeze: true,
  normalizeNegativeZero: true,
  objectPrototype: "ordinary",
  sortObjectKeys: true
});
function jsonError(code, path, message) {
  return { code, path, message };
}
function utf8ByteLength(value) {
  let bytes = 0;
  for (let index = 0;index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 127) {
      bytes += 1;
    } else if (code <= 2047) {
      bytes += 2;
    } else if (code >= 55296 && code <= 56319 && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
function parseJsonAt(input, path, depth, limits, budget, ancestors, options) {
  budget.nodes += 1;
  if (budget.nodes > limits.maxNodes) {
    return err(jsonError("node-limit-exceeded", path, `JSON value exceeds ${limits.maxNodes} nodes`));
  }
  if (depth > limits.maxDepth) {
    return err(jsonError("depth-exceeded", path, `JSON value exceeds depth ${limits.maxDepth}`));
  }
  if (input === null || typeof input === "boolean") {
    return ok(input);
  }
  if (typeof input === "string") {
    budget.stringBytes += utf8ByteLength(input);
    if (budget.stringBytes > limits.maxStringBytes) {
      return err(jsonError("string-limit-exceeded", path, `JSON strings exceed ${limits.maxStringBytes} UTF-8 bytes`));
    }
    return ok(input);
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? ok(options.normalizeNegativeZero && Object.is(input, -0) ? 0 : input) : err(jsonError("invalid-number", path, "JSON numbers must be finite"));
  }
  if (typeof input !== "object") {
    return err(jsonError("invalid-type", path, `${typeof input} is not a JSON value`));
  }
  if (ancestors.has(input)) {
    return err(jsonError("cycle", path, "JSON values cannot contain cycles"));
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(input);
  if (Array.isArray(input)) {
    if (Object.getPrototypeOf(input) !== Array.prototype) {
      return err(jsonError("invalid-object", path, "JSON arrays must have the standard Array prototype"));
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
    if (lengthDescriptor === undefined || lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
      return err(jsonError("invalid-object", path, "JSON arrays must have a valid data length"));
    }
    const length = lengthDescriptor.value;
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key === "symbol") {
        return err(jsonError("symbol-key", path, "JSON arrays cannot have symbol keys"));
      }
      if (key === "length")
        continue;
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
        return err(jsonError("invalid-object", `${path}.${key}`, "JSON arrays cannot have extra properties"));
      }
    }
    const output2 = [];
    for (let index = 0;index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(input, index);
      if (descriptor === undefined) {
        return err(jsonError("invalid-object", `${path}[${index}]`, "Sparse arrays are not exact JSON values"));
      }
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        return err(jsonError("accessor-property", `${path}[${index}]`, "JSON arrays must use data elements"));
      }
      if (!descriptor.enumerable) {
        return err(jsonError("invalid-object", `${path}[${index}]`, "JSON array elements must be enumerable"));
      }
      const item = parseJsonAt(descriptor.value, `${path}[${index}]`, depth + 1, limits, budget, nextAncestors, options);
      if (!item.ok) {
        return item;
      }
      output2.push(item.value);
    }
    return ok(options.freeze ? Object.freeze(output2) : output2);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return err(jsonError("invalid-object", path, "JSON objects must have Object or null prototypes"));
  }
  const output = options.objectPrototype === "ordinary" ? {} : Object.create(null);
  const entries = options.sortObjectKeys ? [] : null;
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key === "symbol") {
      return err(jsonError("symbol-key", path, "JSON objects cannot have symbol keys"));
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      return err(jsonError("accessor-property", `${path}.${key}`, "JSON objects must use data properties"));
    }
    if (!descriptor.enumerable) {
      return err(jsonError("invalid-object", `${path}.${key}`, "JSON object properties must be enumerable"));
    }
    budget.stringBytes += utf8ByteLength(key);
    if (budget.stringBytes > limits.maxStringBytes) {
      return err(jsonError("string-limit-exceeded", `${path}.${key}`, `JSON strings exceed ${limits.maxStringBytes} UTF-8 bytes`));
    }
    const child = parseJsonAt(descriptor.value, `${path}.${key}`, depth + 1, limits, budget, nextAncestors, options);
    if (!child.ok) {
      return child;
    }
    if (entries === null) {
      output[key] = child.value;
    } else {
      entries.push([key, child.value]);
    }
  }
  if (entries !== null) {
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    for (const [key, value] of entries) {
      Object.defineProperty(output, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true
      });
    }
  }
  return ok(options.freeze ? Object.freeze(output) : output);
}
function validateAndCloneJson(input, limits, options) {
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0 || !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1 || !Number.isSafeInteger(limits.maxStringBytes) || limits.maxStringBytes < 0) {
    throw new Error("JSON limits must be non-negative safe integers and allow at least one node");
  }
  try {
    return parseJsonAt(input, "$", 0, limits, { nodes: 0, stringBytes: 0 }, new Set, options);
  } catch (reason) {
    return err(jsonError("invalid-object", "$", renderUnknownReason(reason, "JSON object inspection failed")));
  }
}
function parseJsonValue(input, limits = DEFAULT_JSON_LIMITS) {
  return validateAndCloneJson(input, limits, PARSED_JSON_OPTIONS);
}
function canonicalize(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`);
  return `{${entries.join(",")}}`;
}
function canonicalJson(input, limits = DEFAULT_JSON_LIMITS) {
  const parsed = parseJsonValue(input, limits);
  return parsed.ok ? ok(canonicalize(parsed.value)) : parsed;
}
function freezeJson(value) {
  if (value !== null && typeof value === "object") {
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      freezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}
var STABLE_HASH_ALGORITHM = "fnv1a-64";
var TAGGED_STABLE_HASH_PATTERN = /^fnv1a-64:[0-9a-f]{16}$/u;
function tagStableHash(hash) {
  return `${hash.algorithm}:${hash.value}`;
}
function parseTaggedStableHash(input) {
  return typeof input === "string" && TAGGED_STABLE_HASH_PATTERN.test(input) ? ok(input) : err({
    code: "invalid-stable-hash",
    message: `Stable hashes must use ${STABLE_HASH_ALGORITHM} with 16 lowercase hexadecimal digits`
  });
}
function updateFnvByte(hash, byte) {
  return BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
}
function stableHash(input, limits = DEFAULT_JSON_LIMITS) {
  const serialized = canonicalJson(input, limits);
  if (!serialized.ok) {
    return serialized;
  }
  let hash = 0xcbf29ce484222325n;
  for (let index = 0;index < serialized.value.length; index += 1) {
    const code = serialized.value.charCodeAt(index);
    if (code <= 127) {
      hash = updateFnvByte(hash, code);
    } else if (code <= 2047) {
      hash = updateFnvByte(hash, 192 | code >> 6);
      hash = updateFnvByte(hash, 128 | code & 63);
    } else if (code >= 55296 && code <= 56319 && index + 1 < serialized.value.length) {
      const next = serialized.value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        const point = 65536 + (code - 55296 << 10) + (next - 56320);
        hash = updateFnvByte(hash, 240 | point >> 18);
        hash = updateFnvByte(hash, 128 | point >> 12 & 63);
        hash = updateFnvByte(hash, 128 | point >> 6 & 63);
        hash = updateFnvByte(hash, 128 | point & 63);
        index += 1;
      } else {
        hash = updateFnvByte(hash, 239);
        hash = updateFnvByte(hash, 191);
        hash = updateFnvByte(hash, 189);
      }
    } else {
      hash = updateFnvByte(hash, 224 | code >> 12);
      hash = updateFnvByte(hash, 128 | code >> 6 & 63);
      hash = updateFnvByte(hash, 128 | code & 63);
    }
  }
  return ok({
    algorithm: STABLE_HASH_ALGORITHM,
    value: hash.toString(16).padStart(16, "0")
  });
}

// src/core/coverage.ts
var DIRECT_COVERAGE_SCHEMA = "direct.coverage/v2";
var MAX_DIRECT_COVERAGE_ENTRIES = 256;
var DIRECT_COVERAGE_JSON_LIMITS = Object.freeze({
  ...DEFAULT_JSON_LIMITS,
  maxStringBytes: 16777216
});
var EMPTY_COVERAGE_CATALOG_SNAPSHOT = Object.freeze({
  schema: DIRECT_COVERAGE_SCHEMA,
  entries: Object.freeze([])
});
function coverageError(code, message, keys = []) {
  return { code, message, keys };
}
function hasControlCharacters(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 || code === 127) {
      return true;
    }
  }
  return false;
}
var COVERAGE_ENTRY_KEYS = new Set(["key", "mode", "claim", "scenarios"]);
var COVERAGE_SNAPSHOT_KEYS = new Set(["schema", "entries"]);
function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function createCoverageCatalogSnapshot(catalog) {
  return Object.freeze({
    schema: DIRECT_COVERAGE_SCHEMA,
    entries: catalog.list()
  });
}
function parseCoverageCatalogSnapshot(input, limits = DIRECT_COVERAGE_JSON_LIMITS) {
  const parsed = parseJsonValue(input, limits);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return err(coverageError("invalid-coverage", parsed.ok ? "Coverage snapshot must be an object" : parsed.error.message));
  }
  for (const key of Object.keys(parsed.value)) {
    if (!COVERAGE_SNAPSHOT_KEYS.has(key)) {
      return err(coverageError("invalid-coverage", `Unknown coverage snapshot key: ${key}`));
    }
  }
  if (parsed.value.schema !== DIRECT_COVERAGE_SCHEMA) {
    return err(coverageError("invalid-coverage", `Coverage snapshot schema must be ${DIRECT_COVERAGE_SCHEMA}`));
  }
  if (!Array.isArray(parsed.value.entries)) {
    return err(coverageError("invalid-coverage", "Coverage snapshot entries must be an array"));
  }
  const entries = [];
  for (const [index, candidate] of parsed.value.entries.entries()) {
    if (!isRecord(candidate)) {
      return err(coverageError("invalid-coverage", `Coverage entry ${String(index)} must be an object`));
    }
    for (const key of Object.keys(candidate)) {
      if (!COVERAGE_ENTRY_KEYS.has(key)) {
        return err(coverageError("invalid-coverage", `Unknown coverage entry key at ${String(index)}: ${key}`));
      }
    }
    if (typeof candidate.key !== "string" || typeof candidate.claim !== "string" || candidate.mode !== "fixture" && candidate.mode !== "mixed" && candidate.mode !== "direct" || !isStringArray(candidate.scenarios)) {
      return err(coverageError("invalid-coverage", `Coverage entry ${String(index)} has an invalid wire shape`));
    }
    if (candidate.mode === "direct") {
      if (candidate.scenarios.length > 0) {
        return err(coverageError("invalid-mode", `Direct coverage ${candidate.key} cannot cite fixture scenarios`, [candidate.key]));
      }
      entries.push({
        key: candidate.key,
        mode: candidate.mode,
        claim: candidate.claim,
        scenarios: []
      });
    } else {
      const firstScenario = candidate.scenarios[0];
      if (typeof firstScenario !== "string") {
        return err(coverageError("invalid-mode", `${candidate.mode} coverage ${candidate.key} must cite at least one scenario`, [candidate.key]));
      }
      entries.push({
        key: candidate.key,
        mode: candidate.mode,
        claim: candidate.claim,
        scenarios: [firstScenario, ...candidate.scenarios.slice(1)]
      });
    }
  }
  const catalog = createCoverageCatalog(entries);
  return catalog.ok ? ok(createCoverageCatalogSnapshot(catalog.value)) : catalog;
}
function createCoverageCatalog(inputs, scenarios) {
  if (inputs.length > MAX_DIRECT_COVERAGE_ENTRIES) {
    return err(coverageError("too-many-coverage-entries", `Direct definitions support at most ${String(MAX_DIRECT_COVERAGE_ENTRIES)} coverage entries`));
  }
  const entries = [];
  const byKey = new Map;
  for (const input of inputs) {
    const key = parseCoverageKey(input.key);
    if (!key.ok) {
      return err(coverageError("invalid-coverage", key.error.message, [String(input.key)]));
    }
    if (byKey.has(key.value)) {
      return err(coverageError("duplicate-coverage", `Duplicate coverage key: ${key.value}`, [key.value]));
    }
    if (input.claim.trim().length === 0 || input.claim.length > 1000 || hasControlCharacters(input.claim)) {
      return err(coverageError("invalid-claim", `Coverage ${key.value} needs a 1-1000 character claim`, [key.value]));
    }
    if (input.mode !== "fixture" && input.mode !== "mixed" && input.mode !== "direct") {
      return err(coverageError("invalid-mode", `Coverage ${key.value} has an unknown proof mode`, [key.value]));
    }
    if (input.mode === "direct" && input.scenarios.length > 0) {
      return err(coverageError("invalid-mode", `Direct coverage ${key.value} cannot cite fixture scenarios`, [key.value]));
    }
    if (input.mode !== "direct" && input.scenarios.length === 0) {
      return err(coverageError("invalid-mode", `${input.mode} coverage ${key.value} must cite at least one scenario`, [key.value]));
    }
    const scenarioIds = [];
    const seenScenarios = new Set;
    for (const candidate of input.scenarios) {
      const id = parseScenarioId(candidate);
      if (!id.ok) {
        return err(coverageError("invalid-scenario", id.error.message, [String(candidate)]));
      }
      if (seenScenarios.has(id.value)) {
        return err(coverageError("invalid-scenario", `Coverage ${key.value} repeats scenario ${id.value}`, [id.value]));
      }
      if (scenarios !== undefined && scenarios.get(id.value) === undefined) {
        return err(coverageError("unknown-scenario", `Coverage ${key.value} cites unknown scenario ${id.value}`, [id.value]));
      }
      seenScenarios.add(id.value);
      scenarioIds.push(id.value);
    }
    let entry;
    if (input.mode === "direct") {
      const scenarios2 = Object.freeze([]);
      entry = Object.freeze({
        key: key.value,
        mode: input.mode,
        claim: input.claim,
        scenarios: scenarios2
      });
    } else {
      const firstScenarioId = scenarioIds[0];
      if (firstScenarioId === undefined) {
        return err(coverageError("invalid-mode", `${input.mode} coverage ${key.value} must cite at least one scenario`, [key.value]));
      }
      const scenarios2 = Object.freeze([
        firstScenarioId,
        ...scenarioIds.slice(1)
      ]);
      entry = Object.freeze({
        key: key.value,
        mode: input.mode,
        claim: input.claim,
        scenarios: scenarios2
      });
    }
    entries.push(entry);
    byKey.set(key.value, entry);
  }
  const frozenEntries = Object.freeze(entries);
  const keys = Object.freeze(frozenEntries.map((entry) => entry.key));
  const catalog = {
    size: frozenEntries.length,
    keys: () => keys,
    list: () => frozenEntries,
    get: (key) => byKey.get(key),
    resolve: (input) => {
      const key = parseCoverageKey(input);
      if (!key.ok) {
        return err(coverageError("invalid-coverage", key.error.message, [String(input)]));
      }
      const entry = byKey.get(key.value);
      return entry === undefined ? err(coverageError("unknown-coverage", `Unknown coverage key: ${key.value}`, [key.value])) : ok(entry);
    },
    requireExactKeys: (expected) => {
      const expectedKeys = [];
      const seen = new Set;
      for (const candidate of expected) {
        const parsed = parseCoverageKey(candidate);
        if (!parsed.ok) {
          return err(coverageError("invalid-coverage", parsed.error.message, [String(candidate)]));
        }
        if (seen.has(parsed.value)) {
          return err(coverageError("duplicate-expected-key", `Expected coverage repeats ${parsed.value}`, [parsed.value]));
        }
        seen.add(parsed.value);
        expectedKeys.push(parsed.value);
      }
      const missing = expectedKeys.filter((key) => !byKey.has(key));
      if (missing.length > 0) {
        return err(coverageError("missing-coverage", `Missing coverage keys: ${missing.join(", ")}`, missing));
      }
      const unexpected = keys.filter((key) => !seen.has(key));
      if (unexpected.length > 0) {
        return err(coverageError("unexpected-coverage", `Unexpected coverage keys: ${unexpected.join(", ")}`, unexpected));
      }
      return ok(true);
    }
  };
  return ok(Object.freeze(catalog));
}
// src/core/fixture.ts
var DEFAULT_MAX_FIXTURE_BYTES = 65536;
var FIXTURE_KEYS = new Set(["schema", "scenario", "route", "world", "runtime"]);

// src/core/query.ts
var SCENARIO_QUERY_KEY = "__direct_scenario";
var FIXTURE_QUERY_KEY = "__direct_fixture";
var FIXTURE_QUERY_PREFIX_BYTES = utf8ByteLength(`?${FIXTURE_QUERY_KEY}=`);
function maximumFixtureQueryBytes(maxFixtureBytes) {
  return maxFixtureBytes * 3 + FIXTURE_QUERY_PREFIX_BYTES;
}
var DEFAULT_MAX_QUERY_BYTES = maximumFixtureQueryBytes(DEFAULT_MAX_FIXTURE_BYTES);

// src/core/scenario.ts
var MAX_DIRECT_SCENARIOS = 256;

// src/testing/manifest.ts
var DIRECT_SESSION_MANIFEST_SCHEMA = "direct.session-manifest/v1";
var DIRECT_CATALOG_HASH_ALGORITHM = STABLE_HASH_ALGORITHM;
var DIRECT_SESSION_MANIFEST_JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 1e5,
  maxStringBytes: 16777216
});
var MANIFEST_KEYS = new Set([
  "active",
  "catalogHash",
  "coverage",
  "defaultScenario",
  "queries",
  "scenarios",
  "schema"
]);
var QUERY_KEYS = new Set(["fixture", "scenario"]);
var ACTIVE_KEYS = new Set([
  "activationHash",
  "route",
  "scenario",
  "selectionHash",
  "source"
]);
var SCENARIO_KEYS = new Set([
  "description",
  "id",
  "route",
  "title"
]);
function manifestError(code, message) {
  return Object.freeze({ code, message });
}
function exactKeys(input, expected, label) {
  for (const key of Object.keys(input)) {
    if (!expected.has(key))
      throw new Error(`Unknown ${label} key: ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(input, key))
      throw new Error(`Missing ${label} key: ${key}`);
  }
}
function hasControlCharacters2(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 || code === 127) {
      return true;
    }
  }
  return false;
}
function validText(value, maximum) {
  return value.trim().length > 0 && value.length <= maximum && !hasControlCharacters2(value);
}
function validRoute(value) {
  if (value.trim().length === 0 || value.length > 256)
    return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127)
      return false;
  }
  return true;
}
function parseTaggedHash(value, label) {
  const parsed = parseTaggedStableHash(value);
  if (!parsed.ok)
    throw new Error(`${label}: ${parsed.error.message}`);
  return parsed.value;
}
function selectionHash(payload) {
  const hashed = stableHash(payload, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!hashed.ok) {
    return err(manifestError("invalid-manifest", hashed.error.message));
  }
  return ok(tagStableHash(hashed.value));
}
function catalogHash(payload) {
  const hashed = stableHash(payload, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!hashed.ok) {
    return err(manifestError("invalid-manifest", hashed.error.message));
  }
  return ok(tagStableHash(hashed.value));
}
function parseManifestUnchecked(input) {
  const parsedJson = parseJsonValue(input, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!parsedJson.ok || !isRecord(parsedJson.value)) {
    return err(manifestError("invalid-manifest", parsedJson.ok ? "Direct session manifest must be an object" : parsedJson.error.message));
  }
  const candidate = parsedJson.value;
  exactKeys(candidate, MANIFEST_KEYS, "Direct session manifest");
  if (candidate.schema !== DIRECT_SESSION_MANIFEST_SCHEMA) {
    throw new Error(`Direct session manifest schema must be ${DIRECT_SESSION_MANIFEST_SCHEMA}`);
  }
  if (!isRecord(candidate.queries)) {
    throw new Error("Direct session manifest queries must be an object");
  }
  exactKeys(candidate.queries, QUERY_KEYS, "Direct session manifest queries");
  if (candidate.queries.scenario !== SCENARIO_QUERY_KEY || candidate.queries.fixture !== FIXTURE_QUERY_KEY) {
    throw new Error("Direct session manifest query keys do not match Direct");
  }
  const queries = Object.freeze({
    scenario: SCENARIO_QUERY_KEY,
    fixture: FIXTURE_QUERY_KEY
  });
  const defaultScenario = parseScenarioId(candidate.defaultScenario);
  if (!defaultScenario.ok) {
    throw new Error(`Invalid default scenario: ${defaultScenario.error.message}`);
  }
  if (!Array.isArray(candidate.scenarios)) {
    throw new Error("Direct session manifest scenarios must be an array");
  }
  if (candidate.scenarios.length > MAX_DIRECT_SCENARIOS) {
    throw new Error(`Direct session manifests support at most ${String(MAX_DIRECT_SCENARIOS)} scenarios`);
  }
  const scenarios = [];
  const byId = new Map;
  for (const [index, rawScenario] of candidate.scenarios.entries()) {
    if (!isRecord(rawScenario)) {
      throw new Error(`Direct session manifest scenario ${String(index)} must be an object`);
    }
    exactKeys(rawScenario, SCENARIO_KEYS, `Direct session manifest scenario ${String(index)}`);
    const id = parseScenarioId(rawScenario.id);
    if (!id.ok) {
      throw new Error(`Invalid Direct session manifest scenario ${String(index)}: ${id.error.message}`);
    }
    if (byId.has(id.value)) {
      return err(manifestError("duplicate-scenario", `Duplicate Direct session manifest scenario: ${id.value}`));
    }
    if (typeof rawScenario.title !== "string" || !validText(rawScenario.title, 160)) {
      throw new Error(`Direct session manifest scenario ${id.value} title must contain 1-160 visible characters`);
    }
    if (rawScenario.description !== null && (typeof rawScenario.description !== "string" || !validText(rawScenario.description, 2000))) {
      throw new Error(`Direct session manifest scenario ${id.value} description must be null or contain 1-2000 visible characters`);
    }
    if (typeof rawScenario.route !== "string" || !validRoute(rawScenario.route)) {
      throw new Error(`Direct session manifest scenario ${id.value} route must contain 1-256 visible characters`);
    }
    const scenario = Object.freeze({
      id: id.value,
      title: rawScenario.title,
      description: rawScenario.description,
      route: rawScenario.route
    });
    scenarios.push(scenario);
    byId.set(id.value, scenario);
  }
  const frozenScenarios = Object.freeze(scenarios);
  if (!byId.has(defaultScenario.value)) {
    return err(manifestError("unknown-scenario", `Direct session manifest default scenario is missing: ${defaultScenario.value}`));
  }
  if (!isRecord(candidate.active)) {
    throw new Error("Direct session manifest active selection must be an object");
  }
  exactKeys(candidate.active, ACTIVE_KEYS, "Direct session manifest active selection");
  if (candidate.active.source !== "scenario" && candidate.active.source !== "fixture") {
    throw new Error("Direct session manifest active source must be scenario or fixture");
  }
  const activeScenario = parseScenarioId(candidate.active.scenario);
  if (!activeScenario.ok) {
    throw new Error(`Invalid active scenario: ${activeScenario.error.message}`);
  }
  const activeDefinition = byId.get(activeScenario.value);
  if (activeDefinition === undefined) {
    return err(manifestError("unknown-scenario", `Direct session manifest active scenario is missing: ${activeScenario.value}`));
  }
  if (typeof candidate.active.route !== "string" || !validRoute(candidate.active.route)) {
    throw new Error("Direct session manifest active route is invalid");
  }
  if (candidate.active.route !== activeDefinition.route) {
    return err(manifestError("route-mismatch", `Direct session manifest active route does not match scenario ${activeScenario.value}`));
  }
  const activationHash = parseTaggedHash(candidate.active.activationHash, "Direct session manifest activationHash");
  let suppliedSelectionHash;
  try {
    suppliedSelectionHash = parseTaggedHash(candidate.active.selectionHash, "Direct session manifest selectionHash");
  } catch (reason) {
    return err(manifestError("invalid-selection-hash", renderUnknownReason(reason, "Direct session manifest selectionHash is invalid")));
  }
  const expectedSelectionHash = selectionHash({
    source: candidate.active.source,
    scenario: activeScenario.value,
    route: activeDefinition.route,
    activationHash
  });
  if (!expectedSelectionHash.ok)
    return expectedSelectionHash;
  if (suppliedSelectionHash !== expectedSelectionHash.value) {
    return err(manifestError("selection-hash-mismatch", "Direct session manifest selectionHash does not match its active selection"));
  }
  const active = Object.freeze({
    source: candidate.active.source,
    scenario: activeScenario.value,
    route: activeDefinition.route,
    activationHash,
    selectionHash: expectedSelectionHash.value
  });
  const coverage = parseCoverageCatalogSnapshot(candidate.coverage, DIRECT_SESSION_MANIFEST_JSON_LIMITS);
  if (!coverage.ok) {
    throw new Error(coverage.error.message);
  }
  for (const entry of coverage.value.entries) {
    for (const scenario of entry.scenarios) {
      if (!byId.has(scenario)) {
        return err(manifestError("unknown-coverage-scenario", `Coverage ${entry.key} cites unknown Direct session manifest scenario ${scenario}`));
      }
    }
  }
  let suppliedCatalogHash;
  try {
    const parsedHash = parseTaggedHash(candidate.catalogHash, "Direct session manifest catalogHash");
    const separator = parsedHash.indexOf(":");
    suppliedCatalogHash = `${DIRECT_CATALOG_HASH_ALGORITHM}:${parsedHash.slice(separator + 1)}`;
  } catch (reason) {
    return err(manifestError("invalid-catalog-hash", renderUnknownReason(reason, "Direct session manifest catalogHash is invalid")));
  }
  const expectedCatalogHash = catalogHash({
    queries,
    defaultScenario: defaultScenario.value,
    scenarios: frozenScenarios,
    coverage: coverage.value
  });
  if (!expectedCatalogHash.ok)
    return expectedCatalogHash;
  if (suppliedCatalogHash !== expectedCatalogHash.value) {
    return err(manifestError("catalog-hash-mismatch", "Direct session manifest catalogHash does not match its public catalog"));
  }
  return ok(Object.freeze({
    schema: DIRECT_SESSION_MANIFEST_SCHEMA,
    catalogHash: expectedCatalogHash.value,
    queries,
    defaultScenario: defaultScenario.value,
    active,
    scenarios: frozenScenarios,
    coverage: coverage.value
  }));
}
function parseDirectSessionManifest(input) {
  try {
    return parseManifestUnchecked(input);
  } catch (reason) {
    return err(manifestError("invalid-manifest", renderUnknownReason(reason, "Direct session manifest is invalid")));
  }
}
// src/testing/probe.ts
var DIRECT_PROBE_SCHEMA = "direct.probe/v1";
var MAX_DIRECT_PROBE_COUNTERS = 128;
var COUNTER_NAME_PATTERN = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*$/u;
var SNAPSHOT_KEYS = new Set([
  "schema",
  "activationHash",
  "generation",
  "revision",
  "activity",
  "pending",
  "violations",
  "remainingWork",
  "isQuiescent"
]);
var ACTIVITY_KEYS = new Set(["active", "started", "settled"]);
function probeError(code, message, counter = null) {
  return Object.freeze({ code, message, counter });
}
function readNonNegativeInteger(input) {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : null;
}
function parseSnapshotCounters(input, category) {
  if (!isRecord(input)) {
    return err(probeError("invalid-snapshot", `Probe ${category} counters must be an object`));
  }
  const output = Object.create(null);
  for (const [name, candidate] of Object.entries(input)) {
    if (name.length > 80 || !COUNTER_NAME_PATTERN.test(name)) {
      return err(probeError("invalid-counter-name", "Counter names must be 1-80 ASCII alphanumeric characters with optional dots or hyphens", name));
    }
    const value = readNonNegativeInteger(candidate);
    if (value === null) {
      return err(probeError("invalid-counter", `Counter ${name} must be a non-negative safe integer`, name));
    }
    output[name] = value;
  }
  return ok(Object.freeze(output));
}
function parseDirectProbeSnapshot(input) {
  const parsed = parseJsonValue(input);
  if (!parsed.ok || !isRecord(parsed.value)) {
    return err(probeError("invalid-snapshot", parsed.ok ? "Direct probe snapshot must be an object" : parsed.error.message));
  }
  const record = parsed.value;
  for (const key of Object.keys(record)) {
    if (!SNAPSHOT_KEYS.has(key)) {
      return err(probeError("invalid-snapshot", `Unknown Direct probe snapshot key: ${key}`));
    }
  }
  if (record.schema !== DIRECT_PROBE_SCHEMA) {
    return err(probeError("invalid-snapshot", `Direct probe schema must be ${DIRECT_PROBE_SCHEMA}`));
  }
  const activationHash = parseTaggedStableHash(record.activationHash);
  if (!activationHash.ok) {
    return err(probeError("invalid-activation-hash", "Direct probe activation hash is invalid"));
  }
  const generation = readNonNegativeInteger(record.generation);
  const revision = readNonNegativeInteger(record.revision);
  if (generation === null || generation < 1 || revision === null) {
    return err(probeError("invalid-snapshot", "Direct probe generation must be positive and revision must be non-negative"));
  }
  if (generation - 1 > revision) {
    return err(probeError("invalid-snapshot", "Direct probe generation cannot exceed revision plus one"));
  }
  if (!isRecord(record.activity)) {
    return err(probeError("invalid-snapshot", "Direct probe activity must be an object"));
  }
  for (const key of Object.keys(record.activity)) {
    if (!ACTIVITY_KEYS.has(key)) {
      return err(probeError("invalid-snapshot", `Unknown Direct activity key: ${key}`));
    }
  }
  const active = readNonNegativeInteger(record.activity.active);
  const started = readNonNegativeInteger(record.activity.started);
  const settled = readNonNegativeInteger(record.activity.settled);
  if (active === null || started === null || settled === null || settled > started || active !== started - settled) {
    return err(probeError("invalid-snapshot", "Direct activity counters must be non-negative and conserve started work"));
  }
  if (started > revision || settled > revision - started) {
    return err(probeError("invalid-snapshot", "Direct activity transitions cannot exceed the store revision"));
  }
  const pending = parseSnapshotCounters(record.pending, "pending");
  if (!pending.ok)
    return pending;
  const violations = parseSnapshotCounters(record.violations, "violation");
  if (!violations.ok)
    return violations;
  if (Object.keys(pending.value).length + Object.keys(violations.value).length > MAX_DIRECT_PROBE_COUNTERS) {
    return err(probeError("too-many-counters", `A probe supports at most ${String(MAX_DIRECT_PROBE_COUNTERS)} counters`));
  }
  if (record.remainingWork === undefined) {
    return err(probeError("invalid-snapshot", "Direct probe snapshot requires remainingWork"));
  }
  if (typeof record.isQuiescent !== "boolean") {
    return err(probeError("invalid-snapshot", "Direct probe isQuiescent must be boolean"));
  }
  const expectedQuiescence = active === 0 && Object.values(pending.value).every((value) => value === 0);
  if (record.isQuiescent !== expectedQuiescence) {
    return err(probeError("invalid-snapshot", "Direct probe isQuiescent does not match its activity and pending counters"));
  }
  return ok(Object.freeze({
    schema: DIRECT_PROBE_SCHEMA,
    activationHash: activationHash.value,
    generation,
    revision,
    activity: Object.freeze({ active, started, settled }),
    pending: pending.value,
    violations: violations.value,
    remainingWork: freezeJson(record.remainingWork),
    isQuiescent: record.isQuiescent
  }));
}
// src/index.ts
var FIXTURE_QUERY_KEY2 = "__direct_fixture";
var SCENARIO_QUERY_KEY2 = "__direct_scenario";

// src/tooling/browser-verification.ts
import { randomUUID } from "crypto";
import { mkdir, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
var DEFAULT_LOG_LIMIT = 12000;
var DEFAULT_PROBE_TIMEOUT_MS = 1500;
var DEFAULT_REUSE_PROBE_INTERVAL_MS = 250;
var DEFAULT_STOP_TIMEOUT_MS = 3000;
var MAX_RENDERED_ERROR_LENGTH = 4096;
var MAX_ERROR_CAUSE_DEPTH = 8;
function truncateRenderedError(value) {
  if (value.length <= MAX_RENDERED_ERROR_LENGTH)
    return value;
  return `${value.slice(0, MAX_RENDERED_ERROR_LENGTH - 1)}\u2026`;
}
function readForeignProperty(value, key) {
  try {
    return { ok: true, value: Reflect.get(value, key) };
  } catch {
    return { ok: false };
  }
}
function renderUnknownAtDepth(value, seen, depth) {
  if (typeof value === "string")
    return truncateRenderedError(value);
  if (typeof value === "object" && value !== null || typeof value === "function") {
    if (seen.has(value))
      return "[Circular]";
    if (depth >= MAX_ERROR_CAUSE_DEPTH)
      return "[Cause depth exceeded]";
    seen.add(value);
    const message = readForeignProperty(value, "message");
    if (message.ok && typeof message.value === "string") {
      const name = readForeignProperty(value, "name");
      const label = name.ok && typeof name.value === "string" && name.value.length > 0 ? name.value : "Error";
      const cause = readForeignProperty(value, "cause");
      const renderedCause = cause.ok && cause.value !== undefined ? `; caused by ${renderUnknownAtDepth(cause.value, seen, depth + 1)}` : "";
      return truncateRenderedError(`${label}: ${message.value}${renderedCause}`);
    }
  }
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined)
      return truncateRenderedError(encoded);
  } catch {}
  try {
    return truncateRenderedError(String(value));
  } catch {
    return "Unknown failure";
  }
}
function renderUnknown(value) {
  return renderUnknownAtDepth(value, new WeakSet, 0);
}
function tail(value, maximumLength = DEFAULT_LOG_LIMIT) {
  return value.length <= maximumLength ? value : value.slice(-maximumLength);
}
function normalizeRootHttpOrigin(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("--base-url must be an absolute HTTP URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--base-url must use http: or https:");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("--base-url cannot contain credentials");
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("--base-url must point to the server root without a query string or fragment");
  }
  return url.origin;
}
function canAutomaticallyStartLocalServer(baseUrl, localHosts = new Set(["127.0.0.1", "localhost"])) {
  const url = new URL(normalizeRootHttpOrigin(baseUrl));
  return url.protocol === "http:" && localHosts.has(url.hostname);
}
async function collectStream(stream, logLimit) {
  const reader = stream.getReader();
  const decoder = new TextDecoder;
  let output = "";
  for (;; ) {
    const chunk = await reader.read();
    if (chunk.done)
      return tail(`${output}${decoder.decode()}`, logLimit);
    output = tail(`${output}${decoder.decode(chunk.value, { stream: true })}`, logLimit);
  }
}
function verificationProcessGroupExists(processId) {
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH")
      return false;
    if (error.code === "EPERM")
      return true;
    throw error;
  }
}
async function waitForVerificationProcessGroupExit(processId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (verificationProcessGroupExists(processId)) {
    if (Date.now() >= deadline) {
      throw new Error(`verification server process group ${String(processId)} survived cleanup`);
    }
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}
function spawnVerificationServer(options) {
  const detachedProcessGroup = options.detachedProcessGroup ?? false;
  const omittedEnvironment = new Set(options.omitEnvironment ?? []);
  const environment = Object.fromEntries(Object.entries({ ...process.env, ...options.env }).filter(([name]) => !omittedEnvironment.has(name)));
  const process_ = Bun.spawn([...options.command], {
    cwd: options.cwd,
    detached: detachedProcessGroup,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const logLimit = options.logLimit ?? DEFAULT_LOG_LIMIT;
  const output = Promise.all([
    collectStream(process_.stdout, logLimit),
    collectStream(process_.stderr, logLimit)
  ]).then(([stdout, stderr]) => tail(`${stdout}
${stderr}`.trim(), logLimit));
  const signal = (value) => {
    if (detachedProcessGroup) {
      try {
        process.kill(-process_.pid, value);
        return;
      } catch (error) {
        if (error.code !== "ESRCH")
          throw error;
      }
    }
    if (process_.exitCode === null)
      process_.kill(value);
  };
  return {
    exited: process_.exited,
    exitCode: () => process_.exitCode,
    ...detachedProcessGroup ? {
      killDescendants: async (timeoutMs) => {
        signal("SIGKILL");
        await waitForVerificationProcessGroupExit(process_.pid, timeoutMs);
      }
    } : {},
    output,
    terminate: () => signal("SIGTERM"),
    kill: () => signal("SIGKILL")
  };
}
async function settleWithin(promise, timeoutMs) {
  return await Promise.race([
    promise.then((value) => ({ settled: true, value })),
    Bun.sleep(timeoutMs).then(() => ({ settled: false }))
  ]);
}
async function serverIsReachable(baseUrl, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS, readinessPath = "/") {
  if (!readinessPath.startsWith("/") || readinessPath.startsWith("//")) {
    throw new Error(`readinessPath must be an origin-relative path, received ${JSON.stringify(readinessPath)}`);
  }
  const probeUrl = new URL(readinessPath, `${normalizeRootHttpOrigin(baseUrl)}/`);
  if (probeUrl.hash !== "")
    throw new Error("readinessPath cannot contain a fragment");
  try {
    const response = await fetch(probeUrl, {
      signal: AbortSignal.timeout(probeTimeoutMs)
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
async function stopVerificationServerWithOutput(server, stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs < 0) {
    throw new Error("verification server stop timeout must be a finite nonnegative duration");
  }
  if (server.exitCode() === null)
    server.terminate();
  const stopped = await settleWithin(server.exited, stopTimeoutMs);
  if (!stopped.settled) {
    server.kill();
    const killed = await settleWithin(server.exited, stopTimeoutMs);
    if (!killed.settled) {
      throw new Error(`verification server did not exit within ${stopTimeoutMs}ms after SIGKILL`);
    }
  }
  await server.killDescendants?.(stopTimeoutMs);
  const output = await settleWithin(server.output, stopTimeoutMs);
  if (!output.settled) {
    throw new Error(`verification server output did not settle within ${stopTimeoutMs}ms after exit`);
  }
  return output.value;
}
async function stopVerificationServer(server, stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  await stopVerificationServerWithOutput(server, stopTimeoutMs);
}
function verificationServerAcquisitionAbortError() {
  return new Error("Verification server acquisition was aborted");
}
function throwIfVerificationServerAcquisitionAborted(signal) {
  if (signal?.aborted === true)
    throw verificationServerAcquisitionAbortError();
}
async function waitForVerificationServerAcquisitionStep(promise, signal) {
  if (signal === undefined)
    return await promise;
  throwIfVerificationServerAcquisitionAborted(signal);
  let abortListener;
  const aborted = new Promise((_resolve, reject) => {
    abortListener = () => reject(verificationServerAcquisitionAbortError());
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted)
      abortListener();
  });
  let value;
  try {
    value = await Promise.race([promise, aborted]);
  } finally {
    if (abortListener !== undefined)
      signal.removeEventListener("abort", abortListener);
  }
  throwIfVerificationServerAcquisitionAborted(signal);
  return value;
}
async function acquireVerificationServer(options) {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const readinessPath = options.readinessPath ?? "/";
  const isReachable = options.isReachable ?? serverIsReachable;
  const canStartLocally = canAutomaticallyStartLocalServer(options.baseUrl, options.localHosts);
  throwIfVerificationServerAcquisitionAborted(options.abortSignal);
  if (await waitForVerificationServerAcquisitionStep(Promise.resolve(isReachable(options.baseUrl, probeTimeoutMs, readinessPath)), options.abortSignal)) {
    if (canStartLocally && options.reuseExistingLocalServer === false) {
      throw new Error(`A local server is already reachable at ${options.baseUrl}; ` + "verification will not reuse a server whose worktree ownership is unknown");
    }
    await waitForVerificationServerAcquisitionStep(Bun.sleep(options.reuseProbeIntervalMs ?? DEFAULT_REUSE_PROBE_INTERVAL_MS), options.abortSignal);
    if (await waitForVerificationServerAcquisitionStep(Promise.resolve(isReachable(options.baseUrl, probeTimeoutMs, readinessPath)), options.abortSignal)) {
      throwIfVerificationServerAcquisitionAborted(options.abortSignal);
      return { source: "reused" };
    }
  }
  if (!canStartLocally) {
    throw new Error(`No server is reachable at ${options.baseUrl}; automatic startup is limited to local HTTP URLs`);
  }
  throwIfVerificationServerAcquisitionAborted(options.abortSignal);
  const server = options.startServer();
  let exitedWithCode = null;
  try {
    const deadline = Date.now() + options.startupTimeoutMs;
    while (Date.now() < deadline) {
      const exitCode = server.exitCode();
      if (exitCode !== null) {
        exitedWithCode = exitCode;
        break;
      }
      if (await waitForVerificationServerAcquisitionStep(Promise.resolve(isReachable(options.baseUrl, probeTimeoutMs, readinessPath)), options.abortSignal)) {
        throwIfVerificationServerAcquisitionAborted(options.abortSignal);
        return { source: "started", server };
      }
      await waitForVerificationServerAcquisitionStep(Bun.sleep(options.pollIntervalMs ?? 200), options.abortSignal);
    }
  } catch (error) {
    await stopVerificationServer(server);
    throw error;
  }
  if (exitedWithCode !== null) {
    const output2 = tail(await stopVerificationServerWithOutput(server));
    throw new Error(`${options.label} exited with ${exitedWithCode}:
${output2}`);
  }
  const timeoutMessage = `${options.label} did not become reachable at ${new URL(readinessPath, `${options.baseUrl}/`).href} within ${options.startupTimeoutMs}ms`;
  const output = tail(await stopVerificationServerWithOutput(server));
  throw new Error(output === "" ? timeoutMessage : `${timeoutMessage}:
${output}`);
}
async function writeJsonAtomically(path, value) {
  const temporaryPath = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}
`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {
      return;
    });
    throw error;
  }
}

// src/tooling/bombadil-runner.ts
var EXPECTED_BOMBADIL_VERSION = "0.7.2";
var BOMBADIL_TOOLCHAIN_BUILD_CONTRACTS = new Set([
  "cargo-release-browser-only",
  "nix-default-aarch64-darwin"
]);
var BOMBADIL_TOOLCHAIN_CONFIG_KEYS = [
  "buildContract",
  "executablePath",
  "sha256",
  "sourceRevision",
  "version"
];
var BOMBADIL_TOOLCHAIN_ENVIRONMENT_NAMES = [
  "DIRECT_BOMBADIL_BUILD_CONTRACT",
  "DIRECT_BOMBADIL_EXECUTABLE_PATH",
  "DIRECT_BOMBADIL_EXECUTABLE_SHA256",
  "DIRECT_BOMBADIL_SOURCE_REVISION"
];
var DEFAULT_TIME_LIMIT_SECONDS = 20;
var MIN_TIME_LIMIT_SECONDS = 12;
var MAX_TIME_LIMIT_SECONDS = 300;
var DEFAULT_STARTUP_TIMEOUT_MS = 60000;
var MAX_STARTUP_TIMEOUT_MS = 120000;
var LOG_LIMIT = 24000;
var ARTIFACT_SCHEMA = "direct.bombadil-run/v1";
var ARTIFACT_RECEIPT_SCHEMA = "direct.bombadil-artifact-receipt/v1";
var ARTIFACT_SUMMARY_SCHEMA = "direct.bombadil-upload-summary/v1";
var MATRIX_RECEIPT_SCHEMA = "direct.bombadil-matrix-receipt/v1";
var MATRIX_SUMMARY_SCHEMA = "direct.bombadil-matrix-summary/v1";
var ARTIFACT_FAILURE_CODES = new Set([
  "artifact-policy",
  "configuration-rejected",
  "exploration-policy",
  "interrupted",
  "persistence",
  "process",
  "server",
  "trace-attestation",
  "writer-settlement",
  "unknown"
]);
var ARTIFACT_RECEIPT_KEYS = new Set([
  "completedAt",
  "diagnosticsRetained",
  "failureCode",
  "inventory",
  "mode",
  "policy",
  "runId",
  "schema",
  "status"
]);
var ARTIFACT_RECEIPT_INVENTORY_KEYS = new Set([
  "entryCount",
  "fileCount",
  "inventorySha256",
  "totalBytes"
]);
var ARTIFACT_POLICY_RECEIPT_KEYS = new Set([
  "maxDepth",
  "maxEntries",
  "maxFileBytes",
  "maxFiles",
  "maxPathBytes",
  "maxTotalBytes"
]);
var RUN_SUMMARY_KEYS = new Set([
  "artifactName",
  "attestation",
  "exploration",
  "failureCode",
  "scenario",
  "schema",
  "status"
]);
var RUN_SUMMARY_ATTESTATION_KEYS = new Set([
  "invalidObservationCount",
  "observationCount",
  "validObservationCount"
]);
var RUN_SUMMARY_EXPLORATION_KEYS = new Set([
  "actionCount",
  "nonWaitActionCount",
  "policySatisfied",
  "traceBytes",
  "traceLineCount",
  "traceSha256"
]);
var MATRIX_RECEIPT_KEYS = new Set([
  "campaigns",
  "completedAt",
  "failureCode",
  "mode",
  "omittedCampaignCount",
  "runId",
  "schema",
  "status"
]);
var MATRIX_CAMPAIGN_RECEIPT_KEYS = new Set([
  "campaignId",
  "index",
  "receipt",
  "status"
]);
var MATRIX_SUMMARY_KEYS = new Set([
  "campaigns",
  "failureCode",
  "schema",
  "status"
]);
var MATRIX_SUMMARY_CAMPAIGNS_KEYS = new Set([
  "failed",
  "notRun",
  "notSelected",
  "omitted",
  "passed",
  "rejected",
  "total"
]);
var SHA256_PATTERN = /^[0-9a-f]{64}$/u;
var GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/u;
var ARTIFACT_EVIDENCE_JSON_LIMITS = Object.freeze({
  maxDepth: 8,
  maxNodes: 2048,
  maxStringBytes: 64 * 1024
});
var SCENARIO_PATTERN = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
var ARTIFACT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
var MAX_ARTIFACT_IDENTIFIER_LENGTH = 80;
var MAX_MATRIX_CAMPAIGNS = 32;
var ARTIFACT_COORDINATION_ENVIRONMENT = "DIRECT_BOMBADIL_RUN_ID";
var BOMBADIL_PRIVATE_ENVIRONMENT_NAMES = new Set([
  ARTIFACT_COORDINATION_ENVIRONMENT,
  ...BOMBADIL_TOOLCHAIN_ENVIRONMENT_NAMES
]);
var ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
var QUERY_PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
var PROTOTYPE_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
var TRACE_MAX_BYTES = 64 * 1024 * 1024;
var TRACE_MAX_LINE_BYTES = 16 * 1024 * 1024;
var TRACE_MAX_LINES = 1e4;
var TRACE_MAX_SNAPSHOTS_PER_LINE = 4096;
var TRACE_MAX_NAMED_SNAPSHOT_NAMES = 128;
var TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME = 1024;
var TRACE_MAX_DISTINCT_URLS = 1024;
var TRACE_MAX_PROPERTY_NAMES = 128;
var TRACE_MAX_CANONICAL_SNAPSHOT_BYTES = 2 * 1024 * 1024;
var TRACE_MAX_JSON_DEPTH = 64;
var RANDOM_RUN_OVERHEAD_MS = 30000;
var REPLAY_WALL_CLOCK_TIMEOUT_MS = MAX_TIME_LIMIT_SECONDS * 1000 + RANDOM_RUN_OVERHEAD_MS;
var PROCESS_TERMINATION_GRACE_MS = 5000;
var MIN_PROCESS_OUTPUT_DRAIN_MS = 500;
var BOMBADIL_VERSION_PROBE_TIMEOUT_MS = 5000;
var BOMBADIL_VERSION_OUTPUT_LIMIT = 1024;
var MAX_BOMBADIL_EXECUTABLE_BYTES = 64 * 1024 * 1024;
var SERVER_OUTPUT_TIMEOUT_MS = 3000;
var ARTIFACT_MONITOR_INTERVAL_MS = 100;
var MAX_LIVE_CHROME_RENAME_RETRIES = 4;
var DEFAULT_ARTIFACT_MAX_ENTRIES = 4096;
var DEFAULT_ARTIFACT_MAX_FILES = 2048;
var DEFAULT_ARTIFACT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
var DEFAULT_ARTIFACT_MAX_FILE_BYTES = 64 * 1024 * 1024;
var DEFAULT_ARTIFACT_MAX_DEPTH = 32;
var DEFAULT_ARTIFACT_MAX_PATH_BYTES = 4096;
var MAX_ARTIFACT_ENTRIES = 16384;
var MAX_ARTIFACT_FILES = 8192;
var MAX_ARTIFACT_TOTAL_BYTES = 256 * 1024 * 1024;
var MAX_ARTIFACT_FILE_BYTES = 64 * 1024 * 1024;
var MAX_ARTIFACT_DEPTH = 64;
var MAX_ARTIFACT_PATH_BYTES = 4096;
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
var ARTIFACT_PATH_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
var PRIVATE_DIAGNOSTIC_EXTENSIONS = new Set([
  ".jpeg",
  ".jpg",
  ".json",
  ".jsonl",
  ".log",
  ".png",
  ".txt",
  ".webp"
]);
var DIRECT_BROWSER_BRIDGE_SCHEMA = "direct.browser-bridge/v2";
var TRACE_LINE_KEYS = new Set(["action", "snapshots", "state", "timestamp", "violations"]);
var TRACE_SNAPSHOT_KEYS = new Set(["index", "name", "time", "value"]);
var TRACE_STATE_KEYS = new Set([
  "hash_current",
  "hash_previous",
  "resources",
  "screenshot",
  "url"
]);
var TRACE_RESOURCE_KEYS = new Set([
  "documents",
  "dom_nodes",
  "js_event_listeners",
  "js_heap_total",
  "js_heap_used",
  "layout_objects",
  "script_duration",
  "task_duration",
  "thread_time",
  "timestamp"
]);
var TRACE_VIOLATION_KEYS = new Set(["name", "violation"]);
var TRACE_POINT_KEYS = new Set(["x", "y"]);
var TRACE_FINGERPRINT_KEYS = new Set([
  "accessible_name",
  "href",
  "id",
  "input_type",
  "name_attr",
  "placeholder",
  "role",
  "structural_path",
  "tag",
  "test_id",
  "text_content"
]);
var TRACE_CLICK_ACTION_KEYS = new Set(["fingerprint", "point"]);
var TRACE_DOUBLE_CLICK_ACTION_KEYS = new Set([
  "delay_millis",
  "fingerprint",
  "point"
]);
var TRACE_TYPE_TEXT_ACTION_KEYS = new Set(["delay_millis", "text"]);
var TRACE_PRESS_KEY_ACTION_KEYS = new Set(["code"]);
var TRACE_SCROLL_ACTION_KEYS = new Set(["distance", "origin"]);
var TRACE_FILE_INPUT_ACTION_KEYS = new Set(["files", "selector"]);
var TRACE_MOUSE_DRAG_ACTION_KEYS = new Set([
  "delay_millis",
  "from",
  "steps",
  "to"
]);
var TRACE_VIEWPORT_ACTION_KEYS = new Set(["height", "width"]);
var VIEWPORT_KEYS = new Set(["deviceScaleFactor", "height", "width"]);
var EXPLORATION_POLICY_KEYS = new Set([
  "minDistinctNamedSnapshotValues",
  "minNamedSnapshotChangesAfterActionKind",
  "minNamedSnapshotChangesAfterNonWait",
  "minNonWaitActions",
  "requireStableTargetUrl",
  "requiredActionKinds",
  "requiredNamedSnapshots"
]);
var DEFAULT_VIEWPORT_WIDTH = 1024;
var DEFAULT_VIEWPORT_HEIGHT = 768;
var DEFAULT_DEVICE_SCALE_FACTOR = 2;
var SNAPSHOT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]*$/u;
var TARGET_TAG_PATTERN = /^[a-z][a-z0-9-]*$/u;
var ACTION_KINDS = [
  "Back",
  "Click",
  "DoubleClick",
  "Forward",
  "MouseDrag",
  "PressKey",
  "Reload",
  "ScrollDown",
  "ScrollUp",
  "SetFileInputFiles",
  "SetViewport",
  "TypeText",
  "Wait"
];
var ACTION_KIND_SET = new Set(ACTION_KINDS);
var UNIT_ACTION_KINDS = new Set([
  "Back",
  "Forward",
  "Reload",
  "Wait"
]);
var DIRECT_OBSERVATION_KEYS = new Set([
  "activationHash",
  "activeRoute",
  "activeScenario",
  "activeSource",
  "bridgePresent",
  "bridgeSchema",
  "catalogHash",
  "contractValid",
  "isQuiescent",
  "manifest",
  "probe",
  "violations",
  "violationsValid"
]);
var BOMBADIL_EXECUTABLE_ATTESTATION = Symbol("bombadilExecutableAttestation");
var PROCESS_INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM"];

class BombadilArtifactPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "BombadilArtifactPolicyError";
  }
}

class LiveChromeDownloadRenameRetry extends Error {
  completion;
  constructor(completion) {
    super("Chrome download renamed during live artifact inspection");
    this.name = "LiveChromeDownloadRenameRetry";
    this.completion = completion;
  }
}

class BombadilWriterSettlementError extends Error {
  constructor(message, cause) {
    super(message, { cause });
    this.name = "BombadilWriterSettlementError";
  }
}

class BombadilPersistenceError extends AggregateError {
  constructor(message, errors) {
    super(errors, message, { cause: errors[0] });
    this.name = "BombadilPersistenceError";
  }
}
function retainPrivateBombadilSnapshotAfterWriterSettlementFailure(failure) {
  return new BombadilWriterSettlementError("Bombadil writers were not proven absent; the private executable snapshot was retained as protected persistence evidence", new AggregateError([
    failure,
    new BombadilPersistenceError("Bombadil private executable snapshot removal was suppressed", [new Error("native process and writer settlement was not proven")])
  ], "Bombadil writer settlement and private snapshot persistence evidence", { cause: failure }));
}
function readOptionValue(arguments_, index, option) {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return { index: index + 1, value };
}
function parseTimeLimit(value) {
  const match = /^([1-9][0-9]*)s$/u.exec(value);
  if (match === null) {
    throw new Error("--time-limit must be a whole number of seconds such as 20s");
  }
  const seconds = Number(match[1]);
  if (!Number.isSafeInteger(seconds) || seconds < MIN_TIME_LIMIT_SECONDS || seconds > MAX_TIME_LIMIT_SECONDS) {
    throw new Error(`--time-limit must be between ${String(MIN_TIME_LIMIT_SECONDS)}s and ${String(MAX_TIME_LIMIT_SECONDS)}s`);
  }
  return seconds;
}
function bombadilNativeBinary(repositoryRoot) {
  let binary;
  if (process2.platform === "darwin" && process2.arch === "arm64") {
    binary = "bombadil-darwin-arm64";
  } else if (process2.platform === "linux" && process2.arch === "x64") {
    binary = "bombadil-linux-x64";
  } else if (process2.platform === "linux" && process2.arch === "arm64") {
    binary = "bombadil-linux-arm64";
  } else {
    throw new Error(`Bombadil 0.7.2 does not support ${process2.platform}-${process2.arch}`);
  }
  return join2(repositoryRoot, "node_modules", "@antithesishq", "bombadil", "binaries", binary);
}
function validateBombadilToolchainConfig(value, repositoryRoot) {
  if (value === undefined)
    return null;
  if (!isRecord2(value)) {
    throw new Error("bombadilToolchain must be an exact object");
  }
  const keys = Object.keys(value).sort(compareCodeUnits);
  if (JSON.stringify(keys) !== JSON.stringify(BOMBADIL_TOOLCHAIN_CONFIG_KEYS)) {
    throw new Error(`bombadilToolchain must contain exactly ${BOMBADIL_TOOLCHAIN_CONFIG_KEYS.join(", ")}`);
  }
  const executablePath = Reflect.get(value, "executablePath");
  const sha256 = Reflect.get(value, "sha256");
  const sourceRevision = Reflect.get(value, "sourceRevision");
  const version = Reflect.get(value, "version");
  const buildContract = Reflect.get(value, "buildContract");
  if (typeof executablePath !== "string" || !isAbsolute(executablePath) || resolve(executablePath) !== executablePath || !isWithin(repositoryRoot, executablePath)) {
    throw new Error("bombadilToolchain.executablePath must be an absolute normalized path inside repositoryRoot");
  }
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    throw new Error("bombadilToolchain.sha256 must be exactly 64 lowercase hexadecimal characters");
  }
  if (typeof sourceRevision !== "string" || !GIT_REVISION_PATTERN.test(sourceRevision)) {
    throw new Error("bombadilToolchain.sourceRevision must be exactly 40 lowercase hexadecimal characters");
  }
  if (version !== EXPECTED_BOMBADIL_VERSION) {
    throw new Error(`bombadilToolchain.version must be exactly ${EXPECTED_BOMBADIL_VERSION}`);
  }
  if (typeof buildContract !== "string" || !BOMBADIL_TOOLCHAIN_BUILD_CONTRACTS.has(buildContract)) {
    throw new Error("bombadilToolchain.buildContract is unsupported");
  }
  return Object.freeze({
    buildContract,
    executablePath,
    sha256,
    sourceRevision,
    version: EXPECTED_BOMBADIL_VERSION
  });
}
function bombadilToolchainIdentity(toolchain) {
  return toolchain === null ? "npm-package" : JSON.stringify({
    buildContract: toolchain.buildContract,
    executablePath: toolchain.executablePath,
    sha256: toolchain.sha256,
    sourceRevision: toolchain.sourceRevision,
    version: toolchain.version
  });
}
function requireLocalRootHttpOrigin(value) {
  const baseUrl = normalizeRootHttpOrigin(value);
  const url = new URL(baseUrl);
  if (!canAutomaticallyStartLocalServer(baseUrl)) {
    throw new Error("--base-url must use HTTP on 127.0.0.1 or localhost");
  }
  if (url.port === "") {
    throw new Error("--base-url must include an explicit local server port");
  }
  if (Number(url.port) < 1) {
    throw new Error("--base-url port must be between 1 and 65535");
  }
  return baseUrl;
}
function hasControlCharacters3(value) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127)
      return true;
  }
  return false;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isReadonlyStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}
function compareCodeUnits(left, right) {
  if (left < right)
    return -1;
  if (left > right)
    return 1;
  return 0;
}
function boundedArtifactInteger(options) {
  const value = options.value ?? options.defaultValue;
  if (!Number.isSafeInteger(value) || value < 1 || value > options.maximum) {
    throw new Error(`${options.label} must be an integer between 1 and ${String(options.maximum)}`);
  }
  return value;
}
function validateArtifactPolicy(input) {
  const value = input ?? {};
  return Object.freeze({
    maxDepth: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_DEPTH,
      label: "artifactPolicy.maxDepth",
      maximum: MAX_ARTIFACT_DEPTH,
      value: value.maxDepth
    }),
    maxEntries: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_ENTRIES,
      label: "artifactPolicy.maxEntries",
      maximum: MAX_ARTIFACT_ENTRIES,
      value: value.maxEntries
    }),
    maxFileBytes: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_FILE_BYTES,
      label: "artifactPolicy.maxFileBytes",
      maximum: MAX_ARTIFACT_FILE_BYTES,
      value: value.maxFileBytes
    }),
    maxFiles: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_FILES,
      label: "artifactPolicy.maxFiles",
      maximum: MAX_ARTIFACT_FILES,
      value: value.maxFiles
    }),
    maxPathBytes: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_PATH_BYTES,
      label: "artifactPolicy.maxPathBytes",
      maximum: MAX_ARTIFACT_PATH_BYTES,
      value: value.maxPathBytes
    }),
    maxTotalBytes: boundedArtifactInteger({
      defaultValue: DEFAULT_ARTIFACT_MAX_TOTAL_BYTES,
      label: "artifactPolicy.maxTotalBytes",
      maximum: MAX_ARTIFACT_TOTAL_BYTES,
      value: value.maxTotalBytes
    })
  });
}
function normalizeFuzzRunOptions(input) {
  if (input === undefined || isReadonlyStringArray(input)) {
    return {
      arguments: Object.freeze([...input ?? []]),
      artifactRun: null
    };
  }
  const options = input;
  const artifactRun = options.artifactRun;
  if (!isRecord2(options))
    throw new Error("Bombadil run options must be an object or argument array");
  const keys = Object.keys(options);
  if (keys.some((key) => key !== "arguments" && key !== "artifactRun")) {
    throw new Error("Bombadil run options contain an unknown field");
  }
  const arguments_ = options.arguments ?? [];
  if (!isReadonlyStringArray(arguments_)) {
    throw new Error("Bombadil run options arguments must be a string array");
  }
  return {
    arguments: Object.freeze([...arguments_]),
    artifactRun: artifactRun ?? null
  };
}
function validateArtifactRunPlan(input) {
  const repositoryRoot = resolve(input.repositoryRoot);
  if (!isAbsolute(input.repositoryRoot) || repositoryRoot !== input.repositoryRoot) {
    throw new Error("artifactRun.repositoryRoot must be an absolute normalized path");
  }
  if (!UUID_PATTERN.test(input.runId)) {
    throw new Error("artifactRun.runId must be a lowercase RFC 4122 UUID");
  }
  const uploadMode = input.uploadMode ?? "public-summary";
  if (uploadMode !== "public-summary" && uploadMode !== "private-vetted") {
    throw new Error("artifactRun.uploadMode must be public-summary or private-vetted");
  }
  return Object.freeze({ repositoryRoot, runId: input.runId, uploadMode });
}
function isBoundedArtifactIdentifier(value) {
  return value.length <= MAX_ARTIFACT_IDENTIFIER_LENGTH && ARTIFACT_NAME_PATTERN.test(value);
}
function isBoundedScenarioIdentifier(value) {
  return value.length <= 120 && SCENARIO_PATTERN.test(value);
}
function requireEvidenceRecord(value, keys, label) {
  if (!isRecord2(value) || !hasExactKeys(value, keys)) {
    throw new Error(`${label} must contain exactly its documented fields`);
  }
  return value;
}
function requireEvidenceInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a nonnegative safe integer no greater than ${String(maximum)}`);
  }
  return value;
}
function requireEvidencePositiveInteger(value, label, maximum) {
  const parsed = requireEvidenceInteger(value, label, maximum);
  if (parsed === 0)
    throw new Error(`${label} must be greater than zero`);
  return parsed;
}
function requireEvidenceSha256(value, label) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}
function requireEvidenceTimestamp(value, label) {
  if (typeof value !== "string")
    throw new Error(`${label} must be an ISO timestamp`);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return value;
}
function parseEvidenceFailureCode(value, label) {
  if (value === null)
    return null;
  if (typeof value !== "string" || !ARTIFACT_FAILURE_CODES.has(value)) {
    throw new Error(`${label} is not a known Bombadil failure code`);
  }
  return value;
}
function requireEvidenceStatus(value, label) {
  if (value !== "failed" && value !== "passed" && value !== "rejected") {
    throw new Error(`${label} must be failed, passed, or rejected`);
  }
  return value;
}
function requireFailureStatusConsistency(status, failureCode, label) {
  if (status === "passed" !== (failureCode === null)) {
    throw new Error(`${label} status and failureCode are inconsistent`);
  }
  if (status === "rejected" && failureCode !== "configuration-rejected") {
    throw new Error(`${label} rejected status requires configuration-rejected`);
  }
}
function parseArtifactReceiptUnchecked(input) {
  const value = requireEvidenceRecord(input, ARTIFACT_RECEIPT_KEYS, "Bombadil receipt");
  if (value.schema !== ARTIFACT_RECEIPT_SCHEMA) {
    throw new Error("Bombadil receipt schema is unsupported");
  }
  const completedAt = requireEvidenceTimestamp(value.completedAt, "Bombadil receipt completedAt");
  if (typeof value.diagnosticsRetained !== "boolean") {
    throw new Error("Bombadil receipt diagnosticsRetained must be boolean");
  }
  const failureCode = parseEvidenceFailureCode(value.failureCode, "Bombadil receipt failureCode");
  const status = requireEvidenceStatus(value.status, "Bombadil receipt status");
  requireFailureStatusConsistency(status, failureCode, "Bombadil receipt");
  if (value.mode !== "private-vetted" && value.mode !== "public-summary") {
    throw new Error("Bombadil receipt mode is unsupported");
  }
  if (value.diagnosticsRetained && value.mode !== "private-vetted") {
    throw new Error("Public Bombadil receipts cannot retain diagnostics");
  }
  if (typeof value.runId !== "string" || !UUID_PATTERN.test(value.runId)) {
    throw new Error("Bombadil receipt runId must be a lowercase RFC 4122 UUID");
  }
  const rawPolicy = requireEvidenceRecord(value.policy, ARTIFACT_POLICY_RECEIPT_KEYS, "Bombadil receipt policy");
  const policy = Object.freeze({
    maxDepth: requireEvidencePositiveInteger(rawPolicy.maxDepth, "Bombadil receipt policy.maxDepth", MAX_ARTIFACT_DEPTH),
    maxEntries: requireEvidencePositiveInteger(rawPolicy.maxEntries, "Bombadil receipt policy.maxEntries", MAX_ARTIFACT_ENTRIES),
    maxFileBytes: requireEvidencePositiveInteger(rawPolicy.maxFileBytes, "Bombadil receipt policy.maxFileBytes", MAX_ARTIFACT_FILE_BYTES),
    maxFiles: requireEvidencePositiveInteger(rawPolicy.maxFiles, "Bombadil receipt policy.maxFiles", MAX_ARTIFACT_FILES),
    maxPathBytes: requireEvidencePositiveInteger(rawPolicy.maxPathBytes, "Bombadil receipt policy.maxPathBytes", MAX_ARTIFACT_PATH_BYTES),
    maxTotalBytes: requireEvidencePositiveInteger(rawPolicy.maxTotalBytes, "Bombadil receipt policy.maxTotalBytes", MAX_ARTIFACT_TOTAL_BYTES)
  });
  const rawInventory = requireEvidenceRecord(value.inventory, ARTIFACT_RECEIPT_INVENTORY_KEYS, "Bombadil receipt inventory");
  const entryCount = requireEvidenceInteger(rawInventory.entryCount, "Bombadil receipt inventory.entryCount", policy.maxEntries);
  const fileCount = requireEvidenceInteger(rawInventory.fileCount, "Bombadil receipt inventory.fileCount", policy.maxFiles);
  const totalBytes = requireEvidenceInteger(rawInventory.totalBytes, "Bombadil receipt inventory.totalBytes", policy.maxTotalBytes);
  if (fileCount > entryCount) {
    throw new Error("Bombadil receipt inventory.fileCount cannot exceed entryCount");
  }
  if (fileCount === 0 && totalBytes !== 0) {
    throw new Error("Bombadil receipt inventory bytes require at least one file");
  }
  const inventorySha256 = rawInventory.inventorySha256 === null ? null : requireEvidenceSha256(rawInventory.inventorySha256, "Bombadil receipt inventory.inventorySha256");
  if (entryCount === 0 && (fileCount !== 0 || totalBytes !== 0 || inventorySha256 !== null) || entryCount > 0 && inventorySha256 === null) {
    throw new Error("Bombadil receipt empty-inventory fields are inconsistent");
  }
  if (status === "passed" && (entryCount === 0 || fileCount === 0 || totalBytes === 0) || status === "passed" && value.mode === "private-vetted" && !value.diagnosticsRetained || failureCode === "interrupted" && value.diagnosticsRetained || failureCode === "configuration-rejected" && status !== "rejected" || failureCode === "writer-settlement" && (value.diagnosticsRetained || entryCount !== 0 || fileCount !== 0 || totalBytes !== 0) || status === "rejected" && (value.diagnosticsRetained || entryCount !== 0 || fileCount !== 0 || totalBytes !== 0)) {
    throw new Error("Bombadil receipt terminal state and retained evidence are inconsistent");
  }
  return Object.freeze({
    schema: ARTIFACT_RECEIPT_SCHEMA,
    completedAt,
    diagnosticsRetained: value.diagnosticsRetained,
    failureCode,
    inventory: Object.freeze({ entryCount, fileCount, inventorySha256, totalBytes }),
    mode: value.mode,
    policy,
    runId: value.runId,
    status
  });
}
function parseRunSummaryUnchecked(input) {
  const value = requireEvidenceRecord(input, RUN_SUMMARY_KEYS, "Bombadil run summary");
  if (value.schema !== ARTIFACT_SUMMARY_SCHEMA) {
    throw new Error("Bombadil run summary schema is unsupported");
  }
  if (typeof value.artifactName !== "string" || !isBoundedArtifactIdentifier(value.artifactName)) {
    throw new Error("Bombadil run summary artifactName is invalid");
  }
  if (typeof value.scenario !== "string" || !isBoundedScenarioIdentifier(value.scenario)) {
    throw new Error("Bombadil run summary scenario is invalid");
  }
  const failureCode = parseEvidenceFailureCode(value.failureCode, "Bombadil run summary failureCode");
  const status = requireEvidenceStatus(value.status, "Bombadil run summary status");
  requireFailureStatusConsistency(status, failureCode, "Bombadil run summary");
  let attestation = null;
  if (value.attestation !== null) {
    const raw = requireEvidenceRecord(value.attestation, RUN_SUMMARY_ATTESTATION_KEYS, "Bombadil run summary attestation");
    const observationCount = requireEvidenceInteger(raw.observationCount, "Bombadil run summary attestation.observationCount", TRACE_MAX_LINES);
    const invalidObservationCount = requireEvidenceInteger(raw.invalidObservationCount, "Bombadil run summary attestation.invalidObservationCount", observationCount);
    const validObservationCount = requireEvidenceInteger(raw.validObservationCount, "Bombadil run summary attestation.validObservationCount", observationCount);
    if (invalidObservationCount + validObservationCount !== observationCount) {
      throw new Error("Bombadil run summary attestation counts do not reconcile");
    }
    if (observationCount === 0 || validObservationCount === 0) {
      throw new Error("Bombadil run summary attestation must contain a valid observation");
    }
    attestation = Object.freeze({
      invalidObservationCount,
      observationCount,
      validObservationCount
    });
  }
  let exploration = null;
  if (value.exploration !== null) {
    const raw = requireEvidenceRecord(value.exploration, RUN_SUMMARY_EXPLORATION_KEYS, "Bombadil run summary exploration");
    const traceLineCount = requireEvidenceInteger(raw.traceLineCount, "Bombadil run summary exploration.traceLineCount", TRACE_MAX_LINES);
    const actionCount = requireEvidenceInteger(raw.actionCount, "Bombadil run summary exploration.actionCount", traceLineCount);
    const nonWaitActionCount = requireEvidenceInteger(raw.nonWaitActionCount, "Bombadil run summary exploration.nonWaitActionCount", actionCount);
    if (typeof raw.policySatisfied !== "boolean") {
      throw new Error("Bombadil run summary exploration.policySatisfied must be boolean");
    }
    exploration = Object.freeze({
      actionCount,
      nonWaitActionCount,
      policySatisfied: raw.policySatisfied,
      traceBytes: requireEvidenceInteger(raw.traceBytes, "Bombadil run summary exploration.traceBytes", TRACE_MAX_BYTES),
      traceLineCount,
      traceSha256: requireEvidenceSha256(raw.traceSha256, "Bombadil run summary exploration.traceSha256")
    });
    if (exploration.traceBytes === 0 || exploration.traceLineCount === 0) {
      throw new Error("Bombadil run summary exploration trace must be nonempty");
    }
  }
  if (status === "passed" && (attestation === null || attestation.observationCount === 0 || attestation.validObservationCount === 0 || exploration === null || !exploration.policySatisfied || attestation.observationCount !== exploration.traceLineCount)) {
    throw new Error("A passed Bombadil run summary requires attested policy-satisfying evidence");
  }
  if (attestation !== null && exploration !== null && attestation.observationCount !== exploration.traceLineCount) {
    throw new Error("Bombadil run summary trace counts do not reconcile");
  }
  if (status === "rejected" && (attestation !== null || exploration !== null)) {
    throw new Error("A rejected Bombadil run summary cannot claim trace evidence");
  }
  if (failureCode === "configuration-rejected" && status !== "rejected") {
    throw new Error("A configuration-rejected Bombadil run summary must be rejected");
  }
  if (failureCode === "writer-settlement" && (attestation !== null || exploration !== null)) {
    throw new Error("A writer-settlement Bombadil run summary cannot claim trace evidence");
  }
  return Object.freeze({
    schema: ARTIFACT_SUMMARY_SCHEMA,
    artifactName: value.artifactName,
    attestation,
    exploration,
    failureCode,
    scenario: value.scenario,
    status
  });
}
function parseMatrixReceiptUnchecked(input) {
  const value = requireEvidenceRecord(input, MATRIX_RECEIPT_KEYS, "Bombadil matrix receipt");
  if (value.schema !== MATRIX_RECEIPT_SCHEMA || value.mode !== "public-summary") {
    throw new Error("Bombadil matrix receipt schema or mode is unsupported");
  }
  const completedAt = requireEvidenceTimestamp(value.completedAt, "Bombadil matrix receipt completedAt");
  const failureCode = parseEvidenceFailureCode(value.failureCode, "Bombadil matrix receipt failureCode");
  if (value.status !== "failed" && value.status !== "passed") {
    throw new Error("Bombadil matrix receipt status must be failed or passed");
  }
  requireFailureStatusConsistency(value.status, failureCode, "Bombadil matrix receipt");
  if (typeof value.runId !== "string" || !UUID_PATTERN.test(value.runId)) {
    throw new Error("Bombadil matrix receipt runId must be a lowercase RFC 4122 UUID");
  }
  if (!Array.isArray(value.campaigns) || value.campaigns.length > MAX_MATRIX_CAMPAIGNS) {
    throw new Error("Bombadil matrix receipt campaigns exceed the bounded matrix size");
  }
  const campaignIds = new Set;
  const campaigns = value.campaigns.map((inputCampaign, index) => {
    const campaign = requireEvidenceRecord(inputCampaign, MATRIX_CAMPAIGN_RECEIPT_KEYS, `Bombadil matrix receipt campaign ${String(index)}`);
    if (campaign.index !== index) {
      throw new Error("Bombadil matrix receipt campaign indices must be ordered and contiguous");
    }
    const campaignId = campaign.campaignId;
    if (campaignId !== null && (typeof campaignId !== "string" || !isBoundedArtifactIdentifier(campaignId) || campaignIds.has(campaignId))) {
      throw new Error("Bombadil matrix receipt campaign IDs must be unique bounded identifiers");
    }
    if (campaignId !== null)
      campaignIds.add(campaignId);
    if (campaign.status !== "failed" && campaign.status !== "not-run" && campaign.status !== "not-selected" && campaign.status !== "passed" && campaign.status !== "rejected") {
      throw new Error("Bombadil matrix receipt campaign status is unsupported");
    }
    const expectedReceipt = campaignId === null ? null : `campaigns/${campaignId}/receipt.json`;
    if (campaign.receipt !== null && (typeof campaign.receipt !== "string" || campaign.receipt !== expectedReceipt)) {
      throw new Error("Bombadil matrix child receipt path is not canonical");
    }
    if ((campaign.status === "not-run" || campaign.status === "not-selected") && campaign.receipt !== null || campaign.status === "passed" && campaign.receipt !== expectedReceipt || campaignId === null && (campaign.status !== "rejected" || campaign.receipt !== null)) {
      throw new Error("Bombadil matrix child terminal state is inconsistent");
    }
    return Object.freeze({
      campaignId,
      index,
      receipt: campaign.receipt,
      status: campaign.status
    });
  });
  const omittedCampaignCount = requireEvidenceInteger(value.omittedCampaignCount, "Bombadil matrix receipt omittedCampaignCount");
  if (value.status === "passed" && (omittedCampaignCount !== 0 || !campaigns.some((campaign) => campaign.status === "passed") || campaigns.some((campaign) => campaign.status === "failed" || campaign.status === "not-run" || campaign.status === "rejected"))) {
    throw new Error("A passed Bombadil matrix receipt has a nonterminal child");
  }
  return Object.freeze({
    schema: MATRIX_RECEIPT_SCHEMA,
    campaigns: Object.freeze(campaigns),
    completedAt,
    failureCode,
    mode: "public-summary",
    omittedCampaignCount,
    runId: value.runId,
    status: value.status
  });
}
function parseMatrixSummaryUnchecked(input) {
  const value = requireEvidenceRecord(input, MATRIX_SUMMARY_KEYS, "Bombadil matrix summary");
  if (value.schema !== MATRIX_SUMMARY_SCHEMA) {
    throw new Error("Bombadil matrix summary schema is unsupported");
  }
  const failureCode = parseEvidenceFailureCode(value.failureCode, "Bombadil matrix summary failureCode");
  if (value.status !== "failed" && value.status !== "passed") {
    throw new Error("Bombadil matrix summary status must be failed or passed");
  }
  requireFailureStatusConsistency(value.status, failureCode, "Bombadil matrix summary");
  const rawCampaigns = requireEvidenceRecord(value.campaigns, MATRIX_SUMMARY_CAMPAIGNS_KEYS, "Bombadil matrix summary campaigns");
  const total = requireEvidenceInteger(rawCampaigns.total, "Bombadil matrix summary campaigns.total", MAX_MATRIX_CAMPAIGNS);
  const campaigns = Object.freeze({
    failed: requireEvidenceInteger(rawCampaigns.failed, "Bombadil matrix summary failed", total),
    notRun: requireEvidenceInteger(rawCampaigns.notRun, "Bombadil matrix summary notRun", total),
    notSelected: requireEvidenceInteger(rawCampaigns.notSelected, "Bombadil matrix summary notSelected", total),
    omitted: requireEvidenceInteger(rawCampaigns.omitted, "Bombadil matrix summary omitted"),
    passed: requireEvidenceInteger(rawCampaigns.passed, "Bombadil matrix summary passed", total),
    rejected: requireEvidenceInteger(rawCampaigns.rejected, "Bombadil matrix summary rejected", total),
    total
  });
  if (campaigns.failed + campaigns.notRun + campaigns.notSelected + campaigns.passed + campaigns.rejected !== campaigns.total) {
    throw new Error("Bombadil matrix summary campaign counts do not reconcile");
  }
  if (value.status === "passed" && (campaigns.failed !== 0 || campaigns.notRun !== 0 || campaigns.rejected !== 0 || campaigns.omitted !== 0 || campaigns.passed === 0)) {
    throw new Error("A passed Bombadil matrix summary contains unsuccessful campaigns");
  }
  return Object.freeze({
    schema: MATRIX_SUMMARY_SCHEMA,
    campaigns,
    failureCode,
    status: value.status
  });
}
function artifactEvidenceError(error) {
  return Object.freeze({
    code: "invalid-bombadil-artifact-evidence",
    message: renderUnknown(error)
  });
}
function cloneArtifactEvidence(input) {
  const parsed = parseJsonValue(input, ARTIFACT_EVIDENCE_JSON_LIMITS);
  if (!parsed.ok) {
    throw new Error(`Bombadil artifact evidence is not bounded inert JSON: ${parsed.error.message}`);
  }
  return parsed.value;
}
function parseDirectBombadilArtifactReceipt(input) {
  try {
    return ok(parseArtifactReceiptUnchecked(cloneArtifactEvidence(input)));
  } catch (error) {
    return err(artifactEvidenceError(error));
  }
}
function parseDirectBombadilSanitizedRunSummary(input) {
  try {
    return ok(parseRunSummaryUnchecked(cloneArtifactEvidence(input)));
  } catch (error) {
    return err(artifactEvidenceError(error));
  }
}
function parseDirectBombadilMatrixReceipt(input) {
  try {
    return ok(parseMatrixReceiptUnchecked(cloneArtifactEvidence(input)));
  } catch (error) {
    return err(artifactEvidenceError(error));
  }
}
function parseDirectBombadilMatrixSummary(input) {
  try {
    return ok(parseMatrixSummaryUnchecked(cloneArtifactEvidence(input)));
  } catch (error) {
    return err(artifactEvidenceError(error));
  }
}
function resolveDirectBombadilUploadLeaf(input) {
  const plan = validateArtifactRunPlan(input);
  return join2(plan.repositoryRoot, "artifacts", "direct-bombadil-upload", plan.runId);
}
async function requireSafeDirectory(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch {
    throw new BombadilArtifactPolicyError(`${label} does not exist`);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new BombadilArtifactPolicyError(`${label} must be a non-symlink directory`);
  }
}
async function ensureSafeDirectoryChain(repositoryRoot, parts) {
  await requireSafeDirectory(repositoryRoot, "repositoryRoot");
  let current = repositoryRoot;
  for (const part of parts) {
    if (!ARTIFACT_PATH_PART_PATTERN.test(part) || part === "." || part === "..") {
      throw new BombadilArtifactPolicyError("Artifact directory contains an unsafe path component");
    }
    current = join2(current, part);
    try {
      await mkdir2(current, { mode: 448 });
    } catch (error) {
      if (!isRecord2(error) || error.code !== "EEXIST")
        throw error;
    }
    await requireSafeDirectory(current, `Artifact directory ${part}`);
    const resolved = await realpath(current);
    if (!isWithin(repositoryRoot, resolved) || resolved !== current) {
      throw new BombadilArtifactPolicyError("Artifact directory escaped repositoryRoot");
    }
  }
  return current;
}
async function createExclusiveDirectory(path, label) {
  try {
    await mkdir2(path, { mode: 448 });
  } catch (error) {
    if (isRecord2(error) && error.code === "EEXIST") {
      throw new BombadilArtifactPolicyError(`${label} already exists`);
    }
    throw error;
  }
  await requireSafeDirectory(path, label);
}
async function createBombadilArtifactRun(options) {
  if (!UUID_PATTERN.test(options.runId)) {
    throw new BombadilArtifactPolicyError("Bombadil raw artifact run ID must be a UUID");
  }
  const artifactRoot = await ensureSafeDirectoryChain(options.repositoryRoot, [
    "artifacts",
    "direct-bombadil",
    options.artifactName
  ]);
  const runDirectory = join2(artifactRoot, options.runId);
  await createExclusiveDirectory(runDirectory, "Bombadil artifact run leaf");
  return {
    artifactRoot,
    manifestPath: join2(artifactRoot, "manifest.json"),
    runDirectory
  };
}
async function prepareArtifactUploadSession(planInput) {
  const plan = validateArtifactRunPlan(planInput);
  let repositoryRoot;
  try {
    repositoryRoot = await realpath(plan.repositoryRoot);
  } catch (error) {
    if (!isRecord2(error) || error.code !== "ENOENT") {
      throw new BombadilArtifactPolicyError(`artifactRun.repositoryRoot could not be proven safe: ${renderUnknown(error)}`);
    }
    repositoryRoot = null;
  }
  if (repositoryRoot === null || repositoryRoot !== plan.repositoryRoot) {
    throw new BombadilArtifactPolicyError("artifactRun.repositoryRoot must resolve to its exact configured directory");
  }
  const root = await ensureSafeDirectoryChain(repositoryRoot, [
    "artifacts",
    "direct-bombadil-upload"
  ]);
  const finalDirectory = join2(root, plan.runId);
  let finalMetadata;
  try {
    finalMetadata = await lstat(finalDirectory);
  } catch (error) {
    if (!isRecord2(error) || error.code !== "ENOENT") {
      throw new BombadilArtifactPolicyError(`Bombadil upload run leaf could not be inspected: ${renderUnknown(error)}`);
    }
    finalMetadata = null;
  }
  if (finalMetadata !== null) {
    throw new BombadilArtifactPolicyError("Bombadil upload run leaf already exists");
  }
  const stagingDirectory = join2(root, `.staging-${plan.runId}`);
  return {
    finalDirectory,
    mode: plan.uploadMode,
    publication: "atomic-leaf",
    receiptPath: join2(finalDirectory, "receipt.json"),
    runId: plan.runId,
    stagingDirectory
  };
}
async function requireArtifactUploadLeafAbsent(session2) {
  let existing;
  try {
    existing = await lstat(session2.finalDirectory);
  } catch (error) {
    if (!isRecord2(error) || error.code !== "ENOENT") {
      throw new BombadilArtifactPolicyError(`Bombadil upload run leaf could not be inspected: ${renderUnknown(error)}`);
    }
    existing = null;
  }
  if (existing !== null) {
    throw new BombadilArtifactPolicyError("Bombadil upload run leaf appeared before publication");
  }
}
async function commitArtifactUploadSession(session2) {
  await rename2(session2.stagingDirectory, session2.finalDirectory);
}
function validateArtifactRelativePath(relativePath, policy) {
  const parts = relativePath.split("/");
  if (relativePath.length === 0 || relativePath.includes("\\") || Buffer.byteLength(relativePath, "utf8") > policy.maxPathBytes || parts.length > policy.maxDepth || parts.some((part) => part === "" || part === "." || part === ".." || part.startsWith(".") || !ARTIFACT_PATH_PART_PATTERN.test(part))) {
    throw new BombadilArtifactPolicyError(`Bombadil emitted unsafe artifact path ${relativePath}`);
  }
  return parts;
}
function artifactOutputFileIsAllowed(relativePath) {
  return relativePath === "trace.jsonl" || PRIVATE_DIAGNOSTIC_EXTENSIONS.has(extname(relativePath).toLowerCase());
}
function parseLiveChromeDownloadPartial(relativePath) {
  const prefix = "downloads/";
  const suffix = ".crdownload";
  if (!relativePath.startsWith(prefix) || !relativePath.endsWith(suffix))
    return null;
  const runId = relativePath.slice(prefix.length, -suffix.length);
  return UUID_PATTERN.test(runId) ? runId : null;
}
function parseLiveChromeDownloadCompletion(relativePath) {
  const prefix = "downloads/";
  if (!relativePath.startsWith(prefix))
    return null;
  const runId = relativePath.slice(prefix.length);
  return UUID_PATTERN.test(runId) ? runId : null;
}
function sameLiveChromeDownloadIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}
function liveChromeDownloadCompletionObservation(metadata, size) {
  return {
    ctimeNs: metadata.ctimeNs,
    device: metadata.dev,
    inode: metadata.ino,
    mtimeNs: metadata.mtimeNs,
    size
  };
}
function sameLiveChromeDownloadCompletionObservation(left, right) {
  return sameLiveChromeDownloadIdentity(left, right) && left.size === right.size && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}
function requireNoCrossRunLiveChromeDownloadIdentity(completionRunId, completion, identities) {
  for (const [otherRunId, identity] of identities) {
    if (otherRunId !== completionRunId && sameLiveChromeDownloadIdentity(identity, completion)) {
      throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion downloads/${completionRunId} lacks live partial provenance`);
    }
  }
}
function observePendingLiveChromeDownloadCompletion(context, runId, observation) {
  const pending = context.pendingCompletions.get(runId);
  if (pending !== undefined && !sameLiveChromeDownloadCompletionObservation(pending, observation)) {
    throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion downloads/${runId} changed before provenance was proven`);
  }
  const previous = context.previous.get(runId);
  if (previous === undefined || previous.phase !== "partial") {
    throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion downloads/${runId} lacks live partial provenance`);
  }
  if (!sameLiveChromeDownloadIdentity(previous, observation)) {
    throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion downloads/${runId} changed inode identity`);
  }
  if (pending !== undefined) {
    if (pending.successfulScans === 1) {
      context.nextPendingCompletions.delete(runId);
      return "proven";
    }
    context.currentPendingCompletions.set(runId, pending);
    return "pending";
  }
  if (context.pendingCompletions.size > 0 || context.currentPendingCompletions.size > 0) {
    throw new BombadilArtifactPolicyError("Bombadil Chrome download completion has multiple unproven concurrent candidates");
  }
  const pendingCompletion = {
    ...observation,
    successfulScans: 0
  };
  context.currentPendingCompletions.set(runId, pendingCompletion);
  context.nextPendingCompletions.set(runId, pendingCompletion);
  return "pending";
}
function carryFailedScanPendingCompletions(pendingCompletions, currentPendingCompletions) {
  if (currentPendingCompletions.size === 0)
    return pendingCompletions;
  const carried = new Map(pendingCompletions);
  for (const [runId, observation] of currentPendingCompletions) {
    if (!carried.has(runId)) {
      carried.set(runId, { ...observation, successfulScans: 0 });
    }
  }
  return carried;
}
function requireMatchingLiveChromeDownloadIdentity(existing, completion, relativePath) {
  if (existing === undefined || sameLiveChromeDownloadIdentity(existing, completion))
    return;
  throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion ${relativePath} changed inode identity`);
}
function mayInspectUnobservedChromeDownloadCompletion(context, runId) {
  if (!context.cleanBaselineEstablished)
    return false;
  context.currentUnobservedCompletions.add(runId);
  return true;
}
function sameBigIntFileMetadata(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.ctimeNs === right.ctimeNs && left.mtimeNs === right.mtimeNs;
}
async function withClosedArtifactHandle(handle, operation) {
  let value;
  let operationFailure = null;
  try {
    value = await operation();
  } catch (error) {
    operationFailure = error;
  }
  let closeFailure = null;
  try {
    await handle.close();
  } catch (error) {
    closeFailure = error;
  }
  if (operationFailure !== null) {
    if (closeFailure !== null) {
      throw new AggregateError([operationFailure, closeFailure], "Bombadil artifact operation and descriptor cleanup both failed", { cause: operationFailure });
    }
    throw operationFailure;
  }
  if (closeFailure !== null)
    throw closeFailure;
  return value;
}
async function hashBoundRegularFile(options) {
  const flags = fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW | fileSystemConstants.O_NONBLOCK;
  const handle = await open(options.path, flags);
  return await withClosedArtifactHandle(handle, async () => {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !options.expected.isFile() || options.expected.nlink !== 1n || !sameBigIntFileMetadata(before, options.expected)) {
      throw new BombadilArtifactPolicyError(`Bombadil artifact ${options.relativePath} changed identity before inspection`);
    }
    const size = Number(before.size);
    if (!Number.isSafeInteger(size) || size > options.policy.maxFileBytes) {
      throw new BombadilArtifactPolicyError(`Bombadil artifact ${options.relativePath} exceeds the per-file byte quota`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.length, size - offset);
      const read = await handle.read(buffer, 0, length, offset);
      if (read.bytesRead === 0) {
        throw new BombadilArtifactPolicyError(`Bombadil artifact ${options.relativePath} changed while inspected`);
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameBigIntFileMetadata(before, after)) {
      throw new BombadilArtifactPolicyError(`Bombadil artifact ${options.relativePath} changed while inspected`);
    }
    return {
      device: before.dev,
      inode: before.ino,
      relativePath: options.relativePath,
      sha256: hash.digest("hex"),
      size
    };
  });
}
async function readBoundRegularFileBytes(options) {
  const flags = fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW | fileSystemConstants.O_NONBLOCK;
  let handle;
  try {
    handle = await open(options.path, flags);
  } catch {
    throw new BombadilArtifactPolicyError(`${options.label} is not an openable regular file`);
  }
  try {
    return await withClosedArtifactHandle(handle, async () => {
      const before = await handle.stat({ bigint: true });
      const size = Number(before.size);
      if (!before.isFile() || before.nlink !== 1n || !Number.isSafeInteger(size) || size < 1 || size > options.maximumBytes) {
        throw new BombadilArtifactPolicyError(`${options.label} is not a bounded regular file`);
      }
      if (options.expected !== undefined && (before.dev !== options.expected.device || before.ino !== options.expected.inode || size !== options.expected.size)) {
        throw new BombadilArtifactPolicyError(`${options.label} changed after inventory`);
      }
      const bytes = Buffer.allocUnsafe(size);
      let offset = 0;
      while (offset < size) {
        const read = await handle.read(bytes, offset, size - offset, offset);
        if (read.bytesRead === 0) {
          throw new BombadilArtifactPolicyError(`${options.label} changed while being read`);
        }
        offset += read.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (!sameBigIntFileMetadata(before, after)) {
        throw new BombadilArtifactPolicyError(`${options.label} changed while being read`);
      }
      if (options.expected !== undefined && sha256(bytes) !== options.expected.sha256) {
        throw new BombadilArtifactPolicyError(`${options.label} hash changed after inventory`);
      }
      return bytes;
    });
  } catch (error) {
    throw error instanceof BombadilArtifactPolicyError ? error : new BombadilArtifactPolicyError(`${options.label} could not be read safely: ${renderUnknown(error)}`);
  }
}
function decodeTraceLines(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Bombadil trace is not valid UTF-8");
  }
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "")
    lines.pop();
  return lines;
}
async function scanBombadilArtifactTree(options) {
  if (options.allowLiveChromeDownloadTransients === true && options.hashFiles) {
    throw new BombadilArtifactPolicyError("Live Chrome download transients cannot enter an authoritative artifact inventory");
  }
  if (options.liveChromeDownloadScan !== undefined && (options.allowLiveChromeDownloadTransients !== true || options.hashFiles)) {
    throw new BombadilArtifactPolicyError("Chrome download provenance is restricted to unhashed live artifact scans");
  }
  let rootMetadata;
  try {
    rootMetadata = await lstat(options.root, { bigint: true });
  } catch (error) {
    if (!isRecord2(error) || error.code !== "ENOENT") {
      throw new BombadilArtifactPolicyError(`Bombadil output root could not be inspected: ${renderUnknown(error)}`);
    }
    rootMetadata = null;
  }
  if (rootMetadata === null) {
    if (options.rootMayBeAbsent === true) {
      return {
        directories: Object.freeze([]),
        entryCount: 0,
        files: Object.freeze([]),
        fileCount: 0,
        inventorySha256: sha256(""),
        totalBytes: 0
      };
    }
    throw new BombadilArtifactPolicyError("Bombadil output directory does not exist");
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new BombadilArtifactPolicyError("Bombadil output root must be a non-symlink directory");
  }
  const directories = [];
  const files = [];
  let entryCount = 0;
  let totalBytes = 0;
  const pending = [{
    absolutePath: options.root,
    relativePath: ""
  }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined)
      continue;
    await options.beforeDirectoryOpen?.(current.absolutePath);
    const directory = await opendir(current.absolutePath).catch((error) => {
      if (options.allowTransientEntryAbsence === true && isRecord2(error) && error.code === "ENOENT") {
        throw error;
      }
      throw new BombadilArtifactPolicyError(`Bombadil artifact directory could not be opened safely: ${renderUnknown(error)}`);
    });
    try {
      await withClosedArtifactHandle(directory, async () => {
        while (true) {
          const entry = await directory.read();
          if (entry === null)
            break;
          const relativePath = current.relativePath === "" ? entry.name : `${current.relativePath}/${entry.name}`;
          validateArtifactRelativePath(relativePath, options.policy);
          entryCount += 1;
          if (entryCount > options.policy.maxEntries) {
            throw new BombadilArtifactPolicyError("Bombadil artifact entry quota was exceeded");
          }
          const absolutePath = join2(current.absolutePath, entry.name);
          await options.beforeEntryInspect?.(absolutePath);
          let metadata;
          try {
            metadata = await lstat(absolutePath, { bigint: true });
          } catch (error) {
            const partialRunId = parseLiveChromeDownloadPartial(relativePath);
            if (options.allowTransientEntryAbsence !== true || options.liveChromeDownloadScan === undefined || partialRunId === null || !isRecord2(error) || error.code !== "ENOENT") {
              throw error;
            }
            const completionRelativePath = `downloads/${partialRunId}`;
            validateArtifactRelativePath(completionRelativePath, options.policy);
            const completionPath = join2(current.absolutePath, partialRunId);
            let completionMetadata;
            try {
              await options.beforeLiveChromeDownloadCompletionProbe?.(completionPath);
              completionMetadata = await lstat(completionPath, { bigint: true });
            } catch (completionError) {
              if (isRecord2(completionError) && completionError.code === "ENOENT") {
                throw error;
              }
              throw completionError;
            }
            const previous = options.liveChromeDownloadScan.previous.get(partialRunId);
            if (completionMetadata.isSymbolicLink()) {
              throw new BombadilArtifactPolicyError(`Bombadil emitted a symbolic link at ${completionRelativePath}`);
            }
            if (!completionMetadata.isFile() || completionMetadata.nlink !== 1n) {
              throw new BombadilArtifactPolicyError(`Bombadil emitted a non-regular or multiply-linked file at ${completionRelativePath}`);
            }
            const completionSize = Number(completionMetadata.size);
            if (!Number.isSafeInteger(completionSize) || completionSize > options.policy.maxFileBytes) {
              throw new BombadilArtifactPolicyError(`Bombadil artifact ${completionRelativePath} exceeds the per-file byte quota`);
            }
            if (previous === undefined && !mayInspectUnobservedChromeDownloadCompletion(options.liveChromeDownloadScan, partialRunId)) {
              throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion ${completionRelativePath} lacks live partial provenance`);
            }
            if (previous !== undefined && previous.phase !== "partial") {
              throw new BombadilArtifactPolicyError(`Bombadil Chrome download ${completionRelativePath} reversed its live lifecycle`);
            }
            if (previous !== undefined && !sameLiveChromeDownloadIdentity(previous, {
              device: completionMetadata.dev,
              inode: completionMetadata.ino
            })) {
              throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion ${completionRelativePath} changed inode identity`);
            }
            throw new LiveChromeDownloadRenameRetry({
              device: completionMetadata.dev,
              inode: completionMetadata.ino,
              runId: partialRunId,
              size: completionSize,
              unobserved: previous === undefined
            });
          }
          if (metadata.isSymbolicLink()) {
            throw new BombadilArtifactPolicyError(`Bombadil emitted a symbolic link at ${relativePath}`);
          }
          const liveChromeDownloadPartial = parseLiveChromeDownloadPartial(relativePath);
          const liveChromeDownloadCompletion = parseLiveChromeDownloadCompletion(relativePath);
          if (metadata.isDirectory()) {
            if (liveChromeDownloadPartial !== null || options.liveChromeDownloadScan !== undefined && liveChromeDownloadCompletion !== null) {
              throw new BombadilArtifactPolicyError(`Bombadil emitted a directory at Chrome download path ${relativePath}`);
            }
            directories.push(relativePath);
            options.liveChromeDownloadScan?.currentDirectories.add(relativePath);
            pending.push({ absolutePath, relativePath });
            continue;
          }
          if (!metadata.isFile() || metadata.nlink !== 1n) {
            throw new BombadilArtifactPolicyError(`Bombadil emitted a non-regular or multiply-linked file at ${relativePath}`);
          }
          const liveIdentity = {
            device: metadata.dev,
            inode: metadata.ino
          };
          let liveRunId = null;
          let recordLiveIdentity = true;
          if (options.allowLiveChromeDownloadTransients === true && liveChromeDownloadPartial !== null) {
            const previous = options.liveChromeDownloadScan?.previous.get(liveChromeDownloadPartial);
            if (previous !== undefined) {
              if (previous.phase !== "partial") {
                throw new BombadilArtifactPolicyError(`Bombadil Chrome download ${relativePath} reversed its live lifecycle`);
              }
              if (!sameLiveChromeDownloadIdentity(previous, liveIdentity)) {
                throw new BombadilArtifactPolicyError(`Bombadil Chrome download partial ${relativePath} changed inode identity`);
              }
            }
            options.liveChromeDownloadScan?.currentPartials.set(liveChromeDownloadPartial, { ...liveIdentity, phase: "partial" });
            liveRunId = liveChromeDownloadPartial;
          } else if (options.liveChromeDownloadScan !== undefined && liveChromeDownloadCompletion !== null) {
            const liveChromeDownloadScan = options.liveChromeDownloadScan;
            const previous = liveChromeDownloadScan.previous.get(liveChromeDownloadCompletion);
            const completionSize = Number(metadata.size);
            if (!Number.isSafeInteger(completionSize) || completionSize > options.policy.maxFileBytes) {
              throw new BombadilArtifactPolicyError(`Bombadil artifact ${relativePath} exceeds the per-file byte quota`);
            }
            const completionObservation = liveChromeDownloadCompletionObservation(metadata, completionSize);
            liveChromeDownloadScan.currentCompletionObservations.set(liveChromeDownloadCompletion, completionObservation);
            if (previous === undefined) {
              if (!mayInspectUnobservedChromeDownloadCompletion(liveChromeDownloadScan, liveChromeDownloadCompletion)) {
                throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion ${relativePath} lacks live partial provenance`);
              }
              recordLiveIdentity = false;
            } else if (previous.phase === "partial") {
              recordLiveIdentity = observePendingLiveChromeDownloadCompletion(liveChromeDownloadScan, liveChromeDownloadCompletion, completionObservation) === "proven";
            }
            if (previous !== undefined && !sameLiveChromeDownloadIdentity(previous, liveIdentity)) {
              throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion ${relativePath} changed inode identity`);
            }
            liveRunId = liveChromeDownloadCompletion;
          }
          if (!artifactOutputFileIsAllowed(relativePath) && liveRunId === null) {
            throw new BombadilArtifactPolicyError(`Bombadil emitted a file outside the artifact allowlist at ${relativePath}`);
          }
          if (files.length + 1 > options.policy.maxFiles) {
            throw new BombadilArtifactPolicyError("Bombadil artifact file quota was exceeded");
          }
          const fileSize = Number(metadata.size);
          if (!Number.isSafeInteger(fileSize) || fileSize > options.policy.maxFileBytes) {
            throw new BombadilArtifactPolicyError(`Bombadil artifact ${relativePath} exceeds the per-file byte quota`);
          }
          totalBytes += fileSize;
          if (!Number.isSafeInteger(totalBytes) || totalBytes > options.policy.maxTotalBytes) {
            throw new BombadilArtifactPolicyError("Bombadil aggregate artifact byte quota was exceeded");
          }
          if (options.liveChromeDownloadScan !== undefined) {
            options.liveChromeDownloadScan.currentAccountedFiles.set(relativePath, fileSize);
          }
          files.push(options.hashFiles ? await hashBoundRegularFile({
            expected: metadata,
            path: absolutePath,
            policy: options.policy,
            relativePath
          }) : {
            device: 0n,
            inode: 0n,
            relativePath,
            sha256: "",
            size: fileSize
          });
          if (liveRunId !== null) {
            const liveChromeDownload = options.liveChromeDownloadScan;
            if (liveChromeDownload !== undefined && recordLiveIdentity) {
              const alreadyKnown = liveChromeDownload.next.has(liveRunId);
              if (!alreadyKnown && liveChromeDownload.next.size >= options.policy.maxFiles) {
                throw new BombadilArtifactPolicyError("Bombadil live download provenance quota was exceeded");
              }
              liveChromeDownload.next.set(liveRunId, {
                ...liveIdentity,
                phase: liveChromeDownloadCompletion === null ? "partial" : "complete"
              });
            }
          }
          await options.afterEntryInspect?.(absolutePath);
        }
      });
    } catch (error) {
      if (error instanceof LiveChromeDownloadRenameRetry)
        throw error;
      if (options.allowTransientEntryAbsence === true && isRecord2(error) && error.code === "ENOENT") {
        throw error;
      }
      throw error instanceof BombadilArtifactPolicyError ? error : new BombadilArtifactPolicyError(`Bombadil artifact directory could not be inspected safely: ${renderUnknown(error)}`);
    }
  }
  if (options.liveChromeDownloadScan !== undefined) {
    const liveChromeDownloadScan = options.liveChromeDownloadScan;
    if (liveChromeDownloadScan.currentPartials.size > 0 && liveChromeDownloadScan.currentUnobservedCompletions.size > 0) {
      throw new BombadilArtifactPolicyError("Bombadil Chrome download completion lacks live partial provenance across the current scan");
    }
    for (const [runId, observation] of liveChromeDownloadScan.currentCompletionObservations) {
      if (liveChromeDownloadScan.currentPartials.has(runId)) {
        throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion downloads/${runId} lacks live partial provenance`);
      }
      requireNoCrossRunLiveChromeDownloadIdentity(runId, observation, liveChromeDownloadScan.previous);
      requireNoCrossRunLiveChromeDownloadIdentity(runId, observation, liveChromeDownloadScan.currentPartials);
      requireNoCrossRunLiveChromeDownloadIdentity(runId, observation, liveChromeDownloadScan.currentCompletionObservations);
    }
    if (liveChromeDownloadScan.currentUnobservedCompletions.size > 0) {
      throw new BombadilArtifactPolicyError("Bombadil Chrome download completion lacks live partial provenance");
    }
    for (const runId of liveChromeDownloadScan.pendingCompletions.keys()) {
      if (!liveChromeDownloadScan.currentCompletionObservations.has(runId)) {
        throw new BombadilArtifactPolicyError(`Bombadil Chrome download completion downloads/${runId} disappeared before provenance was proven`);
      }
    }
  }
  let finalRootMetadata;
  try {
    finalRootMetadata = await lstat(options.root, { bigint: true });
  } catch (error) {
    throw new BombadilArtifactPolicyError(`Bombadil output root could not be revalidated: ${renderUnknown(error)}`);
  }
  if (!finalRootMetadata.isDirectory() || finalRootMetadata.isSymbolicLink() || finalRootMetadata.dev !== rootMetadata.dev || finalRootMetadata.ino !== rootMetadata.ino) {
    throw new BombadilArtifactPolicyError("Bombadil output root changed during inspection");
  }
  directories.sort(compareCodeUnits);
  files.sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath));
  const inventorySha256 = sha256([
    ...directories.map((directory) => `D\x00${directory}
`),
    ...files.map((file) => `F\x00${file.relativePath}\x00${String(file.size)}\x00${file.sha256}
`)
  ].join(""));
  return {
    directories: Object.freeze(directories),
    entryCount,
    files: Object.freeze(files),
    fileCount: files.length,
    inventorySha256,
    totalBytes
  };
}
async function scanLiveBombadilArtifactTree(options) {
  const carriedCompletions = new Map;
  const carriedDirectories = new Set;
  const carriedFiles = new Map;
  let pendingCompletions = options.pendingCompletions;
  let previous = options.previous;
  for (let retryCount = 0;retryCount < MAX_LIVE_CHROME_RENAME_RETRIES; retryCount += 1) {
    if (bombadilAbortRequested(options.abortSignal)) {
      return {
        pendingCompletions,
        provenance: previous
      };
    }
    const currentCompletionObservations = new Map;
    const currentPartials = new Map;
    const currentPendingCompletions = new Map;
    const currentUnobservedCompletions = new Set;
    const currentAccountedFiles = new Map;
    const currentDirectories = new Set;
    const next = new Map(previous);
    const nextPendingCompletions = new Map(pendingCompletions);
    let inventory;
    try {
      inventory = await scanBombadilArtifactTree({
        ...options.afterEntryInspect === undefined ? {} : { afterEntryInspect: options.afterEntryInspect },
        allowTransientEntryAbsence: true,
        allowLiveChromeDownloadTransients: true,
        ...options.beforeDirectoryOpen === undefined ? {} : { beforeDirectoryOpen: options.beforeDirectoryOpen },
        ...options.beforeEntryInspect === undefined ? {} : { beforeEntryInspect: options.beforeEntryInspect },
        ...options.beforeLiveChromeDownloadCompletionProbe === undefined ? {} : {
          beforeLiveChromeDownloadCompletionProbe: options.beforeLiveChromeDownloadCompletionProbe
        },
        hashFiles: false,
        liveChromeDownloadScan: {
          currentAccountedFiles,
          currentCompletionObservations,
          currentDirectories,
          cleanBaselineEstablished: options.cleanBaselineEstablished,
          currentPartials,
          currentPendingCompletions,
          currentUnobservedCompletions,
          next,
          nextPendingCompletions,
          pendingCompletions,
          previous
        },
        policy: options.policy,
        root: options.outputPath,
        rootMayBeAbsent: true
      });
    } catch (error) {
      const failedScanPendingCompletions = carryFailedScanPendingCompletions(pendingCompletions, currentPendingCompletions);
      if (!(error instanceof LiveChromeDownloadRenameRetry)) {
        if (isRecord2(error) && error.code === "ENOENT") {
          return {
            pendingCompletions: failedScanPendingCompletions,
            provenance: previous
          };
        }
        throw error;
      }
      pendingCompletions = failedScanPendingCompletions;
      const observedOtherUnprovenCompletion = [...currentUnobservedCompletions].some((runId) => runId !== error.completion.runId);
      if (error.completion.unobserved || observedOtherUnprovenCompletion) {
        throw new BombadilArtifactPolicyError("Bombadil Chrome download completion lacks live partial provenance across the current scan");
      }
      for (const directory of currentDirectories)
        carriedDirectories.add(directory);
      for (const [relativePath, size] of currentAccountedFiles) {
        carriedFiles.set(relativePath, Math.max(carriedFiles.get(relativePath) ?? 0, size));
      }
      const retained = carriedCompletions.get(error.completion.runId);
      const currentIdentity = next.get(error.completion.runId);
      requireMatchingLiveChromeDownloadIdentity(currentIdentity, error.completion, `downloads/${error.completion.runId}`);
      requireMatchingLiveChromeDownloadIdentity(retained, error.completion, `downloads/${error.completion.runId}`);
      if (retained === undefined && carriedCompletions.size >= options.policy.maxFiles) {
        throw new BombadilArtifactPolicyError("Bombadil live download provenance quota was exceeded");
      }
      carriedCompletions.set(error.completion.runId, {
        device: error.completion.device,
        inode: error.completion.inode,
        size: Math.max(retained?.size ?? 0, error.completion.size),
        unobserved: retained?.unobserved === true || error.completion.unobserved
      });
      const completionRelativePath = `downloads/${error.completion.runId}`;
      carriedFiles.set(completionRelativePath, Math.max(carriedFiles.get(completionRelativePath) ?? 0, error.completion.size));
      const carriedTotalBytes = [...carriedFiles.values()].reduce((total, size) => total + size, 0);
      if (carriedFiles.size > options.policy.maxFiles) {
        throw new BombadilArtifactPolicyError("Bombadil artifact file quota was exceeded");
      }
      if (carriedFiles.size + carriedDirectories.size > options.policy.maxEntries) {
        throw new BombadilArtifactPolicyError("Bombadil artifact entry quota was exceeded");
      }
      if (carriedTotalBytes > options.policy.maxTotalBytes) {
        throw new BombadilArtifactPolicyError("Bombadil aggregate artifact byte quota was exceeded");
      }
      const retryPrevious = new Map(previous);
      if (!retryPrevious.has(error.completion.runId) && retryPrevious.size >= options.policy.maxFiles) {
        throw new BombadilArtifactPolicyError("Bombadil live download provenance quota was exceeded");
      }
      retryPrevious.set(error.completion.runId, {
        device: error.completion.device,
        inode: error.completion.inode,
        phase: "complete"
      });
      previous = retryPrevious;
      await options.afterLiveChromeDownloadRenameRetry?.(join2(options.outputPath, "downloads", error.completion.runId));
      if (bombadilAbortRequested(options.abortSignal)) {
        return {
          pendingCompletions,
          provenance: previous
        };
      }
      continue;
    }
    if (currentPartials.size > 0 && [...carriedCompletions.values()].some((completion) => completion.unobserved)) {
      throw new BombadilArtifactPolicyError("Bombadil Chrome download completion lacks live partial provenance across the current scan");
    }
    let absentCarriedFileCount = 0;
    let absentCarriedEntryCount = 0;
    let absentCarriedTotalBytes = 0;
    const inventoryFilesByPath = new Map(inventory.files.map((file) => [file.relativePath, file.size]));
    const inventoryDirectories = new Set(inventory.directories);
    for (const [relativePath, carriedSize] of carriedFiles) {
      const retainedSize = inventoryFilesByPath.get(relativePath);
      if (retainedSize === undefined) {
        absentCarriedFileCount += 1;
        absentCarriedEntryCount += 1;
        absentCarriedTotalBytes += carriedSize;
      } else {
        absentCarriedTotalBytes += Math.max(0, carriedSize - retainedSize);
      }
    }
    for (const directory of carriedDirectories) {
      if (!inventoryDirectories.has(directory))
        absentCarriedEntryCount += 1;
    }
    if (inventory.fileCount + absentCarriedFileCount > options.policy.maxFiles) {
      throw new BombadilArtifactPolicyError("Bombadil artifact file quota was exceeded");
    }
    if (inventory.entryCount + absentCarriedEntryCount > options.policy.maxEntries) {
      throw new BombadilArtifactPolicyError("Bombadil artifact entry quota was exceeded");
    }
    if (inventory.totalBytes + absentCarriedTotalBytes > options.policy.maxTotalBytes) {
      throw new BombadilArtifactPolicyError("Bombadil aggregate artifact byte quota was exceeded");
    }
    if (bombadilAbortRequested(options.abortSignal)) {
      return {
        pendingCompletions: carryFailedScanPendingCompletions(pendingCompletions, currentPendingCompletions),
        provenance: previous
      };
    }
    for (const [runId, observation] of currentPendingCompletions) {
      nextPendingCompletions.set(runId, {
        ...observation,
        successfulScans: 1
      });
    }
    const liveRunIds = new Set([
      ...next.keys(),
      ...nextPendingCompletions.keys()
    ]);
    if (liveRunIds.size > options.policy.maxFiles) {
      throw new BombadilArtifactPolicyError("Bombadil live download provenance quota was exceeded");
    }
    return {
      pendingCompletions: nextPendingCompletions,
      provenance: next
    };
  }
  throw new BombadilArtifactPolicyError("Bombadil Chrome download rename activity did not settle safely");
}
async function ensureSafeChildDirectories(root, parts) {
  await requireSafeDirectory(root, "Bombadil upload staging root");
  let current = root;
  for (const part of parts) {
    if (!ARTIFACT_PATH_PART_PATTERN.test(part) || part.startsWith(".")) {
      throw new BombadilArtifactPolicyError("Bombadil upload path contains an unsafe component");
    }
    current = join2(current, part);
    try {
      await mkdir2(current, { mode: 448 });
    } catch (error) {
      if (!isRecord2(error) || error.code !== "EEXIST")
        throw error;
    }
    await requireSafeDirectory(current, "Bombadil upload directory");
    const resolved = await realpath(current);
    if (!isWithin(root, resolved) || resolved !== current) {
      throw new BombadilArtifactPolicyError("Bombadil upload directory escaped staging root");
    }
  }
  return current;
}
async function writeExclusiveBytes(path, bytes) {
  const flags = fileSystemConstants.O_WRONLY | fileSystemConstants.O_CREAT | fileSystemConstants.O_EXCL | fileSystemConstants.O_NOFOLLOW;
  const handle = await open(path, flags, 384);
  await withClosedArtifactHandle(handle, async () => {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (written.bytesWritten === 0)
        throw new Error("Exclusive artifact write made no progress");
      offset += written.bytesWritten;
    }
    await handle.sync();
  });
}
async function writeExpectedJson(root, relativePath, value) {
  const parts = relativePath.split("/");
  const fileName = parts.pop();
  if (fileName === undefined || !ARTIFACT_PATH_PART_PATTERN.test(fileName)) {
    throw new BombadilArtifactPolicyError("Sanitized upload path is invalid");
  }
  const directory = await ensureSafeChildDirectories(root, parts);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}
`, "utf8");
  await writeExclusiveBytes(join2(directory, fileName), bytes);
  return {
    relativePath,
    sha256: sha256(bytes),
    size: bytes.byteLength
  };
}
function expectedUploadDirectories(files) {
  const directories = new Set;
  for (const file of files) {
    const parts = file.relativePath.split("/");
    parts.pop();
    for (let index = 1;index <= parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return Object.freeze([...directories].sort(compareCodeUnits));
}
async function validateExpectedUploadTree(root, expectedInput) {
  const expected = [...expectedInput].sort((left, right) => compareCodeUnits(left.relativePath, right.relativePath));
  if (new Set(expected.map((file) => file.relativePath)).size !== expected.length) {
    throw new BombadilArtifactPolicyError("Sanitized upload contains duplicate file paths");
  }
  const directories = expectedUploadDirectories(expected);
  const maximumPathBytes = Math.max(1, ...expected.map((file) => Buffer.byteLength(file.relativePath, "utf8")));
  const inventory = await scanBombadilArtifactTree({
    hashFiles: true,
    policy: {
      maxDepth: Math.max(1, ...expected.map((file) => file.relativePath.split("/").length)),
      maxEntries: Math.max(1, expected.length + directories.length),
      maxFileBytes: Math.max(1, ...expected.map((file) => file.size)),
      maxFiles: Math.max(1, expected.length),
      maxPathBytes: maximumPathBytes,
      maxTotalBytes: Math.max(1, expected.reduce((total, file) => total + file.size, 0))
    },
    root
  });
  if (inventory.directories.length !== directories.length || inventory.directories.some((directory, index) => directory !== directories[index]) || inventory.files.length !== expected.length || inventory.files.some((file, index) => {
    const wanted = expected[index];
    return wanted === undefined || file.relativePath !== wanted.relativePath || file.sha256 !== wanted.sha256 || file.size !== wanted.size;
  })) {
    throw new BombadilArtifactPolicyError("Sanitized upload tree differs from its exact expected inventory");
  }
}
async function copyVerifiedArtifactFile(options) {
  const parts = options.file.relativePath.split("/");
  const fileName = parts.pop();
  if (fileName === undefined)
    throw new BombadilArtifactPolicyError("Artifact copy path is empty");
  const destinationDirectory = await ensureSafeChildDirectories(options.destinationRoot, parts);
  const destinationPath = join2(destinationDirectory, fileName);
  const sourcePath = join2(options.sourceRoot, ...options.file.relativePath.split("/"));
  const sourceFlags = fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW | fileSystemConstants.O_NONBLOCK;
  const destinationFlags = fileSystemConstants.O_WRONLY | fileSystemConstants.O_CREAT | fileSystemConstants.O_EXCL | fileSystemConstants.O_NOFOLLOW;
  const source = await open(sourcePath, sourceFlags);
  let destination = null;
  let copyFailure = null;
  try {
    const before = await source.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.dev !== options.file.device || before.ino !== options.file.inode || Number(before.size) !== options.file.size) {
      throw new BombadilArtifactPolicyError(`Bombadil artifact ${options.file.relativePath} changed before private copy`);
    }
    destination = await open(destinationPath, destinationFlags, 384);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < options.file.size) {
      const read = await source.read(buffer, 0, Math.min(buffer.length, options.file.size - offset), offset);
      if (read.bytesRead === 0) {
        throw new BombadilArtifactPolicyError(`Bombadil artifact ${options.file.relativePath} changed during private copy`);
      }
      hash.update(buffer.subarray(0, read.bytesRead));
      let writtenOffset = 0;
      while (writtenOffset < read.bytesRead) {
        const written = await destination.write(buffer, writtenOffset, read.bytesRead - writtenOffset, offset + writtenOffset);
        if (written.bytesWritten === 0)
          throw new Error("Private artifact copy made no progress");
        writtenOffset += written.bytesWritten;
      }
      offset += read.bytesRead;
    }
    await destination.sync();
    const after = await source.stat({ bigint: true });
    if (!sameBigIntFileMetadata(before, after) || hash.digest("hex") !== options.file.sha256) {
      throw new BombadilArtifactPolicyError(`Bombadil artifact ${options.file.relativePath} changed during private copy`);
    }
  } catch (error) {
    copyFailure = error;
    await rm2(destinationPath, { force: true }).catch(() => {
      return;
    });
  }
  let closeFailure = null;
  try {
    await closeBombadilArtifactCopyHandles(destination, source);
  } catch (error) {
    closeFailure = error;
  }
  if (copyFailure !== null) {
    if (closeFailure !== null) {
      throw new AggregateError([copyFailure, closeFailure], "Bombadil artifact copy and descriptor cleanup both failed", { cause: copyFailure });
    }
    throw copyFailure;
  }
  if (closeFailure !== null)
    throw closeFailure;
}
async function closeBombadilArtifactCopyHandles(destination, source) {
  const failures = [];
  if (destination !== null) {
    try {
      await destination.close();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await source.close();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1)
    throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Both Bombadil artifact copy descriptors failed to close");
  }
}
function emptyArtifactInventory() {
  return {
    directories: Object.freeze([]),
    entryCount: 0,
    files: Object.freeze([]),
    fileCount: 0,
    inventorySha256: sha256(""),
    totalBytes: 0
  };
}
function artifactFailureCode(error) {
  if (error instanceof BombadilPersistenceError)
    return "persistence";
  if (error instanceof BombadilWriterSettlementError)
    return "writer-settlement";
  if (error instanceof BombadilArtifactPolicyError)
    return "artifact-policy";
  const message = renderUnknown(error);
  if (message.includes("interrupted") || message.includes("SIGINT") || message.includes("SIGTERM")) {
    return "interrupted";
  }
  if (message.includes("exploration policy"))
    return "exploration-policy";
  if (message.includes("trace") || message.includes("Direct contract"))
    return "trace-attestation";
  if (message.includes("server") || message.includes("reachable"))
    return "server";
  if (message.includes("Bombadil"))
    return "process";
  return "unknown";
}
function failureAsError(error) {
  return error instanceof Error ? error : new Error(renderUnknown(error));
}
function combinePersistenceFailure(primary, persistence, message = "Bombadil persistence also failed") {
  return new BombadilPersistenceError(`${renderUnknown(primary)}; ${message}`, [primary, persistence]);
}
async function publishFailureAndThrow(primary, publish) {
  try {
    await publish();
  } catch (persistence) {
    throw combinePersistenceFailure(primary, persistence, "sanitized Bombadil receipt publication also failed");
  }
  throw failureAsError(primary);
}
function createArtifactReceipt(options) {
  return Object.freeze({
    schema: ARTIFACT_RECEIPT_SCHEMA,
    completedAt: options.completedAt.toISOString(),
    diagnosticsRetained: options.diagnosticsRetained,
    failureCode: options.failureCode,
    inventory: Object.freeze({
      entryCount: options.inventory.entryCount,
      fileCount: options.inventory.fileCount,
      inventorySha256: options.inventory.entryCount === 0 ? null : options.inventory.inventorySha256,
      totalBytes: options.inventory.totalBytes
    }),
    mode: options.session.mode,
    policy: options.policy,
    runId: options.session.runId,
    status: options.status
  });
}
function createSanitizedRunSummary(options) {
  return Object.freeze({
    schema: ARTIFACT_SUMMARY_SCHEMA,
    artifactName: options.artifactName,
    scenario: options.scenario,
    status: options.status,
    failureCode: options.failureCode,
    attestation: options.attestation === null ? null : Object.freeze({
      invalidObservationCount: options.attestation.invalidObservationCount,
      observationCount: options.attestation.observationCount,
      validObservationCount: options.attestation.validObservationCount
    }),
    exploration: options.explorationSummary === null ? null : Object.freeze({
      actionCount: options.explorationSummary.actions.total,
      nonWaitActionCount: options.explorationSummary.actions.nonWaitCount,
      policySatisfied: options.explorationSummary.policy.satisfied,
      traceBytes: options.explorationSummary.trace.bytes,
      traceLineCount: options.explorationSummary.trace.lineCount,
      traceSha256: options.explorationSummary.trace.sha256
    })
  });
}
async function resetUploadStaging(session2) {
  await rm2(session2.stagingDirectory, { force: true, recursive: true });
  await createExclusiveDirectory(session2.stagingDirectory, "Bombadil upload staging leaf");
}
async function withOwnedUploadStaging(session2, operation) {
  await createExclusiveDirectory(session2.stagingDirectory, "Bombadil upload staging leaf");
  try {
    return await operation();
  } catch (error) {
    try {
      await rm2(session2.stagingDirectory, { force: true, recursive: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Bombadil upload staging operation and cleanup both failed", { cause: error });
    }
    throw error;
  }
}
async function publishRunUpload(options) {
  let failure = options.failure;
  let failureCode = failure === null ? null : options.failureCode ?? artifactFailureCode(failure);
  let status = options.status;
  const observeInterruption = () => {
    if (failure !== null || options.abortSignal?.aborted !== true)
      return false;
    const signal = options.interruptedSignal?.() ?? null;
    failure = new Error(signal === null ? "Bombadil fuzzing was interrupted" : `Bombadil fuzzing was interrupted by ${signal}`);
    failureCode = "interrupted";
    status = "failed";
    return true;
  };
  observeInterruption();
  if (options.session.publication === "deferred" && options.session.mode !== "public-summary") {
    throw new BombadilArtifactPolicyError("Bombadil matrices support public-summary uploads only");
  }
  if (options.session.publication === "deferred") {
    const receipt = createArtifactReceipt({
      completedAt: options.completedAt,
      diagnosticsRetained: false,
      failureCode,
      inventory: options.inventory,
      policy: options.policy,
      session: options.session,
      status
    });
    const summary = createSanitizedRunSummary({
      artifactName: options.artifactName,
      attestation: options.attestation,
      explorationSummary: options.explorationSummary,
      failureCode,
      scenario: options.scenario,
      status
    });
    if (options.session.deferredPayload.value !== null) {
      throw new BombadilArtifactPolicyError("Bombadil deferred upload state is invalid");
    }
    options.session.deferredPayload.value = Object.freeze({ receipt, summary });
    return { failure, receipt };
  }
  const session2 = options.session;
  return await withOwnedUploadStaging(session2, async () => {
    const expectedFiles = [];
    let diagnosticsRetained = false;
    if (session2.mode === "private-vetted" && options.privateDiagnosticsAllowed && failureCode !== "interrupted") {
      try {
        const diagnosticsRoot = await ensureSafeChildDirectories(session2.stagingDirectory, ["diagnostics", "bombadil-output"]);
        for (const file of options.inventory.files) {
          await copyVerifiedArtifactFile({
            destinationRoot: diagnosticsRoot,
            file,
            sourceRoot: options.localOutputPath
          });
          expectedFiles.push({
            relativePath: `diagnostics/bombadil-output/${file.relativePath}`,
            sha256: file.sha256,
            size: file.size
          });
        }
        const controlledLogs = await ensureSafeChildDirectories(session2.stagingDirectory, ["diagnostics", "host"]);
        const processLogBytes = Buffer.from(options.processLog, "utf8");
        const serverLogBytes = Buffer.from(options.serverLog, "utf8");
        await writeExclusiveBytes(join2(controlledLogs, "bombadil.log"), processLogBytes);
        await writeExclusiveBytes(join2(controlledLogs, "server.log"), serverLogBytes);
        expectedFiles.push({
          relativePath: "diagnostics/host/bombadil.log",
          sha256: sha256(processLogBytes),
          size: processLogBytes.byteLength
        }, {
          relativePath: "diagnostics/host/server.log",
          sha256: sha256(serverLogBytes),
          size: serverLogBytes.byteLength
        });
        diagnosticsRetained = true;
      } catch (error) {
        const persistence = new BombadilPersistenceError("Bombadil private diagnostics could not be persisted", [error]);
        failure = failure === null ? persistence : combinePersistenceFailure(failure, persistence);
        failureCode = "persistence";
        status = "failed";
        await resetUploadStaging(session2);
        expectedFiles.length = 0;
      }
    }
    const stageSanitizedPayload = async () => {
      const receipt2 = createArtifactReceipt({
        completedAt: options.completedAt,
        diagnosticsRetained,
        failureCode,
        inventory: options.inventory,
        policy: options.policy,
        session: session2,
        status
      });
      const summary = createSanitizedRunSummary({
        artifactName: options.artifactName,
        attestation: options.attestation,
        explorationSummary: options.explorationSummary,
        failureCode,
        scenario: options.scenario,
        status
      });
      expectedFiles.push(await writeExpectedJson(session2.stagingDirectory, "summary.json", summary), await writeExpectedJson(session2.stagingDirectory, "receipt.json", receipt2));
      await validateExpectedUploadTree(session2.stagingDirectory, expectedFiles);
      return receipt2;
    };
    let receipt = await stageSanitizedPayload();
    await options.beforeCommitCheck?.();
    await requireArtifactUploadLeafAbsent(session2);
    if (observeInterruption()) {
      diagnosticsRetained = false;
      await resetUploadStaging(session2);
      expectedFiles.length = 0;
      receipt = await stageSanitizedPayload();
      await requireArtifactUploadLeafAbsent(session2);
    }
    await commitArtifactUploadSession(session2);
    return { failure, receipt };
  });
}
async function publishMatrixUpload(options) {
  const uploadMode = options.session.mode;
  if (uploadMode !== "public-summary") {
    throw new BombadilArtifactPolicyError("Bombadil matrix upload session must be public-summary");
  }
  let failure = options.failure;
  let failureCode = failure === null ? null : options.failureCode ?? artifactFailureCode(failure);
  let status = failure === null ? "passed" : "failed";
  const observeInterruption = () => {
    if (failure !== null || options.abortSignal?.aborted !== true)
      return false;
    const signal = options.interruptedSignal?.() ?? null;
    failure = new Error(signal === null ? "Bombadil matrix was interrupted" : `Bombadil matrix was interrupted by ${signal}`);
    failureCode = "interrupted";
    status = "failed";
    return true;
  };
  observeInterruption();
  return await withOwnedUploadStaging(options.session, async () => {
    const counts = new Map;
    for (const campaign of options.campaigns) {
      counts.set(campaign.status, (counts.get(campaign.status) ?? 0) + 1);
    }
    const expectedFiles = [];
    const stageMatrixPayload = async () => {
      const receipt = Object.freeze({
        schema: MATRIX_RECEIPT_SCHEMA,
        completedAt: options.completedAt.toISOString(),
        failureCode,
        mode: uploadMode,
        runId: options.session.runId,
        status,
        omittedCampaignCount: options.omittedCampaignCount ?? 0,
        campaigns: Object.freeze(options.campaigns.map((campaign) => Object.freeze(campaign)))
      });
      const summary = Object.freeze({
        schema: MATRIX_SUMMARY_SCHEMA,
        failureCode,
        status,
        campaigns: Object.freeze({
          failed: counts.get("failed") ?? 0,
          notRun: counts.get("not-run") ?? 0,
          notSelected: counts.get("not-selected") ?? 0,
          passed: counts.get("passed") ?? 0,
          rejected: counts.get("rejected") ?? 0,
          total: options.campaigns.length,
          omitted: options.omittedCampaignCount ?? 0
        })
      });
      for (const child of options.children) {
        expectedFiles.push(await writeExpectedJson(options.session.stagingDirectory, `campaigns/${child.campaignId}/summary.json`, child.payload.summary), await writeExpectedJson(options.session.stagingDirectory, `campaigns/${child.campaignId}/receipt.json`, child.payload.receipt));
      }
      expectedFiles.push(await writeExpectedJson(options.session.stagingDirectory, "summary.json", summary), await writeExpectedJson(options.session.stagingDirectory, "receipt.json", receipt));
      await validateExpectedUploadTree(options.session.stagingDirectory, expectedFiles);
    };
    await stageMatrixPayload();
    await options.beforeCommitCheck?.();
    await requireArtifactUploadLeafAbsent(options.session);
    if (observeInterruption()) {
      await resetUploadStaging(options.session);
      expectedFiles.length = 0;
      await stageMatrixPayload();
      await requireArtifactUploadLeafAbsent(options.session);
    }
    await commitArtifactUploadSession(options.session);
    return { failure };
  });
}
function parseTraceDirectObservation(value) {
  if (!isRecord2(value) || !hasExactKeys(value, DIRECT_OBSERVATION_KEYS)) {
    throw new Error("Bombadil trace has an invalid named direct observation");
  }
  const stringKeys = [
    "activationHash",
    "activeRoute",
    "activeScenario",
    "activeSource",
    "bridgeSchema",
    "catalogHash"
  ];
  for (const key of stringKeys) {
    if (typeof value[key] !== "string") {
      throw new Error(`Bombadil trace direct observation has an invalid ${key}`);
    }
  }
  const booleanKeys = [
    "bridgePresent",
    "contractValid",
    "isQuiescent",
    "violationsValid"
  ];
  for (const key of booleanKeys) {
    if (typeof value[key] !== "boolean") {
      throw new Error(`Bombadil trace direct observation has an invalid ${key}`);
    }
  }
  if (!Array.isArray(value.violations) || !value.violations.every((candidate) => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0)) {
    throw new Error("Bombadil trace direct observation has invalid violation counters");
  }
  const activationHash = value.activationHash;
  const activeRoute = value.activeRoute;
  const activeScenario = value.activeScenario;
  const activeSource = value.activeSource;
  const bridgePresent = value.bridgePresent;
  const bridgeSchema = value.bridgeSchema;
  const catalogHash2 = value.catalogHash;
  const contractValid = value.contractValid;
  const isQuiescent = value.isQuiescent;
  const violationsValid = value.violationsValid;
  if (typeof activationHash !== "string" || typeof activeRoute !== "string" || typeof activeScenario !== "string" || typeof activeSource !== "string" || typeof bridgePresent !== "boolean" || typeof bridgeSchema !== "string" || typeof catalogHash2 !== "string" || typeof contractValid !== "boolean" || typeof isQuiescent !== "boolean" || typeof violationsValid !== "boolean") {
    throw new Error("Bombadil trace direct observation could not be narrowed");
  }
  return {
    activationHash,
    activeRoute,
    activeScenario,
    activeSource,
    bridgePresent,
    bridgeSchema,
    catalogHash: catalogHash2,
    contractValid,
    isQuiescent,
    manifest: value.manifest,
    probe: value.probe,
    violations: value.violations,
    violationsValid
  };
}
function exactTraceDirectObservation(observation) {
  if (!observation.bridgePresent) {
    if (observation.bridgeSchema !== "" || observation.manifest !== null || observation.probe !== null || observation.contractValid || observation.violationsValid || observation.isQuiescent || observation.activationHash !== "" || observation.activeRoute !== "" || observation.activeScenario !== "" || observation.activeSource !== "" || observation.catalogHash !== "" || observation.violations.length !== 0) {
      throw new Error("Bombadil trace has a malformed bridge-absent Direct observation");
    }
    return null;
  }
  if (observation.bridgeSchema !== DIRECT_BROWSER_BRIDGE_SCHEMA) {
    throw new Error("Bombadil trace Direct bridge schema is invalid");
  }
  const manifest2 = parseDirectSessionManifest(observation.manifest);
  if (!manifest2.ok) {
    throw new Error(`Bombadil trace Direct manifest is invalid: ${manifest2.error.message}`);
  }
  const probe2 = parseDirectProbeSnapshot(observation.probe);
  if (!probe2.ok) {
    throw new Error(`Bombadil trace Direct probe is invalid: ${probe2.error.message}`);
  }
  if (manifest2.value.active.activationHash !== probe2.value.activationHash) {
    throw new Error("Bombadil trace Direct manifest and probe activation hashes differ");
  }
  const violationValues = Object.values(probe2.value.violations);
  if (!observation.contractValid || !observation.violationsValid || observation.catalogHash !== manifest2.value.catalogHash || observation.activationHash !== manifest2.value.active.activationHash || observation.activeRoute !== manifest2.value.active.route || observation.activeScenario !== manifest2.value.active.scenario || observation.activeSource !== manifest2.value.active.source || observation.isQuiescent !== probe2.value.isQuiescent || observation.violations.length !== violationValues.length || observation.violations.some((value, index) => value !== violationValues[index])) {
    throw new Error("Bombadil trace Direct summary does not match its exact manifest and probe");
  }
  return {
    activationHash: manifest2.value.active.activationHash,
    catalogHash: manifest2.value.catalogHash,
    route: manifest2.value.active.route,
    scenario: manifest2.value.active.scenario,
    source: manifest2.value.active.source,
    isQuiescent: probe2.value.isQuiescent
  };
}
var RESOURCE_FIELD_MAP = {
  documents: "documents",
  dom_nodes: "domNodes",
  js_event_listeners: "jsEventListeners",
  js_heap_total: "jsHeapTotalBytes",
  js_heap_used: "jsHeapUsedBytes",
  layout_objects: "layoutObjects",
  script_duration: "scriptDurationSeconds",
  task_duration: "taskDurationSeconds",
  thread_time: "threadTimeSeconds"
};
function canonicalJson2(value, depth = 0, maximumDepth = TRACE_MAX_JSON_DEPTH) {
  if (depth > maximumDepth) {
    throw new Error(`Bombadil named snapshot exceeds JSON depth ${String(maximumDepth)}`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error("Bombadil named snapshot has a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson2(entry, depth + 1, maximumDepth)).join(",")}]`;
  }
  if (!isRecord2(value))
    throw new Error("Bombadil named snapshot is not JSON");
  const entries = Object.keys(value).sort(compareCodeUnits).map((key) => `${JSON.stringify(key)}:${canonicalJson2(value[key], depth + 1, maximumDepth)}`);
  return `{${entries.join(",")}}`;
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function namedSnapshotValueSha256(value, options = {}) {
  const maximumBytes = options.maximumBytes ?? TRACE_MAX_CANONICAL_SNAPSHOT_BYTES;
  const canonical = canonicalJson2(value, 0, options.maximumDepth ?? TRACE_MAX_JSON_DEPTH);
  if (Buffer.byteLength(canonical, "utf8") > maximumBytes) {
    throw new Error(`Bombadil named snapshot exceeds ${String(maximumBytes)} canonical bytes`);
  }
  return sha256(canonical);
}
function validTracePoint(value) {
  return isRecord2(value) && hasExactKeys(value, TRACE_POINT_KEYS) && typeof value.x === "number" && Number.isFinite(value.x) && typeof value.y === "number" && Number.isFinite(value.y);
}
function parseTraceFingerprintTag(value, lineNumber) {
  if (!isRecord2(value) || !Object.keys(value).every((key) => TRACE_FINGERPRINT_KEYS.has(key))) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid action target`);
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (key !== "tag" && typeof candidate !== "string") {
      throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid action target`);
    }
  }
  const tag = value.tag;
  if (typeof tag !== "string" || tag.length === 0) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid action target tag`);
  }
  if (typeof value.structural_path === "string" && Object.keys(value).some((key) => key !== "tag" && key !== "structural_path")) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid action target`);
  }
  return tag.length <= 64 && TARGET_TAG_PATTERN.test(tag) ? tag : `sha256:${sha256(tag)}`;
}
function isSafeIntegerBetween(value, minimum, maximum) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function invalidTraceAction(lineNumber) {
  throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid action`);
}
function parseTraceAction(value, lineNumber) {
  if (value === null)
    return null;
  if (typeof value === "string") {
    if (!ACTION_KIND_SET.has(value) || !UNIT_ACTION_KINDS.has(value)) {
      return invalidTraceAction(lineNumber);
    }
    return { kind: value, targetTag: null };
  }
  if (!isRecord2(value) || Object.keys(value).length !== 1) {
    return invalidTraceAction(lineNumber);
  }
  const kind = Object.keys(value)[0];
  const payload = kind === undefined ? undefined : value[kind];
  if (kind === undefined || !ACTION_KIND_SET.has(kind) || UNIT_ACTION_KINDS.has(kind) || !isRecord2(payload)) {
    return invalidTraceAction(lineNumber);
  }
  const actionKind = kind;
  let targetTag = null;
  switch (actionKind) {
    case "Click":
      if (!hasExactKeys(payload, TRACE_CLICK_ACTION_KEYS) || !validTracePoint(payload.point)) {
        return invalidTraceAction(lineNumber);
      }
      targetTag = parseTraceFingerprintTag(payload.fingerprint, lineNumber);
      break;
    case "DoubleClick":
      if (!hasExactKeys(payload, TRACE_DOUBLE_CLICK_ACTION_KEYS) || !isSafeIntegerBetween(payload.delay_millis, 0, 1000) || !validTracePoint(payload.point))
        return invalidTraceAction(lineNumber);
      targetTag = parseTraceFingerprintTag(payload.fingerprint, lineNumber);
      break;
    case "TypeText":
      if (!hasExactKeys(payload, TRACE_TYPE_TEXT_ACTION_KEYS) || !isSafeIntegerBetween(payload.delay_millis, 0, Number.MAX_SAFE_INTEGER) || typeof payload.text !== "string")
        return invalidTraceAction(lineNumber);
      break;
    case "PressKey":
      if (!hasExactKeys(payload, TRACE_PRESS_KEY_ACTION_KEYS) || !isSafeIntegerBetween(payload.code, 0, 255)) {
        return invalidTraceAction(lineNumber);
      }
      break;
    case "ScrollDown":
    case "ScrollUp":
      if (!hasExactKeys(payload, TRACE_SCROLL_ACTION_KEYS) || typeof payload.distance !== "number" || !Number.isFinite(payload.distance) || !validTracePoint(payload.origin))
        return invalidTraceAction(lineNumber);
      break;
    case "SetFileInputFiles":
      if (!hasExactKeys(payload, TRACE_FILE_INPUT_ACTION_KEYS) || typeof payload.selector !== "string" || !Array.isArray(payload.files) || !payload.files.every((file) => typeof file === "string"))
        return invalidTraceAction(lineNumber);
      break;
    case "MouseDrag":
      if (!hasExactKeys(payload, TRACE_MOUSE_DRAG_ACTION_KEYS) || !isSafeIntegerBetween(payload.delay_millis, 0, 1000) || !isSafeIntegerBetween(payload.steps, 1, 255) || !validTracePoint(payload.from) || !validTracePoint(payload.to))
        return invalidTraceAction(lineNumber);
      break;
    case "SetViewport":
      if (!hasExactKeys(payload, TRACE_VIEWPORT_ACTION_KEYS) || !isSafeIntegerBetween(payload.height, 1, 1e4) || !isSafeIntegerBetween(payload.width, 1, 1e4))
        return invalidTraceAction(lineNumber);
      break;
    default:
      return invalidTraceAction(lineNumber);
  }
  return { kind: actionKind, targetTag };
}
function parseNonNegativeFiniteNumber(value, lineNumber, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid ${field}`);
  }
  return value;
}
function parseTraceState(value, lineNumber) {
  if (!isRecord2(value) || !hasExactKeys(value, TRACE_STATE_KEYS)) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid browser state`);
  }
  if (typeof value.url !== "string" || value.url.length === 0 || value.url.length > 8192) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid browser URL`);
  }
  let url;
  try {
    url = new URL(value.url);
  } catch {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid browser URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid browser URL protocol`);
  }
  if (typeof value.screenshot !== "string" || value.screenshot.length > 8192) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid screenshot path`);
  }
  for (const field of ["hash_previous", "hash_current"]) {
    const hash = value[field];
    if (hash !== null && (typeof hash !== "number" || !Number.isFinite(hash) || !Number.isInteger(hash) || hash < 0)) {
      throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid ${field}`);
    }
  }
  if (!isRecord2(value.resources) || !hasExactKeys(value.resources, TRACE_RESOURCE_KEYS)) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has invalid browser resources`);
  }
  const resources = {};
  for (const field of Object.keys(RESOURCE_FIELD_MAP)) {
    resources[field] = parseNonNegativeFiniteNumber(value.resources[field], lineNumber, `resources.${field}`);
  }
  parseNonNegativeFiniteNumber(value.resources.timestamp, lineNumber, "resources.timestamp");
  return {
    currentHash: value.hash_current,
    resources,
    url
  };
}
function parseTraceEnvelope(line, lineNumber) {
  let input;
  try {
    input = JSON.parse(line);
  } catch {
    throw new Error(`Bombadil trace line ${String(lineNumber)} is not valid JSON`);
  }
  if (!isRecord2(input) || !hasExactKeys(input, TRACE_LINE_KEYS)) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid 0.7.2 envelope`);
  }
  if (!Number.isSafeInteger(input.timestamp) || typeof input.timestamp !== "number" || input.timestamp < 0 || !Array.isArray(input.snapshots) || input.snapshots.length > TRACE_MAX_SNAPSHOTS_PER_LINE || !Array.isArray(input.violations)) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has invalid state fields`);
  }
  return {
    action: input.action,
    snapshots: input.snapshots,
    state: input.state,
    timestamp: input.timestamp,
    violations: input.violations
  };
}
function parseDirectTraceObservation(envelope, lineNumber) {
  const directSnapshots = envelope.snapshots.filter((snapshot2) => isRecord2(snapshot2) && snapshot2.name === "direct");
  if (directSnapshots.length !== 1) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} must contain one named direct snapshot`);
  }
  const snapshot = directSnapshots[0];
  if (snapshot === undefined || !hasExactKeys(snapshot, TRACE_SNAPSHOT_KEYS) || !Number.isSafeInteger(snapshot.index) || !Number.isSafeInteger(snapshot.time) || snapshot.index < 0 || snapshot.time < 0) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid direct snapshot`);
  }
  return {
    observation: parseTraceDirectObservation(snapshot.value),
    value: snapshot.value
  };
}
function parseDirectTraceLine(line, lineNumber) {
  return parseDirectTraceObservation(parseTraceEnvelope(line, lineNumber), lineNumber).observation;
}
function parseTraceLine(line, lineNumber, strictDiagnosticSnapshotNames) {
  const envelope = parseTraceEnvelope(line, lineNumber);
  const state = parseTraceState(envelope.state, lineNumber);
  const action = parseTraceAction(envelope.action, lineNumber);
  const snapshots = envelope.snapshots;
  const direct = parseDirectTraceObservation(envelope, lineNumber);
  const namedSnapshots = [{
    name: "direct",
    valueSha256: namedSnapshotValueSha256(direct.value, {
      maximumBytes: TRACE_MAX_LINE_BYTES,
      maximumDepth: TRACE_MAX_JSON_DEPTH + 4
    })
  }];
  const diagnosticSnapshotValues = new Map;
  for (const snapshotValue of snapshots) {
    if (!isRecord2(snapshotValue) || !hasExactKeys(snapshotValue, TRACE_SNAPSHOT_KEYS) || !Number.isSafeInteger(snapshotValue.index) || !Number.isSafeInteger(snapshotValue.time) || snapshotValue.index < 0 || snapshotValue.time < 0 || snapshotValue.name !== null && typeof snapshotValue.name !== "string") {
      throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid snapshot`);
    }
    if (snapshotValue.name === null || snapshotValue.name === "direct")
      continue;
    let name;
    try {
      name = validateSnapshotName(snapshotValue.name, `Bombadil trace line ${String(lineNumber)} snapshot name`);
    } catch (error) {
      if (strictDiagnosticSnapshotNames.has(snapshotValue.name))
        throw error;
      continue;
    }
    const values = diagnosticSnapshotValues.get(name) ?? [];
    values.push(snapshotValue.value);
    diagnosticSnapshotValues.set(name, values);
  }
  for (const [name, values] of diagnosticSnapshotValues) {
    if (values.length !== 1) {
      if (strictDiagnosticSnapshotNames.has(name)) {
        throw new Error(`Bombadil trace line ${String(lineNumber)} repeats named snapshot ${name}`);
      }
      continue;
    }
    try {
      namedSnapshots.push({
        name,
        valueSha256: namedSnapshotValueSha256(values[0])
      });
    } catch (error) {
      if (strictDiagnosticSnapshotNames.has(name))
        throw error;
    }
  }
  const propertyViolationNames = [];
  for (const violation of envelope.violations) {
    if (!isRecord2(violation) || !hasExactKeys(violation, TRACE_VIOLATION_KEYS)) {
      throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid property violation`);
    }
    propertyViolationNames.push(validateSnapshotName(violation.name, `Bombadil trace line ${String(lineNumber)} property violation name`));
    if (!isRecord2(violation.violation) || Object.keys(violation.violation).length !== 1) {
      throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid property violation`);
    }
  }
  return {
    action,
    directObservation: direct.observation,
    namedSnapshots,
    propertyViolationNames,
    state
  };
}
async function attestDirectBombadilTrace(options) {
  const traceBytes = await readBoundRegularFileBytes({
    label: "Bombadil trace.jsonl",
    maximumBytes: TRACE_MAX_BYTES,
    path: options.tracePath
  });
  return attestDirectBombadilTraceBytes({ ...options, traceBytes });
}
function attestDirectBombadilTraceBytes(options) {
  const lines = decodeTraceLines(options.traceBytes);
  let observationCount = 0;
  let invalidObservationCount = 0;
  let validObservationCount = 0;
  let initial = null;
  let final = null;
  let finalWasInvalid = false;
  for (const line of lines) {
    observationCount += 1;
    if (observationCount > TRACE_MAX_LINES) {
      throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_LINES)} lines`);
    }
    if (Buffer.byteLength(line, "utf8") > TRACE_MAX_LINE_BYTES) {
      throw new Error(`Bombadil trace line ${String(observationCount)} is too large`);
    }
    const observation = parseDirectTraceLine(line, observationCount);
    const exact = exactTraceDirectObservation(observation);
    if (exact === null) {
      if (initial !== null) {
        throw new Error("Bombadil trace lost the Direct bridge after exact activation");
      }
      invalidObservationCount += 1;
      finalWasInvalid = true;
      continue;
    }
    validObservationCount += 1;
    final = exact;
    finalWasInvalid = false;
    if (initial === null) {
      if (exact.source !== "scenario" || exact.scenario !== options.expectedScenario || exact.route !== options.expectedRoute) {
        throw new Error("Bombadil trace first valid Direct activation does not match the requested scenario and route");
      }
      initial = {
        activationHash: exact.activationHash,
        catalogHash: exact.catalogHash,
        route: exact.route,
        scenario: exact.scenario,
        source: exact.source
      };
    }
    if (exact.source !== "scenario") {
      throw new Error("Bombadil trace left scenario activation during the run");
    }
    if (exact.scenario !== initial.scenario || exact.route !== initial.route || exact.activationHash !== initial.activationHash) {
      throw new Error("Bombadil trace Direct activation changed during the run");
    }
    if (exact.catalogHash !== initial.catalogHash) {
      throw new Error("Bombadil trace Direct catalog changed during the run");
    }
    if (observation.violations.some((value) => value !== 0)) {
      throw new Error("Bombadil trace contains a nonzero Direct violation counter");
    }
  }
  if (initial === null || final === null) {
    throw new Error("Bombadil trace never reached a valid Direct contract");
  }
  if (finalWasInvalid) {
    throw new Error("Bombadil trace ended without an installed valid Direct bridge");
  }
  if (!final.isQuiescent) {
    throw new Error("Bombadil trace final Direct observation is not quiescent");
  }
  return {
    schema: "direct.bombadil-trace-attestation/v1",
    catalogHash: initial.catalogHash,
    initial,
    final: {
      activationHash: final.activationHash,
      catalogHash: final.catalogHash,
      route: final.route,
      scenario: final.scenario,
      source: final.source,
      isQuiescent: true
    },
    observationCount,
    invalidObservationCount,
    validObservationCount
  };
}
function sortedCountRecord(values) {
  return Object.freeze(Object.fromEntries([...values.entries()].sort(([left], [right]) => compareCodeUnits(left, right))));
}
async function summarizeDirectBombadilTrace(options) {
  const traceBytes = await readBoundRegularFileBytes({
    label: "Bombadil trace.jsonl",
    maximumBytes: TRACE_MAX_BYTES,
    path: options.tracePath
  });
  return summarizeDirectBombadilTraceBytes({ ...options, traceBytes });
}
function summarizeDirectBombadilTraceBytes(options) {
  let targetUrl;
  try {
    targetUrl = new URL(options.targetUrl);
  } catch {
    throw new Error("targetUrl must be an absolute URL");
  }
  const policy = validateExplorationPolicy(options.explorationPolicy);
  const strictDiagnosticSnapshotNames = explorationPolicySnapshotNames(policy);
  const actionCounts = new Map;
  const targetTags = new Map;
  const urlFingerprints = new Set;
  const rawUrlFingerprints = new Set;
  const transitionHashes = new Set;
  const rawTransitionHashes = new Set;
  const snapshots = new Map;
  const propertyViolations = new Map;
  const resources = {
    documents: 0,
    domNodes: 0,
    jsEventListeners: 0,
    jsHeapTotalBytes: 0,
    jsHeapUsedBytes: 0,
    layoutObjects: 0,
    scriptDurationSeconds: 0,
    taskDurationSeconds: 0,
    threadTimeSeconds: 0
  };
  let lineCount = 0;
  let totalActions = 0;
  let nonWaitCount = 0;
  let waitStreak = 0;
  let maxWaitStreak = 0;
  let nonNullHashCount = 0;
  let rawNonNullHashCount = 0;
  let policyObservationCount = 0;
  let previousObservationWasExact = false;
  let stableTarget = true;
  let trackedUnrelatedSnapshotNameCount = 0;
  const unrelatedSnapshotNameLimit = Math.max(0, TRACE_MAX_NAMED_SNAPSHOT_NAMES - strictDiagnosticSnapshotNames.size);
  const lines = decodeTraceLines(options.traceBytes);
  for (const line of lines) {
    lineCount += 1;
    if (lineCount > TRACE_MAX_LINES) {
      throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_LINES)} lines`);
    }
    if (Buffer.byteLength(line, "utf8") > TRACE_MAX_LINE_BYTES) {
      throw new Error(`Bombadil trace line ${String(lineCount)} is too large`);
    }
    const parsed = parseTraceLine(line, lineCount, strictDiagnosticSnapshotNames);
    const rawRelativeUrl = `${parsed.state.url.pathname}${parsed.state.url.search}${parsed.state.url.hash}`;
    rawUrlFingerprints.add(sha256(rawRelativeUrl));
    if (rawUrlFingerprints.size > TRACE_MAX_DISTINCT_URLS) {
      throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_DISTINCT_URLS)} distinct raw URL fingerprints`);
    }
    if (parsed.state.currentHash !== null) {
      rawNonNullHashCount += 1;
      rawTransitionHashes.add(String(parsed.state.currentHash));
    }
    for (const name of parsed.propertyViolationNames) {
      if (!propertyViolations.has(name) && propertyViolations.size >= TRACE_MAX_PROPERTY_NAMES) {
        throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_PROPERTY_NAMES)} property names`);
      }
      propertyViolations.set(name, (propertyViolations.get(name) ?? 0) + 1);
    }
    for (const [sourceName, outputName] of Object.entries(RESOURCE_FIELD_MAP)) {
      resources[outputName] = Math.max(resources[outputName], parsed.state.resources[sourceName]);
    }
    const currentObservationIsExact = exactTraceDirectObservation(parsed.directObservation) !== null;
    if (!currentObservationIsExact) {
      previousObservationWasExact = false;
      continue;
    }
    policyObservationCount += 1;
    const actionFollowsExactObservation = previousObservationWasExact;
    const recordedActionKind = actionFollowsExactObservation ? parsed.action?.kind ?? null : null;
    if (actionFollowsExactObservation && parsed.action !== null) {
      totalActions += 1;
      actionCounts.set(parsed.action.kind, (actionCounts.get(parsed.action.kind) ?? 0) + 1);
      if (parsed.action.kind === "Wait") {
        waitStreak += 1;
        maxWaitStreak = Math.max(maxWaitStreak, waitStreak);
      } else {
        nonWaitCount += 1;
        waitStreak = 0;
      }
      if (parsed.action.targetTag !== null) {
        if (!targetTags.has(parsed.action.targetTag) && targetTags.size >= 128) {
          throw new Error("Bombadil trace exceeds 128 distinct action target tags");
        }
        targetTags.set(parsed.action.targetTag, (targetTags.get(parsed.action.targetTag) ?? 0) + 1);
      }
    } else if (actionFollowsExactObservation) {
      waitStreak = 0;
    }
    const relativeUrl = `${parsed.state.url.pathname}${parsed.state.url.search}${parsed.state.url.hash}`;
    urlFingerprints.add(sha256(relativeUrl));
    if (urlFingerprints.size > TRACE_MAX_DISTINCT_URLS) {
      throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_DISTINCT_URLS)} distinct URL fingerprints`);
    }
    stableTarget &&= parsed.state.url.href === targetUrl.href;
    if (parsed.state.currentHash !== null) {
      nonNullHashCount += 1;
      transitionHashes.add(String(parsed.state.currentHash));
    }
    for (const snapshot of parsed.namedSnapshots) {
      let entry = snapshots.get(snapshot.name);
      if (entry === undefined) {
        const isStrictSnapshot = snapshot.name === "direct" || strictDiagnosticSnapshotNames.has(snapshot.name);
        if (!isStrictSnapshot && trackedUnrelatedSnapshotNameCount >= unrelatedSnapshotNameLimit) {
          continue;
        }
        if (snapshots.size >= TRACE_MAX_NAMED_SNAPSHOT_NAMES) {
          throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_NAMED_SNAPSHOT_NAMES)} named snapshots`);
        }
        entry = {
          changeAfterActionKind: new Map,
          changeAfterNonWaitCount: 0,
          lastObservationIndex: null,
          lastValueSha256: null,
          observationCount: 0,
          values: new Set
        };
        snapshots.set(snapshot.name, entry);
        if (!isStrictSnapshot)
          trackedUnrelatedSnapshotNameCount += 1;
      }
      if (!entry.values.has(snapshot.valueSha256) && entry.values.size >= TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME) {
        if (snapshot.name === "direct" || strictDiagnosticSnapshotNames.has(snapshot.name)) {
          throw new Error(`Bombadil trace named snapshot ${snapshot.name} exceeds ${String(TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME)} distinct values`);
        }
        continue;
      }
      const changedAfterRecordedAction = recordedActionKind !== null && entry.lastObservationIndex === policyObservationCount - 1 && entry.lastValueSha256 !== null && entry.lastValueSha256 !== snapshot.valueSha256;
      if (changedAfterRecordedAction) {
        entry.changeAfterActionKind.set(recordedActionKind, (entry.changeAfterActionKind.get(recordedActionKind) ?? 0) + 1);
      }
      if (changedAfterRecordedAction && recordedActionKind !== "Wait") {
        entry.changeAfterNonWaitCount += 1;
      }
      entry.lastObservationIndex = policyObservationCount;
      entry.lastValueSha256 = snapshot.valueSha256;
      entry.observationCount += 1;
      entry.values.add(snapshot.valueSha256);
    }
    previousObservationWasExact = true;
  }
  if (lineCount === 0)
    throw new Error("Bombadil did not produce a nonempty trace.jsonl");
  const policyFailures = [];
  if (policy !== null) {
    if (nonWaitCount < policy.minNonWaitActions) {
      policyFailures.push("minimum non-Wait action count was not reached");
    }
    for (const kind of policy.requiredActionKinds) {
      if ((actionCounts.get(kind) ?? 0) === 0) {
        policyFailures.push(`required action kind ${kind} was not observed`);
      }
    }
    for (const name of policy.requiredNamedSnapshots) {
      if (!snapshots.has(name)) {
        policyFailures.push(`required named snapshot ${name} was not observed`);
      }
    }
    for (const [name, minimum] of Object.entries(policy.minDistinctNamedSnapshotValues)) {
      if ((snapshots.get(name)?.values.size ?? 0) < minimum) {
        policyFailures.push(`named snapshot ${name} did not reach its distinct-value minimum`);
      }
    }
    for (const [name, minimum] of Object.entries(policy.minNamedSnapshotChangesAfterNonWait)) {
      if ((snapshots.get(name)?.changeAfterNonWaitCount ?? 0) < minimum) {
        policyFailures.push(`named snapshot ${name} did not reach its post-non-Wait change minimum`);
      }
    }
    for (const [name, minimumByKind] of Object.entries(policy.minNamedSnapshotChangesAfterActionKind)) {
      for (const [kind, minimum] of Object.entries(minimumByKind)) {
        if ((snapshots.get(name)?.changeAfterActionKind.get(kind) ?? 0) < minimum) {
          policyFailures.push(`named snapshot ${name} did not reach its post-${kind} change minimum`);
        }
      }
    }
    if (policy.requireStableTargetUrl && !stableTarget) {
      policyFailures.push("the browser did not remain on the exact target URL");
    }
  }
  return Object.freeze({
    schema: "direct.bombadil-exploration-summary/v2",
    trace: Object.freeze({
      bytes: options.traceBytes.byteLength,
      lineCount,
      sha256: sha256(options.traceBytes)
    }),
    actions: Object.freeze({
      byKind: sortedCountRecord(actionCounts),
      maxWaitStreak,
      nonWaitCount,
      targetTags: sortedCountRecord(targetTags),
      total: totalActions
    }),
    urls: Object.freeze({
      distinctFingerprintCount: urlFingerprints.size,
      fingerprintSha256: Object.freeze([...urlFingerprints].sort(compareCodeUnits)),
      observationCount: policyObservationCount,
      rawDistinctFingerprintCount: rawUrlFingerprints.size,
      rawFingerprintSha256: Object.freeze([...rawUrlFingerprints].sort(compareCodeUnits)),
      rawObservationCount: lineCount,
      stableTarget
    }),
    transitions: Object.freeze({
      distinctNonNullHashCount: transitionHashes.size,
      nonNullHashCount,
      rawDistinctNonNullHashCount: rawTransitionHashes.size,
      rawNonNullHashCount
    }),
    namedSnapshots: Object.freeze([...snapshots.entries()].sort(([left], [right]) => compareCodeUnits(left, right)).map(([name, entry]) => Object.freeze({
      changeAfterActionKind: sortedCountRecord(entry.changeAfterActionKind),
      changeAfterNonWaitCount: entry.changeAfterNonWaitCount,
      distinctValueCount: entry.values.size,
      distinctValueSha256: Object.freeze([...entry.values].sort(compareCodeUnits)),
      name,
      observationCount: entry.observationCount
    }))),
    propertyViolations: Object.freeze({
      byName: sortedCountRecord(propertyViolations),
      total: [...propertyViolations.values()].reduce((total, value) => total + value, 0)
    }),
    resourceHighWaterMarks: Object.freeze(resources),
    policy: Object.freeze({
      configured: policy !== null,
      failures: Object.freeze(policyFailures),
      satisfied: policyFailures.length === 0
    })
  });
}
function parseDirectBombadilFuzzArguments(arguments_, defaultBaseUrl) {
  let baseUrl = defaultBaseUrl;
  let timeLimitSeconds = DEFAULT_TIME_LIMIT_SECONDS;
  let replayPath = null;
  let receivedBaseUrl = false;
  let receivedTimeLimit = false;
  let receivedReplay = false;
  for (let index = 0;index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined)
      continue;
    if (argument === "--help" || argument === "-h")
      return { kind: "help" };
    if (argument === "--base-url" || argument.startsWith("--base-url=")) {
      if (receivedBaseUrl)
        throw new Error("--base-url may be provided only once");
      receivedBaseUrl = true;
      if (argument === "--base-url") {
        const next = readOptionValue(arguments_, index, "--base-url");
        baseUrl = next.value;
        index = next.index;
      } else {
        baseUrl = argument.slice("--base-url=".length);
      }
      continue;
    }
    if (argument === "--time-limit" || argument.startsWith("--time-limit=")) {
      if (receivedTimeLimit)
        throw new Error("--time-limit may be provided only once");
      receivedTimeLimit = true;
      let value;
      if (argument === "--time-limit") {
        const next = readOptionValue(arguments_, index, "--time-limit");
        value = next.value;
        index = next.index;
      } else {
        value = argument.slice("--time-limit=".length);
      }
      timeLimitSeconds = parseTimeLimit(value);
      continue;
    }
    if (argument === "--replay" || argument.startsWith("--replay=")) {
      if (receivedReplay)
        throw new Error("--replay may be provided only once");
      receivedReplay = true;
      if (argument === "--replay") {
        const next = readOptionValue(arguments_, index, "--replay");
        replayPath = next.value;
        index = next.index;
      } else {
        replayPath = argument.slice("--replay=".length);
      }
      if (replayPath.length === 0)
        throw new Error("--replay requires a value");
      continue;
    }
    throw new Error(`Unknown argument at position ${String(index + 1)}`);
  }
  if (receivedReplay && receivedTimeLimit) {
    throw new Error("--replay and --time-limit cannot be used together");
  }
  return {
    kind: "run",
    baseUrl: requireLocalRootHttpOrigin(baseUrl),
    replayPath,
    timeLimitSeconds
  };
}
function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || !path.startsWith("..") && !isAbsolute(path);
}
function validateReadinessPath(value) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("server.readinessPath must be an origin-relative path");
  }
  const url = new URL(value, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1" || url.hash !== "") {
    throw new Error("server.readinessPath must stay on the server origin without a fragment");
  }
}
function validateEntryPath(value) {
  if (!value.startsWith("/") || value.startsWith("//")) {
    throw new Error("entryPath must be an origin-relative path");
  }
  const url = new URL(value, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1" || url.hash !== "" || url.search !== "" || url.pathname !== value) {
    throw new Error("entryPath must be a normalized path without a query or fragment");
  }
}
function validateTargetQuery(value) {
  if (!isRecord2(value)) {
    throw new Error("targetQuery must be an object of string query parameters");
  }
  const entries = Object.entries(value);
  if (entries.length > 16) {
    throw new Error("targetQuery may contain at most 16 parameters");
  }
  const validated = {};
  for (const [name, queryValue] of [...entries].sort(([left], [right]) => compareCodeUnits(left, right))) {
    if (name.length === 0 || name.length > 128 || !QUERY_PARAMETER_NAME_PATTERN.test(name) || PROTOTYPE_PROPERTY_NAMES.has(name) || hasControlCharacters3(name) || name === SCENARIO_QUERY_KEY2 || name === FIXTURE_QUERY_KEY2) {
      throw new Error("targetQuery contains an invalid or reserved parameter name");
    }
    if (typeof queryValue !== "string" || queryValue.length > 2048 || hasControlCharacters3(queryValue)) {
      throw new Error(`targetQuery ${name} must be a bounded string without control characters`);
    }
    validated[name] = queryValue;
  }
  return Object.freeze(validated);
}
function validateSnapshotName(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || !SNAPSHOT_NAME_PATTERN.test(value) || PROTOTYPE_PROPERTY_NAMES.has(value) || hasControlCharacters3(value)) {
    throw new Error(`${label} must be a safe bounded snapshot name`);
  }
  return value;
}
function validateViewport(value) {
  if (value === undefined) {
    return Object.freeze({
      deviceScaleFactor: DEFAULT_DEVICE_SCALE_FACTOR,
      height: DEFAULT_VIEWPORT_HEIGHT,
      width: DEFAULT_VIEWPORT_WIDTH
    });
  }
  if (!isRecord2(value) || !Object.keys(value).every((key) => VIEWPORT_KEYS.has(key))) {
    throw new Error("viewport must contain only width, height, and deviceScaleFactor");
  }
  const validateDimension = (name, input) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > 65535) {
      throw new Error(`viewport.${name} must be an integer between 1 and 65535`);
    }
    return input;
  };
  const width = validateDimension("width", value.width ?? DEFAULT_VIEWPORT_WIDTH);
  const height = validateDimension("height", value.height ?? DEFAULT_VIEWPORT_HEIGHT);
  const deviceScaleFactor = value.deviceScaleFactor ?? DEFAULT_DEVICE_SCALE_FACTOR;
  if (typeof deviceScaleFactor !== "number" || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 0.1 || deviceScaleFactor > 10) {
    throw new Error("viewport.deviceScaleFactor must be a finite number between 0.1 and 10");
  }
  return Object.freeze({ deviceScaleFactor, height, width });
}
function validateSnapshotMinimumMap(options) {
  if (!isRecord2(options.value) || Object.keys(options.value).length > 32) {
    throw new Error(`${options.label} must be a bounded object`);
  }
  const validated = {};
  for (const [rawName, minimum] of Object.entries(options.value).sort(([left], [right]) => compareCodeUnits(left, right))) {
    const name = validateSnapshotName(rawName, `${options.label} key`);
    if (typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum < 1 || minimum > options.maximum) {
      throw new Error(`${options.label} ${name} must be an integer between 1 and ${String(options.maximum)}`);
    }
    validated[name] = minimum;
  }
  return Object.freeze(validated);
}
function validateSnapshotActionMinimumMap(options) {
  if (!isRecord2(options.value) || Object.keys(options.value).length > 32) {
    throw new Error(`${options.label} must be a bounded object`);
  }
  const validated = {};
  for (const [rawName, rawMinimumByKind] of Object.entries(options.value).sort(([left], [right]) => compareCodeUnits(left, right))) {
    const name = validateSnapshotName(rawName, `${options.label} key`);
    if (!isRecord2(rawMinimumByKind) || Object.keys(rawMinimumByKind).length === 0 || Object.keys(rawMinimumByKind).length > ACTION_KINDS.length) {
      throw new Error(`${options.label} ${name} must be a bounded action map`);
    }
    const minimumByKind = {};
    for (const [rawKind, minimum] of Object.entries(rawMinimumByKind).sort(([left], [right]) => compareCodeUnits(left, right))) {
      if (!ACTION_KIND_SET.has(rawKind)) {
        throw new Error(`${options.label} ${name} contains an unknown action kind`);
      }
      if (typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum < 1 || minimum > TRACE_MAX_LINES) {
        throw new Error(`${options.label} ${name}.${rawKind} must be an integer between 1 and ${String(TRACE_MAX_LINES)}`);
      }
      minimumByKind[rawKind] = minimum;
    }
    validated[name] = Object.freeze(minimumByKind);
  }
  return Object.freeze(validated);
}
function explorationPolicySnapshotNames(policy) {
  const names = new Set(["direct"]);
  if (policy === null)
    return names;
  for (const name of policy.requiredNamedSnapshots)
    names.add(name);
  for (const name of Object.keys(policy.minDistinctNamedSnapshotValues))
    names.add(name);
  for (const name of Object.keys(policy.minNamedSnapshotChangesAfterNonWait))
    names.add(name);
  for (const name of Object.keys(policy.minNamedSnapshotChangesAfterActionKind))
    names.add(name);
  return names;
}
function validateExplorationPolicy(value) {
  if (value === undefined)
    return null;
  if (!isRecord2(value) || !Object.keys(value).every((key) => EXPLORATION_POLICY_KEYS.has(key))) {
    throw new Error("explorationPolicy contains an unknown field");
  }
  const minNonWaitActions = value.minNonWaitActions ?? 0;
  if (typeof minNonWaitActions !== "number" || !Number.isSafeInteger(minNonWaitActions) || minNonWaitActions < 0 || minNonWaitActions > TRACE_MAX_LINES) {
    throw new Error(`explorationPolicy.minNonWaitActions must be an integer between 0 and ${String(TRACE_MAX_LINES)}`);
  }
  const requiredActionKindsInput = value.requiredActionKinds ?? [];
  if (!Array.isArray(requiredActionKindsInput) || requiredActionKindsInput.length > ACTION_KINDS.length) {
    throw new Error("explorationPolicy.requiredActionKinds must be a bounded array");
  }
  const requiredActionKinds = [...requiredActionKindsInput];
  if (!requiredActionKinds.every((kind) => typeof kind === "string" && ACTION_KIND_SET.has(kind)) || new Set(requiredActionKinds).size !== requiredActionKinds.length) {
    throw new Error("explorationPolicy.requiredActionKinds contains an unknown or duplicate kind");
  }
  requiredActionKinds.sort(compareCodeUnits);
  const requiredNamedSnapshotsInput = value.requiredNamedSnapshots ?? [];
  if (!Array.isArray(requiredNamedSnapshotsInput) || requiredNamedSnapshotsInput.length > 32) {
    throw new Error("explorationPolicy.requiredNamedSnapshots must be a bounded array");
  }
  const requiredNamedSnapshots = requiredNamedSnapshotsInput.map((name) => validateSnapshotName(name, "explorationPolicy.requiredNamedSnapshots entry"));
  if (new Set(requiredNamedSnapshots).size !== requiredNamedSnapshots.length) {
    throw new Error("explorationPolicy.requiredNamedSnapshots contains a duplicate name");
  }
  requiredNamedSnapshots.sort(compareCodeUnits);
  const minDistinctNamedSnapshotValues = validateSnapshotMinimumMap({
    label: "explorationPolicy.minDistinctNamedSnapshotValues",
    maximum: TRACE_MAX_DISTINCT_SNAPSHOT_VALUES_PER_NAME,
    value: value.minDistinctNamedSnapshotValues ?? {}
  });
  const minNamedSnapshotChangesAfterActionKind = validateSnapshotActionMinimumMap({
    label: "explorationPolicy.minNamedSnapshotChangesAfterActionKind",
    value: value.minNamedSnapshotChangesAfterActionKind ?? {}
  });
  const minNamedSnapshotChangesAfterNonWait = validateSnapshotMinimumMap({
    label: "explorationPolicy.minNamedSnapshotChangesAfterNonWait",
    maximum: TRACE_MAX_LINES,
    value: value.minNamedSnapshotChangesAfterNonWait ?? {}
  });
  const requireStableTargetUrl = value.requireStableTargetUrl ?? false;
  if (typeof requireStableTargetUrl !== "boolean") {
    throw new Error("explorationPolicy.requireStableTargetUrl must be a boolean");
  }
  const validated = Object.freeze({
    minDistinctNamedSnapshotValues,
    minNamedSnapshotChangesAfterActionKind,
    minNamedSnapshotChangesAfterNonWait,
    minNonWaitActions,
    requireStableTargetUrl,
    requiredActionKinds: Object.freeze(requiredActionKinds),
    requiredNamedSnapshots: Object.freeze(requiredNamedSnapshots)
  });
  if (explorationPolicySnapshotNames(validated).size > TRACE_MAX_NAMED_SNAPSHOT_NAMES) {
    throw new Error(`explorationPolicy may reference at most ${String(TRACE_MAX_NAMED_SNAPSHOT_NAMES - 1)} distinct non-Direct snapshots`);
  }
  return validated;
}
function validateDirectBombadilFuzzConfig(config, baseUrlOverride) {
  const repositoryRoot = resolve(config.repositoryRoot);
  if (!isAbsolute(config.repositoryRoot) || repositoryRoot !== config.repositoryRoot) {
    throw new Error("repositoryRoot must be an absolute normalized path");
  }
  if (!isBoundedArtifactIdentifier(config.artifactName)) {
    throw new Error("artifactName must be a safe lowercase kebab identifier");
  }
  if (config.label.trim().length === 0 || config.label.length > 160 || hasControlCharacters3(config.label)) {
    throw new Error("label must contain 1-160 visible characters");
  }
  if (!isBoundedScenarioIdentifier(config.scenario)) {
    throw new Error("scenario must be a valid Direct scenario identifier");
  }
  if (config.expectedRoute.trim().length === 0 || config.expectedRoute.length > 256 || hasControlCharacters3(config.expectedRoute)) {
    throw new Error("expectedRoute must contain 1-256 visible characters");
  }
  const specificationPath = resolve(config.specificationPath);
  const serverCwd = resolve(config.server.cwd);
  if (!isAbsolute(config.specificationPath) || !isWithin(repositoryRoot, specificationPath)) {
    throw new Error("specificationPath must be an absolute path inside repositoryRoot");
  }
  if (!/\.[cm]?[jt]sx?$/u.test(specificationPath)) {
    throw new Error("specificationPath must name a JavaScript or TypeScript specification");
  }
  if (!isAbsolute(config.server.cwd) || !isWithin(repositoryRoot, serverCwd)) {
    throw new Error("server.cwd must be an absolute path inside repositoryRoot");
  }
  if (config.server.command.length === 0) {
    throw new Error("server.command must contain at least one argument");
  }
  if (config.server.command.filter((argument) => argument === "{port}").length !== 1) {
    throw new Error("server.command must contain exactly one literal {port} token");
  }
  for (const argument of config.server.command) {
    if (argument.length === 0 || argument.includes("\x00")) {
      throw new Error("server.command arguments must be nonempty strings without null bytes");
    }
  }
  for (const [name, value] of Object.entries(config.server.env ?? {})) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new Error("server.env contains an invalid environment variable name");
    }
    if (value !== undefined && (typeof value !== "string" || value.includes("\x00"))) {
      throw new Error(`server.env ${name} must be a string without null bytes`);
    }
  }
  const readinessPath = config.server.readinessPath ?? "/";
  validateReadinessPath(readinessPath);
  const entryPath = config.entryPath ?? "/";
  validateEntryPath(entryPath);
  const targetQuery = validateTargetQuery(config.targetQuery ?? {});
  const viewport = validateViewport(config.viewport);
  const explorationPolicy = validateExplorationPolicy(config.explorationPolicy);
  const artifactPolicy = validateArtifactPolicy(config.artifactPolicy);
  const bombadilToolchain = validateBombadilToolchainConfig(config.bombadilToolchain, repositoryRoot);
  const startupTimeoutMs = config.server.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > MAX_STARTUP_TIMEOUT_MS) {
    throw new Error(`server.startupTimeoutMs must be an integer between 1000 and ${String(MAX_STARTUP_TIMEOUT_MS)}`);
  }
  const baseUrl = requireLocalRootHttpOrigin(baseUrlOverride ?? config.baseUrl);
  const port = new URL(baseUrl).port;
  return {
    ...config,
    artifactPolicy,
    repositoryRoot,
    specificationPath,
    baseUrl,
    artifactRoot: join2(repositoryRoot, "artifacts", "direct-bombadil", config.artifactName),
    bombadilExecutable: bombadilToolchain?.executablePath ?? bombadilNativeBinary(repositoryRoot),
    bombadilToolchain,
    entryPath,
    explorationPolicy,
    port,
    targetQuery,
    viewport,
    server: {
      ...config.server,
      cwd: serverCwd,
      readinessPath,
      startupTimeoutMs
    }
  };
}
function resolveReplayPath(repositoryRoot, replayPath) {
  if (replayPath === null)
    return null;
  const resolved = resolve(repositoryRoot, replayPath);
  if (!isWithin(repositoryRoot, resolved) || !resolved.endsWith(".jsonl")) {
    throw new Error("--replay must name a .jsonl trace inside repositoryRoot");
  }
  return resolved;
}
function createDirectBombadilInvocation(options) {
  const viewport = validateViewport(options.viewport);
  const target = new URL(options.entryPath ?? "/", `${options.baseUrl}/`);
  target.searchParams.set(SCENARIO_QUERY_KEY2, options.scenario);
  for (const [name, value] of Object.entries(options.targetQuery ?? {})) {
    target.searchParams.set(name, value);
  }
  const command = [
    options.bombadilExecutable,
    "browser",
    "test",
    target.href,
    options.specificationPath,
    "--output-path",
    options.outputPath,
    "--headless",
    "--instrument-javascript=",
    "--width",
    String(viewport.width),
    "--height",
    String(viewport.height),
    "--device-scale-factor",
    String(viewport.deviceScaleFactor)
  ];
  if (options.replayPath === null) {
    command.push("--exit-on-violation", "--time-limit", `${String(options.timeLimitSeconds)}s`);
  } else {
    command.push("--reproduce", options.replayPath);
  }
  return {
    command,
    cwd: options.repositoryRoot,
    outputPath: options.outputPath,
    targetUrl: target.href,
    wallClockTimeoutMs: options.replayPath === null ? options.timeLimitSeconds * 1000 + RANDOM_RUN_OVERHEAD_MS : REPLAY_WALL_CLOCK_TIMEOUT_MS
  };
}
function bombadilChildEnvironment() {
  return Object.fromEntries(Object.entries({
    ...process2.env,
    NO_COLOR: "1"
  }).filter(([name]) => !BOMBADIL_PRIVATE_ENVIRONMENT_NAMES.has(name)));
}
async function readBoundedProcessStream(stream, maximumBytes, label) {
  const reader = stream.getReader();
  const decoder = new TextDecoder;
  let bytes = 0;
  let output = "";
  for (;; ) {
    const chunk = await reader.read();
    if (chunk.done)
      return `${output}${decoder.decode()}`;
    bytes += chunk.value.byteLength;
    if (bytes > maximumBytes) {
      reader.cancel().catch(() => {
        return;
      });
      throw new Error(`${label} exceeded ${String(maximumBytes)} bytes`);
    }
    output += decoder.decode(chunk.value, { stream: true });
  }
}
function captureStream(stream, maximumLength = LOG_LIMIT) {
  let stopCapture;
  const stopped = new Promise((resolveStopped) => {
    stopCapture = resolveStopped;
  });
  const result = (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder;
    let output = "";
    for (;; ) {
      const next = await Promise.race([
        reader.read().then((chunk) => ({ kind: "chunk", chunk }), (error) => ({ kind: "error", error })),
        stopped.then(() => ({ kind: "stopped" }))
      ]);
      if (next.kind === "stopped") {
        reader.cancel().catch(() => {
          return;
        });
        return tail(`${output}${decoder.decode()}`, maximumLength);
      }
      if (next.kind === "error")
        throw next.error;
      if (next.chunk.done)
        return tail(`${output}${decoder.decode()}`, maximumLength);
      output = tail(`${output}${decoder.decode(next.chunk.value, { stream: true })}`, maximumLength);
    }
  })();
  return { result, stop: stopCapture };
}
async function signalProcessGroup(process_, signal, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;; ) {
    try {
      process2.kill(-process_.pid, signal);
      return;
    } catch (error) {
      if (isRecord2(error) && error.code === "ESRCH") {
        if (process_.exitCode === null)
          process_.kill(signal);
        return;
      }
      if (!isRecord2(error) || error.code !== "EPERM" || Date.now() >= deadline) {
        throw error;
      }
      await Bun.sleep(Math.min(10, Math.max(1, deadline - Date.now())));
    }
  }
}
function processGroupMayExist(processId) {
  try {
    process2.kill(-processId, 0);
    return true;
  } catch (error) {
    if (isRecord2(error) && error.code === "ESRCH")
      return false;
    if (isRecord2(error) && error.code === "EPERM")
      return true;
    throw error;
  }
}
async function waitForProcessGroupExit(processId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupMayExist(processId)) {
    if (Date.now() >= deadline) {
      throw new Error(`Bombadil process group ${String(processId)} survived cleanup`);
    }
    await Bun.sleep(Math.min(25, Math.max(1, deadline - Date.now())));
  }
}
async function waitForBombadilLeaderExit(process_, timeoutMs) {
  if (process_.exitCode !== null)
    return;
  const exited = await Promise.race([
    process_.exited.then(() => true),
    Bun.sleep(timeoutMs).then(() => false)
  ]);
  if (!exited && process_.exitCode === null) {
    throw new Error(`Bombadil process ${String(process_.pid)} survived cleanup`);
  }
}
async function settleBombadilProcessGroup(options) {
  try {
    await signalProcessGroup(options.process, "SIGKILL", options.timeoutMs);
    await waitForBombadilLeaderExit(options.process, options.timeoutMs);
    await waitForProcessGroupExit(options.process.pid, options.timeoutMs);
  } catch (error) {
    throw new BombadilWriterSettlementError(`Bombadil process group ${String(options.process.pid)} did not settle safely`, error);
  }
}
async function readExactBombadilExecutableVersion(executablePath, repositoryRoot, expectedAttestation, options = {}) {
  const maximumOutputBytes = options.maximumOutputBytes ?? BOMBADIL_VERSION_OUTPUT_LIMIT;
  const timeoutMs = options.timeoutMs ?? BOMBADIL_VERSION_PROBE_TIMEOUT_MS;
  const probeAttestation = await attestBombadilExecutable(executablePath);
  assertSameBombadilExecutableAttestation(expectedAttestation, probeAttestation);
  const process_ = Bun.spawn([executablePath, "--version"], {
    cwd: repositoryRoot,
    detached: true,
    env: bombadilChildEnvironment(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  const output = Promise.all([
    readBoundedProcessStream(process_.stdout, maximumOutputBytes, "Bombadil --version stdout"),
    readBoundedProcessStream(process_.stderr, maximumOutputBytes, "Bombadil --version stderr")
  ]);
  let timeout;
  try {
    const timeoutPromise = new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs);
    });
    const outcome = await Promise.race([
      Promise.all([process_.exited, output]).then(([exitCode, streams]) => ({
        exitCode,
        kind: "exited",
        stderr: streams[1],
        stdout: streams[0]
      })),
      timeoutPromise
    ]);
    if (outcome.kind === "timeout") {
      throw new Error(`Bombadil --version exceeded its ${String(timeoutMs)}ms wall-clock limit`);
    }
    if (outcome.exitCode !== 0) {
      throw new Error(`Bombadil --version exited with status ${String(outcome.exitCode)}`);
    }
    if (outcome.stderr !== "") {
      throw new Error("Bombadil --version wrote unexpected stderr");
    }
    if (!/^bombadil 0\.7\.2(?:\r?\n)?$/u.test(outcome.stdout)) {
      throw new Error(`Bombadil executable must report exactly bombadil ${EXPECTED_BOMBADIL_VERSION}`);
    }
    return EXPECTED_BOMBADIL_VERSION;
  } finally {
    if (timeout !== undefined)
      clearTimeout(timeout);
    await settleBombadilProcessGroup({
      process: process_,
      timeoutMs: PROCESS_TERMINATION_GRACE_MS
    });
  }
}
async function establishCleanBombadilArtifactBaseline(options) {
  let baseline;
  try {
    await options.beforeInspect?.();
    baseline = await scanBombadilArtifactTree({
      hashFiles: false,
      policy: options.policy,
      root: options.outputPath,
      rootMayBeAbsent: true
    });
  } catch (error) {
    throw new BombadilArtifactPolicyError(`Bombadil output must be absent or empty before the live artifact epoch: ${renderUnknown(error)}`);
  }
  if (baseline.entryCount !== 0) {
    throw new BombadilArtifactPolicyError("Bombadil output must be absent or empty before the live artifact epoch");
  }
}
async function monitorBombadilArtifactTree(options) {
  let state = {
    pendingCompletions: new Map,
    provenance: new Map
  };
  while (!options.abortSignal.aborted) {
    try {
      state = await scanLiveBombadilArtifactTree({
        abortSignal: options.abortSignal,
        cleanBaselineEstablished: true,
        outputPath: options.outputPath,
        pendingCompletions: state.pendingCompletions,
        policy: options.policy,
        previous: state.provenance
      });
    } catch (error) {
      if (error instanceof LiveChromeDownloadRenameRetry || isRecord2(error) && error.code === "ENOENT") {} else {
        throw error instanceof BombadilArtifactPolicyError ? error : new BombadilArtifactPolicyError("Bombadil artifact monitor could not inspect output");
      }
    }
    await Bun.sleep(ARTIFACT_MONITOR_INTERVAL_MS);
  }
  if (state.pendingCompletions.size > 0) {
    throw new BombadilArtifactPolicyError("Bombadil Chrome download completion was not proven before monitoring stopped");
  }
}
function abortedBombadilProcessResult() {
  return {
    exitCode: 137,
    stderr: "",
    stdout: "",
    termination: "aborted"
  };
}
function bombadilAbortRequested(signal) {
  return signal?.aborted === true;
}
async function runBombadilNativeProcessInternal(invocation, hooks = {}) {
  const artifactPolicy = validateArtifactPolicy(invocation.artifactPolicy);
  if (bombadilAbortRequested(invocation.abortSignal)) {
    return abortedBombadilProcessResult();
  }
  const expectedExecutableAttestation = invocation[BOMBADIL_EXECUTABLE_ATTESTATION] ?? await attestBombadilExecutable(invocation.command[0] ?? "");
  await establishCleanBombadilArtifactBaseline({
    ...hooks.beforeArtifactBaselineInspect === undefined ? {} : { beforeInspect: hooks.beforeArtifactBaselineInspect },
    outputPath: invocation.outputPath,
    policy: artifactPolicy
  });
  if (bombadilAbortRequested(invocation.abortSignal)) {
    return abortedBombadilProcessResult();
  }
  const childEnvironment = bombadilChildEnvironment();
  const spawnAttestation = await attestBombadilExecutable(invocation.command[0] ?? "");
  assertSameBombadilExecutableAttestation(expectedExecutableAttestation, spawnAttestation);
  if (hooks.afterFinalExecutableAttestation !== undefined) {
    await hooks.afterFinalExecutableAttestation();
  }
  if (bombadilAbortRequested(invocation.abortSignal)) {
    return abortedBombadilProcessResult();
  }
  const process_ = Bun.spawn([...invocation.command], {
    cwd: invocation.cwd,
    detached: true,
    env: childEnvironment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  let timeout;
  let abortListener;
  const monitorAbortController = new AbortController;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout("timeout"), invocation.wallClockTimeoutMs);
  });
  const abortPromise = new Promise((resolveAbort) => {
    if (invocation.abortSignal === undefined)
      return;
    if (invocation.abortSignal.aborted) {
      resolveAbort("aborted");
      return;
    }
    abortListener = () => resolveAbort("aborted");
    invocation.abortSignal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const stdoutCapture = captureStream(process_.stdout);
    const stderrCapture = captureStream(process_.stderr);
    const outputPromise = Promise.all([stdoutCapture.result, stderrCapture.result]);
    const artifactMonitor = monitorBombadilArtifactTree({
      abortSignal: monitorAbortController.signal,
      outputPath: invocation.outputPath,
      policy: artifactPolicy
    }).then(() => ({ kind: "monitor-stopped" }), (error) => ({ kind: "artifact-policy", error }));
    const outcome = await Promise.race([
      process_.exited.then((exitCode) => ({ kind: "exited", exitCode })),
      timeoutPromise.then(() => ({ kind: "timeout" })),
      abortPromise.then(() => ({ kind: "aborted" })),
      artifactMonitor
    ]);
    if (outcome.kind === "monitor-stopped") {
      throw new BombadilArtifactPolicyError("Bombadil artifact monitor stopped unexpectedly");
    }
    const terminationGraceMs = invocation.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS;
    try {
      await settleBombadilProcessGroup({
        process: process_,
        timeoutMs: terminationGraceMs
      });
    } catch (error) {
      stdoutCapture.stop();
      stderrCapture.stop();
      throw error;
    }
    let finalArtifactFailure = null;
    try {
      await scanBombadilArtifactTree({
        hashFiles: false,
        policy: artifactPolicy,
        root: invocation.outputPath,
        rootMayBeAbsent: true
      });
    } catch (error) {
      finalArtifactFailure = error instanceof BombadilArtifactPolicyError ? error : new BombadilArtifactPolicyError(`Bombadil final artifact inventory could not be proven safe: ${renderUnknown(error)}`);
    }
    monitorAbortController.abort();
    const finalMonitorOutcome = await artifactMonitor;
    const outputSettled = await Promise.race([
      outputPromise.then(() => true, () => true),
      Bun.sleep(Math.max(terminationGraceMs, MIN_PROCESS_OUTPUT_DRAIN_MS)).then(() => false)
    ]);
    if (!outputSettled) {
      stdoutCapture.stop();
      stderrCapture.stop();
    }
    const [stdout, stderr] = await outputPromise;
    if (outcome.kind === "artifact-policy") {
      throw outcome.error instanceof BombadilArtifactPolicyError ? outcome.error : new BombadilArtifactPolicyError("Bombadil artifact policy was violated");
    }
    if (finalMonitorOutcome.kind === "artifact-policy") {
      throw finalMonitorOutcome.error instanceof BombadilArtifactPolicyError ? finalMonitorOutcome.error : new BombadilArtifactPolicyError("Bombadil artifact policy was violated");
    }
    if (finalArtifactFailure !== null) {
      throw finalArtifactFailure instanceof BombadilArtifactPolicyError ? finalArtifactFailure : new BombadilArtifactPolicyError("Bombadil artifact policy was violated");
    }
    return {
      exitCode: outcome.kind === "exited" ? outcome.exitCode : process_.exitCode ?? 137,
      stderr,
      stdout,
      termination: outcome.kind === "exited" ? null : outcome.kind
    };
  } finally {
    monitorAbortController.abort();
    if (timeout !== undefined)
      clearTimeout(timeout);
    if (abortListener !== undefined) {
      invocation.abortSignal?.removeEventListener("abort", abortListener);
    }
  }
}
async function runBombadilNativeProcess(invocation) {
  return await runBombadilNativeProcessInternal(invocation);
}
var processEvents = process2;
var defaultDependencies = {
  acquireServer: acquireVerificationServer,
  createAbortController: () => new AbortController,
  createRunId: randomUUID2,
  now: () => new Date,
  readBombadilVersion: readExactBombadilVersion,
  runBombadil: runBombadilNativeProcess,
  signalController: {
    forward: (signal) => process2.kill(process2.pid, signal),
    once: (signal, listener) => processEvents.once(signal, listener),
    removeListener: (signal, listener) => processEvents.removeListener(signal, listener)
  },
  serverOutputTimeoutMs: SERVER_OUTPUT_TIMEOUT_MS,
  spawnServer: spawnVerificationServer,
  stopServer: stopVerificationServer
};
async function readServerOutputBounded(server, timeoutMs) {
  let timeout;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timeout = setTimeout(() => resolveTimeout({ kind: "timeout" }), timeoutMs);
  });
  try {
    const outcome = await Promise.race([
      server.output.then((output) => ({ kind: "output", output }), (error) => ({ kind: "error", error })),
      timeoutPromise
    ]);
    if (outcome.kind === "timeout") {
      throw new Error(`Verification server output did not settle within ${String(timeoutMs)}ms after cleanup`);
    }
    if (outcome.kind === "error") {
      throw outcome.error instanceof Error ? outcome.error : new Error(renderUnknown(outcome.error));
    }
    return tail(outcome.output, LOG_LIMIT);
  } finally {
    if (timeout !== undefined)
      clearTimeout(timeout);
  }
}
async function requireRegularFile(path, label) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error(`${label} does not exist at its configured path`);
  }
  if (!metadata.isFile())
    throw new Error(`${label} must be a regular file`);
}
async function resolveBombadilExecutablePath(candidate, repositoryRoot) {
  if (!isAbsolute(candidate) || resolve(candidate) !== candidate || !isWithin(repositoryRoot, candidate)) {
    throw new Error("The root Bombadil executable must be an absolute normalized path inside repositoryRoot");
  }
  let metadata;
  try {
    metadata = await lstat(candidate);
  } catch {
    throw new Error("The root Bombadil executable does not exist at its configured path");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("The root Bombadil executable must be a regular nonsymlink file");
  }
  if ((metadata.mode & 73) === 0) {
    throw new Error("The root Bombadil executable must have an executable mode bit");
  }
  const resolved = await resolveExistingRealPath(candidate, "The root Bombadil executable");
  if (resolved !== candidate || !isWithin(repositoryRoot, resolved)) {
    throw new Error("The root Bombadil executable must not traverse a symlink or escape repositoryRoot");
  }
  return resolved;
}
function sameBombadilExecutableIdentity(first, second) {
  return first.dev === second.dev && first.ino === second.ino && first.nlink === second.nlink && first.mode === second.mode && first.size === second.size && first.mtimeNs === second.mtimeNs && first.ctimeNs === second.ctimeNs;
}
async function attestBombadilExecutable(path, options = {}) {
  let lexical;
  try {
    lexical = await lstat(path, { bigint: true });
  } catch {
    throw new Error("The root Bombadil executable does not exist at its configured path");
  }
  if (lexical.isSymbolicLink() || !lexical.isFile()) {
    throw new Error("The root Bombadil executable must be a regular nonsymlink file");
  }
  if ((lexical.mode & 0o111n) === 0n) {
    throw new Error("The root Bombadil executable must have an executable mode bit");
  }
  if (lexical.size > BigInt(MAX_BOMBADIL_EXECUTABLE_BYTES)) {
    throw new Error(`The root Bombadil executable exceeds the ${String(MAX_BOMBADIL_EXECUTABLE_BYTES)}-byte attestation limit`);
  }
  const handle = await open(path, fileSystemConstants.O_RDONLY | fileSystemConstants.O_NOFOLLOW);
  let snapshotHandle = null;
  try {
    if (options.snapshotPath !== undefined) {
      snapshotHandle = await open(options.snapshotPath, fileSystemConstants.O_WRONLY | fileSystemConstants.O_CREAT | fileSystemConstants.O_EXCL | fileSystemConstants.O_NOFOLLOW, 384);
    }
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameBombadilExecutableIdentity(lexical, before)) {
      throw new Error("The root Bombadil executable changed during attestation");
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    const size = Number(before.size);
    while (position < size) {
      const length = Math.min(buffer.byteLength, size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0) {
        throw new Error("The root Bombadil executable changed during attestation");
      }
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (snapshotHandle !== null) {
        let written = 0;
        while (written < bytesRead) {
          const result = await snapshotHandle.write(bytes, written, bytesRead - written, position + written);
          if (result.bytesWritten <= 0) {
            throw new Error("The private Bombadil executable snapshot write made no progress");
          }
          written += result.bytesWritten;
        }
      }
      position += bytesRead;
    }
    if (snapshotHandle !== null) {
      await snapshotHandle.chmod(320);
      await snapshotHandle.sync();
    }
    const after = await handle.stat({ bigint: true });
    if (!sameBombadilExecutableIdentity(before, after)) {
      throw new Error("The root Bombadil executable changed during attestation");
    }
    const finalLexical = await lstat(path, { bigint: true });
    if (!sameBombadilExecutableIdentity(after, finalLexical)) {
      throw new Error("The root Bombadil executable changed during attestation");
    }
    return Object.freeze({
      device: after.dev,
      inode: after.ino,
      linkCount: after.nlink,
      mode: after.mode,
      sha256: hash.digest("hex"),
      size
    });
  } finally {
    try {
      await snapshotHandle?.close();
    } finally {
      await handle.close();
    }
  }
}
async function removePrivateBombadilExecutableSnapshot(snapshot) {
  if (snapshot.attestation.linkCount !== 1n) {
    throw new Error("The private Bombadil executable snapshot file identity is not exclusive");
  }
  const directory = await openPrivateBombadilSnapshotDirectory(snapshot);
  let madeWritable = false;
  let directoryRemoved = false;
  try {
    await requireSamePrivateBombadilSnapshotExecutable(snapshot);
    await directory.chmod(448);
    madeWritable = true;
    await requireSameOpenPrivateBombadilSnapshotDirectory(directory, snapshot, 0o700n);
    await requireSamePrivateBombadilSnapshotExecutable(snapshot);
    await requireSameOpenPrivateBombadilSnapshotDirectory(directory, snapshot, 0o700n);
    await requireSameLexicalPrivateBombadilSnapshotExecutable(snapshot);
    await unlink(snapshot.executablePath);
    await requireMissingPrivateBombadilSnapshotPath(snapshot.executablePath, "executable");
    await requireSameOpenPrivateBombadilSnapshotDirectory(directory, snapshot, 0o700n);
    await rmdir(snapshot.directoryPath);
    directoryRemoved = true;
    await requireMissingPrivateBombadilSnapshotPath(snapshot.directoryPath, "directory");
  } catch (error) {
    if (madeWritable && !directoryRemoved) {
      try {
        const descriptor = await directory.stat({ bigint: true });
        if (descriptor.isDirectory() && descriptor.dev === snapshot.directoryIdentity.device && descriptor.ino === snapshot.directoryIdentity.inode) {
          await directory.chmod(Number(snapshot.directoryIdentity.mode & 0o777n));
        }
      } catch (resealError) {
        throw new AggregateError([error, resealError], "Bombadil snapshot cleanup failed and its exact directory could not be resealed", { cause: error });
      }
    }
    throw error;
  } finally {
    await directory.close();
  }
}
function sameBombadilSnapshotDirectoryIdentity(metadata, identity, permissions = identity.mode & 0o777n) {
  const expectedMode = identity.mode & ~0o777n | permissions;
  return metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.dev === identity.device && metadata.ino === identity.inode && metadata.mode === expectedMode;
}
async function readPrivateBombadilSnapshotDirectoryIdentity(path) {
  const metadata = await lstat(path, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("The private Bombadil executable snapshot path is not a nonsymlink directory");
  }
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode
  });
}
async function openPrivateBombadilSnapshotDirectory(snapshot) {
  const lexical = await lstat(snapshot.directoryPath, { bigint: true });
  if (!sameBombadilSnapshotDirectoryIdentity(lexical, snapshot.directoryIdentity)) {
    throw new Error("The private Bombadil executable snapshot directory identity changed");
  }
  const directory = await open(snapshot.directoryPath, fileSystemConstants.O_RDONLY | fileSystemConstants.O_DIRECTORY | fileSystemConstants.O_NOFOLLOW);
  try {
    const descriptor = await directory.stat({ bigint: true });
    if (!sameBombadilSnapshotDirectoryIdentity(descriptor, snapshot.directoryIdentity)) {
      throw new Error("The private Bombadil executable snapshot directory identity changed");
    }
    return directory;
  } catch (error) {
    await directory.close();
    throw error;
  }
}
async function requireSameOpenPrivateBombadilSnapshotDirectory(directory, snapshot, permissions) {
  const descriptor = await directory.stat({ bigint: true });
  const lexical = await lstat(snapshot.directoryPath, { bigint: true });
  if (!sameBombadilSnapshotDirectoryIdentity(descriptor, snapshot.directoryIdentity, permissions) || !sameBombadilSnapshotDirectoryIdentity(lexical, snapshot.directoryIdentity, permissions)) {
    throw new Error("The private Bombadil executable snapshot directory identity changed");
  }
}
async function requireSamePrivateBombadilSnapshotExecutable(snapshot) {
  const attestation = await attestBombadilExecutable(snapshot.executablePath);
  if (attestation.device !== snapshot.attestation.device || attestation.inode !== snapshot.attestation.inode || attestation.linkCount !== snapshot.attestation.linkCount || attestation.mode !== snapshot.attestation.mode || attestation.size !== snapshot.attestation.size || attestation.sha256 !== snapshot.attestation.sha256) {
    throw new Error("The private Bombadil executable snapshot file identity changed");
  }
}
async function requireSameLexicalPrivateBombadilSnapshotExecutable(snapshot) {
  const metadata = await lstat(snapshot.executablePath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.dev !== snapshot.attestation.device || metadata.ino !== snapshot.attestation.inode || metadata.nlink !== snapshot.attestation.linkCount || metadata.mode !== snapshot.attestation.mode || metadata.size !== BigInt(snapshot.attestation.size)) {
    throw new Error("The private Bombadil executable snapshot file identity changed");
  }
}
async function requireMissingPrivateBombadilSnapshotPath(path, label) {
  try {
    await lstat(path);
  } catch (error) {
    if (isRecord2(error) && error.code === "ENOENT")
      return;
    throw error;
  }
  throw new Error(`The private Bombadil executable snapshot ${label} survived cleanup`);
}
async function sealPartialPrivateBombadilSnapshotForRetention(snapshot) {
  const directory = await openPrivateBombadilSnapshotDirectory(snapshot);
  try {
    await directory.chmod(320);
    await requireSameOpenPrivateBombadilSnapshotDirectory(directory, snapshot, 0o500n);
  } finally {
    await directory.close();
  }
}
async function materializePrivateBombadilExecutableSnapshot(options) {
  await createExclusiveDirectory(options.directoryPath, "Private Bombadil executable snapshot directory");
  const executablePath = join2(options.directoryPath, "bombadil");
  let initialDirectoryIdentity = null;
  let cleanupSnapshot = null;
  try {
    initialDirectoryIdentity = await readPrivateBombadilSnapshotDirectoryIdentity(options.directoryPath);
    const sourceAttestation = await attestBombadilExecutable(options.sourcePath, {
      snapshotPath: executablePath
    });
    const attestation = await attestBombadilExecutable(executablePath);
    cleanupSnapshot = Object.freeze({
      attestation,
      directoryIdentity: initialDirectoryIdentity,
      directoryPath: options.directoryPath,
      executablePath,
      sourceAttestation
    });
    if (sourceAttestation.sha256 !== attestation.sha256 || sourceAttestation.size !== attestation.size) {
      throw new Error("The private Bombadil executable snapshot does not match reviewed bytes");
    }
    if (sourceAttestation.device === attestation.device && sourceAttestation.inode === attestation.inode) {
      throw new Error("The private Bombadil executable snapshot must own a distinct file identity");
    }
    if ((attestation.mode & 0o777n) !== 0o500n) {
      throw new Error("The private Bombadil executable snapshot must be owner-read-execute only");
    }
    if (attestation.linkCount !== 1n) {
      throw new Error("The private Bombadil executable snapshot must have exactly one hard link");
    }
    const directory = await openPrivateBombadilSnapshotDirectory(cleanupSnapshot);
    let directoryIdentity;
    try {
      await directory.chmod(320);
      const descriptor = await directory.stat({ bigint: true });
      const lexical = await lstat(options.directoryPath, { bigint: true });
      if (!sameBombadilSnapshotDirectoryIdentity(descriptor, initialDirectoryIdentity, 0o500n) || !sameBombadilSnapshotDirectoryIdentity(lexical, initialDirectoryIdentity, 0o500n)) {
        throw new Error("The private Bombadil executable snapshot directory is not sealed");
      }
      directoryIdentity = Object.freeze({
        device: descriptor.dev,
        inode: descriptor.ino,
        mode: descriptor.mode
      });
    } finally {
      await directory.close();
    }
    return Object.freeze({
      attestation,
      directoryIdentity,
      directoryPath: options.directoryPath,
      executablePath,
      sourceAttestation
    });
  } catch (error) {
    if (cleanupSnapshot !== null) {
      try {
        await removePrivateBombadilExecutableSnapshot(cleanupSnapshot);
      } catch (cleanupError) {
        throw new BombadilPersistenceError("Bombadil executable snapshot materialization and cleanup both failed", [error, cleanupError]);
      }
    } else if (initialDirectoryIdentity !== null) {
      try {
        await sealPartialPrivateBombadilSnapshotForRetention({
          directoryIdentity: initialDirectoryIdentity,
          directoryPath: options.directoryPath
        });
      } catch (retentionError) {
        throw new BombadilPersistenceError("Bombadil snapshot materialization failed and its exact partial evidence could not be sealed", [error, retentionError]);
      }
      throw new BombadilPersistenceError("Bombadil snapshot materialization failed; its exact partial snapshot was retained as protected persistence evidence", [error]);
    }
    throw error;
  }
}
function validateBombadilExecutableAttestation(attestation, toolchain, observedVersion) {
  assertBombadilExecutableAttestationMatchesToolchain(attestation, toolchain);
  return Object.freeze(toolchain === null ? {
    buildContract: null,
    kind: "npm-package",
    sha256: attestation.sha256,
    sourceRevision: null,
    version: observedVersion
  } : {
    buildContract: toolchain.buildContract,
    kind: "reviewed-override",
    sha256: attestation.sha256,
    sourceRevision: toolchain.sourceRevision,
    version: observedVersion
  });
}
function assertBombadilExecutableAttestationMatchesToolchain(attestation, toolchain) {
  if (toolchain !== null && attestation.sha256 !== toolchain.sha256) {
    throw new Error("The root Bombadil executable SHA-256 does not match bombadilToolchain.sha256");
  }
}
function assertSameBombadilExecutableAttestation(before, after) {
  if (before.device !== after.device || before.inode !== after.inode || before.linkCount !== after.linkCount || before.mode !== after.mode || before.size !== after.size || before.sha256 !== after.sha256) {
    throw new Error("The root Bombadil executable changed before native process startup");
  }
}
async function requireDirectory(path, label) {
  let metadata;
  try {
    metadata = await stat(path);
  } catch {
    throw new Error(`${label} does not exist at its configured path`);
  }
  if (!metadata.isDirectory())
    throw new Error(`${label} must be a directory`);
}
async function resolveExistingRealPath(path, label) {
  try {
    return await realpath(path);
  } catch {
    throw new Error(`${label} does not exist at its configured path`);
  }
}
async function resolveConfinedRealPath(options) {
  const resolved = await resolveExistingRealPath(options.candidate, options.label);
  if (!isWithin(options.repositoryRoot, resolved)) {
    throw new Error(`${options.label} resolves outside repositoryRoot`);
  }
  if (options.kind === "directory") {
    await requireDirectory(resolved, options.label);
  } else {
    await requireRegularFile(resolved, options.label);
  }
  return resolved;
}
async function resolveDirectBombadilRealPaths(config, replayPath) {
  const repositoryRoot = await resolveExistingRealPath(config.repositoryRoot, "repositoryRoot");
  await requireDirectory(repositoryRoot, "repositoryRoot");
  const specificationPath = await resolveConfinedRealPath({
    candidate: config.specificationPath,
    kind: "file",
    label: "specificationPath",
    repositoryRoot
  });
  if (!/\.[cm]?[jt]sx?$/u.test(specificationPath)) {
    throw new Error("specificationPath must resolve to a JavaScript or TypeScript file");
  }
  const serverCwd = await resolveConfinedRealPath({
    candidate: config.server.cwd,
    kind: "directory",
    label: "server.cwd",
    repositoryRoot
  });
  const resolvedReplayPath = replayPath === null ? null : await resolveConfinedRealPath({
    candidate: replayPath,
    kind: "file",
    label: "--replay",
    repositoryRoot
  });
  if (resolvedReplayPath !== null && !resolvedReplayPath.endsWith(".jsonl")) {
    throw new Error("--replay must resolve to a .jsonl trace inside repositoryRoot");
  }
  const bombadilExecutable = config.bombadilToolchain === null ? bombadilNativeBinary(repositoryRoot) : await resolveBombadilExecutablePath(config.bombadilToolchain.executablePath, repositoryRoot);
  return {
    config: {
      ...config,
      repositoryRoot,
      specificationPath,
      artifactRoot: join2(repositoryRoot, "artifacts", "direct-bombadil", config.artifactName),
      bombadilExecutable,
      server: { ...config.server, cwd: serverCwd }
    },
    replayPath: resolvedReplayPath
  };
}
async function readExactBombadilVersion(repositoryRoot, toolchain, executablePath, expectedExecutableAttestation) {
  const packagePath = join2(repositoryRoot, "node_modules", "@antithesishq", "bombadil", "package.json");
  let input;
  try {
    input = JSON.parse(await readFile(packagePath, "utf8"));
  } catch {
    throw new Error("The root Bombadil package metadata is missing or malformed");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input) || Reflect.get(input, "version") !== EXPECTED_BOMBADIL_VERSION) {
    throw new Error(`The root Bombadil package must be exactly ${EXPECTED_BOMBADIL_VERSION}`);
  }
  if (toolchain !== null) {
    return await readExactBombadilExecutableVersion(executablePath, repositoryRoot, expectedExecutableAttestation);
  }
  return EXPECTED_BOMBADIL_VERSION;
}
function helpText(defaultBaseUrl) {
  return [
    "Usage: bun fuzz-browser.ts [options]",
    "",
    `  --base-url <url>    Local server root (default: ${defaultBaseUrl})`,
    `  --time-limit <Ns>   Random exploration limit, 12-300s (default: ${String(DEFAULT_TIME_LIMIT_SECONDS)}s)`,
    "  --replay <trace>    Reproduce a repository-local trace.jsonl",
    "  -h, --help          Show this help"
  ].join(`
`);
}
function parseMatrixCampaignArgument(arguments_) {
  const forwarded = [];
  let campaignId = null;
  let help = false;
  for (let index = 0;index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined)
      continue;
    if (argument === "--help" || argument === "-h")
      help = true;
    if (argument === "--campaign" || argument.startsWith("--campaign=")) {
      if (campaignId !== null)
        throw new Error("--campaign may be provided only once");
      if (argument === "--campaign") {
        const next = readOptionValue(arguments_, index, "--campaign");
        campaignId = next.value;
        index = next.index;
      } else {
        campaignId = argument.slice("--campaign=".length);
      }
      if (campaignId.length === 0)
        throw new Error("--campaign requires a value");
      continue;
    }
    forwarded.push(argument);
  }
  return { arguments: Object.freeze(forwarded), campaignId, help };
}
function validateCampaignMatrix(campaigns) {
  if (campaigns.length === 0 || campaigns.length > MAX_MATRIX_CAMPAIGNS) {
    throw new Error(`Bombadil campaign matrix must contain 1-${String(MAX_MATRIX_CAMPAIGNS)} campaigns`);
  }
  const ids = new Set;
  for (const campaign of campaigns) {
    if (!isBoundedArtifactIdentifier(campaign.id) || ids.has(campaign.id)) {
      throw new Error("Bombadil campaign IDs must be unique lowercase kebab identifiers");
    }
    ids.add(campaign.id);
  }
  return campaigns;
}
async function runDirectBombadilFuzzMatrix(campaignsInput, input = process2.argv.slice(2), dependencyOverrides = {}) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const normalizedOptions = normalizeFuzzRunOptions(input);
  if (normalizedOptions.arguments.some((argument) => argument === "--help" || argument === "-h")) {
    const campaigns = validateCampaignMatrix(campaignsInput);
    parseMatrixCampaignArgument(normalizedOptions.arguments);
    process2.stdout.write(`${[
      helpText(campaigns[0]?.config.baseUrl ?? ""),
      "  --campaign <id>   Run one campaign; required with --replay",
      "",
      `Campaigns: ${campaigns.map((campaign) => campaign.id).join(", ")}`
    ].join(`
`)}
`);
    return { kind: "help" };
  }
  const matrixAbortController = dependencies.createAbortController?.() ?? new AbortController;
  let interruptedSignal = null;
  const interrupt = (signal) => {
    interruptedSignal ??= signal;
    matrixAbortController.abort();
  };
  const processSignals = dependencies.signalController;
  for (const signal of PROCESS_INTERRUPT_SIGNALS)
    processSignals.once(signal, interrupt);
  const releaseSignalHandlers = () => {
    for (const signal of PROCESS_INTERRUPT_SIGNALS) {
      processSignals.removeListener(signal, interrupt);
    }
  };
  let invalidMatrixUploadMode;
  let matrixPlan;
  let uploadSession;
  try {
    const firstRepositoryRoot = campaignsInput[0]?.config.repositoryRoot;
    if (normalizedOptions.artifactRun === null && firstRepositoryRoot === undefined) {
      throw new Error(`Bombadil campaign matrix must contain 1-${String(MAX_MATRIX_CAMPAIGNS)} campaigns`);
    }
    const requestedMatrixPlan = normalizedOptions.artifactRun ?? {
      repositoryRoot: await realpath(resolve(firstRepositoryRoot ?? "")),
      runId: dependencies.createRunId(),
      uploadMode: "public-summary"
    };
    const requestedMatrixUploadMode = requestedMatrixPlan.uploadMode ?? "public-summary";
    invalidMatrixUploadMode = requestedMatrixUploadMode !== "public-summary";
    matrixPlan = {
      repositoryRoot: requestedMatrixPlan.repositoryRoot,
      runId: requestedMatrixPlan.runId,
      uploadMode: "public-summary"
    };
    uploadSession = await prepareArtifactUploadSession(matrixPlan);
  } catch (error) {
    releaseSignalHandlers();
    const signalToForward = interruptedSignal;
    if (signalToForward !== null)
      processSignals.forward(signalToForward);
    throw error;
  }
  try {
    let campaigns;
    let parsed;
    let selected;
    try {
      if (invalidMatrixUploadMode) {
        throw new Error("Bombadil matrices support public-summary uploads only");
      }
      campaigns = validateCampaignMatrix(campaignsInput);
      const toolchainIdentities = new Set(campaigns.map((campaign) => bombadilToolchainIdentity(validateBombadilToolchainConfig(campaign.config.bombadilToolchain, resolve(campaign.config.repositoryRoot)))));
      if (toolchainIdentities.size !== 1) {
        throw new Error("Every Bombadil matrix campaign must use the same toolchain identity");
      }
      parsed = parseMatrixCampaignArgument(normalizedOptions.arguments);
      selected = parsed.campaignId === null ? campaigns : campaigns.filter((campaign) => campaign.id === parsed.campaignId);
      if (selected.length === 0) {
        throw new Error(`Unknown Bombadil campaign ${parsed.campaignId ?? ""}`);
      }
      if (parsed.campaignId === null && parsed.arguments.some((argument) => argument === "--replay" || argument.startsWith("--replay="))) {
        throw new Error("--replay requires exactly one --campaign in matrix mode");
      }
      for (const campaign of selected) {
        if (interruptedSignal !== null)
          throw new Error("Bombadil matrix was interrupted");
        const campaignArguments = parseDirectBombadilFuzzArguments(parsed.arguments, campaign.config.baseUrl);
        if (campaignArguments.kind !== "run") {
          throw new Error("Bombadil matrix campaign unexpectedly entered help mode");
        }
        const lexicalConfig = validateDirectBombadilFuzzConfig(campaign.config, campaignArguments.baseUrl);
        const resolvedPaths = await resolveDirectBombadilRealPaths(lexicalConfig, resolveReplayPath(lexicalConfig.repositoryRoot, campaignArguments.replayPath));
        if (resolvedPaths.config.repositoryRoot !== matrixPlan.repositoryRoot) {
          throw new BombadilArtifactPolicyError("Every Bombadil matrix campaign must share artifactRun.repositoryRoot");
        }
      }
    } catch (error) {
      const boundedCampaigns = campaignsInput.slice(0, MAX_MATRIX_CAMPAIGNS);
      const retainedCampaignIds = new Set;
      const entries2 = boundedCampaigns.map((campaign, index) => {
        const boundedCampaignId = isBoundedArtifactIdentifier(campaign.id) ? campaign.id : null;
        const campaignId = boundedCampaignId !== null && !retainedCampaignIds.has(boundedCampaignId) ? boundedCampaignId : null;
        if (campaignId !== null)
          retainedCampaignIds.add(campaignId);
        return {
          campaignId,
          index,
          receipt: null,
          status: "rejected"
        };
      });
      return await publishFailureAndThrow(error, async () => {
        await publishMatrixUpload({
          abortSignal: matrixAbortController.signal,
          beforeCommitCheck: dependencies.beforeArtifactCommit,
          campaigns: entries2,
          children: [],
          completedAt: dependencies.now(),
          failure: error,
          failureCode: interruptedSignal === null ? "configuration-rejected" : "interrupted",
          interruptedSignal: () => interruptedSignal,
          omittedCampaignCount: Math.max(0, campaignsInput.length - entries2.length),
          session: uploadSession
        });
      });
    }
    const results = [];
    const entries = campaigns.map((campaign, index) => ({
      campaignId: campaign.id,
      index,
      receipt: null,
      status: selected.includes(campaign) ? "not-run" : "not-selected"
    }));
    const children = [];
    let executionFailure = null;
    let executionFailureCode;
    for (const campaign of selected) {
      if (interruptedSignal !== null) {
        executionFailure = new Error("Bombadil matrix was interrupted");
        break;
      }
      const campaignIndex = campaigns.indexOf(campaign);
      const deferredPayload = { value: null };
      const childSession = {
        deferredPayload,
        finalDirectory: join2(uploadSession.finalDirectory, "campaigns", campaign.id),
        mode: uploadSession.mode,
        publication: "deferred",
        receiptPath: join2(uploadSession.finalDirectory, "campaigns", campaign.id, "receipt.json"),
        runId: uploadSession.runId
      };
      try {
        const result = await runDirectBombadilFuzzInternal(campaign.config, parsed.arguments, dependencyOverrides, {
          abortSignal: matrixAbortController.signal,
          forwardSignal: false,
          interruptedSignal: () => interruptedSignal,
          plan: matrixPlan,
          session: childSession
        });
        if (result.kind !== "run" || deferredPayload.value === null) {
          throw new Error("Bombadil campaign did not finalize its sanitized receipt");
        }
        children.push({ campaignId: campaign.id, payload: deferredPayload.value });
        results.push({ campaignId: campaign.id, result });
        entries[campaignIndex] = {
          campaignId: campaign.id,
          index: campaignIndex,
          receipt: `campaigns/${campaign.id}/receipt.json`,
          status: "passed"
        };
      } catch (error) {
        executionFailure = error;
        const childPayload = deferredPayload.value;
        if (childPayload !== null) {
          children.push({ campaignId: campaign.id, payload: childPayload });
          executionFailureCode = childPayload.receipt.failureCode ?? undefined;
        }
        entries[campaignIndex] = {
          campaignId: campaign.id,
          index: campaignIndex,
          receipt: childPayload === null ? null : `campaigns/${campaign.id}/receipt.json`,
          status: childPayload?.receipt.status === "rejected" ? "rejected" : "failed"
        };
        break;
      }
    }
    if (executionFailure === null && interruptedSignal !== null) {
      executionFailure = new Error("Bombadil matrix was interrupted");
      executionFailureCode = "interrupted";
    }
    if (executionFailure !== null) {
      await publishFailureAndThrow(executionFailure, async () => {
        await publishMatrixUpload({
          abortSignal: matrixAbortController.signal,
          beforeCommitCheck: dependencies.beforeArtifactCommit,
          campaigns: entries,
          children,
          completedAt: dependencies.now(),
          failure: executionFailure,
          ...executionFailureCode === undefined ? {} : { failureCode: executionFailureCode },
          interruptedSignal: () => interruptedSignal,
          session: uploadSession
        });
      });
    }
    const published = await publishMatrixUpload({
      abortSignal: matrixAbortController.signal,
      beforeCommitCheck: dependencies.beforeArtifactCommit,
      campaigns: entries,
      children,
      completedAt: dependencies.now(),
      failure: null,
      interruptedSignal: () => interruptedSignal,
      session: uploadSession
    });
    if (published.failure !== null)
      throw failureAsError(published.failure);
    return {
      kind: "matrix",
      receiptPath: uploadSession.receiptPath,
      results: Object.freeze(results),
      uploadArtifactPath: uploadSession.finalDirectory
    };
  } finally {
    releaseSignalHandlers();
    const signalToForward = interruptedSignal;
    if (signalToForward !== null)
      processSignals.forward(signalToForward);
  }
}
function throwIfBombadilRunAborted(signal) {
  if (signal.aborted)
    throw new Error("Bombadil fuzzing was interrupted");
}
function terminateAbortedOwnedServer(signal, server) {
  if (!signal.aborted)
    return;
  if (server.exitCode() === null)
    server.terminate();
  throwIfBombadilRunAborted(signal);
}
async function runDirectBombadilFuzzInternal(config, input = process2.argv.slice(2), dependencyOverrides = {}, preparedUpload) {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const normalizedOptions = normalizeFuzzRunOptions(input);
  if (normalizedOptions.arguments.some((argument) => argument === "--help" || argument === "-h")) {
    parseDirectBombadilFuzzArguments(normalizedOptions.arguments, config.baseUrl);
    process2.stdout.write(`${helpText(config.baseUrl)}
`);
    return { kind: "help" };
  }
  const abortController = dependencies.createAbortController?.() ?? new AbortController;
  let interruptedSignal = null;
  let ownedServer = null;
  const interrupt = (signal) => {
    interruptedSignal ??= signal;
    abortController.abort();
    if (ownedServer?.exitCode() === null)
      ownedServer.terminate();
  };
  const processSignals = dependencies.signalController;
  for (const signal of PROCESS_INTERRUPT_SIGNALS)
    processSignals.once(signal, interrupt);
  const abortFromPreparedMatrix = () => {
    interruptedSignal ??= preparedUpload?.interruptedSignal?.() ?? null;
    abortController.abort();
    if (ownedServer?.exitCode() === null)
      ownedServer.terminate();
  };
  if (preparedUpload?.abortSignal !== undefined) {
    if (preparedUpload.abortSignal.aborted)
      abortFromPreparedMatrix();
    else
      preparedUpload.abortSignal.addEventListener("abort", abortFromPreparedMatrix, { once: true });
  }
  try {
    const generatedAt = dependencies.now();
    const artifactPlan = preparedUpload?.plan ?? normalizedOptions.artifactRun ?? {
      repositoryRoot: await realpath(resolve(config.repositoryRoot)),
      runId: dependencies.createRunId(),
      uploadMode: "public-summary"
    };
    const uploadSession = preparedUpload?.session ?? await prepareArtifactUploadSession(artifactPlan);
    let parsed;
    let validated;
    let replayPath;
    try {
      throwIfBombadilRunAborted(abortController.signal);
      const parsedInput = parseDirectBombadilFuzzArguments(normalizedOptions.arguments, config.baseUrl);
      if (parsedInput.kind !== "run") {
        throw new Error("Bombadil help was not handled before artifact allocation");
      }
      parsed = parsedInput;
      const lexicalConfig = validateDirectBombadilFuzzConfig(config, parsed.baseUrl);
      const lexicalReplayPath = resolveReplayPath(lexicalConfig.repositoryRoot, parsed.replayPath);
      const resolvedPaths = await resolveDirectBombadilRealPaths(lexicalConfig, lexicalReplayPath);
      validated = resolvedPaths.config;
      replayPath = resolvedPaths.replayPath;
      throwIfBombadilRunAborted(abortController.signal);
      if (validated.repositoryRoot !== resolve(artifactPlan.repositoryRoot)) {
        throw new BombadilArtifactPolicyError("artifactRun.repositoryRoot must equal the campaign repositoryRoot");
      }
    } catch (error) {
      const policy = (() => {
        try {
          return validateArtifactPolicy(config.artifactPolicy);
        } catch {
          return validateArtifactPolicy(undefined);
        }
      })();
      return await publishFailureAndThrow(error, async () => {
        await publishRunUpload({
          abortSignal: abortController.signal,
          artifactName: isBoundedArtifactIdentifier(config.artifactName) ? config.artifactName : "rejected",
          beforeCommitCheck: dependencies.beforeArtifactCommit,
          attestation: null,
          completedAt: dependencies.now(),
          explorationSummary: null,
          failure: error,
          failureCode: abortController.signal.aborted ? "interrupted" : "configuration-rejected",
          inventory: emptyArtifactInventory(),
          interruptedSignal: () => interruptedSignal,
          localOutputPath: config.repositoryRoot,
          policy,
          privateDiagnosticsAllowed: false,
          processLog: "",
          scenario: isBoundedScenarioIdentifier(config.scenario) ? config.scenario : "rejected",
          serverLog: "",
          session: uploadSession,
          status: abortController.signal.aborted ? "failed" : "rejected"
        });
      });
    }
    let artifactRun;
    try {
      throwIfBombadilRunAborted(abortController.signal);
      artifactRun = await createBombadilArtifactRun({
        artifactName: validated.artifactName,
        repositoryRoot: validated.repositoryRoot,
        runId: dependencies.createRunId()
      });
      throwIfBombadilRunAborted(abortController.signal);
    } catch (error) {
      return await publishFailureAndThrow(error, async () => {
        await publishRunUpload({
          abortSignal: abortController.signal,
          artifactName: validated.artifactName,
          beforeCommitCheck: dependencies.beforeArtifactCommit,
          attestation: null,
          completedAt: dependencies.now(),
          explorationSummary: null,
          failure: error,
          inventory: emptyArtifactInventory(),
          interruptedSignal: () => interruptedSignal,
          localOutputPath: validated.repositoryRoot,
          policy: validated.artifactPolicy,
          privateDiagnosticsAllowed: false,
          processLog: "",
          scenario: validated.scenario,
          serverLog: "",
          session: uploadSession,
          status: "failed"
        });
      });
    }
    const outputPath = join2(artifactRun.runDirectory, "bombadil");
    const tracePath = join2(outputPath, "trace.jsonl");
    const invocation = createDirectBombadilInvocation({
      baseUrl: validated.baseUrl,
      bombadilExecutable: validated.bombadilExecutable,
      entryPath: validated.entryPath,
      outputPath,
      replayPath,
      repositoryRoot: validated.repositoryRoot,
      scenario: validated.scenario,
      specificationPath: validated.specificationPath,
      targetQuery: validated.targetQuery,
      timeLimitSeconds: parsed.timeLimitSeconds,
      viewport: validated.viewport
    });
    const abortableInvocation = {
      ...invocation,
      abortSignal: abortController.signal,
      artifactPolicy: validated.artifactPolicy
    };
    const serverCommand = validated.server.command.map((argument) => argument === "{port}" ? validated.port : argument);
    let bombadilVersion = null;
    let bombadilExecutableAttestation = null;
    let bombadilRuntimeExecutableAttestation = null;
    let bombadilRuntimeExecutable = validated.bombadilExecutable;
    let bombadilExecutableSnapshot = null;
    let bombadilToolchainEvidence = null;
    let lease = null;
    let processResult = null;
    let attestation = null;
    let attestationFailure = null;
    let explorationSummary = null;
    let explorationSummaryFailure = null;
    let artifactInventory = emptyArtifactInventory();
    let artifactInventoryVetted = false;
    let rawTracePath = null;
    let serverOutput = "";
    let serverOutputFailure = null;
    let failure = null;
    let writersSettled = true;
    {
      try {
        if (validated.bombadilToolchain === null) {
          bombadilExecutableAttestation = await attestBombadilExecutable(validated.bombadilExecutable);
          bombadilRuntimeExecutableAttestation = bombadilExecutableAttestation;
        } else {
          bombadilExecutableSnapshot = await materializePrivateBombadilExecutableSnapshot({
            directoryPath: join2(artifactRun.runDirectory, ".bombadil-toolchain"),
            sourcePath: validated.bombadilExecutable
          });
          bombadilExecutableAttestation = bombadilExecutableSnapshot.sourceAttestation;
          bombadilRuntimeExecutableAttestation = bombadilExecutableSnapshot.attestation;
          bombadilRuntimeExecutable = bombadilExecutableSnapshot.executablePath;
        }
        assertBombadilExecutableAttestationMatchesToolchain(bombadilExecutableAttestation, validated.bombadilToolchain);
        bombadilVersion = await dependencies.readBombadilVersion(validated.repositoryRoot, validated.bombadilToolchain, bombadilRuntimeExecutable, bombadilRuntimeExecutableAttestation);
        bombadilToolchainEvidence = validateBombadilExecutableAttestation(bombadilExecutableAttestation, validated.bombadilToolchain, bombadilVersion);
        throwIfBombadilRunAborted(abortController.signal);
        try {
          lease = await dependencies.acquireServer({
            abortSignal: abortController.signal,
            baseUrl: validated.baseUrl,
            label: validated.label,
            readinessPath: validated.server.readinessPath,
            reuseExistingLocalServer: false,
            startupTimeoutMs: validated.server.startupTimeoutMs,
            startServer: () => {
              throwIfBombadilRunAborted(abortController.signal);
              ownedServer = dependencies.spawnServer({
                command: serverCommand,
                cwd: validated.server.cwd,
                detachedProcessGroup: true,
                ...validated.server.env === undefined ? {} : { env: validated.server.env },
                omitEnvironment: [...BOMBADIL_PRIVATE_ENVIRONMENT_NAMES]
              });
              terminateAbortedOwnedServer(abortController.signal, ownedServer);
              return ownedServer;
            }
          });
        } catch (error) {
          if (abortController.signal.aborted)
            throwIfBombadilRunAborted(abortController.signal);
          throw error;
        }
        if (abortController.signal.aborted) {
          const acquiredOwnedServer = ownedServer;
          if (acquiredOwnedServer?.exitCode() === null)
            acquiredOwnedServer.terminate();
          throwIfBombadilRunAborted(abortController.signal);
        }
        let processFailure = null;
        try {
          const spawnAttestation = await attestBombadilExecutable(bombadilRuntimeExecutable);
          if (bombadilExecutableAttestation === null || bombadilRuntimeExecutableAttestation === null) {
            throw new Error("The root Bombadil executable was not attested before server startup");
          }
          assertSameBombadilExecutableAttestation(bombadilRuntimeExecutableAttestation, spawnAttestation);
          bombadilToolchainEvidence = validateBombadilExecutableAttestation(bombadilExecutableAttestation, validated.bombadilToolchain, bombadilVersion);
          const attestedInvocation = {
            ...abortableInvocation,
            command: [bombadilRuntimeExecutable, ...abortableInvocation.command.slice(1)],
            [BOMBADIL_EXECUTABLE_ATTESTATION]: spawnAttestation
          };
          processResult = await dependencies.runBombadil(attestedInvocation);
        } catch (error) {
          processFailure = error;
        }
        if (processFailure !== null) {
          throw processFailure instanceof Error ? processFailure : new Error(renderUnknown(processFailure));
        }
        if (processResult === null)
          throw new Error("Bombadil did not return a process result");
        if (processResult.termination === "timeout") {
          throw new Error(`Bombadil exceeded its ${String(invocation.wallClockTimeoutMs)}ms wall-clock limit`);
        }
        if (processResult.termination === "aborted") {
          throw new Error("Bombadil process was interrupted");
        }
        if (processResult.exitCode !== 0) {
          throw new Error(`Bombadil exited with status ${String(processResult.exitCode)}`);
        }
      } catch (error) {
        if (error instanceof BombadilWriterSettlementError)
          writersSettled = false;
        failure = error;
      }
      const serverToStop = lease?.source === "started" ? lease.server : ownedServer;
      if (serverToStop !== null) {
        try {
          await dependencies.stopServer(serverToStop);
        } catch (error) {
          writersSettled = false;
          failure = new BombadilWriterSettlementError("Bombadil server writers were not proven absent", failure === null ? error : new AggregateError([failure, error], "Bombadil run and server cleanup both failed"));
        }
      }
      const serverAfterRun = ownedServer;
      if (serverAfterRun !== null && writersSettled) {
        try {
          serverOutput = await readServerOutputBounded(serverAfterRun, dependencies.serverOutputTimeoutMs);
        } catch (error) {
          serverOutputFailure = error;
          failure ??= error;
        }
      }
      if (bombadilExecutableSnapshot !== null && writersSettled) {
        try {
          await removePrivateBombadilExecutableSnapshot(bombadilExecutableSnapshot);
          bombadilExecutableSnapshot = null;
        } catch (error) {
          const persistence = new BombadilPersistenceError("Bombadil private executable snapshot could not be removed", [error]);
          failure = failure === null ? persistence : combinePersistenceFailure(failure, persistence, "Bombadil private executable snapshot could not be removed");
        }
      } else if (bombadilExecutableSnapshot !== null) {
        failure = retainPrivateBombadilSnapshotAfterWriterSettlementFailure(failure ?? new Error("writer settlement unavailable"));
      }
      if (writersSettled) {
        try {
          try {
            artifactInventory = await scanBombadilArtifactTree({
              hashFiles: true,
              policy: validated.artifactPolicy,
              root: outputPath
            });
          } catch (error) {
            throw error instanceof BombadilArtifactPolicyError ? error : new BombadilArtifactPolicyError(`Bombadil artifact inventory could not be proven safe: ${renderUnknown(error)}`);
          }
          artifactInventoryVetted = true;
          const trace = artifactInventory.files.find((file) => file.relativePath === "trace.jsonl");
          if (trace === undefined || trace.size === 0) {
            const missingTrace = new BombadilArtifactPolicyError("Bombadil did not produce a retained nonempty trace.jsonl");
            attestationFailure = missingTrace;
            throw missingTrace;
          }
          rawTracePath = tracePath;
          const traceBytes = await readBoundRegularFileBytes({
            expected: trace,
            label: "Bombadil trace.jsonl",
            maximumBytes: TRACE_MAX_BYTES,
            path: tracePath
          });
          try {
            attestation = attestDirectBombadilTraceBytes({
              expectedRoute: validated.expectedRoute,
              expectedScenario: validated.scenario,
              traceBytes
            });
          } catch (error) {
            attestationFailure = error;
          }
          try {
            explorationSummary = summarizeDirectBombadilTraceBytes({
              ...validated.explorationPolicy === null ? {} : { explorationPolicy: validated.explorationPolicy },
              targetUrl: invocation.targetUrl,
              traceBytes
            });
          } catch (error) {
            explorationSummaryFailure = error;
          }
          if (attestationFailure !== null) {
            throw attestationFailure instanceof Error ? attestationFailure : new Error(renderUnknown(attestationFailure));
          }
          if (explorationSummaryFailure !== null) {
            throw explorationSummaryFailure instanceof Error ? explorationSummaryFailure : new Error(renderUnknown(explorationSummaryFailure));
          }
          if (explorationSummary?.policy.satisfied !== true) {
            throw new Error(`Bombadil exploration policy was not satisfied: ${explorationSummary?.policy.failures.join("; ") ?? "summary unavailable"}`);
          }
        } catch (error) {
          failure ??= error;
        }
      } else {
        artifactInventory = emptyArtifactInventory();
        failure ??= new BombadilWriterSettlementError("Bombadil writers were not proven absent; artifact inspection was suppressed", new Error("writer settlement unavailable"));
      }
    }
    const signalAfterRun = interruptedSignal;
    if (signalAfterRun !== null && failure === null) {
      failure = new Error(`Bombadil fuzzing was interrupted by ${signalAfterRun}`);
    }
    const logPath = join2(artifactRun.runDirectory, "bombadil.log");
    const serverLogPath = join2(artifactRun.runDirectory, "server.log");
    const explorationSummaryPath = join2(artifactRun.runDirectory, "exploration-summary.json");
    const log = [processResult?.stdout ?? "", processResult?.stderr ?? ""].filter((part) => part.length > 0).join(`
`);
    try {
      await writeExclusiveBytes(logPath, Buffer.from(`${log}${log.length > 0 ? `
` : ""}`, "utf8"));
      await writeExclusiveBytes(serverLogPath, Buffer.from(`${serverOutput}${serverOutput.length > 0 ? `
` : ""}`, "utf8"));
      if (explorationSummary !== null) {
        await writeJsonAtomically(explorationSummaryPath, explorationSummary);
      }
    } catch (error) {
      const persistence = new BombadilPersistenceError("Bombadil local diagnostic logs could not be persisted", [error]);
      failure = failure === null ? persistence : combinePersistenceFailure(failure, persistence);
    }
    let completedAt = dependencies.now();
    const createRecord = () => ({
      schema: ARTIFACT_SCHEMA,
      evidenceClass: "diagnostic-fuzz",
      artifactName: validated.artifactName,
      label: validated.label,
      status: failure === null ? "passed" : "failed",
      generatedAt: generatedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - generatedAt.getTime()),
      scenario: validated.scenario,
      expectedRoute: validated.expectedRoute,
      baseUrl: validated.baseUrl,
      entryPath: validated.entryPath,
      targetQuery: validated.targetQuery,
      targetUrl: invocation.targetUrl,
      viewport: validated.viewport,
      artifactPolicy: validated.artifactPolicy,
      artifactInventory: {
        entryCount: artifactInventory.entryCount,
        fileCount: artifactInventory.fileCount,
        inventorySha256: artifactInventory.inventorySha256,
        totalBytes: artifactInventory.totalBytes,
        files: artifactInventory.files.map((file) => ({
          path: file.relativePath,
          sha256: file.sha256,
          size: file.size
        }))
      },
      explorationPolicy: validated.explorationPolicy,
      specificationPath: validated.specificationPath,
      replayPath,
      timeLimitSeconds: replayPath === null ? parsed.timeLimitSeconds : null,
      serverSource: lease?.source ?? null,
      bombadil: {
        version: bombadilVersion,
        executable: validated.bombadilExecutable,
        toolchain: bombadilToolchainEvidence,
        exitCode: processResult?.exitCode ?? null,
        termination: processResult?.termination ?? null,
        outputPath,
        rawTracePath,
        tracePath: attestation === null ? null : tracePath,
        logPath
      },
      server: {
        logPath: serverLogPath,
        logPresent: serverOutput.length > 0,
        outputFailure: serverOutputFailure === null ? null : renderUnknown(serverOutputFailure)
      },
      attestation,
      attestationFailure: attestationFailure === null ? null : renderUnknown(attestationFailure),
      explorationSummary,
      explorationSummaryPath: explorationSummary === null ? null : explorationSummaryPath,
      explorationSummaryFailure: explorationSummaryFailure === null ? null : renderUnknown(explorationSummaryFailure),
      initialDirect: attestation?.initial ?? null,
      interruptedSignal,
      failure: failure === null ? null : renderUnknown(failure)
    });
    const runRecordPath = join2(artifactRun.runDirectory, "run.json");
    try {
      await writeJsonAtomically(runRecordPath, createRecord());
    } catch (error) {
      const persistence = new BombadilPersistenceError("Bombadil local run record could not be persisted", [error]);
      failure = failure === null ? persistence : combinePersistenceFailure(failure, persistence);
    }
    const failureBeforeUpload = failure;
    const signalBeforeUpload = interruptedSignal;
    if (signalBeforeUpload !== null && failure === null) {
      failure = new Error(`Bombadil fuzzing was interrupted by ${signalBeforeUpload}`);
    }
    let published;
    try {
      published = await publishRunUpload({
        abortSignal: abortController.signal,
        artifactName: validated.artifactName,
        beforeCommitCheck: dependencies.beforeArtifactCommit,
        attestation,
        completedAt,
        explorationSummary,
        failure,
        inventory: artifactInventory,
        interruptedSignal: () => interruptedSignal,
        localOutputPath: outputPath,
        policy: validated.artifactPolicy,
        privateDiagnosticsAllowed: writersSettled && artifactInventoryVetted,
        processLog: `${log}${log.length > 0 ? `
` : ""}`,
        scenario: validated.scenario,
        serverLog: `${serverOutput}${serverOutput.length > 0 ? `
` : ""}`,
        session: uploadSession,
        status: failure === null ? "passed" : "failed"
      });
    } catch (persistence) {
      if (failure === null)
        throw persistence;
      throw combinePersistenceFailure(failure, persistence, "sanitized Bombadil receipt publication also failed");
    }
    failure = published.failure;
    completedAt = dependencies.now();
    if (failure !== failureBeforeUpload) {
      await writeJsonAtomically(runRecordPath, createRecord()).catch(() => {
        return;
      });
    }
    await writeJsonAtomically(artifactRun.manifestPath, createRecord()).catch(() => {
      return;
    });
    const status = failure === null ? "passed" : "failed";
    const exploration = explorationSummary === null ? "exploration=unavailable" : [
      `nonWait=${String(explorationSummary.actions.nonWaitCount)}`,
      `maxWaitStreak=${String(explorationSummary.actions.maxWaitStreak)}`,
      `namedChanges=${explorationSummary.namedSnapshots.map((snapshot) => `${snapshot.name}:${String(snapshot.changeAfterNonWaitCount)}`).join(",") || "none"}`,
      `policy=${explorationSummary.policy.satisfied ? "satisfied" : "failed"}`
    ].join("; ");
    const summary = [
      `${status === "passed" ? "PASS" : "FAIL"} ${validated.label}`,
      exploration,
      `artifacts: ${artifactRun.runDirectory}`,
      `log: ${logPath}`
    ].join("; ");
    (status === "passed" ? process2.stdout : process2.stderr).write(`${summary}
`);
    if (failure !== null) {
      throw failure instanceof Error ? failure : new Error(renderUnknown(failure));
    }
    return {
      kind: "run",
      artifactDirectory: artifactRun.runDirectory,
      manifestPath: artifactRun.manifestPath,
      receiptPath: uploadSession.receiptPath,
      status: "passed",
      uploadArtifactPath: uploadSession.finalDirectory
    };
  } finally {
    preparedUpload?.abortSignal?.removeEventListener("abort", abortFromPreparedMatrix);
    for (const signal of PROCESS_INTERRUPT_SIGNALS) {
      processSignals.removeListener(signal, interrupt);
    }
    const signalToForward = interruptedSignal;
    if (signalToForward !== null && preparedUpload?.forwardSignal !== false) {
      processSignals.forward(signalToForward);
    }
  }
}
async function runDirectBombadilFuzz(config, input = process2.argv.slice(2), dependencyOverrides = {}) {
  return await runDirectBombadilFuzzInternal(config, input, dependencyOverrides);
}

// src/tooling/bombadil.ts
var attestDirectBombadilTrace2 = attestDirectBombadilTrace;
var summarizeDirectBombadilTrace2 = summarizeDirectBombadilTrace;
var parseDirectBombadilArtifactReceipt2 = parseDirectBombadilArtifactReceipt;
var parseDirectBombadilSanitizedRunSummary2 = parseDirectBombadilSanitizedRunSummary;
var parseDirectBombadilMatrixReceipt2 = parseDirectBombadilMatrixReceipt;
var parseDirectBombadilMatrixSummary2 = parseDirectBombadilMatrixSummary;
var resolveDirectBombadilUploadLeaf2 = resolveDirectBombadilUploadLeaf;
function runDirectBombadilFuzz2(config, argumentsOrOptions) {
  return argumentsOrOptions === undefined ? runDirectBombadilFuzz(config) : runDirectBombadilFuzz(config, argumentsOrOptions);
}
function runDirectBombadilFuzzMatrix2(campaigns, argumentsOrOptions) {
  return argumentsOrOptions === undefined ? runDirectBombadilFuzzMatrix(campaigns) : runDirectBombadilFuzzMatrix(campaigns, argumentsOrOptions);
}
export {
  summarizeDirectBombadilTrace2 as summarizeDirectBombadilTrace,
  runDirectBombadilFuzzMatrix2 as runDirectBombadilFuzzMatrix,
  runDirectBombadilFuzz2 as runDirectBombadilFuzz,
  resolveDirectBombadilUploadLeaf2 as resolveDirectBombadilUploadLeaf,
  parseDirectBombadilSanitizedRunSummary2 as parseDirectBombadilSanitizedRunSummary,
  parseDirectBombadilMatrixSummary2 as parseDirectBombadilMatrixSummary,
  parseDirectBombadilMatrixReceipt2 as parseDirectBombadilMatrixReceipt,
  parseDirectBombadilArtifactReceipt2 as parseDirectBombadilArtifactReceipt,
  attestDirectBombadilTrace2 as attestDirectBombadilTrace
};
