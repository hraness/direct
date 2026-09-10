import { preview } from "vite";
import { buildTodo } from "./build.ts";
import { parseTodoBuildTarget } from "./build-contract.ts";

const target = parseTodoBuildTarget(process.argv[2]);
const directory = await buildTodo(target);
const server = await preview({
  configFile: false,
  root: directory,
  build: { outDir: directory },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true, open: false },
});
console.log(`Compiled Todo preview: http://127.0.0.1:5173/${target === "direct" ? "direct/" : ""}`);
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
