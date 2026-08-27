// @bun
// src/tooling/bombadil-runner.ts
import { createReadStream } from "fs";
import { readFile, realpath, stat, writeFile as writeFile2 } from "fs/promises";
import { isAbsolute, join as join2, relative, resolve } from "path";
import process2 from "process";
import { createInterface } from "readline";

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
function spawnVerificationServer(options) {
  const process_ = Bun.spawn([...options.command], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
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
  return {
    exited: process_.exited,
    exitCode: () => process_.exitCode,
    output,
    terminate: () => process_.kill("SIGTERM"),
    kill: () => process_.kill("SIGKILL")
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
  const output = await settleWithin(server.output, stopTimeoutMs);
  if (!output.settled) {
    throw new Error(`verification server output did not settle within ${stopTimeoutMs}ms after exit`);
  }
  return output.value;
}
async function stopVerificationServer(server, stopTimeoutMs = DEFAULT_STOP_TIMEOUT_MS) {
  await stopVerificationServerWithOutput(server, stopTimeoutMs);
}
async function acquireVerificationServer(options) {
  const probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const readinessPath = options.readinessPath ?? "/";
  const isReachable = options.isReachable ?? serverIsReachable;
  const canStartLocally = canAutomaticallyStartLocalServer(options.baseUrl, options.localHosts);
  if (await isReachable(options.baseUrl, probeTimeoutMs, readinessPath)) {
    if (canStartLocally && options.reuseExistingLocalServer === false) {
      throw new Error(`A local server is already reachable at ${options.baseUrl}; ` + "verification will not reuse a server whose worktree ownership is unknown");
    }
    await Bun.sleep(options.reuseProbeIntervalMs ?? DEFAULT_REUSE_PROBE_INTERVAL_MS);
    if (await isReachable(options.baseUrl, probeTimeoutMs, readinessPath)) {
      return { source: "reused" };
    }
  }
  if (!canStartLocally) {
    throw new Error(`No server is reachable at ${options.baseUrl}; automatic startup is limited to local HTTP URLs`);
  }
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
      if (await isReachable(options.baseUrl, probeTimeoutMs, readinessPath)) {
        return { source: "started", server };
      }
      await Bun.sleep(options.pollIntervalMs ?? 200);
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
async function createArtifactRun(options) {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const processId = options.processId ?? process.pid;
  const runId = `${generatedAt.replaceAll(/[^0-9A-Za-z]/gu, "-")}-${processId}`;
  const runDirectory = join(options.artifactRoot, runId);
  await mkdir(runDirectory, { recursive: true });
  return {
    artifactRoot: options.artifactRoot,
    generatedAt,
    manifestPath: join(options.artifactRoot, "manifest.json"),
    runDirectory
  };
}
async function writeJsonAtomically(path, value) {
  const temporaryPath = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}
`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

// src/tooling/bombadil-runner.ts
var EXPECTED_BOMBADIL_VERSION = "0.7.2";
var DEFAULT_TIME_LIMIT_SECONDS = 20;
var MIN_TIME_LIMIT_SECONDS = 12;
var MAX_TIME_LIMIT_SECONDS = 300;
var DEFAULT_STARTUP_TIMEOUT_MS = 60000;
var MAX_STARTUP_TIMEOUT_MS = 120000;
var LOG_LIMIT = 24000;
var ARTIFACT_SCHEMA = "direct.bombadil-run/v1";
var SCENARIO_PATTERN = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/u;
var ARTIFACT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
var ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
var QUERY_PARAMETER_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
var PROTOTYPE_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);
var TRACE_MAX_BYTES = 64 * 1024 * 1024;
var TRACE_MAX_LINE_BYTES = 16 * 1024 * 1024;
var TRACE_MAX_LINES = 1e4;
var TRACE_MAX_SNAPSHOTS_PER_LINE = 4096;
var RANDOM_RUN_OVERHEAD_MS = 30000;
var REPLAY_WALL_CLOCK_TIMEOUT_MS = MAX_TIME_LIMIT_SECONDS * 1000 + RANDOM_RUN_OVERHEAD_MS;
var PROCESS_TERMINATION_GRACE_MS = 5000;
var MIN_PROCESS_OUTPUT_DRAIN_MS = 500;
var SERVER_OUTPUT_TIMEOUT_MS = 3000;
var DIRECT_BROWSER_BRIDGE_SCHEMA = "direct.browser-bridge/v2";
var TRACE_LINE_KEYS = new Set(["action", "snapshots", "state", "timestamp", "violations"]);
var TRACE_SNAPSHOT_KEYS = new Set(["index", "name", "time", "value"]);
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
function hasExactKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
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
function parseTraceLine(line, lineNumber) {
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
  const snapshots = input.snapshots;
  const directSnapshots = snapshots.filter((snapshot2) => isRecord2(snapshot2) && snapshot2.name === "direct");
  if (directSnapshots.length !== 1) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} must contain one named direct snapshot`);
  }
  const snapshot = directSnapshots[0];
  if (snapshot === undefined || !hasExactKeys(snapshot, TRACE_SNAPSHOT_KEYS) || !Number.isSafeInteger(snapshot.index) || !Number.isSafeInteger(snapshot.time) || snapshot.index < 0 || snapshot.time < 0) {
    throw new Error(`Bombadil trace line ${String(lineNumber)} has an invalid direct snapshot`);
  }
  return parseTraceDirectObservation(snapshot.value);
}
async function attestDirectBombadilTrace(options) {
  const metadata = await stat(options.tracePath).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.size === 0) {
    throw new Error("Bombadil did not produce a nonempty trace.jsonl");
  }
  if (metadata.size > TRACE_MAX_BYTES) {
    throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_BYTES)} bytes`);
  }
  const stream = createReadStream(options.tracePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let observationCount = 0;
  let invalidObservationCount = 0;
  let validObservationCount = 0;
  let initial = null;
  let final = null;
  let finalWasInvalid = false;
  try {
    for await (const line of lines) {
      observationCount += 1;
      if (observationCount > TRACE_MAX_LINES) {
        throw new Error(`Bombadil trace exceeds ${String(TRACE_MAX_LINES)} lines`);
      }
      if (Buffer.byteLength(line, "utf8") > TRACE_MAX_LINE_BYTES) {
        throw new Error(`Bombadil trace line ${String(observationCount)} is too large`);
      }
      const observation = parseTraceLine(line, observationCount);
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
  } finally {
    lines.close();
    stream.destroy();
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
  for (const [name, queryValue] of entries.toSorted(([left], [right]) => left.localeCompare(right))) {
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
function validateDirectBombadilFuzzConfig(config, baseUrlOverride) {
  const repositoryRoot = resolve(config.repositoryRoot);
  if (!isAbsolute(config.repositoryRoot) || repositoryRoot !== config.repositoryRoot) {
    throw new Error("repositoryRoot must be an absolute normalized path");
  }
  if (!ARTIFACT_NAME_PATTERN.test(config.artifactName)) {
    throw new Error("artifactName must be a safe lowercase kebab identifier");
  }
  if (config.label.trim().length === 0 || config.label.length > 160 || hasControlCharacters3(config.label)) {
    throw new Error("label must contain 1-160 visible characters");
  }
  if (config.scenario.length > 120 || !SCENARIO_PATTERN.test(config.scenario)) {
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
  const startupTimeoutMs = config.server.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > MAX_STARTUP_TIMEOUT_MS) {
    throw new Error(`server.startupTimeoutMs must be an integer between 1000 and ${String(MAX_STARTUP_TIMEOUT_MS)}`);
  }
  const baseUrl = requireLocalRootHttpOrigin(baseUrlOverride ?? config.baseUrl);
  const port = new URL(baseUrl).port;
  return {
    ...config,
    repositoryRoot,
    specificationPath,
    baseUrl,
    artifactRoot: join2(repositoryRoot, "artifacts", "direct-bombadil", config.artifactName),
    bombadilExecutable: bombadilNativeBinary(repositoryRoot),
    entryPath,
    port,
    targetQuery,
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
    "--instrument-javascript="
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
function signalProcessGroup(process_, signal) {
  try {
    process2.kill(-process_.pid, signal);
  } catch {
    if (process_.exitCode === null)
      process_.kill(signal);
  }
}
async function terminateProcessGroup(process_, graceMs) {
  signalProcessGroup(process_, "SIGTERM");
  await Bun.sleep(graceMs);
  signalProcessGroup(process_, "SIGKILL");
  await Promise.race([process_.exited.then(() => {
    return;
  }), Bun.sleep(graceMs)]);
}
async function runBombadilNativeProcess(invocation) {
  const process_ = Bun.spawn([...invocation.command], {
    cwd: invocation.cwd,
    detached: true,
    env: { ...process2.env, NO_COLOR: "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe"
  });
  let timeout;
  let abortListener;
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
    const outcome = await Promise.race([
      process_.exited.then((exitCode) => ({ kind: "exited", exitCode })),
      timeoutPromise.then(() => ({ kind: "timeout" })),
      abortPromise.then(() => ({ kind: "aborted" }))
    ]);
    const terminationGraceMs = invocation.terminationGraceMs ?? PROCESS_TERMINATION_GRACE_MS;
    if (outcome.kind === "exited") {
      signalProcessGroup(process_, "SIGKILL");
    } else {
      await terminateProcessGroup(process_, terminationGraceMs);
    }
    const outputSettled = await Promise.race([
      outputPromise.then(() => true, () => true),
      Bun.sleep(Math.max(terminationGraceMs, MIN_PROCESS_OUTPUT_DRAIN_MS)).then(() => false)
    ]);
    if (!outputSettled) {
      stdoutCapture.stop();
      stderrCapture.stop();
    }
    const [stdout, stderr] = await outputPromise;
    return {
      exitCode: outcome.kind === "exited" ? outcome.exitCode : process_.exitCode ?? 137,
      stderr,
      stdout,
      termination: outcome.kind === "exited" ? null : outcome.kind
    };
  } finally {
    if (timeout !== undefined)
      clearTimeout(timeout);
    if (abortListener !== undefined) {
      invocation.abortSignal?.removeEventListener("abort", abortListener);
    }
  }
}
var defaultDependencies = {
  acquireServer: acquireVerificationServer,
  now: () => new Date,
  runBombadil: runBombadilNativeProcess,
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
  return {
    config: {
      ...config,
      repositoryRoot,
      specificationPath,
      artifactRoot: join2(repositoryRoot, "artifacts", "direct-bombadil", config.artifactName),
      bombadilExecutable: bombadilNativeBinary(repositoryRoot),
      server: { ...config.server, cwd: serverCwd }
    },
    replayPath: resolvedReplayPath
  };
}
async function readExactBombadilVersion(repositoryRoot) {
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
async function runDirectBombadilFuzz(config, arguments_ = process2.argv.slice(2), dependencyOverrides = {}) {
  const parsed = parseDirectBombadilFuzzArguments(arguments_, config.baseUrl);
  if (parsed.kind === "help") {
    process2.stdout.write(`${helpText(config.baseUrl)}
