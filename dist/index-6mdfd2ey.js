import {
  DEFAULT_JSON_LIMITS,
  cloneJson,
  err,
  ok,
  parseAndCloneWorld,
  parseOperationId,
  renderUnknownReason,
  utf8ByteLength
} from "./index-1csg00w4.js";

// src/core/store.ts
var DIRECT_STORE_MAX_REPLACEMENTS = 32;
var DIRECT_STORE_MAX_REPLACEMENT_PATH_DEPTH = 32;
function storeError(code, message, operation = null) {
  return { code, message, operation };
}
function replacementFailure(message) {
  throw new TypeError(message);
}
function standardRecord(input) {
  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
function isJsonArray(input) {
  return Array.isArray(input);
}
function ownEnumerableDataValue(input, key) {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (descriptor === undefined || descriptor.enumerable !== true || !("value" in descriptor)) {
    replacementFailure(`Replacement property ${JSON.stringify(key)} must be an own enumerable data property.`);
  }
  return descriptor.value;
}
function exactEnumerableKeys(input, expected, label) {
  if (Object.getOwnPropertySymbols(input).length > 0) {
    replacementFailure(`${label} cannot contain symbol properties.`);
  }
  const keys = Object.keys(input);
  const ownKeys = Reflect.ownKeys(input);
  if (keys.length !== expected.length || ownKeys.length !== expected.length || expected.some((key) => !Object.hasOwn(input, key))) {
    replacementFailure(`${label} must contain exactly ${expected.join(", ")}.`);
  }
  for (const key of expected)
    ownEnumerableDataValue(input, key);
}
function denseStandardArrayValues(input, label, maximumLength) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) {
    replacementFailure(`${label} must be a standard array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) {
    replacementFailure(`${label} must have a data length from 0 through ${String(maximumLength)}.`);
  }
  const lengthValue = lengthDescriptor.value;
  if (typeof lengthValue !== "number" || !Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > maximumLength) {
    replacementFailure(`${label} must have a data length from 0 through ${String(maximumLength)}.`);
  }
  const length = lengthValue;
  const ownKeys = Reflect.ownKeys(input);
  if (ownKeys.length !== length + 1 || ownKeys.at(-1) !== "length") {
    replacementFailure(`${label} must be dense and cannot contain extra properties.`);
  }
  return Array.from({ length }, (_, index) => {
    const key = String(index);
    if (ownKeys[index] !== key) {
      replacementFailure(`${label} must contain every index exactly once.`);
    }
    return ownEnumerableDataValue(input, key);
  });
}
function consumeReplacementString(value, label, budget, budgetKey) {
  budget[budgetKey] += utf8ByteLength(value);
  if (budget[budgetKey] > DEFAULT_JSON_LIMITS.maxStringBytes) {
    replacementFailure(`${label} exceeds the replacement string byte limit.`);
  }
  return value;
}
function replacementPrimitive(input, label, budget, budgetKey) {
  if (input === null || typeof input === "boolean")
    return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input) || Object.is(input, -0)) {
      replacementFailure(`${label} must be a finite normalized JSON number.`);
    }
    return input;
  }
  if (typeof input === "string") {
    return consumeReplacementString(input, label, budget, budgetKey);
  }
  return replacementFailure(`${label} must be a JSON primitive.`);
}
function replacementPath(input, index, budget) {
  const values = denseStandardArrayValues(input, `Replacement ${String(index)} path`, DIRECT_STORE_MAX_REPLACEMENT_PATH_DEPTH);
  if (values.length === 0) {
    replacementFailure(`Replacement ${String(index)} path must contain 1 through ${String(DIRECT_STORE_MAX_REPLACEMENT_PATH_DEPTH)} segments.`);
  }
  return Object.freeze(values.map((segment, segmentIndex) => {
    if (typeof segment === "string") {
      return consumeReplacementString(segment, `Replacement ${String(index)} path segment ${String(segmentIndex)}`, budget, "pathStringBytes");
    }
    if (typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0 && !Object.is(segment, -0)) {
      return segment;
    }
    return replacementFailure(`Replacement ${String(index)} path segment ${String(segmentIndex)} must be a string or non-negative safe integer.`);
  }));
}
function parsePrimitiveReplacements(input) {
  const values = denseStandardArrayValues(input, "Replacements", DIRECT_STORE_MAX_REPLACEMENTS);
  if (values.length === 0) {
    replacementFailure(`A replacement transaction must contain 1 through ${String(DIRECT_STORE_MAX_REPLACEMENTS)} entries.`);
  }
  const budget = {
    expectedStringBytes: 0,
    pathStringBytes: 0,
    valueStringBytes: 0
  };
  return Object.freeze(values.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !standardRecord(value)) {
      replacementFailure(`Replacement ${String(index)} must be a standard or null-prototype object.`);
    }
    exactEnumerableKeys(value, ["expected", "path", "value"], `Replacement ${String(index)}`);
    return Object.freeze({
      expected: replacementPrimitive(ownEnumerableDataValue(value, "expected"), `Replacement ${String(index)} expected value`, budget, "expectedStringBytes"),
      path: replacementPath(ownEnumerableDataValue(value, "path"), index, budget),
      value: replacementPrimitive(ownEnumerableDataValue(value, "value"), `Replacement ${String(index)} value`, budget, "valueStringBytes")
    });
  }));
}
function replacementTrie(replacements) {
  const root = { children: new Map, replacement: null };
  for (const replacement of replacements) {
    let node = root;
    for (const segment of replacement.path) {
      if (node.replacement !== null) {
        replacementFailure("Replacement paths cannot overlap.");
      }
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map, replacement: null };
        node.children.set(segment, child);
      }
      node = child;
    }
    if (node.replacement !== null) {
      replacementFailure("Replacement paths cannot be duplicated.");
    }
    if (node.children.size > 0) {
      replacementFailure("Replacement paths cannot overlap.");
    }
    node.replacement = replacement;
  }
  return root;
}
function samePrimitive(left, right) {
  return left === right;
}
function primitiveShapeMatches(current, replacement) {
  return current === null ? replacement === null : replacement !== null && typeof current === typeof replacement;
}
function replacedJsonValue(current, node, path) {
  if (node.replacement !== null) {
    if (current !== null && typeof current === "object") {
      return replacementFailure(`${path} is a container, not a primitive leaf.`);
    }
    if (!samePrimitive(current, node.replacement.expected)) {
      return replacementFailure(`${path} no longer matches its expected value.`);
    }
    if (!primitiveShapeMatches(current, node.replacement.value)) {
      return replacementFailure(`${path} replacement would change the JSON shape.`);
    }
    return node.replacement.value;
  }
  if (current === null || typeof current !== "object") {
    return replacementFailure(`${path} is a primitive and cannot contain a replacement path.`);
  }
  if (isJsonArray(current)) {
    const next2 = [...current];
    for (const [segment, child] of node.children) {
      if (typeof segment !== "number" || !Number.isSafeInteger(segment) || segment < 0 || segment >= current.length) {
        return replacementFailure(`${path} requires an existing numeric array index.`);
      }
      const currentValue = current[segment];
      if (currentValue === undefined) {
        return replacementFailure(`${path} requires an existing numeric array index.`);
      }
      next2[segment] = replacedJsonValue(currentValue, child, `${path}[${String(segment)}]`);
    }
    return Object.freeze(next2);
  }
  const prototype = Object.getPrototypeOf(current);
  if (prototype !== Object.prototype && prototype !== null) {
    return replacementFailure(`${path} is not a standard JSON object.`);
  }
  const record = current;
  const next = prototype === null ? Object.create(null) : {};
  for (const key of Object.keys(record)) {
    const child = node.children.get(key);
    const currentValue = record[key];
    if (currentValue === undefined) {
      return replacementFailure(`${path} requires an existing string-keyed property.`);
    }
    Object.defineProperty(next, key, {
      configurable: true,
      enumerable: true,
      value: child === undefined ? currentValue : replacedJsonValue(currentValue, child, `${path}.${key}`),
      writable: true
    });
  }
  for (const segment of node.children.keys()) {
    if (typeof segment !== "string" || !Object.hasOwn(record, segment)) {
      return replacementFailure(`${path} requires an existing string-keyed property.`);
    }
  }
  return Object.freeze(next);
}
function applyPrimitiveReplacements(world, replacements) {
  const trie = replacementTrie(replacements);
  const stringByteDelta = replacements.reduce((delta, replacement) => delta + (typeof replacement.value === "string" ? utf8ByteLength(replacement.value) : 0) - (typeof replacement.expected === "string" ? utf8ByteLength(replacement.expected) : 0), 0);
  if (stringByteDelta > 0) {
    replacementFailure("Primitive replacements cannot increase aggregate raw UTF-8 string bytes.");
  }
  return replacedJsonValue(world, trie, "$");
}
function generation(value) {
  return value;
}
function activity(active, started, settled) {
  return Object.freeze({ active, started, settled });
}
function storeSnapshot(currentGeneration, revision, world, currentActivity) {
  return Object.freeze({ generation: currentGeneration, revision, world, activity: currentActivity });
}
function isPromiseLike(value) {
  return (typeof value === "object" && value !== null || typeof value === "function") && typeof Reflect.get(value, "then") === "function";
}
function createDirectStore(initialWorld, parseWorld, options = {}) {
  const initial = parseAndCloneWorld(initialWorld, parseWorld);
  if (!initial.ok) {
    return err(storeError("invalid-world", initial.error.message));
  }
  let currentGeneration = generation(1);
  let revision = 0;
  let currentActivity = activity(0, 0, 0);
  let snapshot = storeSnapshot(currentGeneration, revision, initial.value, currentActivity);
  const listeners = new Set;
  const activeOperations = new Set;
  let onListenerError;
  let validateReplacements;
  try {
    onListenerError = options.onListenerError;
    validateReplacements = options.validateReplacements;
  } catch (reason) {
    return err(storeError("invalid-world", renderUnknownReason(reason, "Direct store options could not be inspected")));
  }
  if (onListenerError !== undefined && typeof onListenerError !== "function") {
    return err(storeError("invalid-world", "Direct listener error reporting must be callable."));
  }
  if (validateReplacements !== undefined && typeof validateReplacements !== "function") {
    return err(storeError("invalid-world", "Direct replacement validation must be callable."));
  }
  const reportListenerError = (reason) => {
    if (onListenerError === undefined)
      return;
    try {
      const returned = onListenerError(reason);
      if (isPromiseLike(returned)) {
        Promise.resolve(returned).catch(() => {
          return;
        });
      }
    } catch {}
  };
  const publish = (world = snapshot.world) => {
    revision += 1;
    const committed = storeSnapshot(currentGeneration, revision, world, currentActivity);
    snapshot = committed;
    for (const listener of [...listeners]) {
      try {
        const returned = listener();
        if (isPromiseLike(returned)) {
          Promise.resolve(returned).catch(reportListenerError);
        }
      } catch (reason) {
        reportListenerError(reason);
      }
    }
    return committed;
  };
  const stale = (expected, operation = null) => expected === currentGeneration ? null : storeError("stale-generation", `Generation ${String(expected)} is stale; current generation is ${String(currentGeneration)}`, operation);
  const validateOperation = (candidate) => {
    const parsed = parseOperationId(candidate);
    return parsed.ok ? ok(parsed.value) : err(storeError("invalid-operation", parsed.error.message));
  };
  const settleActivity = (expected, candidate) => {
    const operation = validateOperation(candidate);
    if (!operation.ok) {
      return operation;
    }
    const staleError = stale(expected, operation.value);
    if (staleError !== null) {
      return err(staleError);
    }
    if (!activeOperations.delete(operation.value)) {
      return err(storeError("activity-not-found", `Activity is not active: ${operation.value}`, operation.value));
    }
    currentActivity = activity(currentActivity.active - 1, currentActivity.started, currentActivity.settled + 1);
    return ok(publish());
  };
  const store = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    transact: (expected, candidate, update) => {
      const operation = validateOperation(candidate);
      if (!operation.ok) {
        return operation;
      }
      const staleError = stale(expected, operation.value);
      if (staleError !== null) {
        return err(staleError);
      }
      const baseSnapshot = snapshot;
      const cloned = cloneJson(snapshot.world);
      if (!cloned.ok) {
        return err(storeError("invalid-world", cloned.error.message, operation.value));
      }
      let candidateWorld;
      try {
        const draft = cloned.value;
        const returned = update(draft);
        candidateWorld = returned === undefined ? draft : returned;
      } catch (reason) {
        return err(storeError("transaction-failed", renderUnknownReason(reason), operation.value));
      }
      const validated = parseAndCloneWorld(candidateWorld, parseWorld);
      if (!validated.ok) {
        return err(storeError("invalid-world", validated.error.message, operation.value));
      }
      const nextStaleError = stale(expected, operation.value);
      if (nextStaleError !== null) {
        return err(nextStaleError);
      }
      if (snapshot !== baseSnapshot) {
        return err(storeError("transaction-conflict", `Store revision changed during transaction ${operation.value}`, operation.value));
      }
      return ok(publish(validated.value));
    },
    transactReplacements: (expected, candidate, input) => {
      const operation = validateOperation(candidate);
      if (!operation.ok) {
        return operation;
      }
      const staleError = stale(expected, operation.value);
      if (staleError !== null) {
        return err(staleError);
      }
      if (validateReplacements === undefined) {
        return err(storeError("invalid-world", "This Direct store does not define a primitive replacement validator.", operation.value));
      }
      const baseSnapshot = snapshot;
      let replacements;
      let candidateWorld;
      try {
        replacements = parsePrimitiveReplacements(input);
        candidateWorld = applyPrimitiveReplacements(baseSnapshot.world, replacements);
        const returned = validateReplacements(Object.freeze({
          baseWorld: baseSnapshot.world,
          candidateWorld,
          generation: expected,
          operation: operation.value,
          replacements
        }));
        if (returned !== undefined) {
          if (isPromiseLike(returned)) {
            Promise.resolve(returned).catch(() => {
              return;
            });
          }
          throw new TypeError("Direct replacement validation must complete synchronously and return undefined.");
        }
      } catch (reason) {
        return err(storeError("invalid-world", renderUnknownReason(reason, "Direct primitive replacements are invalid"), operation.value));
      }
      const nextStaleError = stale(expected, operation.value);
      if (nextStaleError !== null) {
        return err(nextStaleError);
      }
      if (snapshot !== baseSnapshot) {
        return err(storeError("transaction-conflict", `Store revision changed during transaction ${operation.value}`, operation.value));
      }
      return ok(publish(candidateWorld));
    },
    reset: (world) => {
      const validated = parseAndCloneWorld(world, parseWorld);
      if (!validated.ok) {
        return err(storeError("invalid-world", validated.error.message));
      }
      const nextGeneration = Number(currentGeneration) + 1;
      if (!Number.isSafeInteger(nextGeneration)) {
        return err(storeError("generation-overflow", "Store generation exceeds the safe integer range"));
      }
      currentGeneration = generation(nextGeneration);
      activeOperations.clear();
      currentActivity = activity(0, 0, 0);
      return ok(publish(validated.value));
    },
    beginActivity: (expected, candidate) => {
      const operation = validateOperation(candidate);
      if (!operation.ok) {
        return operation;
      }
      const staleError = stale(expected, operation.value);
      if (staleError !== null) {
        return err(staleError);
      }
      if (activeOperations.has(operation.value)) {
        return err(storeError("duplicate-activity", `Activity is already active: ${operation.value}`, operation.value));
      }
      activeOperations.add(operation.value);
      currentActivity = activity(currentActivity.active + 1, currentActivity.started + 1, currentActivity.settled);
      publish();
      const lease = Object.freeze({
        generation: expected,
        operation: operation.value,
        settle: () => settleActivity(expected, operation.value)
      });
      return ok(lease);
    },
    settleActivity,
    isQuiescent: (expected) => {
      const staleError = stale(expected);
      return staleError === null ? ok(currentActivity.active === 0) : err(staleError);
    },
    whenQuiescent: (expected) => {
      const staleError = stale(expected);
      if (staleError !== null) {
        return Promise.resolve(err(staleError));
      }
      if (currentActivity.active === 0) {
        return Promise.resolve(ok(snapshot));
      }
      return new Promise((resolve) => {
        const unsubscribe = store.subscribe(() => {
          const nextStaleError = stale(expected);
          if (nextStaleError !== null) {
            unsubscribe();
            resolve(err(nextStaleError));
          } else if (currentActivity.active === 0) {
            unsubscribe();
            resolve(ok(snapshot));
          }
        });
      });
    }
  };
  return ok(Object.freeze(store));
}

export { DIRECT_STORE_MAX_REPLACEMENTS, DIRECT_STORE_MAX_REPLACEMENT_PATH_DEPTH, createDirectStore };
