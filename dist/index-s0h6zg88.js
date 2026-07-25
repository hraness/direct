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
function parseOperationId(input) {
  const parsed = parseIdentifier(input, "operation");
  return parsed.ok ? ok(parsed.value) : parsed;
}
function parseCoverageKey(input) {
  const parsed = parseIdentifier(input, "coverage");
  return parsed.ok ? ok(parsed.value) : parsed;
}
function scenarioId(input) {
  const parsed = parseScenarioId(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
}
function operationId(input) {
  const parsed = parseOperationId(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
}
function coverageKey(input) {
  const parsed = parseCoverageKey(input);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
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
function jsonError(code, path, message) {
  return { code, path, message };
}
function exactJsonSourceError(code, path, message) {
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
function childJsonPath(path, key) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}
function findDuplicateJsonKey(source) {
  let index = 0;
  let duplicate = null;
  const skipWhitespace = () => {
    while (source[index] === " " || source[index] === `
` || source[index] === "\r" || source[index] === "\t") {
      index += 1;
    }
  };
  const readString = () => {
    const start = index;
    index += 1;
    while (index < source.length) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      index += 1;
      if (character === '"') {
        return JSON.parse(source.slice(start, index));
      }
    }
    throw new Error("Unterminated JSON string");
  };
  const scanValue = (path) => {
    skipWhitespace();
    const character = source[index];
    if (character === "{") {
      index += 1;
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      const keys = new Set;
      while (index < source.length) {
        skipWhitespace();
        const key = readString();
        const keyPath = childJsonPath(path, key);
        if (keys.has(key) && duplicate === null) {
          duplicate = { key, path: keyPath };
        }
        keys.add(key);
        skipWhitespace();
        index += 1;
        scanValue(keyPath);
        skipWhitespace();
        if (source[index] === "}") {
          index += 1;
          return;
        }
        index += 1;
      }
      return;
    }
    if (character === "[") {
      index += 1;
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      let itemIndex = 0;
      while (index < source.length) {
        scanValue(`${path}[${String(itemIndex)}]`);
        itemIndex += 1;
        skipWhitespace();
        if (source[index] === "]") {
          index += 1;
          return;
        }
        index += 1;
      }
      return;
    }
    if (character === '"') {
      readString();
      return;
    }
    while (index < source.length) {
      const next = source[index];
      if (next === "," || next === "]" || next === "}" || /\s/u.test(next ?? ""))
        return;
      index += 1;
    }
  };
  skipWhitespace();
  scanValue("$");
  return duplicate;
}
function parseExactJsonSource(source) {
  if (typeof source !== "string") {
    return err(exactJsonSourceError("invalid-json", "$", "JSON source must be a string"));
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return err(exactJsonSourceError("invalid-json", "$", "Source is not valid JSON"));
  }
  try {
    const duplicate = findDuplicateJsonKey(source);
    return duplicate === null ? ok(parsed) : err(exactJsonSourceError("duplicate-key", duplicate.path, `Duplicate JSON object key at ${duplicate.path}: ${duplicate.key}`));
  } catch (reason) {
    return err(exactJsonSourceError("invalid-json", "$", renderUnknownReason(reason, "JSON source inspection failed")));
  }
}
function parseJsonAt(input, path, depth, limits, budget, ancestors) {
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
    return Number.isFinite(input) ? ok(input) : err(jsonError("invalid-number", path, "JSON numbers must be finite"));
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
      const item = parseJsonAt(descriptor.value, `${path}[${index}]`, depth + 1, limits, budget, nextAncestors);
      if (!item.ok) {
        return item;
      }
      output2.push(item.value);
    }
    return ok(output2);
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    return err(jsonError("invalid-object", path, "JSON objects must have Object or null prototypes"));
  }
  const output = Object.create(null);
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
    const child = parseJsonAt(descriptor.value, `${path}.${key}`, depth + 1, limits, budget, nextAncestors);
    if (!child.ok) {
      return child;
    }
    output[key] = child.value;
  }
  return ok(output);
}
function parseJsonValue(input, limits = DEFAULT_JSON_LIMITS) {
  if (!Number.isSafeInteger(limits.maxDepth) || limits.maxDepth < 0 || !Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1 || !Number.isSafeInteger(limits.maxStringBytes) || limits.maxStringBytes < 0) {
    throw new Error("JSON limits must be non-negative safe integers and allow at least one node");
  }
  try {
    return parseJsonAt(input, "$", 0, limits, { nodes: 0, stringBytes: 0 }, new Set);
  } catch (reason) {
    return err(jsonError("invalid-object", "$", renderUnknownReason(reason, "JSON object inspection failed")));
  }
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
function cloneJson(input, limits = DEFAULT_JSON_LIMITS) {
  const canonical = canonicalJson(input, limits);
  if (!canonical.ok) {
    return canonical;
  }
  return ok(JSON.parse(canonical.value));
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
function parseAndCloneWorld(input, parseWorld) {
  const cloned = cloneJson(input);
  if (!cloned.ok) {
    return cloned;
  }
  try {
    const world = parseWorld(cloned.value);
    const verified = cloneJson(world);
    if (!verified.ok) {
      return verified;
    }
    return ok(freezeJson(verified.value));
  } catch (reason) {
    return err({ code: "invalid-world", message: renderUnknownReason(reason) });
  }
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

// src/core/runtime.ts
var LOGICAL_RUNTIME_SCHEMA = "direct.runtime/v1";
var MAX_HOST_TIMER_MILLISECONDS = 2147483647;
var DEFAULT_LOGICAL_RUNTIME_SNAPSHOT = Object.freeze({
  schema: LOGICAL_RUNTIME_SCHEMA,
  nowMs: 0,
  nextOperation: 1,
  acceleration: 100
});
var RUNTIME_KEYS = new Set(["schema", "nowMs", "nextOperation", "acceleration"]);
var NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
function parseLogicalRuntimeSnapshot(input) {
  const parsedJson = parseJsonValue(input);
  if (!parsedJson.ok || !isRecord(parsedJson.value)) {
    return err({ code: "invalid-runtime", message: "Logical runtime must be an object" });
  }
  for (const key of Object.keys(parsedJson.value)) {
    if (!RUNTIME_KEYS.has(key)) {
      return err({ code: "invalid-runtime", message: `Unknown logical runtime key: ${key}` });
    }
  }
  const record = parsedJson.value;
  if (record.schema !== LOGICAL_RUNTIME_SCHEMA) {
    return err({ code: "invalid-runtime", message: `Logical runtime schema must be ${LOGICAL_RUNTIME_SCHEMA}` });
  }
  if (typeof record.nowMs !== "number" || !Number.isSafeInteger(record.nowMs) || record.nowMs < 0) {
    return err({ code: "invalid-runtime", message: "Logical nowMs must be a non-negative safe integer" });
  }
  if (typeof record.nextOperation !== "number" || !Number.isSafeInteger(record.nextOperation) || record.nextOperation < 1) {
    return err({ code: "invalid-runtime", message: "Logical nextOperation must be a positive safe integer" });
  }
  if (typeof record.acceleration !== "number" || !Number.isFinite(record.acceleration) || record.acceleration < 1 || record.acceleration > 1e6) {
    return err({ code: "invalid-runtime", message: "Logical acceleration must be in [1, 1000000]" });
  }
  return ok(Object.freeze({
    schema: LOGICAL_RUNTIME_SCHEMA,
    nowMs: record.nowMs,
    nextOperation: record.nextOperation,
    acceleration: record.acceleration
  }));
}
function sleepTimerChunk(wallMilliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    let timeout = null;
    let settled = false;
    const finish = () => {
      if (settled)
        return;
      settled = true;
      if (timeout !== null)
        clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    signal?.addEventListener("abort", finish, { once: true });
    timeout = setTimeout(finish, wallMilliseconds);
  });
}
async function defaultSleep(wallMilliseconds, signal) {
  let remaining = wallMilliseconds;
  while (remaining > 0 && signal?.aborted !== true) {
    const chunk = Math.min(remaining, MAX_HOST_TIMER_MILLISECONDS);
    await sleepTimerChunk(chunk, signal);
    remaining -= chunk;
  }
}
function parseDuration(logicalMilliseconds) {
  return Number.isSafeInteger(logicalMilliseconds) && logicalMilliseconds >= 0 ? ok(logicalMilliseconds) : err({ code: "invalid-duration", message: "Logical durations must be non-negative safe integers" });
}
function isWaitCancelled(signal) {
  return signal?.aborted === true;
}
function waitCancelled() {
  return err({
    code: "wait-cancelled",
    message: "Logical wait was cancelled"
  });
}
function nextLogicalTime(nowMs, duration) {
  const nextNow = nowMs + duration;
  return Number.isSafeInteger(nextNow) ? ok(nextNow) : err({ code: "time-overflow", message: "Logical time exceeds the safe integer range" });
}
function createLogicalRuntime(initial = DEFAULT_LOGICAL_RUNTIME_SNAPSHOT, sleep = defaultSleep) {
  const parsed = parseLogicalRuntimeSnapshot(initial);
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  let nowMs = parsed.value.nowMs;
  let nextOperation = parsed.value.nextOperation;
  const acceleration = parsed.value.acceleration;
  let waitTail = Promise.resolve();
  const snapshot = () => Object.freeze({
    schema: LOGICAL_RUNTIME_SCHEMA,
    nowMs,
    nextOperation,
    acceleration
  });
  const advance = (logicalMilliseconds) => {
    const duration = parseDuration(logicalMilliseconds);
    if (!duration.ok) {
      return duration;
    }
    const nextNow = nextLogicalTime(nowMs, duration.value);
    if (!nextNow.ok) {
      return nextNow;
    }
    nowMs = nextNow.value;
    return ok(nowMs);
  };
  const wait = (logicalMilliseconds, signal) => {
    const duration = parseDuration(logicalMilliseconds);
    if (!duration.ok) {
      return Promise.resolve(duration);
    }
    const run = waitTail.then(async () => {
      if (isWaitCancelled(signal))
        return waitCancelled();
      const target = nextLogicalTime(nowMs, duration.value);
      if (!target.ok)
        return target;
      const wallMilliseconds = Math.ceil(duration.value / acceleration);
      try {
        if (wallMilliseconds > 0) {
          await sleep(wallMilliseconds, signal);
        }
      } catch (reason) {
        if (isWaitCancelled(signal))
          return waitCancelled();
        return err({
          code: "sleep-failed",
          message: renderUnknownReason(reason, "Logical sleep failed")
        });
      }
      if (isWaitCancelled(signal))
        return waitCancelled();
      return advance(duration.value);
    });
    waitTail = run.then(() => {
      return;
    }, () => {
      return;
    });
    return run;
  };
  return Object.freeze({
    now: () => nowMs,
    snapshot,
    nextOperationId: (namespace = "operation") => {
      if (!NAMESPACE_PATTERN.test(namespace) || namespace.length > 48) {
        throw new Error("Operation namespaces must be lowercase hyphen-separated ASCII identifiers");
      }
      if (!Number.isSafeInteger(nextOperation) || nextOperation >= Number.MAX_SAFE_INTEGER) {
        throw new Error("Operation sequence exceeds the safe integer range");
      }
      const candidate = `${namespace}-${String(nextOperation).padStart(6, "0")}`;
      nextOperation += 1;
      const parsedOperation = parseOperationId(candidate);
      if (!parsedOperation.ok) {
        throw new Error(parsedOperation.error.message);
      }
      return parsedOperation.value;
    },
    advance,
    wait
  });
}

// src/core/fixture.ts
var FIXTURE_SCHEMA = "direct.fixture/v1";
var DEFAULT_MAX_FIXTURE_BYTES = 65536;
var FIXTURE_KEYS = new Set(["schema", "scenario", "route", "world", "runtime"]);
function fixtureError(code, message) {
  return { code, message };
}
function maxFixtureBytes(value) {
  const maximum = value ?? DEFAULT_MAX_FIXTURE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("Fixture maxBytes must be a positive safe integer");
  }
  return maximum;
}
function parseFixtureEnvelope(input, options) {
  const maximum = maxFixtureBytes(options.maxBytes);
  const serialized = canonicalJson(input);
  if (!serialized.ok) {
    return err(fixtureError("invalid-fixture", serialized.error.message));
  }
  if (utf8ByteLength(serialized.value) > maximum) {
    return err(fixtureError("oversized-fixture", "Fixture exceeds its byte limit"));
  }
  const foreign = JSON.parse(serialized.value);
  if (!isRecord(foreign)) {
    return err(fixtureError("invalid-fixture", "Fixture must be an object"));
  }
  for (const key of Object.keys(foreign)) {
    if (!FIXTURE_KEYS.has(key)) {
      return err(fixtureError("unknown-key", `Unknown fixture key: ${key}`));
    }
  }
  if (foreign.schema !== FIXTURE_SCHEMA) {
    return err(fixtureError("invalid-fixture", `Fixture schema must be ${FIXTURE_SCHEMA}`));
  }
  const id = parseScenarioId(foreign.scenario);
  if (!id.ok) {
    return err(fixtureError("invalid-scenario", id.error.message));
  }
  const scenario = options.scenarios.get(id.value);
  if (scenario === undefined) {
    return err(fixtureError("unknown-scenario", `Unknown fixture scenario: ${id.value}`));
  }
  if (typeof foreign.route !== "string" || foreign.route !== scenario.route) {
    return err(fixtureError("mismatched-route", `Fixture route must match scenario ${id.value}`));
  }
  const runtime = foreign.runtime === undefined ? ok(scenario.runtime) : parseLogicalRuntimeSnapshot(foreign.runtime);
  if (!runtime.ok) {
    return err(fixtureError("invalid-runtime", runtime.error.message));
  }
  const world = parseAndCloneWorld(foreign.world, options.parseWorld);
  if (!world.ok) {
    return err(fixtureError("invalid-world", world.error.message));
  }
  const envelope = Object.freeze({
    schema: FIXTURE_SCHEMA,
    scenario: id.value,
    route: scenario.route,
    world: world.value,
    runtime: runtime.value
  });
  const normalized = canonicalJson(envelope);
  if (!normalized.ok) {
    return err(fixtureError("invalid-fixture", normalized.error.message));
  }
  if (utf8ByteLength(normalized.value) > maximum) {
    return err(fixtureError("oversized-fixture", "Normalized fixture exceeds its byte limit"));
  }
  return ok(envelope);
}
function parseFixtureJson(source, options) {
  if (typeof source !== "string") {
    return err(fixtureError("invalid-json", "Fixture JSON source must be a string"));
  }
  if (utf8ByteLength(source) > maxFixtureBytes(options.maxBytes)) {
    return err(fixtureError("oversized-fixture", "Fixture exceeds its byte limit"));
  }
  const input = parseExactJsonSource(source);
  if (!input.ok) {
    return err(fixtureError(input.error.code === "duplicate-key" ? "duplicate-key" : "invalid-json", input.error.code === "duplicate-key" ? input.error.message : "Fixture is not valid JSON"));
  }
  return parseFixtureEnvelope(input.value, options);
}
function createFixtureEnvelope(input, options) {
  const id = parseScenarioId(input.scenario);
  if (!id.ok)
    return err(fixtureError("invalid-scenario", id.error.message));
  const scenario = options.scenarios.get(id.value);
  if (scenario === undefined) {
    return err(fixtureError("unknown-scenario", `Unknown fixture scenario: ${id.value}`));
  }
  return parseFixtureEnvelope({
    schema: FIXTURE_SCHEMA,
    scenario: id.value,
    route: scenario.route,
    world: input.world,
    runtime: input.runtime ?? scenario.runtime
  }, options);
}
function serializeFixtureJson(input, options) {
  const fixture = createFixtureEnvelope(input, options);
  if (!fixture.ok)
    return fixture;
  const serialized = canonicalJson(fixture.value);
  if (!serialized.ok) {
    return err(fixtureError("invalid-fixture", serialized.error.message));
  }
  if (utf8ByteLength(serialized.value) > maxFixtureBytes(options.maxBytes)) {
    return err(fixtureError("oversized-fixture", "Normalized fixture exceeds its byte limit"));
  }
  return ok(serialized.value);
}

// src/core/query.ts
var SCENARIO_QUERY_KEY = "__direct_scenario";
var FIXTURE_QUERY_KEY = "__direct_fixture";
var FIXTURE_QUERY_PREFIX_BYTES = utf8ByteLength(`?${FIXTURE_QUERY_KEY}=`);
function maximumFixtureQueryBytes(maxFixtureBytes2) {
  return maxFixtureBytes2 * 3 + FIXTURE_QUERY_PREFIX_BYTES;
}
var DEFAULT_MAX_QUERY_BYTES = maximumFixtureQueryBytes(DEFAULT_MAX_FIXTURE_BYTES);
function queryError(code, message) {
  return { code, message };
}
function decodeQueryPart(value) {
  try {
    return ok(decodeURIComponent(value.replaceAll("+", " ")));
  } catch {
    return err(queryError("invalid-encoding", "Direct query contains invalid percent encoding"));
  }
}
function queryBody(source) {
  const question = source.indexOf("?");
  const candidate = question >= 0 ? source.slice(question + 1) : source.startsWith("?") ? source.slice(1) : source;
  const fragment = candidate.indexOf("#");
  return fragment >= 0 ? candidate.slice(0, fragment) : candidate;
}
function parseActivationParameters(source) {
  let scenario = null;
  let fixture = null;
  const body = queryBody(source);
  if (body.length === 0) {
    return ok({ scenario, fixture });
  }
  for (const part of body.split("&")) {
    if (part.length === 0) {
      continue;
    }
    const equals = part.indexOf("=");
    const encodedKey = equals < 0 ? part : part.slice(0, equals);
    const encodedValue = equals < 0 ? "" : part.slice(equals + 1);
    const key = decodeQueryPart(encodedKey);
    if (!key.ok) {
      return key;
    }
    const reserved = key.value.startsWith("__direct_");
    if (key.value !== SCENARIO_QUERY_KEY && key.value !== FIXTURE_QUERY_KEY) {
      if (reserved) {
        return err(queryError("unknown-parameter", `Unknown Direct query parameter: ${key.value}`));
      }
      continue;
    }
    const value = decodeQueryPart(encodedValue);
    if (!value.ok) {
      return value;
    }
    if (key.value === SCENARIO_QUERY_KEY) {
      if (scenario !== null) {
        return err(queryError("duplicate-parameter", `Duplicate ${SCENARIO_QUERY_KEY} parameter`));
      }
      scenario = value.value;
    } else {
      if (fixture !== null) {
        return err(queryError("duplicate-parameter", `Duplicate ${FIXTURE_QUERY_KEY} parameter`));
      }
      fixture = value.value;
    }
  }
  return ok({ scenario, fixture });
}
function activationHash(source, scenario, route, world, runtime) {
  const hashed = stableHash({ source, scenario, route, world, runtime });
  if (!hashed.ok) {
    throw new Error(hashed.error.message);
  }
  return tagStableHash(hashed.value);
}
function activateDirectScenario(id, scenarios) {
  const parsed = parseScenarioId(id);
  if (!parsed.ok) {
    return err(queryError("invalid-scenario", parsed.error.message));
  }
  const scenario = scenarios.get(parsed.value);
  if (scenario === undefined) {
    return err(queryError("unknown-scenario", `Unknown scenario: ${parsed.value}`));
  }
  return ok(Object.freeze({
    kind: "active",
    source: "scenario",
    scenario: scenario.id,
    route: scenario.route,
    world: scenario.world,
    runtime: scenario.runtime,
    activationHash: activationHash("scenario", scenario.id, scenario.route, scenario.world, scenario.runtime)
  }));
}
function parseDirectQuery(source, options) {
  const maxBytes = options.maxQueryBytes ?? DEFAULT_MAX_QUERY_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Query maxQueryBytes must be a positive safe integer");
  }
  if (typeof source !== "string") {
    return err(queryError("invalid-query", "Direct query source must be a string"));
  }
  if (utf8ByteLength(source) > maxBytes) {
    return err(queryError("oversized-query", "Direct query exceeds its byte limit"));
  }
  const parameters = parseActivationParameters(source);
  if (!parameters.ok) {
    return parameters;
  }
  if (parameters.value.scenario === null && parameters.value.fixture === null) {
    return ok(Object.freeze({ kind: "inactive" }));
  }
  const requestedScenario = parameters.value.scenario === null ? null : activateDirectScenario(parameters.value.scenario, options.scenarios);
  if (requestedScenario !== null && !requestedScenario.ok) {
    return requestedScenario;
  }
  if (parameters.value.fixture === null) {
    return requestedScenario ?? err(queryError("invalid-scenario", "Missing scenario activation"));
  }
  const fixture = parseFixtureJson(parameters.value.fixture, options);
  if (!fixture.ok) {
    return err(queryError("invalid-fixture", fixture.error.message));
  }
  if (requestedScenario !== null && requestedScenario.value.scenario !== fixture.value.scenario) {
    return err(queryError("mismatched-scenario", `${SCENARIO_QUERY_KEY} does not match the fixture scenario`));
  }
  return ok(Object.freeze({
    kind: "active",
    source: "fixture",
    scenario: fixture.value.scenario,
    route: fixture.value.route,
    world: fixture.value.world,
    runtime: fixture.value.runtime,
    activationHash: activationHash("fixture", fixture.value.scenario, fixture.value.route, fixture.value.world, fixture.value.runtime)
  }));
}

