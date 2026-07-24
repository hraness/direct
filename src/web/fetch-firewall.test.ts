import { afterEach, describe, expect, test } from "bun:test";

import { installDirectFetchFirewall } from "./fetch-firewall.js";

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

describe("Direct fetch firewall", () => {
  test("blocks relative, same-origin, malformed, and external requests without reaching fetch", async () => {
    let calls = 0;
    let active = 0;
    const blocked: (URL | null)[] = [];
    const uninstall = installDirectFetchFirewall({
      originalFetch: () => {
        calls += 1;
        return Promise.reject(new Error("must not reach network"));
      },
      beginActivity: () => {
        active += 1;
        return () => { active -= 1; };
      },
      onBlocked: (url) => blocked.push(url),
    });

    for (const url of ["/api/agent", "http://direct.invalid/api/chat", "https://example.com/"]) {
      const response = await fetch(url);
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual({ error: "Direct blocked an unmapped network request." });
    }
    expect(calls).toBe(0);
    expect(active).toBe(0);
    expect(blocked).toHaveLength(3);
    uninstall();
  });

  test("allows only an explicit mapping and restores the previous fetch idempotently", async () => {
    let calls = 0;
    const original: typeof fetch = Object.assign(() => {
      calls += 1;
      return Promise.resolve(new Response("fixture"));
    }, { preconnect: nativeFetch.preconnect });
    const uninstall = installDirectFetchFirewall({
      originalFetch: original,
      allow: (url) => url.protocol === "data:",
    });

    expect(await (await fetch("data:text/plain,hello")).text()).toBe("fixture");
    expect((await fetch("https://example.com")).status).toBe(501);
    expect(calls).toBe(1);
    uninstall();
    uninstall();
    expect(globalThis.fetch).toBe(nativeFetch);
  });

  test("a later installation safely replaces the earlier firewall", () => {
    const first = installDirectFetchFirewall();
    const firstFetch = globalThis.fetch;
    const second = installDirectFetchFirewall();
    expect(globalThis.fetch).not.toBe(firstFetch);
    first();
    expect(globalThis.fetch).not.toBe(nativeFetch);
    second();
    expect(globalThis.fetch).toBe(nativeFetch);
  });

  test("a failed replacement leaves the active firewall installed", async () => {
    const first = installDirectFetchFirewall();
    const firstFetch = globalThis.fetch;
    const hostileOptions = new Proxy({}, {
      get: (_target, key) => {
        if (key === "allow") throw new Error("option getter rejected");
        return undefined;
      },
    });

    expect(() => installDirectFetchFirewall(hostileOptions)).toThrow("option getter rejected");
    expect(globalThis.fetch).toBe(firstFetch);
    expect((await fetch("https://example.com")).status).toBe(501);
    first();
    expect(globalThis.fetch).toBe(nativeFetch);
  });

  test("guards and accounts for preconnect through the same allow policy", () => {
    const preconnected: string[] = [];
    let started = 0;
    let released = 0;
    const blocked: (URL | null)[] = [];
    const hostFetch = Object.assign(
      () => Promise.resolve(new Response("host")),
      {
        preconnect: (url: string | URL) => { preconnected.push(String(url)); },
      },
    ) as typeof fetch;
    globalThis.fetch = hostFetch;

    const uninstall = installDirectFetchFirewall({
      allow: (url) => url.protocol === "data:",
      beginActivity: () => {
        started += 1;
        return () => { released += 1; };
      },
      onBlocked: (url) => { blocked.push(url); },
    });

    globalThis.fetch.preconnect("data:text/plain,fixture");
    globalThis.fetch.preconnect("https://example.com");
    expect(preconnected).toEqual(["data:text/plain,fixture"]);
    expect(blocked.map((url) => url?.href)).toEqual(["https://example.com/"]);
    expect({ started, released }).toEqual({ started: 2, released: 2 });
    uninstall();
    expect(globalThis.fetch).toBe(hostFetch);
  });

  test("contains asynchronous hook returns and fails closed when policy or activity is asynchronous", async () => {
    let originalCalls = 0;
    let blocked = 0;
    const asynchronousAllow = (() => Promise.reject(new Error("allow rejected"))) as unknown as (
      url: URL
    ) => boolean;
    const firstOptions = {
      allow: asynchronousAllow,
      originalFetch: () => {
        originalCalls += 1;
        return Promise.resolve(new Response("must not run"));
      },
      beginActivity: () => () => Promise.reject(new Error("release rejected")),
      onBlocked: () => {
        blocked += 1;
      },
    };
    Object.defineProperty(firstOptions, "onBlocked", {
      value: () => {
        blocked += 1;
        return Promise.reject(new Error("reporter rejected"));
      },
    });
    const first = installDirectFetchFirewall(firstOptions);
    expect((await fetch("https://example.com")).status).toBe(501);
    await Promise.resolve();
    expect(originalCalls).toBe(0);
    expect(blocked).toBe(1);
    first();

    const asynchronousBegin = (() => Promise.reject(new Error("begin rejected"))) as unknown as (
      url: URL | null
    ) => () => void;
    const second = installDirectFetchFirewall({
      allow: () => true,
      beginActivity: asynchronousBegin,
      originalFetch: () => {
        originalCalls += 1;
        return Promise.resolve(new Response("must not run"));
      },
      onBlocked: () => { blocked += 1; },
    });
    expect((await fetch("data:text/plain,fixture")).status).toBe(501);
    await Promise.resolve();
    expect(originalCalls).toBe(0);
    expect(blocked).toBe(2);
    second();
  });
});
