import { connect, createServer } from "node:net";
import { describe, expect, test } from "bun:test";
import { startVerificationBrowserProxy } from "./browser-network-proxy.js";

function connectRequest(proxyUrl: string, authority: string): Promise<string> {
  const proxy = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(proxy.port), proxy.hostname, () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    let result = "";
    socket.setTimeout(2_000, () => socket.destroy(new Error("CONNECT fixture timed out")));
    socket.on("data", data => {
      result += data.toString();
      if (result.includes("\r\n\r\n")) { resolve(result); socket.destroy(); }
    });
    socket.once("error", reject);
  });
}

describe("Direct browser network containment", () => {
  test("allows only the exact approved HTTP origin and collects its sockets", async () => {
    let requests = 0;
    const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
      requests += 1;
      return new Response(new URL(request.url).pathname);
    } });
    const origin = `http://127.0.0.1:${fixture.port}`;
    const proxy = await startVerificationBrowserProxy([origin], 2_000);
    try {
      const response = await fetch(`${origin}/scenario`, { proxy: proxy.url });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("/scenario");
      expect(requests).toBe(1);
      expect(() => proxy.assertHealthy()).not.toThrow();
    } finally { await proxy.close(); await fixture.stop(true); }
    await expect(fetch(`${origin}/scenario`, { proxy: proxy.url })).rejects.toThrow();
  });

  test("denies a foreign origin and CONNECT without reaching its fixture", async () => {
    let leaked = 0;
    const fixture = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked += 1; return new Response("private"); } });
    const proxy = await startVerificationBrowserProxy(["http://example.test"], 2_000);
    try {
      const response = await fetch(`http://127.0.0.1:${fixture.port}/private`, { proxy: proxy.url });
      expect(response.status).toBe(403);
      await response.text();
      expect(await connectRequest(proxy.url, `127.0.0.1:${fixture.port}`)).toContain("403 Forbidden");
      expect(leaked).toBe(0);
      expect(() => proxy.assertHealthy()).toThrow("denied");
    } finally { await proxy.close(); await fixture.stop(true); }
  });

  test("rejects redirects to foreign origins before forwarding", async () => {
    let leaked = 0;
    const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { leaked += 1; return new Response("must-not-read"); } });
    const source = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { return Response.redirect(`http://127.0.0.1:${foreign.port}/private`, 302); } });
    const proxy = await startVerificationBrowserProxy([`http://127.0.0.1:${source.port}`], 2_000);
    try {
      const response = await fetch(`http://127.0.0.1:${source.port}/redirect`, { proxy: proxy.url });
      expect(response.status).toBe(403);
      await response.text();
      expect(leaked).toBe(0);
      expect(() => proxy.assertHealthy()).toThrow("denied");
    } finally { await proxy.close(); await source.stop(true); await foreign.stop(true); }
  });

  test("connects only a canonical approved HTTPS authority", async () => {
    const fixture = createServer(socket => socket.on("data", bytes => socket.write(bytes)));
    await new Promise<void>(resolve => fixture.listen(0, "127.0.0.1", resolve));
    const address = fixture.address();
    if (address === null || typeof address === "string") throw new Error("Missing tunnel fixture address");
    const authority = `127.0.0.1:${address.port}`;
    const proxy = await startVerificationBrowserProxy([`https://${authority}`], 2_000);
    try {
      const destination = new URL(proxy.url);
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(destination.port), destination.hostname, () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
        let received = "";
        let sent = false;
        socket.on("data", bytes => {
          received += bytes.toString();
          if (!sent && received.includes("\r\n\r\n")) { sent = true; socket.write("tunnel-fixture"); }
          if (received.endsWith("tunnel-fixture")) { resolve(received); socket.destroy(); }
        });
        socket.once("error", reject);
        socket.setTimeout(2_000, () => socket.destroy(new Error("Tunnel timed out")));
      });
      expect(echoed).toContain("200 Connection Established");
      expect(() => proxy.assertHealthy()).not.toThrow();
    } finally { await proxy.close(); await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve())); }
  });

  test.each(["fixture@example.test:443", "example.test:443/path", "example.test:443#fragment", "example.test:443:9"])("rejects malformed CONNECT authority %s independently", async authority => {
    const proxy = await startVerificationBrowserProxy(["https://example.test"], 2_000);
    try {
      expect(await connectRequest(proxy.url, authority)).toContain("403 Forbidden");
      expect(() => proxy.assertHealthy()).toThrow("denied");
    } finally { await proxy.close(); }
  });

  test("rejects ambiguous origins, credentials, empty policy, and invalid timeouts", async () => {
    for (const origin of ["file:///tmp", "https://user:password@example.test", "https://example.test/path", "https://example.test/", "https://EXAMPLE.test"]) {
      await expect(startVerificationBrowserProxy([origin], 1_000)).rejects.toThrow("canonical");
    }
    await expect(startVerificationBrowserProxy([], 1_000)).rejects.toThrow("explicit origins");
    await expect(startVerificationBrowserProxy(["https://example.test"], 0)).rejects.toThrow("positive timeout");
  });
});
