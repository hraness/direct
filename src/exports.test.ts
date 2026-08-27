import { describe, expect, test } from "bun:test";

import * as root from "@hraness/direct";
import * as core from "@hraness/direct/core";
import { createDirectReactBindings } from "@hraness/direct/react";
import * as testing from "@hraness/direct/testing";
import * as browserVerification from "@hraness/direct/tooling/browser-verification";
import * as bombadil from "@hraness/direct/tooling/bombadil";
import type { DirectBombadilProperties } from "@hraness/direct/tooling/bombadil-campaign";
import * as bundleBoundary from "@hraness/direct/tooling/bundle-boundary";
import * as web from "@hraness/direct/web";

describe("public package exports", () => {
  test("the default entry is the curated definition and activation surface", () => {
    expect(Object.keys(root).toSorted()).toEqual([
      "FIXTURE_QUERY_KEY",
      "SCENARIO_QUERY_KEY",
      "defineDirect",
      "parseDirectDefinition",
      "tryDefineDirect",
    ]);
    expect(root.FIXTURE_QUERY_KEY).toBe(core.FIXTURE_QUERY_KEY);
    expect(root.SCENARIO_QUERY_KEY).toBe(core.SCENARIO_QUERY_KEY);
    expect("defineDirect" in core).toBeFalse();
    expect("parseDirectDefinition" in core).toBeFalse();
    expect("tryDefineDirect" in core).toBeFalse();
    expect("createDirectStore" in root).toBeFalse();
    expect("parseDirectQuery" in root).toBeFalse();
    expect(typeof core.createDirectStore).toBe("function");
    expect("createDirectSession" in root).toBeFalse();
    expect("installDirectBrowserBridge" in root).toBeFalse();
  });

  test("testing and web mechanics remain opt-in", () => {
    expect(Object.keys(web).toSorted()).toEqual([
      "DIRECT_BROWSER_BRIDGE_SCHEMA",
      "installDirectBrowser",
      "installDirectBrowserBridge",
      "installDirectFetchFirewall",
    ]);
    expect(testing.DIRECT_SESSION_MANIFEST_SCHEMA).toBe(
      "direct.session-manifest/v1",
    );
    expect(typeof testing.createDirectSessionManifest).toBe("function");
    expect(typeof testing.parseDirectSessionManifest).toBe("function");
    expect(typeof testing.createDirectSession).toBe("function");
    expect(typeof testing.createExactScriptedTransport).toBe("function");
    expect(typeof web.installDirectBrowserBridge).toBe("function");
    expect(typeof web.installDirectFetchFirewall).toBe("function");
    expect(typeof web.installDirectBrowser).toBe("function");
  });

  test("React bindings can be created without owning a product component tree", () => {
    const bindings = createDirectReactBindings();
    expect(typeof bindings.Provider).toBe("function");
    expect(typeof bindings.useSnapshot).toBe("function");
    expect(bindings.Context).toBeDefined();
  });

  test("host tooling stays behind explicit subpaths", () => {
    expect(Object.keys(bombadil).toSorted()).toEqual([
      "attestDirectBombadilTrace",
      "runDirectBombadilFuzz",
    ]);
    expect(typeof browserVerification.createAgentBrowser).toBe("function");
    expect(typeof browserVerification.createDirectBrowserContractReader).toBe("function");
    expect(typeof browserVerification.readDirectBrowserContract).toBe("function");
    expect(typeof bombadil.runDirectBombadilFuzz).toBe("function");
    expect(typeof bombadil.attestDirectBombadilTrace).toBe("function");
    expect(typeof bundleBoundary.checkBundleBoundary).toBe("function");
    expect(typeof bundleBoundary.findForbiddenMarkers).toBe("function");
    expect("createAgentBrowser" in root).toBeFalse();
    expect("checkBundleBoundary" in root).toBeFalse();
    expect("createAgentBrowser" in web).toBeFalse();
    expect("checkBundleBoundary" in testing).toBeFalse();
    type PublicRunnerArity = Parameters<typeof bombadil.runDirectBombadilFuzz>["length"];
    const supportedRunnerArities: readonly PublicRunnerArity[] = [1, 2];
    // @ts-expect-error Dependency injection stays internal to package tests.
    const unsupportedRunnerArity: PublicRunnerArity = 3;
    expect(supportedRunnerArities).toEqual([1, 2]);
    void unsupportedRunnerArity;
    type CampaignProperties = DirectBombadilProperties;
    void (undefined as unknown as CampaignProperties);
  });
});
