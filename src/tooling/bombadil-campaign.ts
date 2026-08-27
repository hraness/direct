/* eslint-disable @typescript-eslint/triple-slash-reference */
/// <reference path="./bombadil-internal.d.ts" />
/* eslint-enable @typescript-eslint/triple-slash-reference */

import {
  actions,
  always,
  eventually,
  extract,
  weighted,
  type ActionGenerator,
  type Formula,
  type JSON as BombadilJson,
  type Tree,
} from "@antithesishq/bombadil";
import type {
  ActionTemplate,
  State as BombadilBrowserState,
} from "@antithesishq/bombadil/browser";
import {
  clicks,
  inputs,
  scroll,
} from "@antithesishq/bombadil/browser/defaults/actions";

const DIRECT_BROWSER_BRIDGE_SCHEMA = "direct.browser-bridge/v2";
const DIRECT_SESSION_MANIFEST_SCHEMA = "direct.session-manifest/v1";
const DIRECT_PROBE_SCHEMA = "direct.probe/v1";
const MAX_RAW_CONTRACT_CHARACTERS = 2_000_000;
const BRIDGE_KEYS = new Set(["manifest", "reset", "schema", "snapshot"]);
const UNSAFE_CLICK_INPUT_TYPES = new Set(["image", "reset", "submit"]);

export interface DirectBombadilObservation {
  readonly [key: string | number | symbol]: BombadilJson;
  readonly activationHash: string;
  readonly activeRoute: string;
  readonly activeScenario: string;
  readonly activeSource: string;
  readonly bridgePresent: boolean;
  readonly bridgeSchema: string;
  readonly catalogHash: string;
  readonly contractValid: boolean;
  readonly isQuiescent: boolean;
  readonly manifest: BombadilJson;
  readonly probe: BombadilJson;
  readonly violations: number[];
  readonly violationsValid: boolean;
}

export interface DirectBombadilProperties {
  readonly exactContract: Formula;
  readonly stableCatalog: Formula;
  readonly noDeclaredViolations: Formula;
  readonly eventualQuiescence: Formula;
}

function safeClickAction(action: ActionTemplate): boolean {
  if (typeof action !== "object" || action === null) return false;
  const candidate = "Click" in action
    ? action.Click
    : "DoubleClick" in action
      ? action.DoubleClick
      : null;
  if (candidate === null) return false;
  const { fingerprint } = candidate;
  const tag = fingerprint.tag.toLowerCase();
  const inputType = fingerprint.inputType?.toLowerCase() ?? "";
  const labels = [fingerprint.accessibleName, fingerprint.textContent]
    .filter((label): label is string => label !== null)
    .map((label) => label.trim().toLowerCase());
  return fingerprint.href === null
    && tag !== "a"
    && fingerprint.role?.toLowerCase() !== "link"
    && !labels.includes("reset")
    && !UNSAFE_CLICK_INPUT_TYPES.has(inputType)
    && (tag !== "button" || inputType === "button");
}

function safeInputAction(action: ActionTemplate): boolean {
  return !(
    typeof action === "object"
    && action !== null
    && "PressKey" in action
    && action.PressKey.code === 13
  );
}

function pruneActionTree<Action>(
  tree: Tree<Action>,
  keep: (action: Action) => boolean,
): Tree<Action> | null {
  if ("value" in tree) return keep(tree.value) ? tree : null;
  const branches: [number, Tree<Action>][] = [];
  for (const [weight, child] of tree.branches) {
    const filtered = pruneActionTree(child, keep);
    if (filtered !== null) branches.push([weight, filtered]);
  }
  return branches.length === 0 ? null : { branches };
}

/**
 * Builds a browser action generator without reload/history actions or visible
 * navigation and submission click targets, keeping Direct continuously bound.
 */
