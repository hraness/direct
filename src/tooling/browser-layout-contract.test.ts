import { describe, expect, test } from "bun:test";

import {
  DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA,
  DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA,
  parseDirectNamedLayoutContract,
  parseDirectNamedLayoutSample,
  validateDirectNamedLayout,
  type DirectNamedLayoutContract,
  type DirectNamedLayoutSample,
} from "./browser-verification-entry.js";

function sampleInput(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    schema: DIRECT_NAMED_LAYOUT_SAMPLE_SCHEMA,
    viewport: { width: 800, height: 600 },
    boxes: [
      { name: "page", x: 0, y: 0, width: 800, height: 600 },
      { name: "panel", x: 50, y: 60, width: 500, height: 300 },
      { name: "control", x: 200, y: 168, width: 200, height: 44 },
      { name: "label", x: 80, y: 170, width: 100, height: 40 },
      { name: "footer", x: 0, y: 520, width: 800, height: 80 },
      { name: "footer.brand", x: 40, y: 540, width: 120, height: 40 },
      { name: "footer.form", x: 300, y: 540, width: 220, height: 40 },
      { name: "unlisted.one", x: 600, y: 100, width: 80, height: 80 },
      { name: "unlisted.two", x: 620, y: 120, width: 80, height: 80 },
    ],
    ...overrides,
  };
}

function contractInput(rules: readonly unknown[]): unknown {
  return {
    schema: DIRECT_NAMED_LAYOUT_CONTRACT_SCHEMA,
    rules,
  };
}

