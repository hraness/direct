import { preview } from "vite";
import { buildTodo } from "./build.ts";
import { parseTodoBuildTarget } from "./build-contract.ts";

const defaultPort = 5173;

// DIRECT_EXAMPLE_PORT lets parallel worktrees serve side by side; 0 picks a free port.
function parsePreviewPort(value: string | undefined): number {
  if (value === undefined || value === "") return defaultPort;
  if (!/^(0|[1-9][0-9]{0,4})$/u.test(value) || Number(value) > 65_535) {
    throw new Error(`DIRECT_EXAMPLE_PORT must be an integer from 0 to 65535, got ${JSON.stringify(value)}`);
  }
  return Number(value);
}

const target = parseTodoBuildTarget(process.argv[2]);
const port = parsePreviewPort(process.env.DIRECT_EXAMPLE_PORT);
const directory = await buildTodo(target);
const server = await preview({
  configFile: false,
  root: directory,
  build: { outDir: directory },
  preview: { host: "127.0.0.1", port, strictPort: true, open: false },
});
const address = server.httpServer.address();
const boundPort = typeof address === "object" && address !== null ? address.port : port;
console.log(`Compiled Todo preview: http://127.0.0.1:${String(boundPort)}/${target === "direct" ? "direct/" : ""}`);
console.log(`Generation: ${directory}\nAfter edits, stop this command, rebuild/restart, then refresh the browser. HMR is disabled.`);
let closing = false;
function close(): void {
  if (closing) return;
  closing = true;
  void server.close().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