export function createDirectBombadilActions(): ActionGenerator<ActionTemplate> {
  const safeClicks = actions(() => pruneActionTree(clicks.generate(), safeClickAction) ?? []);
  const safeInputs = actions(() => pruneActionTree(inputs.generate(), safeInputAction) ?? []);
  const wait = actions<ActionTemplate>(() => ["Wait"]);
  return weighted([
    [4, safeClicks],
    [3, safeInputs],
    [2, scroll],
    [1, wait],
  ]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function invalidObservation(bridgePresent = false): DirectBombadilObservation {
  return {
    activationHash: "",
    activeRoute: "",
    activeScenario: "",
    activeSource: "",
    bridgePresent,
    bridgeSchema: "",
    catalogHash: "",
    contractValid: false,
    isQuiescent: false,
    manifest: null,
    probe: null,
    violations: [],
    violationsValid: false,
  };
}

function boundedJsonClone(value: unknown): BombadilJson | null {
  const source = JSON.stringify(value);
  if (source === undefined || source.length > MAX_RAW_CONTRACT_CHARACTERS) return null;
  return JSON.parse(source) as BombadilJson;
}

function readNonNegativeCounters(value: unknown): {
  readonly valid: boolean;
  readonly values: number[];
} {
  if (!isRecord(value)) return { valid: false, values: [] };
  const values = Object.values(value);
  if (!values.every((candidate) =>
    typeof candidate === "number"
    && Number.isSafeInteger(candidate)
    && candidate >= 0
  )) {
    return { valid: false, values: [] };
  }
  return { valid: true, values: values as number[] };
}

/**
 * Reads the foreign Direct browser boundary without allowing a hostile getter,
 * proxy, or snapshot callback to escape the extractor.
 *
 * The extractor intentionally retains bounded raw contracts. The host runner
 * applies Direct's canonical manifest and probe parsers to every trace sample.
 */
export function readDirectBombadilObservation(
  windowValue: unknown,
): DirectBombadilObservation {
  let bridgePresent = false;
  try {
    if (!isRecord(windowValue)) return invalidObservation();
    bridgePresent = Object.hasOwn(windowValue, "__direct");
    if (!bridgePresent) return invalidObservation();
    const bridge = Reflect.get(windowValue, "__direct");
    if (!isRecord(bridge) || !hasExactKeys(bridge, BRIDGE_KEYS)) {
      return invalidObservation(true);
    }

    if (
      bridge.schema !== DIRECT_BROWSER_BRIDGE_SCHEMA
      || typeof bridge.reset !== "function"
      || typeof bridge.snapshot !== "function"
    ) {
      return invalidObservation(true);
    }

    const manifest = boundedJsonClone(Reflect.get(bridge, "manifest"));
    const snapshot = Reflect.get(bridge, "snapshot");
    if (manifest === null || typeof snapshot !== "function") return invalidObservation(true);
    const probe: unknown = Reflect.apply(snapshot, bridge, []) as unknown;
    const clonedProbe = boundedJsonClone(probe);
    if (clonedProbe === null || !isRecord(manifest) || !isRecord(clonedProbe)) {
      return invalidObservation(true);
    }
    const active: unknown = Reflect.get(manifest, "active");
    if (!isRecord(active)) return invalidObservation(true);
    const violations = readNonNegativeCounters(Reflect.get(clonedProbe, "violations"));
    const activationHash: unknown = Reflect.get(active, "activationHash");
    const probeActivationHash: unknown = Reflect.get(clonedProbe, "activationHash");
    const activeRoute: unknown = Reflect.get(active, "route");
    const activeScenario: unknown = Reflect.get(active, "scenario");
    const activeSource: unknown = Reflect.get(active, "source");
    const catalogHash: unknown = Reflect.get(manifest, "catalogHash");
    const isQuiescent: unknown = Reflect.get(clonedProbe, "isQuiescent");
    const contractValid = Reflect.get(manifest, "schema") === DIRECT_SESSION_MANIFEST_SCHEMA
      && Reflect.get(clonedProbe, "schema") === DIRECT_PROBE_SCHEMA
      && typeof activationHash === "string"
      && activationHash.length > 0
      && probeActivationHash === activationHash
      && typeof activeRoute === "string"
      && activeRoute.length > 0
      && typeof activeScenario === "string"
      && activeScenario.length > 0
      && (activeSource === "scenario" || activeSource === "fixture")
      && typeof catalogHash === "string"
      && catalogHash.length > 0
      && typeof isQuiescent === "boolean"
      && violations.valid;

    return {
      activationHash: typeof activationHash === "string" ? activationHash : "",
      activeRoute: typeof activeRoute === "string" ? activeRoute : "",
      activeScenario: typeof activeScenario === "string" ? activeScenario : "",
      activeSource: typeof activeSource === "string" ? activeSource : "",
      bridgePresent: true,
      bridgeSchema: DIRECT_BROWSER_BRIDGE_SCHEMA,
      catalogHash: typeof catalogHash === "string" ? catalogHash : "",
      contractValid,
      isQuiescent: isQuiescent === true,
      manifest,
      probe: clonedProbe,
      violations: violations.values,
      violationsValid: violations.valid,
    };
  } catch {
    return invalidObservation(bridgePresent);
  }
}

/** Builds the four Direct invariants used by Bombadil browser campaigns. */
export function createDirectBombadilProperties(): DirectBombadilProperties {
  const direct = extract<BombadilBrowserState, DirectBombadilObservation>((state) =>
    readDirectBombadilObservation(state.window)
  ).named("direct");

  const exactContract = always(
    eventually(() =>
      direct.current.contractValid
      && direct.current.activeSource === "scenario"
      && direct.current.activeScenario.length > 0
      && direct.current.activeRoute.length > 0
      && direct.current.activationHash.length > 0
    ).within(10, "seconds"),
  );
  const stableCatalog = always(
    eventually(() =>
      direct.current.contractValid
      && direct.current.catalogHash.length > 0
    ).within(10, "seconds"),
  );
  const noDeclaredViolations = always(
    eventually(() =>
      direct.current.contractValid
      && direct.current.violationsValid
      && direct.current.violations.every((value: number) => value === 0)
    ).within(10, "seconds"),
  );
  const eventualQuiescence = always(
    eventually(() => direct.current.isQuiescent).within(10, "seconds"),
  );

  return Object.freeze({
    exactContract,
    stableCatalog,
    noDeclaredViolations,
    eventualQuiescence,
  });
}