// src/core/scenario.ts
var MAX_DIRECT_SCENARIOS = 256;
function validText(value, maximum) {
  if (value.trim().length === 0 || value.length > maximum) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13 || code === 127) {
      return false;
    }
  }
  return true;
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
function scenarioError(code, scenario, message) {
  return { code, scenario, message };
}
function createScenarioCatalog(inputs, parseWorld) {
  if (inputs.length > MAX_DIRECT_SCENARIOS) {
    return err(scenarioError("too-many-scenarios", inputs.length, `Direct definitions support at most ${String(MAX_DIRECT_SCENARIOS)} scenarios`));
  }
  const definitions = [];
  const byId = new Map;
  for (const input of inputs) {
    const id = parseScenarioId(input.id);
    if (!id.ok) {
      return err(scenarioError("invalid-scenario", input.id, id.error.message));
    }
    if (byId.has(id.value)) {
      return err(scenarioError("duplicate-scenario", id.value, `Duplicate scenario: ${id.value}`));
    }
    if (!validText(input.title, 160)) {
      return err(scenarioError("invalid-title", id.value, "Scenario titles must contain 1-160 visible characters"));
    }
    if (input.description !== undefined && !validText(input.description, 2000)) {
      return err(scenarioError("invalid-description", id.value, "Scenario descriptions must contain 1-2000 visible characters"));
    }
    if (!validRoute(input.route)) {
      return err(scenarioError("invalid-route", id.value, "Scenario routes must contain 1-256 visible characters"));
    }
    const runtime = parseLogicalRuntimeSnapshot(input.runtime ?? DEFAULT_LOGICAL_RUNTIME_SNAPSHOT);
    if (!runtime.ok) {
      return err(scenarioError("invalid-runtime", id.value, runtime.error.message));
    }
    const world = parseAndCloneWorld(input.world, parseWorld);
    if (!world.ok) {
      return err(scenarioError("invalid-world", id.value, world.error.message));
    }
    const definition = Object.freeze({
      id: id.value,
      title: input.title,
      description: input.description ?? null,
      route: input.route,
      world: world.value,
      runtime: runtime.value
    });
    definitions.push(definition);
    byId.set(id.value, definition);
  }
  const frozenDefinitions = Object.freeze(definitions);
  return ok(Object.freeze({
    size: frozenDefinitions.length,
    list: () => frozenDefinitions,
    get: (id) => byId.get(id),
    resolve: (input) => {
      const id = parseScenarioId(input);
      if (!id.ok) {
        return err(scenarioError("invalid-scenario", input, id.error.message));
      }
      const definition = byId.get(id.value);
      return definition === undefined ? err(scenarioError("unknown-scenario", id.value, `Unknown scenario: ${id.value}`)) : ok(definition);
    }
  }));
}