`);
    return { kind: "help" };
  }
  const lexicalConfig = validateDirectBombadilFuzzConfig(config, parsed.baseUrl);
  const lexicalReplayPath = resolveReplayPath(lexicalConfig.repositoryRoot, parsed.replayPath);
  const resolvedPaths = await resolveDirectBombadilRealPaths(lexicalConfig, lexicalReplayPath);
  const validated = resolvedPaths.config;
  const replayPath = resolvedPaths.replayPath;
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  const generatedAt = dependencies.now();
  const artifactRun = await createArtifactRun({
    artifactRoot: validated.artifactRoot,
    generatedAt: generatedAt.toISOString()
  });
  const outputPath = join2(artifactRun.runDirectory, "bombadil");
  const tracePath = join2(outputPath, "trace.jsonl");
  const abortController = new AbortController;
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
    timeLimitSeconds: parsed.timeLimitSeconds
  });
  const abortableInvocation = { ...invocation, abortSignal: abortController.signal };
  const serverCommand = validated.server.command.map((argument) => argument === "{port}" ? validated.port : argument);
  let bombadilVersion = null;
  let lease = null;
  let ownedServer = null;
  let processResult = null;
  let attestation = null;
  let attestationFailure = null;
  let rawTracePath = null;
  let serverOutput = "";
  let serverOutputFailure = null;
  let failure = null;
  let interruptedSignal = null;
  const interrupt = (signal) => {
    interruptedSignal ??= signal;
    abortController.abort();
    if (ownedServer?.exitCode() === null)
      ownedServer.terminate();
  };
  const interruptSignals = ["SIGINT", "SIGTERM"];
  const processSignals = process2;
  for (const signal of interruptSignals)
    processSignals.once(signal, interrupt);
  try {
    try {
      await requireRegularFile(validated.bombadilExecutable, "The root Bombadil executable");
      bombadilVersion = await readExactBombadilVersion(validated.repositoryRoot);
      if (abortController.signal.aborted)
        throw new Error("Bombadil fuzzing was interrupted");
      lease = await dependencies.acquireServer({
        baseUrl: validated.baseUrl,
        label: validated.label,
        readinessPath: validated.server.readinessPath,
        reuseExistingLocalServer: false,
        startupTimeoutMs: validated.server.startupTimeoutMs,
        startServer: () => {
          ownedServer = dependencies.spawnServer({
            command: serverCommand,
            cwd: validated.server.cwd,
            ...validated.server.env === undefined ? {} : { env: validated.server.env }
          });
          return ownedServer;
        }
      });
      let processFailure = null;
      try {
        processResult = await dependencies.runBombadil(abortableInvocation);
      } catch (error) {
        processFailure = error;
      }
      const traceMetadata = await stat(tracePath).catch(() => null);
      if (traceMetadata?.isFile() === true && traceMetadata.size > 0) {
        rawTracePath = tracePath;
      }
      try {
        attestation = await attestDirectBombadilTrace({
          expectedRoute: validated.expectedRoute,
          expectedScenario: validated.scenario,
          tracePath
        });
      } catch (error) {
        attestationFailure = error;
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
      if (attestationFailure !== null) {
        throw attestationFailure instanceof Error ? attestationFailure : new Error(renderUnknown(attestationFailure));
      }
    } catch (error) {
      failure = error;
    }
    const serverToStop = lease?.source === "started" ? lease.server : ownedServer;
    if (serverToStop !== null) {
      try {
        await dependencies.stopServer(serverToStop);
      } catch (error) {
        failure ??= error;
      }
    }
    const serverAfterRun = ownedServer;
    if (serverAfterRun !== null) {
      try {
        serverOutput = await readServerOutputBounded(serverAfterRun, dependencies.serverOutputTimeoutMs);
      } catch (error) {
        serverOutputFailure = error;
        failure ??= error;
      }
    }
  } finally {
    for (const signal of interruptSignals) {
      processSignals.removeListener(signal, interrupt);
    }
  }
  const capturedSignal = interruptedSignal;
  if (capturedSignal !== null && failure === null) {
    failure = new Error(`Bombadil fuzzing was interrupted by ${capturedSignal}`);
  }
  const completedAt = dependencies.now();
  const status = failure === null ? "passed" : "failed";
  const logPath = join2(artifactRun.runDirectory, "bombadil.log");
  const serverLogPath = join2(artifactRun.runDirectory, "server.log");
  const record = {
    schema: ARTIFACT_SCHEMA,
    evidenceClass: "diagnostic-fuzz",
    artifactName: validated.artifactName,
    label: validated.label,
    status,
    generatedAt: generatedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Math.max(0, completedAt.getTime() - generatedAt.getTime()),
    scenario: validated.scenario,
    expectedRoute: validated.expectedRoute,
    baseUrl: validated.baseUrl,
    entryPath: validated.entryPath,
    targetQuery: validated.targetQuery,
    targetUrl: invocation.targetUrl,
    specificationPath: validated.specificationPath,
    replayPath,
    timeLimitSeconds: replayPath === null ? parsed.timeLimitSeconds : null,
    serverSource: lease?.source ?? null,
    bombadil: {
      version: bombadilVersion,
      executable: validated.bombadilExecutable,
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
    initialDirect: attestation?.initial ?? null,
    interruptedSignal: capturedSignal,
    failure: failure === null ? null : renderUnknown(failure)
  };
  const log = [processResult?.stdout ?? "", processResult?.stderr ?? ""].filter((part) => part.length > 0).join(`
