import { parseOperationId, type OperationId } from "./ids.js";
import {
  cloneJson,
  DEFAULT_JSON_LIMITS,
  parseAndCloneWorld,
  utf8ByteLength,
  type WorldParser,
} from "./json.js";
import type { JsonArray, JsonPrimitive, JsonValue } from "./json-value.js";
import { renderUnknownReason } from "./reason.js";
import { err, ok, type Result } from "./result.js";

declare const generationBrand: unique symbol;
export type StoreGeneration = number & { readonly [generationBrand]: "StoreGeneration" };

export interface ActivitySnapshot {
  readonly active: number;
  readonly started: number;
  readonly settled: number;
}

export interface DirectStoreSnapshot<World extends JsonValue> {
  readonly generation: StoreGeneration;
  readonly revision: number;
  readonly world: World;
  readonly activity: ActivitySnapshot;
}

export type StoreErrorCode =
  | "activity-not-found"
  | "duplicate-activity"
  | "generation-overflow"
  | "invalid-operation"
  | "invalid-world"
  | "stale-generation"
  | "transaction-conflict"
  | "transaction-failed";

export interface StoreError {
  readonly code: StoreErrorCode;
  readonly message: string;
  readonly operation: OperationId | null;
}

export interface TypedActivityLease<World extends JsonValue> {
  readonly generation: StoreGeneration;
  readonly operation: OperationId;
  readonly settle: () => Result<DirectStoreSnapshot<World>, StoreError>;
}

export interface DirectStore<World extends JsonValue> {
  readonly getSnapshot: () => DirectStoreSnapshot<World>;
  readonly subscribe: (listener: () => void | PromiseLike<void>) => () => void;
  readonly transact: (
    generation: StoreGeneration,
    operation: OperationId,
    update: (draft: World) => World | void,
  ) => Result<DirectStoreSnapshot<World>, StoreError>;
  readonly transactReplacements: (
    generation: StoreGeneration,
    operation: OperationId,
    replacements: readonly DirectStorePrimitiveReplacement[],
  ) => Result<DirectStoreSnapshot<World>, StoreError>;
  readonly reset: (world: World) => Result<DirectStoreSnapshot<World>, StoreError>;
  readonly beginActivity: (
    generation: StoreGeneration,
    operation: OperationId,
  ) => Result<TypedActivityLease<World>, StoreError>;
  readonly settleActivity: (
    generation: StoreGeneration,
    operation: OperationId,
  ) => Result<DirectStoreSnapshot<World>, StoreError>;
  readonly isQuiescent: (generation: StoreGeneration) => Result<boolean, StoreError>;
  readonly whenQuiescent: (
    generation: StoreGeneration,
  ) => Promise<Result<DirectStoreSnapshot<World>, StoreError>>;
}

export const DIRECT_STORE_MAX_REPLACEMENTS = 32;
export const DIRECT_STORE_MAX_REPLACEMENT_PATH_DEPTH = 32;

export type DirectStoreReplacementPathSegment = number | string;

export interface DirectStorePrimitiveReplacement {
  readonly expected: JsonPrimitive;
  readonly path: readonly DirectStoreReplacementPathSegment[];
  readonly value: JsonPrimitive;
}

export interface DirectStoreReplacementValidationContext<
  World extends JsonValue,
> {
  readonly baseWorld: World;
  readonly candidateWorld: World;
  readonly generation: StoreGeneration;
  readonly operation: OperationId;
  readonly replacements: readonly DirectStorePrimitiveReplacement[];
}

export type DirectStoreReplacementValidator<World extends JsonValue> = (
  context: DirectStoreReplacementValidationContext<World>,
) => undefined;

export interface DirectStoreOptions<World extends JsonValue = JsonValue> {
  /** Listener failures are isolated from committed state and reported here. */
  readonly onListenerError?: (reason: unknown) => void;
  /**
   * Optional app-owned semantic gate for bounded primitive-leaf replacements.
   * It is captured once at store construction and must return `undefined`.
   */
  readonly validateReplacements?: DirectStoreReplacementValidator<World>;
}

function storeError(code: StoreErrorCode, message: string, operation: OperationId | null = null): StoreError {
  return { code, message, operation };
}

type ReplacementTrieNode = {
  readonly children: Map<DirectStoreReplacementPathSegment, ReplacementTrieNode>;
  replacement: DirectStorePrimitiveReplacement | null;
};

type ReplacementInputBudget = {
  expectedStringBytes: number;
  pathStringBytes: number;
  valueStringBytes: number;
};

function replacementFailure(message: string): never {
  throw new TypeError(message);
}

