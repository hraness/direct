export const DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA =
  "direct.named-layout-sample/v1" as const;
export const DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA =
  "direct.named-layout-contract/v1" as const;

const MAX_LAYOUT_BOXES = 128;
const MAX_LAYOUT_RULES = 256;
const MAX_LAYOUT_COORDINATE = 10_000_000;
const MAX_LAYOUT_TOLERANCE = 10_000;
const MAX_LAYOUT_NAME_LENGTH = 128;
const LAYOUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]*$/u;
const RESERVED_LAYOUT_NAMES = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const SAMPLE_KEYS = new Set(["boxes", "schema", "viewport"]);
const VIEWPORT_KEYS = new Set(["height", "width"]);
const BOX_KEYS = new Set(["height", "name", "width", "x", "y"]);
const CONTRACT_KEYS = new Set(["rules", "schema"]);
const INSIDE_RULE_KEYS = new Set([
  "id",
  "inner",
  "kind",
  "outer",
  "tolerance",
]);
const PAIR_RULE_KEYS = new Set([
  "first",
  "id",
  "kind",
  "second",
  "tolerance",
]);
const BOX_TOLERANCE_RULE_KEYS = new Set([
  "box",
  "id",
  "kind",
  "tolerance",
]);
const MINIMUM_SIZE_RULE_KEYS = new Set([
  "box",
  "id",
  "kind",
  "minimumHeight",
  "minimumWidth",
]);

export interface DirectNamedLayoutViewport {
  readonly height: number;
  readonly width: number;
}

export interface DirectNamedLayoutBox {
  readonly height: number;
  readonly name: string;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

export interface DirectNamedLayoutSample {
  readonly boxes: readonly DirectNamedLayoutBox[];
  readonly schema: typeof DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA;
  readonly viewport: DirectNamedLayoutViewport;
}

export interface DirectNamedLayoutInsideRule {
  readonly id: string;
  readonly inner: string;
  readonly kind: "inside";
  readonly outer: string;
  readonly tolerance: number;
}

export interface DirectNamedLayoutNoOverlapRule {
  readonly first: string;
  readonly id: string;
  readonly kind: "no-overlap";
  readonly second: string;
  readonly tolerance: number;
}

export interface DirectNamedLayoutCenterRule {
  readonly first: string;
  readonly id: string;
  readonly kind: "center-x" | "center-y";
  readonly second: string;
  readonly tolerance: number;
}

export interface DirectNamedLayoutNotClippedRule {
  readonly box: string;
  readonly id: string;
  readonly kind: "not-clipped";
  readonly tolerance: number;
}

export interface DirectNamedLayoutMinimumSizeRule {
  readonly box: string;
  readonly id: string;
  readonly kind: "minimum-size";
  readonly minimumHeight: number;
  readonly minimumWidth: number;
}

export interface DirectNamedLayoutStableRule {
  readonly box: string;
  readonly id: string;
  readonly kind: "stable";
  readonly tolerance: number;
}

export type DirectNamedLayoutRule =
  | DirectNamedLayoutInsideRule
  | DirectNamedLayoutNoOverlapRule
  | DirectNamedLayoutCenterRule
  | DirectNamedLayoutNotClippedRule
  | DirectNamedLayoutMinimumSizeRule
  | DirectNamedLayoutStableRule;

export interface DirectNamedLayoutContract {
  readonly rules: readonly DirectNamedLayoutRule[];
  readonly schema: typeof DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA;
}

export interface DirectNamedLayoutParseError {
  readonly code: "invalid-contract" | "invalid-sample";
  readonly message: string;
}

export type DirectNamedLayoutParseResult<Value> =
  | Readonly<{ readonly ok: true; readonly value: Value }>
  | Readonly<{
    readonly error: DirectNamedLayoutParseError;
    readonly ok: false;
  }>;

export type DirectNamedLayoutViolationCode =
  | "clipped"
  | "misaligned"
  | "missing-box"
  | "outside"
  | "overlap"
  | "second-sample-required"
  | "too-small"
  | "unstable"
  | "viewport-changed";

export interface DirectNamedLayoutViolation {
  readonly code: DirectNamedLayoutViolationCode;
  readonly message: string;
  readonly ruleId: string;
  readonly ruleKind: DirectNamedLayoutRule["kind"];
  readonly sample: "first" | "pair" | "second";
}

export interface DirectNamedLayoutValidation {
  readonly ok: boolean;
  readonly violations: readonly DirectNamedLayoutViolation[];
}

class NamedLayoutInputError extends Error {}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireExactRecord(
  value: unknown,
  expected: ReadonlySet<string>,
  label: string,
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new NamedLayoutInputError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  if (
    keys.length !== expected.size
    || keys.some((key) => !expected.has(key))
    || [...expected].some((key) => !Object.hasOwn(value, key))
  ) {
    throw new NamedLayoutInputError(
      `${label} must contain exactly: ${[...expected].sort().join(", ")}`,
    );
  }
  return value;
}

function requireLayoutName(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length > MAX_LAYOUT_NAME_LENGTH
    || !LAYOUT_NAME_PATTERN.test(value)
    || RESERVED_LAYOUT_NAMES.has(value)
  ) {
    throw new NamedLayoutInputError(
      `${label} must be a safe, unreserved 1-${String(MAX_LAYOUT_NAME_LENGTH)} character identifier`,
    );
  }
  return value;
}

