import { createServer, request as httpRequest, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";

export async function startVerificationBrowserProxy(origins: readonly string[], timeoutMs: number) {
  if (origins.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Browser containment requires explicit origins and a positive timeout");
  }
  const allowed = new Set(origins.map(origin => {
    const parsed = new URL(origin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin
      || parsed.username !== "" || parsed.password !== "") {
      throw new Error("Browser containment requires canonical HTTP(S) origins");
    }
    return parsed.origin;
  }));
  const sockets = new Set<Socket>();
  let transferred = 0;
  let denied = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (closed) { socket.destroy(); return; }
    socket.setTimeout(timeoutMs, () => socket.destroy());
    socket.on("data", chunk => {
      transferred += chunk.length;
      if (transferred > 64 * 1024 * 1024) {
        denied = true;
        for (const active of sockets) active.destroy();
      }
    });
  };
  const server = createServer({ maxHeaderSize: 32 * 1024 }, (incoming, response) => {
    let target: URL;
    try {
      target = new URL(incoming.url ?? "");
      if (!allowed.has(target.origin) || target.username !== "" || target.password !== ""
        || target.hash !== "" || closed || denied) throw new Error("denied");
    } catch {
      denied = true;
      response.writeHead(403).end();
      incoming.resume();
      return;
    }
    const hopHeaders = new Set(["connection", "proxy-connection", "proxy-authorization", "keep-alive", "upgrade",
      ...String(incoming.headers.connection ?? "").split(",").map(value => value.trim().toLowerCase())]);
    const headers: OutgoingHttpHeaders = Object.fromEntries(Object.entries(incoming.headers)
      .filter(([name]) => !hopHeaders.has(name)));
    headers.host = target.host;
    const upstream = (target.protocol === "https:" ? httpsRequest : httpRequest)(target, {
      method: incoming.method, headers, agent: false,
    }, outgoing => {
      response.writeHead(outgoing.statusCode ?? 502, outgoing.headers);
      outgoing.pipe(response);
    });
    const deadline = setTimeout(() => upstream.destroy(), timeoutMs);
    upstream.once("close", () => clearTimeout(deadline));
    upstream.setTimeout(timeoutMs, () => upstream.destroy());
    upstream.once("socket", track);
    upstream.once("error", () => {
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    });
    incoming.once("aborted", () => upstream.destroy());
    response.once("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", track);
  server.on("upgrade", (_request, socket) => { denied = true; socket.destroy(); });
  server.on("connect", (incoming, downstream, head) => {
    let target: URL;
    try {
      target = new URL(`https://${incoming.url ?? ""}`);
      if (!allowed.has(target.origin) || incoming.url !== `${target.hostname}:${target.port || 443}`
        || target.username !== "" || target.password !== "" || closed || denied) throw new Error("denied");
    } catch {
      denied = true;
      downstream.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connect(Number(target.port || 443), target.hostname, () => {
      downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream);
      upstream.pipe(downstream);
    });
    track(upstream);
    downstream.once("close", () => upstream.destroy());
    upstream.once("error", () => downstream.destroy());
    upstream.once("close", () => downstream.destroy());
  });
  server.headersTimeout = Math.min(timeoutMs, 30_000);
  server.requestTimeout = timeoutMs;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Browser proxy did not bind loopback");
  return {
    url: `http://127.0.0.1:${address.port}`,
    assertHealthy() {
      if (denied) throw new Error("Browser containment denied a request or exceeded its transfer budget");
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      closePromise = (async () => {
        const closing = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const socket of sockets) socket.end();
        let force: ReturnType<typeof setTimeout> | undefined;
        const forced = new Promise<void>(resolve => { force = setTimeout(() => { for (const socket of sockets) socket.destroy(); resolve(); }, 1_000); });
        try {
          await closing;
          await Promise.race([Promise.all([...sockets].map(socket => new Promise<void>(resolve => socket.once("close", resolve)))), forced]);
          if ([...sockets].some(socket => !socket.destroyed)) throw new Error("Browser proxy socket cleanup did not complete");
        } finally { clearTimeout(force); }
      })();
      return closePromise;
    },
  };
}