`);
  try {
    await writeFile2(logPath, `${log}${log.length > 0 ? `
` : ""}`, "utf8");
    await writeFile2(serverLogPath, `${serverOutput}${serverOutput.length > 0 ? `
` : ""}`, "utf8");
    await writeJsonAtomically(join2(artifactRun.runDirectory, "run.json"), record);
    await writeJsonAtomically(artifactRun.manifestPath, record);
    const summary = `${status === "passed" ? "PASS" : "FAIL"} ${validated.label}; artifacts: ${artifactRun.runDirectory}; log: ${logPath}`;
    (status === "passed" ? process2.stdout : process2.stderr).write(`${summary}
`);
    if (failure !== null) {
      throw failure instanceof Error ? failure : new Error(renderUnknown(failure));
    }
    return {
      kind: "run",
      artifactDirectory: artifactRun.runDirectory,
      manifestPath: artifactRun.manifestPath,
      status: "passed"
    };
  } finally {
    if (capturedSignal !== null) {
      process2.kill(process2.pid, capturedSignal);
    }
  }
}

// src/tooling/bombadil.ts
var attestDirectBombadilTrace2 = attestDirectBombadilTrace;
function runDirectBombadilFuzz2(config, arguments_) {
  return arguments_ === undefined ? runDirectBombadilFuzz(config) : runDirectBombadilFuzz(config, arguments_);
}
export {
  runDirectBombadilFuzz2 as runDirectBombadilFuzz,
  attestDirectBombadilTrace2 as attestDirectBombadilTrace
};
