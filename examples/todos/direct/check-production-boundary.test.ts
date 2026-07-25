import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  TODO_DIRECT_EXECUTABLE_MARKERS,
  scanTodoDirectOutput,
  scanTodoProductionOutput,
} from "./check-production-boundary";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(exampleRoot, "../..");
const localStorageSource = join(exampleRoot, "src/local-storage-todo-port.ts");
const productionSources = [
  join(exampleRoot, "src/main.tsx"),
  join(exampleRoot, "src/TodoApp.tsx"),
  join(exampleRoot, "src/todo-port.ts"),
  localStorageSource,
];
const directSources = [
  join(exampleRoot, "direct/main.tsx"),
  join(exampleRoot, "direct/workbench.tsx"),
  join(exampleRoot, "direct/session.ts"),
  join(exampleRoot, "direct/deterministic-todo-port.ts"),
  join(exampleRoot, "src/TodoApp.tsx"),
  join(exampleRoot, "src/todo-port.ts"),
  join(packageRoot, "src/web/browser-bridge.ts"),
  join(packageRoot, "src/web/fetch-firewall.ts"),
];
const standaloneDirectSources = [
  ...directSources.slice(0, -2),
  join(packageRoot, "dist/web.js"),
];
const directJavaScript = `console.log(${TODO_DIRECT_EXECUTABLE_MARKERS
  .map((marker) => JSON.stringify(marker))
  .join(",")});`;

async function emitMappedBrowserBuild(
  directory: string,
  sources: readonly string[],
  javaScript = "console.log('todo');",
): Promise<void> {
  const assets = join(directory, "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(join(directory, "index.html"), "<main>Todo example</main>");
  await writeFile(join(assets, "app.js"), `${javaScript}\n//# sourceMappingURL=app.js.map\n`);
  await writeFile(join(assets, "app.js.map"), JSON.stringify({
    version: 3,
    file: "app.js",
    names: [],
    mappings: "",
    sources,
  }));
}

async function expectBoundaryFailure(promise: Promise<unknown>, message: string): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (reason) {
    rejection = reason;
  }
  expect(rejection).toBeInstanceOf(Error);
  if (!(rejection instanceof Error)) throw new Error("Expected the boundary scan to reject.");
  expect(rejection.message).toContain(message);
}

