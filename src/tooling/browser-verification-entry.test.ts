import { describe, expect, test } from "bun:test";

import { defineDirect } from "@hraness/direct";
import { createDirectSession } from "@hraness/direct/testing";
import { DIRECT_BROWSER_BRIDGE_SCHEMA } from "@hraness/direct/web";

import {
  readDirectBrowserContract,
  type DirectSessionBrowserContract,
} from "./browser-verification-entry.js";

describe("Direct package browser verification binding", () => {
  test("reads the exact package bridge through the ready-bound parser", async () => {
    const definition = defineDirect({
      parseWorld: (input) => {
        if (typeof input !== "object" || input === null || !("ready" in input)) {
          throw new Error("World readiness is required");
        }
        if (input.ready !== true) throw new Error("World must be ready");
        return { ready: true } as const;
      },
      defaultScenario: "surface.ready",
      scenarios: [{
        id: "surface.ready",
        title: "Ready surface",
        route: "/surface",
        world: { ready: true },
      }],
      coverage: [{
        key: "surface.render",
        claim: "The ready surface renders.",
        mode: "fixture",
        scenarios: ["surface.ready"],
      }],
    });
    const opened = createDirectSession({
      definition,
      activation: { kind: "scenario", scenario: "surface.ready" },
      create: () => ({}),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const probe = opened.value.probe.snapshot();
    if (!probe.ok) throw new Error(probe.error.message);

    const contract: DirectSessionBrowserContract = await readDirectBrowserContract({
      evaluate: () => Promise.resolve({
        bridgeSchema: DIRECT_BROWSER_BRIDGE_SCHEMA,
        manifest: opened.value.manifest,
        probe: probe.value,
      }),
    }, {
      route: "/surface",
      scenario: "surface.ready",
      source: "scenario",
    });

    expect(contract.manifest.coverage.entries).toHaveLength(1);
    expect(contract.probe.activationHash).toBe(
      contract.manifest.active.activationHash,
    );
    opened.value.dispose();
  });
});