function standardRecord(input: object): boolean {
  const prototype = Object.getPrototypeOf(input) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isJsonArray(input: JsonValue): input is JsonArray {
  return Array.isArray(input);
}

function ownEnumerableDataValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key);
  if (
    descriptor === undefined
    || descriptor.enumerable !== true
    || !("value" in descriptor)
  ) {
    replacementFailure(`Replacement property ${JSON.stringify(key)} must be an own enumerable data property.`);
  }
  return descriptor.value;
}

function exactEnumerableKeys(
  input: object,
  expected: readonly string[],
  label: string,
): void {
  if (Object.getOwnPropertySymbols(input).length > 0) {
    replacementFailure(`${label} cannot contain symbol properties.`);
  }
  const keys = Object.keys(input);
  const ownKeys = Reflect.ownKeys(input);
  if (
    keys.length !== expected.length
    || ownKeys.length !== expected.length
    || expected.some(key => !Object.hasOwn(input, key))
  ) {
    replacementFailure(`${label} must contain exactly ${expected.join(", ")}.`);
  }
  for (const key of expected) ownEnumerableDataValue(input, key);
}

function denseStandardArrayValues(
  input: unknown,
  label: string,
  maximumLength: number,
): unknown[] {
  if (
    !Array.isArray(input)
    || Object.getPrototypeOf(input) !== Array.prototype
  ) {
    replacementFailure(`${label} must be a standard array.`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, "length");
  if (
    lengthDescriptor === undefined
    || !("value" in lengthDescriptor)
  ) {
    replacementFailure(
      `${label} must have a data length from 0 through ${String(maximumLength)}.`,
    );
  }
  const lengthValue = lengthDescriptor.value as unknown;
  if (
    typeof lengthValue !== "number"
    || !Number.isSafeInteger(lengthValue)
    || lengthValue < 0
    || lengthValue > maximumLength
  ) {
    replacementFailure(
      `${label} must have a data length from 0 through ${String(maximumLength)}.`,
    );
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

function consumeReplacementString(
  value: string,
  label: string,
  budget: ReplacementInputBudget,
  budgetKey: keyof ReplacementInputBudget,
): string {
  budget[budgetKey] += utf8ByteLength(value);
  if (budget[budgetKey] > DEFAULT_JSON_LIMITS.maxStringBytes) {
    replacementFailure(`${label} exceeds the replacement string byte limit.`);
  }
  return value;
}

function replacementPrimitive(
  input: unknown,
  label: string,
  budget: ReplacementInputBudget,
  budgetKey: "expectedStringBytes" | "valueStringBytes",
): JsonPrimitive {
  if (input === null || typeof input === "boolean") return input;
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

function replacementPath(
  input: unknown,
  index: number,
  budget: ReplacementInputBudget,
): readonly DirectStoreReplacementPathSegment[] {
  const values = denseStandardArrayValues(
    input,
    `Replacement ${String(index)} path`,
    DIRECT_STORE_MAX_REPLACEMENT_PATH_DEPTH,
  );
  if (values.length === 0) {
    replacementFailure(
      `Replacement ${String(index)} path must contain 1 through ${String(DIRECT_STORE_MAX_REPLACEMENT_PATH_DEPTH)} segments.`,
    );
  }
  return Object.freeze(values.map((segment, segmentIndex) => {
    if (typeof segment === "string") {
      return consumeReplacementString(
        segment,
        `Replacement ${String(index)} path segment ${String(segmentIndex)}`,
        budget,
        "pathStringBytes",
      );
    }
    if (
      typeof segment === "number"
      && Number.isSafeInteger(segment)
      && segment >= 0
      && !Object.is(segment, -0)
    ) {
      return segment;
    }
    return replacementFailure(
      `Replacement ${String(index)} path segment ${String(segmentIndex)} must be a string or non-negative safe integer.`,
    );
  }));
}

function parsePrimitiveReplacements(
  input: unknown,
): readonly DirectStorePrimitiveReplacement[] {
  const values = denseStandardArrayValues(
    input,
    "Replacements",
    DIRECT_STORE_MAX_REPLACEMENTS,
  );
  if (values.length === 0) {
    replacementFailure(
      `A replacement transaction must contain 1 through ${String(DIRECT_STORE_MAX_REPLACEMENTS)} entries.`,
    );
  }
  const budget: ReplacementInputBudget = {
    expectedStringBytes: 0,
    pathStringBytes: 0,
    valueStringBytes: 0,
  };
  return Object.freeze(values.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value) || !standardRecord(value)) {
      replacementFailure(`Replacement ${String(index)} must be a standard or null-prototype object.`);
    }
    exactEnumerableKeys(value, ["expected", "path", "value"], `Replacement ${String(index)}`);
    return Object.freeze({
      expected: replacementPrimitive(
        ownEnumerableDataValue(value, "expected"),
        `Replacement ${String(index)} expected value`,
        budget,
        "expectedStringBytes",
      ),
      path: replacementPath(
        ownEnumerableDataValue(value, "path"),
        index,
        budget,
      ),
      value: replacementPrimitive(
        ownEnumerableDataValue(value, "value"),
        `Replacement ${String(index)} value`,
        budget,
        "valueStringBytes",
      ),
    });
  }));
}

