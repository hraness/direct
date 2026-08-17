import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  checkBundleBoundary,
  DIRECT_WIRE_MARKERS,
  findForbiddenMarkers,
  inspectExactVersionedMarkers,
} from "./bundle-boundary.js";

describe("Direct bundle boundary", () => {
  test("reports markers in declaration order across binary data", () => {
    const markers = ["direct.fixture/v1", "__direct_scenario", "Direct workbench"] as const;
    const bytes = Buffer.from(`prefix\0${markers[2]}\0${markers[0]}\0suffix`);

    expect(findForbiddenMarkers(bytes, markers)).toEqual([markers[0], markers[2]]);
  });

  test("rejects empty and duplicate policies", () => {
    expect(() => findForbiddenMarkers(Buffer.from("bundle"), [])).toThrow("at least one");
    expect(() => findForbiddenMarkers(Buffer.from("bundle"), ["fixture", "fixture"]))
      .toThrow("duplicated");
    expect(() => findForbiddenMarkers(Buffer.from("bundle"), [""])).toThrow("cannot be empty");
    expect(checkBundleBoundary({
      directory: import.meta.dir,
      excludePatterns: [""],
      markers: ["fixture"],
      patterns: ["*.ts"],
    })).rejects.toThrow("exclusion patterns cannot be empty");
  });

  test("uses exact wire families instead of the ambiguous product adjective", () => {
    expect(DIRECT_WIRE_MARKERS).toEqual([
      "direct.browser-bridge/",
      "direct.coverage/",
      "direct.fixture/",
      "direct.probe/",
      "direct.runtime/",
      "direct.session-manifest/",
    ]);
    expect(findForbiddenMarkers(
      Buffer.from("ordinary direct.file metadata"),
      DIRECT_WIRE_MARKERS,
    )).toEqual([]);
    expect(findForbiddenMarkers(
      Buffer.from("direct.runtime/v1 direct.session-manifest/v1"),
      DIRECT_WIRE_MARKERS,
    )).toEqual(["direct.runtime/", "direct.session-manifest/"]);
  });

  test("matches complete numeric versions instead of version prefixes", () => {
    expect(inspectExactVersionedMarkers([
      Buffer.from([
        "direct.browser-bridge/v20",
        "direct.session-manifest/v10",
        "direct.probe/v10",
      ].join(" ")),
    ], [
      "direct.browser-bridge/v2",
      "direct.session-manifest/v1",
      "direct.probe/v1",
    ])).toEqual({
      missing: [
        "direct.browser-bridge/v2",
        "direct.session-manifest/v1",
        "direct.probe/v1",
      ],
      observed: [
        "direct.browser-bridge/v20",
        "direct.probe/v10",
        "direct.session-manifest/v10",
      ],
      unexpected: [
        "direct.browser-bridge/v20",
        "direct.probe/v10",
        "direct.session-manifest/v10",
      ],
    });
  });

  test("reports additional versions beside an exact current contract", () => {
    expect(inspectExactVersionedMarkers([
      Buffer.from([
        "direct.browser-bridge/v2",
        "direct.browser-bridge/v1",
        "direct.session-manifest/v1",
        "direct.session-manifest/v99",
      ].join(" ")),
      Buffer.from("direct.probe/v1 direct.probe/v2"),
    ], [
      "direct.browser-bridge/v2",
      "direct.session-manifest/v1",
      "direct.probe/v1",
    ])).toEqual({
      missing: [],
      observed: [
        "direct.browser-bridge/v2",
        "direct.session-manifest/v1",
        "direct.probe/v1",
        "direct.browser-bridge/v1",
        "direct.probe/v2",
        "direct.session-manifest/v99",
      ],
      unexpected: [
        "direct.browser-bridge/v1",
        "direct.probe/v2",
        "direct.session-manifest/v99",
      ],
    });
  });

  test("rejects malformed or ambiguous exact-version policies", () => {
    expect(() => inspectExactVersionedMarkers([], [])).toThrow("at least one");
    expect(() => inspectExactVersionedMarkers([], ["direct.probe/v01"]))
      .toThrow("canonical numeric version");
    expect(() => inspectExactVersionedMarkers([], [
      "direct.probe/v1",
      "direct.probe/v2",
    ])).toThrow("family is duplicated");
  });

  test("scans overlapping patterns once and returns deterministic violations", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hraness-direct-boundary-"));
    try {
      await mkdir(path.join(directory, "nested"));
      await writeFile(path.join(directory, "safe.js"), "production only");
      await writeFile(
        path.join(directory, "nested", "fixture.js"),
        Buffer.from("prefix\0__direct_scenario\0direct.fixture/v1\0suffix"),
      );

      const result = await checkBundleBoundary({
        directory,
        markers: ["direct.fixture/v1", "__direct_scenario"],
        patterns: ["**/*.js", "nested/**/*"],
      });

      expect(result.scanned).toEqual([
        path.join(directory, "nested", "fixture.js"),
        path.join(directory, "safe.js"),
      ]);
      expect(result.violations).toEqual([{
        file: path.join(directory, "nested", "fixture.js"),
        markers: ["direct.fixture/v1", "__direct_scenario"],
      }]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("excludes non-production files before scanning for forbidden markers", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hraness-direct-boundary-"));
    try {
      await mkdir(path.join(directory, "nested"));
      await writeFile(path.join(directory, "production.ts"), "export const production = true;");
      await writeFile(
        path.join(directory, "production.test.ts"),
        'import "@hraness/direct";',
      );
      await writeFile(
        path.join(directory, "nested", "production.spec.tsx"),
        'import "@hraness/direct";',
      );

      const result = await checkBundleBoundary({
        directory,
        excludePatterns: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
        markers: ["@hraness/direct"],
        patterns: ["**/*.ts", "**/*.tsx"],
      });

      expect(result.scanned).toEqual([path.join(directory, "production.ts")]);
      expect(result.violations).toEqual([]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
