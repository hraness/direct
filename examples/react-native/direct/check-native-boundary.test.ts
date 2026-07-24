import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanReactNativeDirectWebOutput,
  scanReactNativeProductionOutput,
} from "./check-native-boundary";

const temporaryRoots: string[] = [];
const nativeSources = [
  "/index.ts",
  "/src/root.native.tsx",
  "/src/DeviceStatusApp.tsx",
  "/src/native-device-status-port.ts",
] as const;
const webSources = [
  "/index.ts",
  "/src/root.web.tsx",
  "/src/DeviceStatusApp.tsx",
  "/src/device-status-port.ts",
  "/direct/web-provider.tsx",
  "/direct/workbench.tsx",
  "/direct/deterministic-device-status-port.ts",
] as const;

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "direct-react-native-boundary-"));
  temporaryRoots.push(root);
  return root;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (reason: unknown) {
    return reason instanceof Error ? reason : new Error(String(reason));
  }
  throw new Error("Expected the operation to reject.");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("React Native production boundary", () => {
  test("accepts a clean emitted bundle", async () => {
    const root = await temporaryRoot();
    await mkdir(join(root, "_expo", "static", "js", "ios"), { recursive: true });
    await writeFile(
      join(root, "_expo", "static", "js", "ios", "entry.hbc"),
      "device-status-example/screen/v1 device-status-example/native-port/v1",
    );
    await writeFile(
      join(root, "_expo", "static", "js", "ios", "entry.hbc.map"),
      JSON.stringify({ sources: nativeSources }),
    );
    expect(await scanReactNativeProductionOutput(root)).toEqual({
      scanned: ["_expo/static/js/ios/entry.hbc", "_expo/static/js/ios/entry.hbc.map"],
      violations: [],
    });
  });

  test("reports every forbidden marker in deterministic order", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "entry.js"),
      "device-status-example/screen/v1 device-status-example/native-port/v1 @cclrte/direct __direct_scenario Direct activation failed Direct hooks require their matching Direct Provider",
    );
    await writeFile(join(root, "entry.js.map"), JSON.stringify({ sources: nativeSources }));
    const result = await scanReactNativeProductionOutput(root);
    expect(result.violations).toEqual([{
      file: "entry.js",
      markers: [
        "@cclrte/direct",
        "__direct_scenario",
        "Direct activation failed",
        "Direct hooks require their matching Direct Provider",
      ],
    }]);
  });

  test("rejects a vacuous scan", async () => {
    const root = await temporaryRoot();
    expect((await rejection(scanReactNativeProductionOutput(root))).message)
      .toContain("scanned no emitted files");
  });

  test("rejects metadata-only output", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "metadata.json"), "{}");
    expect((await rejection(scanReactNativeProductionOutput(root))).message)
      .toContain("scanned no emitted executable bundles");
  });

  test("rejects a clean bundle that did not select the native product composition", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "entry.js"), "unrelated clean entry");
    await writeFile(join(root, "entry.js.map"), JSON.stringify({ sources: nativeSources }));
    expect((await rejection(scanReactNativeProductionOutput(root))).message)
      .toContain("missing native composition markers");
  });

  test("rejects production source maps that contain package or web-composition modules", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "entry.js"),
      "device-status-example/screen/v1 device-status-example/native-port/v1",
    );
    await writeFile(join(root, "entry.js.map"), JSON.stringify({
      sources: [
        ...nativeSources,
        "/../../src/react.ts",
        "/../../dist/react.js",
        "/direct/web-provider.tsx",
        "/src/root.web.tsx",
      ],
    }));
    expect((await scanReactNativeProductionOutput(root)).violations).toEqual([{
      file: "entry.js.map",
      markers: [
        "source-map:/../../src/react.ts",
        "source-map:/../../dist/react.js",
        "source-map:/direct/web-provider.tsx",
        "source-map:/src/root.web.tsx",
      ],
    }]);
  });

  test("rejects empty source-map evidence", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "entry.js"),
      "device-status-example/screen/v1 device-status-example/native-port/v1",
    );
    await writeFile(join(root, "entry.js.map"), JSON.stringify({ sources: [] }));
    expect((await rejection(scanReactNativeProductionOutput(root))).message)
      .toContain("source maps are missing native composition modules");
  });

  test("rejects a source map that is not paired with the emitted executable", async () => {
    const root = await temporaryRoot();
    await writeFile(
      join(root, "entry.js"),
      "device-status-example/screen/v1 device-status-example/native-port/v1",
    );
    await writeFile(join(root, "other.js.map"), JSON.stringify({ sources: nativeSources }));
    expect((await rejection(scanReactNativeProductionOutput(root))).message)
      .toContain("executables without paired source maps");
  });

  test("requires the web export to contain the deterministic composition", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "entry.js"), [
      "__direct_scenario",
      "direct.browser-bridge/v1",
      "direct.react-native-example/v1",
      "ios-ready",
    ].join(" "));
    await writeFile(join(root, "entry.js.map"), JSON.stringify({ sources: webSources }));
    expect(await scanReactNativeDirectWebOutput(root)).toEqual({
      scanned: ["entry.js", "entry.js.map"],
      observedMarkers: [
        "__direct_scenario",
        "direct.browser-bridge/v1",
        "direct.react-native-example/v1",
        "ios-ready",
      ],
    });
  });

  test("rejects a web export that selected the production root", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "entry.js"), "production device status");
    await writeFile(join(root, "entry.js.map"), JSON.stringify({ sources: webSources }));
    expect((await rejection(scanReactNativeDirectWebOutput(root))).message)
      .toContain("missing markers");
  });

  test("rejects web output without paired source-map evidence", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "entry.js"), [
      "__direct_scenario",
      "direct.browser-bridge/v1",
      "direct.react-native-example/v1",
      "ios-ready",
    ].join(" "));
    expect((await rejection(scanReactNativeDirectWebOutput(root))).message)
      .toContain("scanned no emitted source maps");
  });

  test("requires the web composition sources and rejects native variants", async () => {
    const missingRoot = await temporaryRoot();
    await writeFile(join(missingRoot, "entry.js"), [
      "__direct_scenario",
      "direct.browser-bridge/v1",
      "direct.react-native-example/v1",
      "ios-ready",
    ].join(" "));
    await writeFile(join(missingRoot, "entry.js.map"), JSON.stringify({
      sources: webSources.filter((source) => source !== "/direct/web-provider.tsx"),
    }));
    expect((await rejection(scanReactNativeDirectWebOutput(missingRoot))).message)
      .toContain("missing composition modules");

    const nativeRoot = await temporaryRoot();
    await writeFile(join(nativeRoot, "entry.js"), [
      "__direct_scenario",
      "direct.browser-bridge/v1",
      "direct.react-native-example/v1",
      "ios-ready",
    ].join(" "));
    await writeFile(join(nativeRoot, "entry.js.map"), JSON.stringify({
      sources: [...webSources, "/src/root.native.tsx", "/src/native-device-status-port.ts"],
    }));
    expect((await rejection(scanReactNativeDirectWebOutput(nativeRoot))).message)
      .toContain("contain native composition modules");
  });

  test("rejects web markers found only in metadata", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "metadata.json"), [
      "__direct_scenario",
      "direct.browser-bridge/v1",
      "direct.react-native-example/v1",
      "ios-ready",
    ].join(" "));
    expect((await rejection(scanReactNativeDirectWebOutput(root))).message)
      .toContain("scanned no emitted executable bundles");
  });
});