function replacementTrie(
  replacements: readonly DirectStorePrimitiveReplacement[],
): ReplacementTrieNode {
  const root: ReplacementTrieNode = { children: new Map(), replacement: null };
  for (const replacement of replacements) {
    let node = root;
    for (const segment of replacement.path) {
      if (node.replacement !== null) {
        replacementFailure("Replacement paths cannot overlap.");
      }
      let child = node.children.get(segment);
      if (child === undefined) {
        child = { children: new Map(), replacement: null };
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

function samePrimitive(left: JsonPrimitive, right: JsonPrimitive): boolean {
  return left === right;
}

function primitiveShapeMatches(
  current: JsonPrimitive,
  replacement: JsonPrimitive,
): boolean {
  return current === null
    ? replacement === null
    : replacement !== null && typeof current === typeof replacement;
}

function replacedJsonValue(
  current: JsonValue,
  node: ReplacementTrieNode,
  path: string,
): JsonValue {
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
    const next: JsonValue[] = [...current];
    for (const [segment, child] of node.children) {
      if (
        typeof segment !== "number"
        || !Number.isSafeInteger(segment)
        || segment < 0
        || segment >= current.length
      ) {
        return replacementFailure(`${path} requires an existing numeric array index.`);
      }
      const currentValue = current[segment];
      if (currentValue === undefined) {
        return replacementFailure(`${path} requires an existing numeric array index.`);
      }
      next[segment] = replacedJsonValue(
        currentValue,
        child,
        `${path}[${String(segment)}]`,
      );
    }
    return Object.freeze(next);
  }

  const prototype = Object.getPrototypeOf(current) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return replacementFailure(`${path} is not a standard JSON object.`);
  }
  const record = current as Readonly<Record<string, JsonValue>>;
  const next = (
    prototype === null ? Object.create(null) : {}
  ) as Record<string, JsonValue>;
  for (const key of Object.keys(record)) {
    const child = node.children.get(key);
    const currentValue = record[key];
    if (currentValue === undefined) {
      return replacementFailure(`${path} requires an existing string-keyed property.`);
    }
    Object.defineProperty(next, key, {
      configurable: true,
      enumerable: true,
      value: child === undefined
        ? currentValue
        : replacedJsonValue(currentValue, child, `${path}.${key}`),
      writable: true,
    });
  }
  for (const segment of node.children.keys()) {
    if (typeof segment !== "string" || !Object.hasOwn(record, segment)) {
      return replacementFailure(`${path} requires an existing string-keyed property.`);
    }
  }
  return Object.freeze(next);
}

function applyPrimitiveReplacements<World extends JsonValue>(
  world: World,
  replacements: readonly DirectStorePrimitiveReplacement[],
): World {
  const trie = replacementTrie(replacements);
  const stringByteDelta = replacements.reduce((delta, replacement) => (
    delta
      + (typeof replacement.value === "string"
        ? utf8ByteLength(replacement.value)
        : 0)
      - (typeof replacement.expected === "string"
        ? utf8ByteLength(replacement.expected)
        : 0)
  ), 0);
  if (stringByteDelta > 0) {
    replacementFailure(
      "Primitive replacements cannot increase aggregate raw UTF-8 string bytes.",
    );
  }
  return replacedJsonValue(world, trie, "$") as World;
}

function generation(value: number): StoreGeneration {
  return value as StoreGeneration;
}

function activity(active: number, started: number, settled: number): ActivitySnapshot {
  return Object.freeze({ active, started, settled });
}

function storeSnapshot<World extends JsonValue>(
  currentGeneration: StoreGeneration,
  revision: number,
  world: World,
  currentActivity: ActivitySnapshot,
): DirectStoreSnapshot<World> {
  return Object.freeze({ generation: currentGeneration, revision, world, activity: currentActivity });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof Reflect.get(value, "then") === "function";
}

export function createDirectStore<World extends JsonValue>(
  initialWorld: World,
  parseWorld: WorldParser<World>,
  options: DirectStoreOptions<World> = {},
): Result<DirectStore<World>, StoreError> {
  const initial = parseAndCloneWorld(initialWorld, parseWorld);
  if (!initial.ok) {
    return err(storeError("invalid-world", initial.error.message));
  }

  let currentGeneration = generation(1);
  let revision = 0;
  let currentActivity = activity(0, 0, 0);
  let snapshot = storeSnapshot(currentGeneration, revision, initial.value, currentActivity);
  const listeners = new Set<() => void | PromiseLike<void>>();
  const activeOperations = new Set<OperationId>();
  let onListenerError: DirectStoreOptions<World>["onListenerError"];
  let validateReplacements:
    DirectStoreOptions<World>["validateReplacements"];
  try {
    onListenerError = options.onListenerError;
    validateReplacements = options.validateReplacements;
  } catch (reason) {
    return err(storeError(
      "invalid-world",
      renderUnknownReason(reason, "Direct store options could not be inspected"),
    ));
  }
  if (
    onListenerError !== undefined
    && typeof onListenerError !== "function"
  ) {
    return err(storeError("invalid-world", "Direct listener error reporting must be callable."));
  }
  if (
    validateReplacements !== undefined
    && typeof validateReplacements !== "function"
  ) {
    return err(storeError("invalid-world", "Direct replacement validation must be callable."));
  }

  const reportListenerError = (reason: unknown): void => {
    if (onListenerError === undefined) return;
    try {
      const returned: unknown = onListenerError(reason);
      if (isPromiseLike(returned)) {
        void Promise.resolve(returned).catch(() => undefined);
      }
    } catch {
      // A reporter is another listener boundary and cannot roll back committed state.
    }
  };

  const publish = (world: World = snapshot.world): DirectStoreSnapshot<World> => {
    revision += 1;
    const committed = storeSnapshot(currentGeneration, revision, world, currentActivity);
    snapshot = committed;
    for (const listener of [...listeners]) {
      try {
        const returned: unknown = listener();
        if (isPromiseLike(returned)) {
          void Promise.resolve(returned).catch(reportListenerError);
        }
      } catch (reason) {
        reportListenerError(reason);
      }
    }
    return committed;
  };

  const stale = (expected: StoreGeneration, operation: OperationId | null = null): StoreError | null => (
    expected === currentGeneration
      ? null
      : storeError(
        "stale-generation",
        `Generation ${String(expected)} is stale; current generation is ${String(currentGeneration)}`,
        operation,
      )
  );

  const validateOperation = (candidate: OperationId): Result<OperationId, StoreError> => {
    const parsed = parseOperationId(candidate);
    return parsed.ok
      ? ok(parsed.value)
      : err(storeError("invalid-operation", parsed.error.message));
  };

  const settleActivity = (
    expected: StoreGeneration,
    candidate: OperationId,
  ): Result<DirectStoreSnapshot<World>, StoreError> => {
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
    currentActivity = activity(
      currentActivity.active - 1,
      currentActivity.started,
      currentActivity.settled + 1,
    );
    return ok(publish());
  };

  const store: DirectStore<World> = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void | PromiseLike<void>) => {
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
      let candidateWorld: World;
      try {
        // The current snapshot already passed parseWorld. Its JSON clone is an
        // owned mutable draft and cannot alias a value returned by the parser.
        const draft = cloned.value as World;
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
        return err(storeError(
          "transaction-conflict",
          `Store revision changed during transaction ${operation.value}`,
          operation.value,
        ));
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
        return err(storeError(
          "invalid-world",
          "This Direct store does not define a primitive replacement validator.",
          operation.value,
        ));
      }
      const baseSnapshot = snapshot;
      let replacements: readonly DirectStorePrimitiveReplacement[];
      let candidateWorld: World;
      try {
        replacements = parsePrimitiveReplacements(input);
        candidateWorld = applyPrimitiveReplacements(
          baseSnapshot.world,
          replacements,
        );
        const returned: unknown = validateReplacements(Object.freeze({
          baseWorld: baseSnapshot.world,
          candidateWorld,
          generation: expected,
          operation: operation.value,
          replacements,
        }));
        if (returned !== undefined) {
          if (isPromiseLike(returned)) {
            void Promise.resolve(returned).catch(() => undefined);
          }
          throw new TypeError(
            "Direct replacement validation must complete synchronously and return undefined.",
          );
        }
      } catch (reason) {
        return err(storeError(
          "invalid-world",
          renderUnknownReason(reason, "Direct primitive replacements are invalid"),
          operation.value,
        ));
      }
      const nextStaleError = stale(expected, operation.value);
      if (nextStaleError !== null) {
        return err(nextStaleError);
      }
      if (snapshot !== baseSnapshot) {
        return err(storeError(
          "transaction-conflict",
          `Store revision changed during transaction ${operation.value}`,
          operation.value,
        ));
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
      currentActivity = activity(
        currentActivity.active + 1,
        currentActivity.started + 1,
        currentActivity.settled,
      );
      publish();
      const lease: TypedActivityLease<World> = Object.freeze({
        generation: expected,
        operation: operation.value,
        settle: () => settleActivity(expected, operation.value),
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
    },
  };

  return ok(Object.freeze(store));
}