describe("todo production boundary", () => {
  test("reports forbidden markers after proving the emitted production graph", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-production-boundary-"));
    try {
      await emitMappedBrowserBuild(
        directory,
        [...productionSources.slice(0, -1), pathToFileURL(localStorageSource).href],
        "prefix\0__direct\0suffix",
      );
      const result = await scanTodoProductionOutput(directory, ["__direct"]);
      expect(result.scanned).toHaveLength(3);
      expect(result.sourceMaps).toEqual([join(directory, "assets", "app.js.map")]);
      expect(result.observedSources).toEqual([...productionSources].sort());
      expect(result.violations).toEqual([{
        file: join(directory, "assets", "app.js"),
        markers: ["__direct"],
      }]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects future Direct wire versions from production output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-production-wire-boundary-"));
    try {
      await emitMappedBrowserBuild(
        directory,
        productionSources,
        [
          "direct.browser-bridge/v99",
          "direct.coverage/v99",
          "direct.fixture/v99",
          "direct.probe/v99",
          "direct.runtime/v99",
          "direct.session-manifest/v99",
        ].join(" "),
      );
      const result = await scanTodoProductionOutput(directory);
      expect(result.violations).toEqual([{
        file: join(directory, "assets", "app.js"),
        markers: [
          "direct.browser-bridge/v",
          "direct.coverage/v",
          "direct.fixture/v",
          "direct.probe/v",
          "direct.runtime/v",
          "direct.session-manifest/v",
        ],
      }]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects empty, executable-free, and unrelated clean output", async () => {
    const empty = await mkdtemp(join(tmpdir(), "todo-production-empty-"));
    const unrelated = await mkdtemp(join(tmpdir(), "todo-production-unrelated-"));
    const htmlOnly = await mkdtemp(join(tmpdir(), "todo-production-html-only-"));
    try {
      await expectBoundaryFailure(scanTodoProductionOutput(empty), "did not scan");
      await writeFile(join(htmlOnly, "index.html"), "<main>unrelated</main>");
      await expectBoundaryFailure(scanTodoProductionOutput(htmlOnly), "did not find emitted JavaScript");
      await emitMappedBrowserBuild(unrelated, [join(unrelated, "unrelated.ts")]);
      await expectBoundaryFailure(scanTodoProductionOutput(unrelated), "missing required source modules");
    } finally {
      await Promise.all([empty, unrelated, htmlOnly].map((directory) => (
        rm(directory, { force: true, recursive: true })
      )));
    }
  });

  test("requires every emitted JavaScript file to have a valid source map", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-production-unmapped-"));
    try {
      await mkdir(join(directory, "assets"));
      await writeFile(join(directory, "index.html"), "<main>Todo</main>");
      await writeFile(join(directory, "assets/app.js"), "console.log('todo')");
      await expectBoundaryFailure(scanTodoProductionOutput(directory), "missing its source map");
      await writeFile(join(directory, "assets/app.js.map"), JSON.stringify({
        version: 3,
        sources: productionSources,
      }));
      await expectBoundaryFailure(
        scanTodoProductionOutput(directory),
        "does not reference its paired source map",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects mapped package sources outside the production-owned graph", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-production-import-"));
    try {
      await emitMappedBrowserBuild(directory, [
        ...productionSources,
        join(packageRoot, "src/core/store.ts"),
      ]);
      await expectBoundaryFailure(
        scanTodoProductionOutput(directory, ["forbidden-marker"]),
        "outside its allowed graph",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe("todo Direct boundary", () => {
  test("proves the separate Direct entry, shared UI, and web boundary modules", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-direct-boundary-"));
    try {
      await emitMappedBrowserBuild(directory, directSources, directJavaScript);
      const result = await scanTodoDirectOutput(directory);
      expect(result.violations).toEqual([]);
      expect(result.observedSources).toEqual([...directSources].sort());
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("accepts the standalone package web entry with positive executable evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-direct-standalone-boundary-"));
    try {
      await emitMappedBrowserBuild(directory, standaloneDirectSources, directJavaScript);
      const result = await scanTodoDirectOutput(directory);
      expect(result.observedSources).toEqual([...standaloneDirectSources].sort());
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects a mapped Direct graph without bridge and firewall executable evidence", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-direct-marker-free-"));
    try {
      await emitMappedBrowserBuild(directory, directSources);
      await expectBoundaryFailure(
        scanTodoDirectOutput(directory),
        "missing required executable markers",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("does not accept v20 or v10 as the current Direct wire versions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-direct-wire-version-"));
    try {
      const futureWireJavaScript = directJavaScript
        .replace("direct.browser-bridge/v2", "direct.browser-bridge/v20")
        .replace("direct.session-manifest/v1", "direct.session-manifest/v10")
        .replace("direct.probe/v1", "direct.probe/v10");
      await emitMappedBrowserBuild(directory, directSources, futureWireJavaScript);
      await expectBoundaryFailure(
        scanTodoDirectOutput(directory),
        "missing required executable markers",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects stale or future wire versions beside the current contract", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-direct-mixed-wire-version-"));
    try {
      await emitMappedBrowserBuild(
        directory,
        directSources,
        [
          directJavaScript,
          "direct.browser-bridge/v1",
          "direct.session-manifest/v2",
          "direct.probe/v2",
        ].join(" "),
      );
      await expectBoundaryFailure(
        scanTodoDirectOutput(directory),
        "unexpected executable marker versions",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects production composition and storage modules in the Direct graph", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo-direct-production-import-"));
    try {
      await emitMappedBrowserBuild(
        directory,
        [...directSources, ...productionSources],
        directJavaScript,
      );
      await expectBoundaryFailure(
        scanTodoDirectOutput(directory),
        "forbidden source modules",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