function requireBoundedNumber(options: {
  readonly label: string;
  readonly maximum: number;
  readonly minimum: number;
  readonly value: unknown;
}): number {
  if (
    typeof options.value !== "number"
    || !Number.isFinite(options.value)
    || options.value < options.minimum
    || options.value > options.maximum
  ) {
    throw new NamedLayoutInputError(
      `${options.label} must be a finite number between ${String(options.minimum)} and ${String(options.maximum)}`,
    );
  }
  return options.value;
}

function requireCoordinate(value: unknown, label: string): number {
  return requireBoundedNumber({
    label,
    maximum: MAX_LAYOUT_COORDINATE,
    minimum: -MAX_LAYOUT_COORDINATE,
    value,
  });
}

function requireSize(value: unknown, label: string, positive: boolean): number {
  const size = requireBoundedNumber({
    label,
    maximum: MAX_LAYOUT_COORDINATE,
    minimum: 0,
    value,
  });
  if (positive && size === 0) {
    throw new NamedLayoutInputError(`${label} must be greater than zero`);
  }
  return size;
}

function requireTolerance(value: unknown, label: string): number {
  return requireBoundedNumber({
    label,
    maximum: MAX_LAYOUT_TOLERANCE,
    minimum: 0,
    value,
  });
}

function parseLayoutBox(input: unknown, index: number): DirectNamedLayoutBox {
  const label = `Direct named layout box ${String(index)}`;
  const record = requireExactRecord(input, BOX_KEYS, label);
  return Object.freeze({
    height: requireSize(record.height, `${label} height`, true),
    name: requireLayoutName(record.name, `${label} name`),
    width: requireSize(record.width, `${label} width`, true),
    x: requireCoordinate(record.x, `${label} x`),
    y: requireCoordinate(record.y, `${label} y`),
  });
}

