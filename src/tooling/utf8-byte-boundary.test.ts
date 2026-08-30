import { describe, expect, test } from "bun:test";
import { assertProperty, fc } from "../core/test-support.js";

import { isUtf8ByteLengthAtMost } from "./utf8-byte-boundary.js";

describe("UTF-8 byte boundary", () => {
  test("matches exact UTF-16 code-unit boundaries", () => {
    const cases = [
      ["\u0000\u007f", 2],
      ["\u0080\u07ff", 4],
      ["\u0800\ud7ff\ue000\uffff", 12],
      ["\ud800\udc00\udbff\udfff", 8],
      ["\ud800", 3],
      ["\udc00", 3],
      ["\ud800A", 4],
      ["\ud800\ud800", 6],
      ["\udc00\ud800", 6],
    ] as const;

    for (const [value, expectedBytes] of cases) {
      expect(isUtf8ByteLengthAtMost(value, expectedBytes)).toBeTrue();
      expect(isUtf8ByteLengthAtMost(value, expectedBytes - 1)).toBeFalse();
    }
    expect(isUtf8ByteLengthAtMost("", 0)).toBeTrue();
    expect(isUtf8ByteLengthAtMost("value", -1)).toBeFalse();
    expect(isUtf8ByteLengthAtMost("value", Number.POSITIVE_INFINITY)).toBeFalse();
  });

  test("matches TextEncoder for arbitrary UTF-16 code units when available", () => {
    const TextEncoderConstructor = globalThis.TextEncoder;
    if (typeof TextEncoderConstructor !== "function") return;
    const encoder = new TextEncoderConstructor();
    const utf16String = fc.array(
      fc.integer({ min: 0, max: 0xffff }),
      { maxLength: 256 },
    ).map((codeUnits) => String.fromCharCode(...codeUnits));

    assertProperty(fc.property(
      utf16String,
      fc.integer({ min: 0, max: 1_024 }),
      (value, maximumBytes) => {
        expect(isUtf8ByteLengthAtMost(value, maximumBytes)).toBe(
          encoder.encode(value).byteLength <= maximumBytes,
        );
      },
    ));
  });
});
