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
function updateFnvByte(hash, byte) {
  return BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
}
function stableHash(input) {
  const serialized = canonicalJson(input);
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
  return ok({ algorithm: "fnv1a-64", value: hash.toString(16).padStart(16, "0") });
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
function parseCoverageCatalogSnapshot(input) {
  const parsed = parseJsonValue(input);
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

export { ok, err, isRecord, parseScenarioId, parseOperationId, parseCoverageKey, scenarioId, operationId, coverageKey, renderUnknownReason, DEFAULT_JSON_LIMITS, utf8ByteLength, parseExactJsonSource, parseJsonValue, canonicalJson, cloneJson, freezeJson, stableHash, parseAndCloneWorld, DIRECT_COVERAGE_SCHEMA, EMPTY_COVERAGE_CATALOG_SNAPSHOT, createCoverageCatalogSnapshot, parseCoverageCatalogSnapshot, createCoverageCatalog };