function parseLayoutSampleUnchecked(input: unknown): DirectNamedLayoutSample {
  const record = requireExactRecord(
    input,
    SAMPLE_KEYS,
    "Direct named layout sample",
  );
  if (record.schema !== DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA) {
    throw new NamedLayoutInputError(
      `Direct named layout sample schema must be ${DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA}`,
    );
  }
  const viewportRecord = requireExactRecord(
    record.viewport,
    VIEWPORT_KEYS,
    "Direct named layout viewport",
  );
  if (!Array.isArray(record.boxes)) {
    throw new NamedLayoutInputError("Direct named layout boxes must be an array");
  }
  if (record.boxes.length === 0 || record.boxes.length > MAX_LAYOUT_BOXES) {
    throw new NamedLayoutInputError(
      `Direct named layout samples require 1-${String(MAX_LAYOUT_BOXES)} boxes`,
    );
  }
  const boxes: DirectNamedLayoutBox[] = [];
  for (let index = 0; index < record.boxes.length; index += 1) {
    boxes.push(parseLayoutBox(record.boxes[index], index));
  }
  const names = new Set<string>();
  for (const box of boxes) {
    if (names.has(box.name)) {
      throw new NamedLayoutInputError(
        `Direct named layout box name is duplicated: ${box.name}`,
      );
    }
    names.add(box.name);
  }
  return Object.freeze({
    boxes: Object.freeze(boxes),
    schema: DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA,
    viewport: Object.freeze({
      height: requireSize(
        viewportRecord.height,
        "Direct named layout viewport height",
        true,
      ),
      width: requireSize(
        viewportRecord.width,
        "Direct named layout viewport width",
        true,
      ),
    }),
  });
}

function parsePairRule(
  record: Readonly<Record<string, unknown>>,
  kind: DirectNamedLayoutNoOverlapRule["kind"] | DirectNamedLayoutCenterRule["kind"],
  id: string,
): DirectNamedLayoutNoOverlapRule | DirectNamedLayoutCenterRule {
  requireExactRecord(record, PAIR_RULE_KEYS, `Direct named layout ${kind} rule`);
  const first = requireLayoutName(
    record.first,
    `Direct named layout rule ${id} first box`,
  );
  const second = requireLayoutName(
    record.second,
    `Direct named layout rule ${id} second box`,
  );
  if (first === second) {
    throw new NamedLayoutInputError(
      `Direct named layout rule ${id} must name two different boxes`,
    );
  }
  return Object.freeze({
    first,
    id,
    kind,
    second,
    tolerance: requireTolerance(
      record.tolerance,
      `Direct named layout rule ${id} tolerance`,
    ),
  });
}

function parseBoxToleranceRule(
  record: Readonly<Record<string, unknown>>,
  kind: DirectNamedLayoutNotClippedRule["kind"] | DirectNamedLayoutStableRule["kind"],
  id: string,
): DirectNamedLayoutNotClippedRule | DirectNamedLayoutStableRule {
  requireExactRecord(
    record,
    BOX_TOLERANCE_RULE_KEYS,
    `Direct named layout ${kind} rule`,
  );
  return Object.freeze({
    box: requireLayoutName(record.box, `Direct named layout rule ${id} box`),
    id,
    kind,
    tolerance: requireTolerance(
      record.tolerance,
      `Direct named layout rule ${id} tolerance`,
    ),
  });
}