export { ok, err, isRecord, parseScenarioId, parseOperationId, parseCoverageKey, scenarioId, operationId, coverageKey, renderUnknownReason, DEFAULT_JSON_LIMITS, utf8ByteLength, parseExactJsonSource, parseJsonValue, canonicalJson, cloneJson, freezeJson, STABLE_HASH_ALGORITHM, tagStableHash, parseTaggedStableHash, stableHash, parseAndCloneWorld, DIRECT_COVERAGE_SCHEMA, MAX_DIRECT_COVERAGE_ENTRIES, EMPTY_COVERAGE_CATALOG_SNAPSHOT, createCoverageCatalogSnapshot, parseCoverageCatalogSnapshot, createCoverageCatalog, LOGICAL_RUNTIME_SCHEMA, MAX_HOST_TIMER_MILLISECONDS, DEFAULT_LOGICAL_RUNTIME_SNAPSHOT, parseLogicalRuntimeSnapshot, createLogicalRuntime, FIXTURE_SCHEMA, DEFAULT_MAX_FIXTURE_BYTES, parseFixtureEnvelope, parseFixtureJson, createFixtureEnvelope, serializeFixtureJson, SCENARIO_QUERY_KEY, FIXTURE_QUERY_KEY, maximumFixtureQueryBytes, DEFAULT_MAX_QUERY_BYTES, activateDirectScenario, parseDirectQuery, MAX_DIRECT_SCENARIOS, createScenarioCatalog };
