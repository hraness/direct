// @bun
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
// src/web/browser-bridge.ts
var DIRECT_BROWSER_BRIDGE_SCHEMA = "direct.browser-bridge/v2";

// src/web.ts
var DIRECT_BROWSER_BRIDGE_SCHEMA2 = DIRECT_BROWSER_BRIDGE_SCHEMA;

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
function parseDirectBrowserContractEnvelope(input) {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length !== 3 || !Object.hasOwn(input, "bridgeSchema") || !Object.hasOwn(input, "manifest") || !Object.hasOwn(input, "probe")) {
      throw new Error("invalid");
    }
    return {
      bridgeSchema: Reflect.get(input, "bridgeSchema"),
      manifest: Reflect.get(input, "manifest"),
      probe: Reflect.get(input, "probe")
    };
  } catch {
    throw new Error("Direct browser contract has an invalid envelope");
  }
}
function directCatalogIdentity(manifest2) {
  return JSON.stringify({
    queries: manifest2.queries,
    defaultScenario: manifest2.defaultScenario,
    scenarios: manifest2.scenarios
  });
}
function bindDirectScenarioCatalog(manifests) {
  const baseline = manifests[0];
  if (baseline === undefined) {
    throw new Error("Direct scenario verification requires at least one session manifest");
  }
  const baselineCoverage = JSON.stringify(baseline.coverage);
  const baselineCatalog = directCatalogIdentity(baseline);
  for (const [index, manifest2] of manifests.entries()) {
    if (manifest2.catalogHash !== baseline.catalogHash) {
      throw new Error(`Direct scenario ${String(index)} exposed catalog ${manifest2.catalogHash} instead of ${baseline.catalogHash}`);
    }
    if (JSON.stringify(manifest2.coverage) !== baselineCoverage) {
      throw new Error(`Direct scenario ${String(index)} exposed different coverage for catalog ${baseline.catalogHash}`);
    }
    if (directCatalogIdentity(manifest2) !== baselineCatalog) {
      throw new Error(`Direct scenario ${String(index)} exposed different public metadata for catalog ${baseline.catalogHash}`);
    }
  }
  return baseline.coverage;
}
function bindDirectBrowserContractEvidence(initial, final, retainedProbe = final.probe) {
  if (directCatalogIdentity(final.manifest) !== directCatalogIdentity(initial.manifest)) {
    throw new Error("Direct public catalog metadata changed during verification");
  }
  if (JSON.stringify(final.manifest.coverage) !== JSON.stringify(initial.manifest.coverage)) {
    throw new Error("Direct coverage changed during verification");
  }
  if (final.manifest.catalogHash !== initial.manifest.catalogHash) {
    throw new Error("Direct catalog hash changed during verification");
  }
  if (JSON.stringify(final.manifest.active) !== JSON.stringify(initial.manifest.active)) {
    throw new Error("Direct activation identity changed during verification");
  }
  if (initial.probe.activationHash !== initial.manifest.active.activationHash || final.probe.activationHash !== final.manifest.active.activationHash || retainedProbe.activationHash !== final.manifest.active.activationHash) {
    throw new Error("Direct probe identity changed during verification");
  }
  return final;
}
function createDirectBrowserContractReader(protocol) {
  return async (browser2, expectation) => {
    const envelope = parseDirectBrowserContractEnvelope(await browser2.evaluate(`(() => {
        const bridge = window.__direct;
        return {
          bridgeSchema: bridge?.schema,
          manifest: bridge?.manifest,
          probe: typeof bridge?.snapshot === "function" ? bridge.snapshot() : undefined,
        };
      })()`));
    if (envelope.bridgeSchema !== protocol.bridgeSchema) {
      throw new Error(`Direct browser bridge schema must be ${protocol.bridgeSchema}`);
    }
    const manifest2 = protocol.parseManifest(envelope.manifest);
    if (!manifest2.ok) {
      throw new Error(`Direct session manifest is invalid: ${manifest2.error.message}`);
    }
    const probe2 = protocol.parseProbe(envelope.probe);
    if (!probe2.ok) {
      throw new Error(`Direct probe is invalid: ${probe2.error.message}`);
    }
    if (manifest2.value.active.source !== expectation.source) {
      throw new Error(`Direct activated from ${manifest2.value.active.source} instead of ${expectation.source}`);
    }
    if (String(manifest2.value.active.scenario) !== expectation.scenario) {
      throw new Error(`Direct activated ${String(manifest2.value.active.scenario)} instead of ${expectation.scenario}`);
    }
    if (manifest2.value.active.route !== expectation.route) {
      throw new Error(`Direct scenario ${expectation.scenario} activated route ${manifest2.value.active.route} instead of ${expectation.route}`);
    }
    if (manifest2.value.active.activationHash !== probe2.value.activationHash) {
      throw new Error("Direct session manifest and probe identify different activations");
    }
    return Object.freeze({
      manifest: manifest2.value,
      probe: probe2.value
    });
  };
}
function serializeAgentBrowserLaunchArguments(launchArguments) {
  for (const argument of launchArguments) {
    if (!argument.startsWith("--") || argument.includes(`
`) || argument.includes(",")) {
      throw new Error(`agent-browser launch arguments must be comma-free Chrome flags, received ${JSON.stringify(argument)}`);
    }
  }
  return launchArguments.join(",");
}
function isolatedAgentBrowserEnvironment(options) {
  const environment = { ...options.inheritedEnvironment };
  for (const variable of Object.keys(environment)) {
    if (variable.startsWith("AGENT_BROWSER_"))
      Reflect.deleteProperty(environment, variable);
  }
  return {
    ...environment,
    AGENT_BROWSER_CONFIG: options.configPath,
    AGENT_BROWSER_DEFAULT_TIMEOUT: String(options.defaultTimeoutMs),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: String(options.idleTimeoutMs ?? options.defaultTimeoutMs + 60000),
    ...options.launchArguments === undefined ? {} : { AGENT_BROWSER_ARGS: serializeAgentBrowserLaunchArguments(options.launchArguments) },
    AGENT_BROWSER_NAMESPACE: options.session,
    AGENT_BROWSER_RESTORE_SAVE: "never",
    AGENT_BROWSER_SESSION: options.session
  };
}
function boundedAgentBrowserSessionName(prefix, processId, nonce) {
  const boundedPrefix = prefix.replaceAll(/[^a-zA-Z0-9_-]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 6) || "verify";
  const boundedProcessId = Math.max(0, Math.trunc(processId)).toString(36).slice(-6);
  const boundedNonce = nonce.replaceAll(/[^a-zA-Z0-9]+/g, "").slice(0, 6) || "run";
  return `${boundedPrefix}-${boundedProcessId}-${boundedNonce}`;
}
function renderAgentBrowserCommand(arguments_) {
  const [command, payload] = arguments_;
  if (command === "eval" && payload !== undefined) {
    return `${command} (${payload.length} character payload)`;
  }
  if (command === "batch") {
    return `${command} (${arguments_.slice(1).join(`
`).length} character payload)`;
  }
  return arguments_.join(" ");
}
var agentBrowserCloseProcessTimeoutMs = 1e4;
function agentBrowserProcessTimeoutMs(arguments_, defaultTimeoutMs) {
  const defaultProcessTimeoutMs = defaultTimeoutMs + 5000;
  return arguments_[0] === "close" ? Math.min(defaultProcessTimeoutMs, agentBrowserCloseProcessTimeoutMs) : defaultProcessTimeoutMs;
}
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
function isUnknownArray(value) {
  return Array.isArray(value);
}
function isNonArrayObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyStringArray(value) {
  return isUnknownArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string");
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
function parseBaseUrlArguments(arguments_, defaultBaseUrl) {
  let baseUrl = defaultBaseUrl;
  let receivedBaseUrl = false;
  for (let index = 0;index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined)
      continue;
    if (argument === "--help" || argument === "-h")
      return { kind: "help" };
    if (argument.startsWith("--base-url=")) {
      if (receivedBaseUrl)
        throw new Error("--base-url may be provided only once");
      receivedBaseUrl = true;
      baseUrl = argument.slice("--base-url=".length);
      continue;
    }
    if (argument === "--base-url") {
      if (receivedBaseUrl)
        throw new Error("--base-url may be provided only once");
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error("--base-url requires a value");
      }
      receivedBaseUrl = true;
      baseUrl = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument at position ${String(index + 1)}`);
  }
  return { kind: "run", baseUrl: normalizeRootHttpOrigin(baseUrl) };
}
function canAutomaticallyStartLocalServer(baseUrl, localHosts = new Set(["127.0.0.1", "localhost"])) {
  const url = new URL(normalizeRootHttpOrigin(baseUrl));
  return url.protocol === "http:" && localHosts.has(url.hostname);
}
function parseAgentBrowserEnvelope(source) {
  let input;
  try {
    input = JSON.parse(source);
  } catch {
    throw new Error("agent-browser did not return one JSON document");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input) || typeof Reflect.get(input, "success") !== "boolean" || !Object.hasOwn(input, "data") || !Object.hasOwn(input, "error")) {
    throw new Error("agent-browser returned an invalid envelope");
  }
  if (!Reflect.get(input, "success")) {
    throw new Error(`agent-browser reported failure: ${renderUnknown(Reflect.get(input, "error"))}`);
  }
  return Reflect.get(input, "data");
}
function parseAgentBrowserBatchEnvelope(source) {
  let input;
  try {
    input = JSON.parse(source);
  } catch {
    throw new Error("agent-browser batch did not return one JSON document");
  }
  if (!isUnknownArray(input) || input.length === 0) {
    throw new Error("agent-browser batch returned an invalid envelope");
  }
  return input.map((entry, index) => {
    if (!isNonArrayObject(entry) || !Object.hasOwn(entry, "command") || !Object.hasOwn(entry, "success") || !Object.hasOwn(entry, "result") || !Object.hasOwn(entry, "error")) {
      throw new Error(`agent-browser batch returned an invalid envelope at position ${String(index + 1)}`);
    }
    const command = readForeignProperty(entry, "command");
    const success = readForeignProperty(entry, "success");
    const result = readForeignProperty(entry, "result");
    const error = readForeignProperty(entry, "error");
    if (!command.ok || !isNonEmptyStringArray(command.value) || !success.ok || typeof success.value !== "boolean" || !result.ok || !error.ok) {
      throw new Error(`agent-browser batch returned an invalid envelope at position ${String(index + 1)}`);
    }
    if (!success.value) {
      throw new Error(`agent-browser batch command ${String(index + 1)} (${renderAgentBrowserCommand(command.value)}) reported failure: ${renderUnknown(error.value)}`);
    }
    return result.value;
  });
}
function createAgentBrowser(options) {
  const binary = join(options.repositoryRoot, "node_modules/.bin/agent-browser");
  const createEnvironment = () => {
    const session2 = boundedAgentBrowserSessionName(options.sessionPrefix, process.pid, randomUUID());
    return isolatedAgentBrowserEnvironment({
      configPath: join(options.repositoryRoot, "scripts/direct/agent-browser.verify.json"),
      defaultTimeoutMs: options.defaultTimeoutMs ?? 35000,
      ...options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs },
      inheritedEnvironment: process.env,
      ...options.launchArguments === undefined ? {} : { launchArguments: options.launchArguments },
      session: session2
    });
  };
  let environment = createEnvironment();
  let used = false;
  async function run(arguments_) {
    used = true;
    const defaultTimeoutMs = options.defaultTimeoutMs ?? 35000;
    const commandArguments = arguments_[0] === "wait" && !arguments_.includes("--timeout") ? [...arguments_, "--timeout", String(defaultTimeoutMs)] : arguments_;
    const command = Bun.spawn([process.execPath, binary, "--json", ...commandArguments], {
      cwd: options.repositoryRoot,
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    });
    let timedOut = false;
    let forceKillTimer;
    const commandTimeoutMs = agentBrowserProcessTimeoutMs(commandArguments, defaultTimeoutMs);
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      command.kill();
      forceKillTimer = setTimeout(() => command.kill(9), 1000);
    }, commandTimeoutMs);
    let stdout;
    let stderr;
    let exitCode;
    try {
      [stdout, stderr, exitCode] = await Promise.all([
        new Response(command.stdout).text(),
        new Response(command.stderr).text(),
        command.exited
      ]);
    } finally {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined)
        clearTimeout(forceKillTimer);
    }
    if (timedOut) {
      throw new Error(`agent-browser ${renderAgentBrowserCommand(commandArguments)} exceeded its ${commandTimeoutMs}ms process deadline`);
    }
    if (exitCode !== 0) {
      throw new Error(`agent-browser ${renderAgentBrowserCommand(commandArguments)} exited with ${exitCode}: ${tail(stderr.trim() || stdout.trim())}`);
    }
    return commandArguments[0] === "batch" ? parseAgentBrowserBatchEnvelope(stdout) : parseAgentBrowserEnvelope(stdout);
  }
  async function evaluate(expression) {
    const evaluation = await run(["eval", expression]);
    if (typeof evaluation !== "object" || evaluation === null || Array.isArray(evaluation) || !Object.hasOwn(evaluation, "result")) {
      throw new Error("browser evaluation returned invalid data");
    }
    return Reflect.get(evaluation, "result");
  }
  async function readBodyText() {
    const result = await evaluate("document.body?.innerText ?? ''");
    if (typeof result !== "string")
      throw new Error("body text evaluation did not return a string");
    return result;
  }
  async function close() {
    if (!used)
      return;
    try {
      await run(["close"]);
    } catch (error) {
      if (!renderUnknown(error).includes("Failed to connect: No such file or directory")) {
        throw error;
      }
    } finally {
      used = false;
    }
  }
  async function restart() {
    try {
      await close();
    } catch {
      used = false;
    }
    environment = createEnvironment();
  }
  return { close, evaluate, readBodyText, restart, run };
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
async function runVerificationCommand(options) {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("verification command timeout must be a finite positive duration");
  }
  const command = spawnVerificationServer({
    command: options.command,
    cwd: options.cwd,
    ...options.env === undefined ? {} : { env: options.env }
  });
  let timeout;
  const completed = await Promise.race([
    command.exited.then(() => true),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), options.timeoutMs);
    })
  ]);
  if (timeout !== undefined)
    clearTimeout(timeout);
  if (!completed) {
    const output2 = tail(await stopVerificationServerWithOutput(command));
    const message = `${options.label} exceeded its ${options.timeoutMs}ms deadline`;
    throw new Error(output2 === "" ? message : `${message}:
${output2}`);
  }
  const exitCode = command.exitCode();
  const output = tail(await stopVerificationServerWithOutput(command));
  if (exitCode !== 0) {
    throw new Error(`${options.label} exited with ${String(exitCode)}:
${output}`);
  }
  return output;
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
    await rm(temporaryPath, { force: true }).catch(() => {
      return;
    });
    throw error;
  }
}
// src/tooling/browser-layout-contract.ts
var DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA = "direct.named-layout-sample/v1";
var DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA = "direct.named-layout-contract/v1";
var MAX_LAYOUT_BOXES = 128;
var MAX_LAYOUT_RULES = 256;
var MAX_LAYOUT_COORDINATE = 1e7;
var MAX_LAYOUT_TOLERANCE = 1e4;
var MAX_LAYOUT_NAME_LENGTH = 128;
var LAYOUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]*$/u;
var RESERVED_LAYOUT_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);
var SAMPLE_KEYS = new Set(["boxes", "schema", "viewport"]);
var VIEWPORT_KEYS = new Set(["height", "width"]);
var BOX_KEYS = new Set(["height", "name", "width", "x", "y"]);
var CONTRACT_KEYS = new Set(["rules", "schema"]);
var INSIDE_RULE_KEYS = new Set([
  "id",
  "inner",
  "kind",
  "outer",
  "tolerance"
]);
var PAIR_RULE_KEYS = new Set([
  "first",
  "id",
  "kind",
  "second",
  "tolerance"
]);
var BOX_TOLERANCE_RULE_KEYS = new Set([
  "box",
  "id",
  "kind",
  "tolerance"
]);
var MINIMUM_SIZE_RULE_KEYS = new Set([
  "box",
  "id",
  "kind",
  "minimumHeight",
  "minimumWidth"
]);

class NamedLayoutInputError extends Error {
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireExactRecord(value, expected, label) {
  if (!isRecord2(value)) {
    throw new NamedLayoutInputError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key)) || [...expected].some((key) => !Object.hasOwn(value, key))) {
    throw new NamedLayoutInputError(`${label} must contain exactly: ${[...expected].sort().join(", ")}`);
  }
  return value;
}
function requireLayoutName(value, label) {
  if (typeof value !== "string" || value.length > MAX_LAYOUT_NAME_LENGTH || !LAYOUT_NAME_PATTERN.test(value) || RESERVED_LAYOUT_NAMES.has(value)) {
    throw new NamedLayoutInputError(`${label} must be a safe, unreserved 1-${String(MAX_LAYOUT_NAME_LENGTH)} character identifier`);
  }
  return value;
}
function requireBoundedNumber(options) {
  if (typeof options.value !== "number" || !Number.isFinite(options.value) || options.value < options.minimum || options.value > options.maximum) {
    throw new NamedLayoutInputError(`${options.label} must be a finite number between ${String(options.minimum)} and ${String(options.maximum)}`);
  }
  return options.value;
}
function requireCoordinate(value, label) {
  return requireBoundedNumber({
    label,
    maximum: MAX_LAYOUT_COORDINATE,
    minimum: -MAX_LAYOUT_COORDINATE,
    value
  });
}
function requireSize(value, label, positive) {
  const size = requireBoundedNumber({
    label,
    maximum: MAX_LAYOUT_COORDINATE,
    minimum: 0,
    value
  });
  if (positive && size === 0) {
    throw new NamedLayoutInputError(`${label} must be greater than zero`);
  }
  return size;
}
function requireTolerance(value, label) {
  return requireBoundedNumber({
    label,
    maximum: MAX_LAYOUT_TOLERANCE,
    minimum: 0,
    value
  });
}
function parseLayoutBox(input, index) {
  const label = `Direct named layout box ${String(index)}`;
  const record = requireExactRecord(input, BOX_KEYS, label);
  return Object.freeze({
    height: requireSize(record.height, `${label} height`, true),
    name: requireLayoutName(record.name, `${label} name`),
    width: requireSize(record.width, `${label} width`, true),
    x: requireCoordinate(record.x, `${label} x`),
    y: requireCoordinate(record.y, `${label} y`)
  });
}
function parseLayoutSampleUnchecked(input) {
  const record = requireExactRecord(input, SAMPLE_KEYS, "Direct named layout sample");
  if (record.schema !== DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA) {
    throw new NamedLayoutInputError(`Direct named layout sample schema must be ${DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA}`);
  }
  const viewportRecord = requireExactRecord(record.viewport, VIEWPORT_KEYS, "Direct named layout viewport");
  if (!Array.isArray(record.boxes)) {
    throw new NamedLayoutInputError("Direct named layout boxes must be an array");
  }
  if (record.boxes.length === 0 || record.boxes.length > MAX_LAYOUT_BOXES) {
    throw new NamedLayoutInputError(`Direct named layout samples require 1-${String(MAX_LAYOUT_BOXES)} boxes`);
  }
  const boxes = [];
  for (let index = 0;index < record.boxes.length; index += 1) {
    boxes.push(parseLayoutBox(record.boxes[index], index));
  }
  const names = new Set;
  for (const box of boxes) {
    if (names.has(box.name)) {
      throw new NamedLayoutInputError(`Direct named layout box name is duplicated: ${box.name}`);
    }
    names.add(box.name);
  }
  return Object.freeze({
    boxes: Object.freeze(boxes),
    schema: DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA,
    viewport: Object.freeze({
      height: requireSize(viewportRecord.height, "Direct named layout viewport height", true),
      width: requireSize(viewportRecord.width, "Direct named layout viewport width", true)
    })
  });
}
function parsePairRule(record, kind, id) {
  requireExactRecord(record, PAIR_RULE_KEYS, `Direct named layout ${kind} rule`);
  const first = requireLayoutName(record.first, `Direct named layout rule ${id} first box`);
  const second = requireLayoutName(record.second, `Direct named layout rule ${id} second box`);
  if (first === second) {
    throw new NamedLayoutInputError(`Direct named layout rule ${id} must name two different boxes`);
  }
  return Object.freeze({
    first,
    id,
    kind,
    second,
    tolerance: requireTolerance(record.tolerance, `Direct named layout rule ${id} tolerance`)
  });
}
function parseBoxToleranceRule(record, kind, id) {
  requireExactRecord(record, BOX_TOLERANCE_RULE_KEYS, `Direct named layout ${kind} rule`);
  return Object.freeze({
    box: requireLayoutName(record.box, `Direct named layout rule ${id} box`),
    id,
    kind,
    tolerance: requireTolerance(record.tolerance, `Direct named layout rule ${id} tolerance`)
  });
}
function parseLayoutRule(input, index) {
  const label = `Direct named layout rule ${String(index)}`;
  if (!isRecord2(input)) {
    throw new NamedLayoutInputError(`${label} must be an object`);
  }
  const id = requireLayoutName(input.id, `${label} id`);
  switch (input.kind) {
    case "inside": {
      const record = requireExactRecord(input, INSIDE_RULE_KEYS, `${label} inside`);
      const inner = requireLayoutName(record.inner, `${label} inner box`);
      const outer = requireLayoutName(record.outer, `${label} outer box`);
      if (inner === outer) {
        throw new NamedLayoutInputError(`${label} must name different inner and outer boxes`);
      }
      return Object.freeze({
        id,
        inner,
        kind: "inside",
        outer,
        tolerance: requireTolerance(record.tolerance, `${label} tolerance`)
      });
    }
    case "no-overlap":
    case "center-x":
    case "center-y":
      return parsePairRule(input, input.kind, id);
    case "not-clipped":
    case "stable":
      return parseBoxToleranceRule(input, input.kind, id);
    case "minimum-size": {
      const record = requireExactRecord(input, MINIMUM_SIZE_RULE_KEYS, `${label} minimum-size`);
      const minimumHeight = requireSize(record.minimumHeight, `${label} minimumHeight`, false);
      const minimumWidth = requireSize(record.minimumWidth, `${label} minimumWidth`, false);
      if (minimumHeight === 0 && minimumWidth === 0) {
        throw new NamedLayoutInputError(`${label} must require a positive width or height`);
      }
      return Object.freeze({
        box: requireLayoutName(record.box, `${label} box`),
        id,
        kind: "minimum-size",
        minimumHeight,
        minimumWidth
      });
    }
    default:
      throw new NamedLayoutInputError(`${label} kind must be inside, no-overlap, center-x, center-y, not-clipped, minimum-size, or stable`);
  }
}
function parseLayoutContractUnchecked(input) {
  const record = requireExactRecord(input, CONTRACT_KEYS, "Direct named layout contract");
  if (record.schema !== DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA) {
    throw new NamedLayoutInputError(`Direct named layout contract schema must be ${DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA}`);
  }
  if (!Array.isArray(record.rules)) {
    throw new NamedLayoutInputError("Direct named layout rules must be an array");
  }
  if (record.rules.length === 0 || record.rules.length > MAX_LAYOUT_RULES) {
    throw new NamedLayoutInputError(`Direct named layout contracts require 1-${String(MAX_LAYOUT_RULES)} rules`);
  }
  const rules = [];
  for (let index = 0;index < record.rules.length; index += 1) {
    rules.push(parseLayoutRule(record.rules[index], index));
  }
  const ids = new Set;
  for (const rule of rules) {
    if (ids.has(rule.id)) {
      throw new NamedLayoutInputError(`Direct named layout rule id is duplicated: ${rule.id}`);
    }
    ids.add(rule.id);
  }
  return Object.freeze({
    rules: Object.freeze(rules),
    schema: DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA
  });
}
function parseError(code, error) {
  return Object.freeze({
    code,
    message: error instanceof NamedLayoutInputError ? error.message : `Direct named layout ${code === "invalid-sample" ? "sample" : "contract"} could not be read`
  });
}
function parseDirectNamedLayoutSample(input) {
  try {
    return Object.freeze({ ok: true, value: parseLayoutSampleUnchecked(input) });
  } catch (error) {
    return Object.freeze({
      error: parseError("invalid-sample", error),
      ok: false
    });
  }
}
function parseDirectNamedLayoutContract(input) {
  try {
    return Object.freeze({ ok: true, value: parseLayoutContractUnchecked(input) });
  } catch (error) {
    return Object.freeze({
      error: parseError("invalid-contract", error),
      ok: false
    });
  }
}
function boxMap(sample) {
  return new Map(sample.boxes.map((box) => [box.name, box]));
}
function right(box) {
  return box.x + box.width;
}
function bottom(box) {
  return box.y + box.height;
}
function violation(options) {
  return Object.freeze(options);
}
function missingBoxViolation(rule, sample, names) {
  return violation({
    code: "missing-box",
    message: `Rule ${rule.id} references missing box${names.length === 1 ? "" : "es"}: ${names.join(", ")}`,
    ruleId: rule.id,
    ruleKind: rule.kind,
    sample
  });
}
function pairBoxes(rule, boxes) {
  const first = boxes.get(rule.first);
  const second = boxes.get(rule.second);
  return first === undefined || second === undefined ? null : [first, second];
}
function validateStaticRule(rule, sampleName, sample, boxes) {
  switch (rule.kind) {
    case "inside": {
      const inner = boxes.get(rule.inner);
      const outer = boxes.get(rule.outer);
      if (inner === undefined || outer === undefined) {
        return missingBoxViolation(rule, sampleName, [inner === undefined ? rule.inner : null, outer === undefined ? rule.outer : null].filter((name) => name !== null));
      }
      if (inner.x < outer.x - rule.tolerance || inner.y < outer.y - rule.tolerance || right(inner) > right(outer) + rule.tolerance || bottom(inner) > bottom(outer) + rule.tolerance) {
        return violation({
          code: "outside",
          message: `Box ${rule.inner} is not inside ${rule.outer} within ${String(rule.tolerance)} CSS pixels`,
          ruleId: rule.id,
          ruleKind: rule.kind,
          sample: sampleName
        });
      }
      return null;
    }
    case "no-overlap": {
      const pair = pairBoxes(rule, boxes);
      if (pair === null) {
        return missingBoxViolation(rule, sampleName, [rule.first, rule.second].filter((name) => !boxes.has(name)));
      }
      const [first, second] = pair;
      const overlapWidth = Math.min(right(first), right(second)) - Math.max(first.x, second.x);
      const overlapHeight = Math.min(bottom(first), bottom(second)) - Math.max(first.y, second.y);
      if (overlapWidth > rule.tolerance && overlapHeight > rule.tolerance) {
        return violation({
          code: "overlap",
          message: `Boxes ${rule.first} and ${rule.second} overlap beyond ${String(rule.tolerance)} CSS pixels`,
          ruleId: rule.id,
          ruleKind: rule.kind,
          sample: sampleName
        });
      }
      return null;
    }
    case "center-x":
    case "center-y": {
      const pair = pairBoxes(rule, boxes);
      if (pair === null) {
        return missingBoxViolation(rule, sampleName, [rule.first, rule.second].filter((name) => !boxes.has(name)));
      }
      const [first, second] = pair;
      const firstCenter = rule.kind === "center-x" ? first.x + first.width / 2 : first.y + first.height / 2;
      const secondCenter = rule.kind === "center-x" ? second.x + second.width / 2 : second.y + second.height / 2;
      if (Math.abs(firstCenter - secondCenter) > rule.tolerance) {
        return violation({
          code: "misaligned",
          message: `Boxes ${rule.first} and ${rule.second} are not ${rule.kind} aligned within ${String(rule.tolerance)} CSS pixels`,
          ruleId: rule.id,
          ruleKind: rule.kind,
          sample: sampleName
        });
      }
      return null;
    }
    case "not-clipped": {
      const box = boxes.get(rule.box);
      if (box === undefined) {
        return missingBoxViolation(rule, sampleName, [rule.box]);
      }
      if (box.x < -rule.tolerance || box.y < -rule.tolerance || right(box) > sample.viewport.width + rule.tolerance || bottom(box) > sample.viewport.height + rule.tolerance) {
        return violation({
          code: "clipped",
          message: `Box ${rule.box} extends outside the viewport beyond ${String(rule.tolerance)} CSS pixels`,
          ruleId: rule.id,
          ruleKind: rule.kind,
          sample: sampleName
        });
      }
      return null;
    }
    case "minimum-size": {
      const box = boxes.get(rule.box);
      if (box === undefined) {
        return missingBoxViolation(rule, sampleName, [rule.box]);
      }
      if (box.width < rule.minimumWidth || box.height < rule.minimumHeight) {
        return violation({
          code: "too-small",
          message: `Box ${rule.box} is smaller than ${String(rule.minimumWidth)} by ${String(rule.minimumHeight)} CSS pixels`,
          ruleId: rule.id,
          ruleKind: rule.kind,
          sample: sampleName
        });
      }
      return null;
    }
  }
}
function validateStabilityRule(rule, firstSample, secondSample, first, second) {
  if (secondSample === undefined || second === null) {
    return violation({
      code: "second-sample-required",
      message: `Rule ${rule.id} requires two layout samples`,
      ruleId: rule.id,
      ruleKind: rule.kind,
      sample: "pair"
    });
  }
  if (firstSample.viewport.width !== secondSample.viewport.width || firstSample.viewport.height !== secondSample.viewport.height) {
    return violation({
      code: "viewport-changed",
      message: `Rule ${rule.id} requires two samples at the same viewport`,
      ruleId: rule.id,
      ruleKind: rule.kind,
      sample: "pair"
    });
  }
  const firstBox = first.get(rule.box);
  const secondBox = second.get(rule.box);
  if (firstBox === undefined || secondBox === undefined) {
    return missingBoxViolation(rule, "pair", [firstBox === undefined ? `first:${rule.box}` : null, secondBox === undefined ? `second:${rule.box}` : null].filter((name) => name !== null));
  }
  if (Math.abs(firstBox.x - secondBox.x) > rule.tolerance || Math.abs(firstBox.y - secondBox.y) > rule.tolerance || Math.abs(firstBox.width - secondBox.width) > rule.tolerance || Math.abs(firstBox.height - secondBox.height) > rule.tolerance) {
    return violation({
      code: "unstable",
      message: `Box ${rule.box} changed between samples beyond ${String(rule.tolerance)} CSS pixels`,
      ruleId: rule.id,
      ruleKind: rule.kind,
      sample: "pair"
    });
  }
  return null;
}
function validateDirectNamedLayout(contract, samples) {
  if (!Array.isArray(samples) || samples.length !== 1 && samples.length !== 2) {
    throw new RangeError("Direct named layout validation requires exactly one or two parsed samples");
  }
  const violations = [];
  const firstBoxes = boxMap(samples[0]);
  const secondSample = samples[1];
  const secondBoxes = secondSample === undefined ? null : boxMap(secondSample);
  for (const rule of contract.rules) {
    if (rule.kind === "stable") {
      const found = validateStabilityRule(rule, samples[0], secondSample, firstBoxes, secondBoxes);
      if (found !== null)
        violations.push(found);
      continue;
    }
    const firstViolation = validateStaticRule(rule, "first", samples[0], firstBoxes);
    if (firstViolation !== null)
      violations.push(firstViolation);
    if (secondSample !== undefined && secondBoxes !== null) {
      const secondViolation = validateStaticRule(rule, "second", secondSample, secondBoxes);
      if (secondViolation !== null)
        violations.push(secondViolation);
    }
  }
  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations)
  });
}

// src/tooling/browser-verification-entry.ts
var readDirectBrowserContract = createDirectBrowserContractReader({
  bridgeSchema: DIRECT_BROWSER_BRIDGE_SCHEMA2,
  parseManifest: parseDirectSessionManifest,
  parseProbe: parseDirectProbeSnapshot
});
export {
  writeJsonAtomically,
  validateDirectNamedLayout,
  tail,
  stopVerificationServer,
  spawnVerificationServer,
  serverIsReachable,
  serializeAgentBrowserLaunchArguments,
  runVerificationCommand,
  renderUnknown,
  renderAgentBrowserCommand,
  readDirectBrowserContract,
  parseDirectNamedLayoutSample,
  parseDirectNamedLayoutContract,
  parseBaseUrlArguments,
  parseAgentBrowserEnvelope,
  parseAgentBrowserBatchEnvelope,
  normalizeRootHttpOrigin,
  isolatedAgentBrowserEnvironment,
  createDirectBrowserContractReader,
  createArtifactRun,
  createAgentBrowser,
  canAutomaticallyStartLocalServer,
  boundedAgentBrowserSessionName,
  bindDirectScenarioCatalog,
  bindDirectBrowserContractEvidence,
  agentBrowserProcessTimeoutMs,
  agentBrowserCloseProcessTimeoutMs,
  acquireVerificationServer,
  DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA,
  DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA
};