function parseSample(input: unknown = sampleInput()): DirectNamedLayoutSample {
  const parsed = parseDirectNamedLayoutSample(input);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function parseContract(rules: readonly unknown[]): DirectNamedLayoutContract {
  const parsed = parseDirectNamedLayoutContract(contractInput(rules));
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

const passingRules = [
  {
    id: "control.inside-panel",
    kind: "inside",
    inner: "control",
    outer: "panel",
    tolerance: 0,
  },
  {
    id: "label.clear-of-control",
    kind: "no-overlap",
    first: "label",
    second: "control",
    tolerance: 0,
  },
  {
    id: "control.centered-in-panel",
    kind: "center-x",
    first: "control",
    second: "panel",
    tolerance: 0,
  },
  {
    id: "footer.controls-centered",
    kind: "center-y",
    first: "footer.brand",
    second: "footer.form",
    tolerance: 1,
  },
  {
    id: "footer.visible",
    kind: "not-clipped",
    box: "footer",
    tolerance: 1,
  },
  {
    id: "control.tap-size",
    kind: "minimum-size",
    box: "control",
    minimumWidth: 44,
    minimumHeight: 44,
  },
  {
    id: "footer.stable",
    kind: "stable",
    box: "footer",
    tolerance: 1,
  },
] as const;

describe("Direct named layout input", () => {
  test("parses and freezes bounded named boxes and product rules", () => {
    const sample = parseSample();
    const contract = parseContract(passingRules);

    expect(sample.boxes).toHaveLength(9);
    expect(Object.isFrozen(sample)).toBeTrue();
    expect(Object.isFrozen(sample.boxes)).toBeTrue();
    expect(Object.isFrozen(sample.boxes[0])).toBeTrue();
    expect(Object.isFrozen(sample.viewport)).toBeTrue();
    expect(contract.rules.map((rule) => rule.kind)).toEqual([
      "inside",
      "no-overlap",
      "center-x",
      "center-y",
      "not-clipped",
      "minimum-size",
      "stable",
    ]);
    expect(Object.isFrozen(contract)).toBeTrue();
    expect(Object.isFrozen(contract.rules)).toBeTrue();
    expect(Object.isFrozen(contract.rules[0])).toBeTrue();
  });

  test("rejects unknown fields at every versioned boundary", () => {
    const mutations = [
      { ...sampleInput() as object, extra: true },
      sampleInput({ viewport: { width: 800, height: 600, extra: true } }),
      sampleInput({
        boxes: [{ name: "page", x: 0, y: 0, width: 800, height: 600, extra: true }],
      }),
    ];
    for (const mutation of mutations) {
      const parsed = parseDirectNamedLayoutSample(mutation);
      expect(parsed.ok).toBeFalse();
      if (!parsed.ok) expect(parsed.error.code).toBe("invalid-sample");
    }

    for (const mutation of [
      { ...contractInput(passingRules) as object, extra: true },
      contractInput([{ ...passingRules[0], extra: true }]),
    ]) {
      const parsed = parseDirectNamedLayoutContract(mutation);
      expect(parsed.ok).toBeFalse();
      if (!parsed.ok) expect(parsed.error.code).toBe("invalid-contract");
    }
  });

  test("rejects duplicate, unsafe, unbounded, and vacuous declarations", () => {
    const badSamples = [
      sampleInput({
        boxes: [
          { name: "page", x: 0, y: 0, width: 800, height: 600 },
          { name: "page", x: 1, y: 1, width: 10, height: 10 },
        ],
      }),
      sampleInput({
        boxes: [{ name: "__proto__", x: 0, y: 0, width: 1, height: 1 }],
      }),
      sampleInput({ viewport: { width: 0, height: 600 } }),
      sampleInput({
        boxes: [{ name: "hidden", x: 0, y: 0, width: 0, height: 0 }],
      }),
      sampleInput({
        boxes: [{ name: "page", x: Number.POSITIVE_INFINITY, y: 0, width: 1, height: 1 }],
      }),
    ];
    for (const input of badSamples) {
      expect(parseDirectNamedLayoutSample(input).ok).toBeFalse();
    }

    const badContracts = [
      contractInput([passingRules[0], passingRules[0]]),
      contractInput([{
        id: "same.inside",
        kind: "inside",
        inner: "panel",
        outer: "panel",
        tolerance: 0,
      }]),
      contractInput([{
        id: "empty.minimum",
        kind: "minimum-size",
        box: "control",
        minimumWidth: 0,
        minimumHeight: 0,
      }]),
    ];
    for (const input of badContracts) {
      expect(parseDirectNamedLayoutContract(input).ok).toBeFalse();
    }
  });

  test("fails closed without reflecting an accessor error", () => {
    const secret = "SECRET_LAYOUT_ACCESSOR_TOKEN";
    const input = new Proxy({}, {
      ownKeys: () => {
        throw new Error(secret);
      },
    });

    const parsed = parseDirectNamedLayoutSample(input);
    expect(parsed.ok).toBeFalse();
    if (!parsed.ok) {
      expect(parsed.error.message).not.toContain(secret);
      expect(parsed.error.message).toContain("could not be read");
    }
  });
});

describe("Direct named layout validation", () => {
  test("passes every explicit rule across a stable two-sample pair", () => {
    const first = parseSample();
    const second = parseSample(sampleInput({
      boxes: first.boxes.map((box) => box.name === "footer"
        ? { ...box, y: box.y + 0.5 }
        : box),
    }));
    const result = validateDirectNamedLayout(parseContract(passingRules), [
      first,
      second,
    ]);

    expect(result).toEqual({ ok: true, violations: [] });
  });

  test("does not compare unnamed pairs automatically", () => {
    const contract = parseContract([{
      id: "footer.visible",
      kind: "not-clipped",
      box: "footer",
      tolerance: 0,
    }]);

    expect(validateDirectNamedLayout(contract, [parseSample()])).toEqual({
      ok: true,
      violations: [],
    });
  });

  test("locks overlap and edge-contact tolerance boundaries", () => {
    const contract = parseContract([{
      id: "boxes.clear",
      kind: "no-overlap",
      first: "first",
      second: "second",
      tolerance: 1,
    }]);
    const withSecondAt = (x: number) => parseSample(sampleInput({
      boxes: [
        { name: "first", x: 10, y: 10, width: 20, height: 20 },
        { name: "second", x, y: 10, width: 20, height: 20 },
      ],
    }));

    expect(validateDirectNamedLayout(contract, [withSecondAt(30)]).ok).toBeTrue();
    expect(validateDirectNamedLayout(contract, [withSecondAt(29)]).ok).toBeTrue();
    expect(validateDirectNamedLayout(contract, [withSecondAt(28.9)]).violations[0])
      .toMatchObject({ code: "overlap", ruleId: "boxes.clear" });
  });

  test("locks containment and clipping tolerance boundaries", () => {
    const contract = parseContract([
      {
        id: "inner.contained",
        kind: "inside",
        inner: "inner",
        outer: "outer",
        tolerance: 1,
      },
      {
        id: "inner.visible",
        kind: "not-clipped",
        box: "inner",
        tolerance: 1,
      },
    ]);
    const atBoundary = parseSample(sampleInput({
      viewport: { width: 100, height: 100 },
      boxes: [
        { name: "outer", x: 0, y: 0, width: 100, height: 100 },
        { name: "inner", x: -1, y: -1, width: 102, height: 102 },
      ],
    }));
    const beyondBoundary = parseSample(sampleInput({
      viewport: { width: 100, height: 100 },
      boxes: [
        { name: "outer", x: 0, y: 0, width: 100, height: 100 },
        { name: "inner", x: -1.1, y: -1.1, width: 102.2, height: 102.2 },
      ],
    }));

    expect(validateDirectNamedLayout(contract, [atBoundary]).ok).toBeTrue();
    expect(validateDirectNamedLayout(contract, [beyondBoundary]).violations.map(
      ({ code }) => code,
    )).toEqual(["outside", "clipped"]);
  });

  test("reports each failed geometry rule with its owned id", () => {
    const contract = parseContract([
      {
        id: "outside",
        kind: "inside",
        inner: "footer",
        outer: "panel",
        tolerance: 0,
      },
      {
        id: "overlap",
        kind: "no-overlap",
        first: "unlisted.one",
        second: "unlisted.two",
        tolerance: 0,
      },
      {
        id: "center-x",
        kind: "center-x",
        first: "label",
        second: "control",
        tolerance: 1,
      },
      {
        id: "center-y",
        kind: "center-y",
        first: "label",
        second: "footer.form",
        tolerance: 1,
      },
      {
        id: "clipped",
        kind: "not-clipped",
        box: "panel",
        tolerance: 0,
      },
      {
        id: "small",
        kind: "minimum-size",
        box: "label",
        minimumWidth: 101,
        minimumHeight: 41,
      },
    ]);
    const clipped = parseSample(sampleInput({
      boxes: (parseSample().boxes).map((box) => box.name === "panel"
        ? { ...box, x: 700 }
        : box),
    }));
    const result = validateDirectNamedLayout(contract, [clipped]);

    expect(result.ok).toBeFalse();
    expect(result.violations.map(({ code, ruleId, sample }) => ({
      code,
      ruleId,
      sample,
    }))).toEqual([
      { code: "outside", ruleId: "outside", sample: "first" },
      { code: "overlap", ruleId: "overlap", sample: "first" },
      { code: "misaligned", ruleId: "center-x", sample: "first" },
      { code: "misaligned", ruleId: "center-y", sample: "first" },
      { code: "clipped", ruleId: "clipped", sample: "first" },
      { code: "too-small", ruleId: "small", sample: "first" },
    ]);
  });

  test("requires the named boxes in each sample", () => {
    const contract = parseContract([{
      id: "missing.pair",
      kind: "no-overlap",
      first: "label",
      second: "absent",
      tolerance: 0,
    }]);
    const result = validateDirectNamedLayout(contract, [parseSample()]);

    expect(result.ok).toBeFalse();
    expect(result.violations[0]).toMatchObject({
      code: "missing-box",
      ruleId: "missing.pair",
      sample: "first",
    });
  });

  test("requires a second sample and rejects movement beyond tolerance", () => {
    const contract = parseContract([{
      id: "footer.stable",
      kind: "stable",
      box: "footer",
      tolerance: 1,
    }]);
    const first = parseSample();

    expect(validateDirectNamedLayout(contract, [first]).violations[0]).toMatchObject({
      code: "second-sample-required",
      sample: "pair",
    });

    const resized = parseSample(sampleInput({
      viewport: { width: 801, height: 600 },
    }));
    expect(validateDirectNamedLayout(contract, [first, resized]).violations[0])
      .toMatchObject({ code: "viewport-changed", sample: "pair" });

    const second = parseSample(sampleInput({
      boxes: first.boxes.map((box) => box.name === "footer"
        ? { ...box, y: box.y - 2 }
        : box),
    }));
    expect(validateDirectNamedLayout(contract, [first, second]).violations[0])
      .toMatchObject({ code: "unstable", sample: "pair" });
  });

  test("checks stability tolerance across position and size", () => {
    const contract = parseContract([{
      id: "footer.stable",
      kind: "stable",
      box: "footer",
      tolerance: 1,
    }]);
    const first = parseSample();
    for (const field of ["x", "y", "width", "height"] as const) {
      const atBoundary = parseSample(sampleInput({
        boxes: first.boxes.map((box) => box.name === "footer"
          ? { ...box, [field]: box[field] + 1 }
          : box),
      }));
      expect(validateDirectNamedLayout(contract, [first, atBoundary]).ok).toBeTrue();

      const beyondBoundary = parseSample(sampleInput({
        boxes: first.boxes.map((box) => box.name === "footer"
          ? { ...box, [field]: box[field] + 1.1 }
          : box),
      }));
      expect(validateDirectNamedLayout(contract, [first, beyondBoundary]).violations[0])
        .toMatchObject({ code: "unstable", sample: "pair" });
    }
  });

  test("rejects runtime sample counts outside the public one-or-two boundary", () => {
    const contract = parseContract(passingRules);
    const first = parseSample();
    const invalidCounts: readonly unknown[] = [[], [first, first, first]];

    for (const samples of invalidCounts) {
      expect(() => validateDirectNamedLayout(
        contract,
        samples as readonly [DirectNamedLayoutSample],
      )).toThrow("requires exactly one or two parsed samples");
    }
  });

  test("checks static rules in both samples", () => {
    const contract = parseContract([{
      id: "footer.visible",
      kind: "not-clipped",
      box: "footer",
      tolerance: 0,
    }]);
    const first = parseSample();
    const second = parseSample(sampleInput({
      boxes: first.boxes.map((box) => box.name === "footer"
        ? { ...box, y: 550 }
        : box),
    }));
    const result = validateDirectNamedLayout(contract, [first, second]);

    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      code: "clipped",
      ruleId: "footer.visible",
      sample: "second",
    });
  });
});
