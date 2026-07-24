import { describe, expect, test } from "bun:test";

import * as root from "@cclrte/direct";
import * as core from "@cclrte/direct/core";
import { createDirectReactBindings } from "@cclrte/direct/react";
import * as testing from "@cclrte/direct/testing";
import * as web from "@cclrte/direct/web";

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
});
