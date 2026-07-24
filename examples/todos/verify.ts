import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import {
  scanTodoDirectOutput,
  scanTodoProductionOutput,
} from "./direct/check-production-boundary";

const exampleRoot = dirname(fileURLToPath(import.meta.url));

async function verifyTodoExample(): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cclrte-direct-todos-"));
  const productionOutput = join(temporaryRoot, "production");
  const directOutput = join(temporaryRoot, "direct");

  try {
    await build({
      configFile: resolve(exampleRoot, "vite.config.ts"),
      build: {
        emptyOutDir: true,
        outDir: productionOutput,
      },
    });
    const boundary = await scanTodoProductionOutput(productionOutput);
    if (boundary.violations.length > 0) {
      throw new Error([
        "Todo production output contains Direct markers:",
        ...boundary.violations.map((violation) => (
          `${violation.file}: ${violation.markers.join(", ")}`
        )),
      ].join("\n"));
    }

    await build({
      configFile: resolve(exampleRoot, "direct/vite.config.ts"),
      build: {
        emptyOutDir: true,
        outDir: directOutput,
      },
    });
    const directBoundary = await scanTodoDirectOutput(directOutput);

    console.log([
      `Todo production boundary passed (${String(boundary.scanned.length)} files).`,
      `Todo Direct boundary passed (${String(directBoundary.scanned.length)} files).`,
      "Production and Direct source graphs were proved in an isolated temporary directory.",
    ].join("\n"));
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

await verifyTodoExample();