function parseLayoutRule(input: unknown, index: number): DirectNamedLayoutRule {
  const label = `Direct named layout rule ${String(index)}`;
  if (!isRecord(input)) {
    throw new NamedLayoutInputError(`${label} must be an object`);
  }
  const id = requireLayoutName(input.id, `${label} id`);
  switch (input.kind) {
    case "inside": {
      const record = requireExactRecord(input, INSIDE_RULE_KEYS, `${label} inside`);
      const inner = requireLayoutName(record.inner, `${label} inner box`);
      const outer = requireLayoutName(record.outer, `${label} outer box`);
      if (inner === outer) {
        throw new NamedLayoutInputError(
          `${label} must name different inner and outer boxes`,
        );
      }
      return Object.freeze({
        id,
        inner,
        kind: "inside",
        outer,
        tolerance: requireTolerance(record.tolerance, `${label} tolerance`),
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
      const record = requireExactRecord(
        input,
        MINIMUM_SIZE_RULE_KEYS,
        `${label} minimum-size`,
      );
      const minimumHeight = requireSize(
        record.minimumHeight,
        `${label} minimumHeight`,
        false,
      );
      const minimumWidth = requireSize(
        record.minimumWidth,
        `${label} minimumWidth`,
        false,
      );
      if (minimumHeight === 0 && minimumWidth === 0) {
        throw new NamedLayoutInputError(
          `${label} must require a positive width or height`,
        );
      }
      return Object.freeze({
        box: requireLayoutName(record.box, `${label} box`),
        id,
        kind: "minimum-size",
        minimumHeight,
        minimumWidth,
      });
    }
    default:
      throw new NamedLayoutInputError(
        `${label} kind must be inside, no-overlap, center-x, center-y, not-clipped, minimum-size, or stable`,
      );
  }
}

function parseLayoutContractUnchecked(input: unknown): DirectNamedLayoutContract {
  const record = requireExactRecord(
    input,
    CONTRACT_KEYS,
    "Direct named layout contract",
  );
  if (record.schema !== DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA) {
    throw new NamedLayoutInputError(
      `Direct named layout contract schema must be ${DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA}`,
    );
  }
  if (!Array.isArray(record.rules)) {
    throw new NamedLayoutInputError("Direct named layout rules must be an array");
  }
  if (record.rules.length === 0 || record.rules.length > MAX_LAYOUT_RULES) {
    throw new NamedLayoutInputError(
      `Direct named layout contracts require 1-${String(MAX_LAYOUT_RULES)} rules`,
    );
  }
  const rules: DirectNamedLayoutRule[] = [];
  for (let index = 0; index < record.rules.length; index += 1) {
    rules.push(parseLayoutRule(record.rules[index], index));
  }
  const ids = new Set<string>();
  for (const rule of rules) {
    if (ids.has(rule.id)) {
      throw new NamedLayoutInputError(
        `Direct named layout rule id is duplicated: ${rule.id}`,
      );
    }
    ids.add(rule.id);
  }
  return Object.freeze({
    rules: Object.freeze(rules),
    schema: DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA,
  });
}

function parseError(
  code: DirectNamedLayoutParseError["code"],
  error: unknown,
): DirectNamedLayoutParseError {
  return Object.freeze({
    code,
    message: error instanceof NamedLayoutInputError
      ? error.message
      : `Direct named layout ${code === "invalid-sample" ? "sample" : "contract"} could not be read`,
  });
}

/** Parse one driver-produced, versioned named-box sample from `unknown`. */
export function parseDirectNamedLayoutSample(
  input: unknown,
): DirectNamedLayoutParseResult<DirectNamedLayoutSample> {
  try {
    return Object.freeze({ ok: true, value: parseLayoutSampleUnchecked(input) });
  } catch (error: unknown) {
    return Object.freeze({
      error: parseError("invalid-sample", error),
      ok: false,
    });
  }
}

/** Parse one versioned set of product-owned named-box rules from `unknown`. */
export function parseDirectNamedLayoutContract(
  input: unknown,
): DirectNamedLayoutParseResult<DirectNamedLayoutContract> {
  try {
    return Object.freeze({ ok: true, value: parseLayoutContractUnchecked(input) });
  } catch (error: unknown) {
    return Object.freeze({
      error: parseError("invalid-contract", error),
      ok: false,
    });
  }
}

function boxMap(sample: DirectNamedLayoutSample): ReadonlyMap<string, DirectNamedLayoutBox> {
  return new Map(sample.boxes.map((box) => [box.name, box]));
}

function right(box: DirectNamedLayoutBox): number {
  return box.x + box.width;
}

function bottom(box: DirectNamedLayoutBox): number {
  return box.y + box.height;
}

function violation(
  options: DirectNamedLayoutViolation,
): DirectNamedLayoutViolation {
  return Object.freeze(options);
}

function missingBoxViolation(
  rule: DirectNamedLayoutRule,
  sample: DirectNamedLayoutViolation["sample"],
  names: readonly string[],
): DirectNamedLayoutViolation {
  return violation({
    code: "missing-box",
    message: `Rule ${rule.id} references missing box${names.length === 1 ? "" : "es"}: ${names.join(", ")}`,
    ruleId: rule.id,
    ruleKind: rule.kind,
    sample,
  });
}

function pairBoxes(
  rule: DirectNamedLayoutNoOverlapRule | DirectNamedLayoutCenterRule,
  boxes: ReadonlyMap<string, DirectNamedLayoutBox>,
): readonly [DirectNamedLayoutBox, DirectNamedLayoutBox] | null {
  const first = boxes.get(rule.first);
  const second = boxes.get(rule.second);
  return first === undefined || second === undefined ? null : [first, second];
}

function validateStaticRule(
  rule: Exclude<DirectNamedLayoutRule, DirectNamedLayoutStableRule>,
  sampleName: "first" | "second",
  sample: DirectNamedLayoutSample,
  boxes: ReadonlyMap<string, DirectNamedLayoutBox>,
): DirectNamedLayoutViolation | null {
  switch (rule.kind) {
    case "inside": {
      const inner = boxes.get(rule.inner);
      const outer = boxes.get(rule.outer);
      if (inner === undefined || outer === undefined) {
        return missingBoxViolation(
          rule,
          sampleName,
          [inner === undefined ? rule.inner : null, outer === undefined ? rule.outer : null]
            .filter((name): name is string => name !== null),
        );
      }
      if (
        inner.x < outer.x - rule.tolerance
        || inner.y < outer.y - rule.tolerance
        || right(inner) > right(outer) + rule.tolerance
        || bottom(inner) > bottom(outer) + rule.tolerance
      ) {
        return violation({
          code: "outside",
          message: `Box ${rule.inner} is not inside ${rule.outer} within ${String(rule.tolerance)} CSS pixels`,
          ruleId: rule.id,
          ruleKind: rule.kind,
          sample: sampleName,
        });
      }
      return null;
    }
    case "no-overlap": {
      const pair = pairBoxes(rule, boxes);
      if (pair === null) {
        return missingBoxViolation(
          rule,
          sampleName,
          [rule.first, rule.second].filter((name) => !boxes.has(name)),
        );
      }
      const [first, second] = pair;
      const overlapWidth = Math.min(right(first), right(second))
        - Math.max(first.x, second.x);
      const overlapHeight = Math.min(bottom(first), bottom(second))
        - Math.max(first.y, second.y);
      if (overlapWidth > rule.tolerance && overlapHeight > rule.tolerance) {
        return violation({
          code: "overlap",
          message: `Boxes ${rule.first} and ${rule.second} overlap beyond ${String(rule.tolerance)} CSS pixels`,
          ruleId: rule.id,
          ruleKind: rule.kind,
          sample: sampleName,
        });
      }
      return null;
    }
    case "center-x":
    case "center-y": {
      const pair = pairBoxes(rule, boxes);
      if (pair === null) {
        return missingBoxViolation(
          rule,
          sampleName,
          [rule.first, rule.second].filter((name) => !boxes.has(name)),
        );
      }
      const [first, second] = pair;
      const firstCenter = rule.kind === "center-x"
        ? first.x + first.width / 2
        : first.y + first.height / 2;
      const secondCenter = rule.kind === "center-x"
        ? second.x + second.width / 2
        : second.y + second.height / 2;
      if (Math.abs(firstCenter - secondCenter) > rule.tolerance) {
        return violation({
          code: "misaligned",
          message: `Boxes ${rule.first} and ${rule.second} are not ${rule.kind} aligned within ${String(rule.tolerance)} CSS pixels`,
          ruleId: rule.id,
          ruleKind: rule.kind,
          sample: sampleName,
        });
      }
      return null;
    }
    case "not-clipped": {
      const box = boxes.get(rule.box);
      if (box === undefined) {
        return missingBoxViolation(rule, sampleName, [rule.box]);
      }
      if (
        box.x < -rule.tolerance
        || box.y < -rule.tolerance
        || right(box) > sample.viewport.width + rule.tolerance
        || bottom(box) > sample.viewport.height + rule.tolerance
      ) {
        return violation({
          code: "clipped",
          message: `Box ${rule.box} extends outside the viewport beyond ${String(rule.tolerance)} CSS pixels`,
          ruleId: rule.id,
          ruleKind: rule.kind,
          sample: sampleName,
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
          sample: sampleName,
        });
      }
      return null;
    }
  }
}

function validateStabilityRule(
  rule: DirectNamedLayoutStableRule,
  firstSample: DirectNamedLayoutSample,
  secondSample: DirectNamedLayoutSample | undefined,
  first: ReadonlyMap<string, DirectNamedLayoutBox>,
  second: ReadonlyMap<string, DirectNamedLayoutBox> | null,
): DirectNamedLayoutViolation | null {
  if (secondSample === undefined || second === null) {
    return violation({
      code: "second-sample-required",
      message: `Rule ${rule.id} requires two layout samples`,
      ruleId: rule.id,
      ruleKind: rule.kind,
      sample: "pair",
    });
  }
  if (
    firstSample.viewport.width !== secondSample.viewport.width
    || firstSample.viewport.height !== secondSample.viewport.height
  ) {
    return violation({
      code: "viewport-changed",
      message: `Rule ${rule.id} requires two samples at the same viewport`,
      ruleId: rule.id,
      ruleKind: rule.kind,
      sample: "pair",
    });
  }
  const firstBox = first.get(rule.box);
  const secondBox = second.get(rule.box);
  if (firstBox === undefined || secondBox === undefined) {
    return missingBoxViolation(
      rule,
      "pair",
      [firstBox === undefined ? `first:${rule.box}` : null, secondBox === undefined ? `second:${rule.box}` : null]
        .filter((name): name is string => name !== null),
    );
  }
  if (
    Math.abs(firstBox.x - secondBox.x) > rule.tolerance
    || Math.abs(firstBox.y - secondBox.y) > rule.tolerance
    || Math.abs(firstBox.width - secondBox.width) > rule.tolerance
    || Math.abs(firstBox.height - secondBox.height) > rule.tolerance
  ) {
    return violation({
      code: "unstable",
      message: `Box ${rule.box} changed between samples beyond ${String(rule.tolerance)} CSS pixels`,
      ruleId: rule.id,
      ruleKind: rule.kind,
      sample: "pair",
    });
  }
  return null;
}

/**
 * Validate only the named product rules. Static rules run against every
 * supplied sample; `stable` compares the first and second samples.
 */
export function validateDirectNamedLayout(
  contract: DirectNamedLayoutContract,
  samples:
    | readonly [DirectNamedLayoutSample]
    | readonly [DirectNamedLayoutSample, DirectNamedLayoutSample],
): DirectNamedLayoutValidation {
  if (!Array.isArray(samples) || (samples.length !== 1 && samples.length !== 2)) {
    throw new RangeError(
      "Direct named layout validation requires exactly one or two parsed samples",
    );
  }
  const violations: DirectNamedLayoutViolation[] = [];
  const firstBoxes = boxMap(samples[0]);
  const secondSample = samples[1];
  const secondBoxes = secondSample === undefined ? null : boxMap(secondSample);
  for (const rule of contract.rules) {
    if (rule.kind === "stable") {
      const found = validateStabilityRule(
        rule,
        samples[0],
        secondSample,
        firstBoxes,
        secondBoxes,
      );
      if (found !== null) violations.push(found);
      continue;
    }
    const firstViolation = validateStaticRule(
      rule,
      "first",
      samples[0],
      firstBoxes,
    );
    if (firstViolation !== null) violations.push(firstViolation);
    if (secondSample !== undefined && secondBoxes !== null) {
      const secondViolation = validateStaticRule(
        rule,
        "second",
        secondSample,
        secondBoxes,
      );
      if (secondViolation !== null) violations.push(secondViolation);
    }
  }
  return Object.freeze({
    ok: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
