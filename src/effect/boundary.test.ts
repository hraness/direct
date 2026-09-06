import { expect, test } from "bun:test";
import * as effect from "@hraness/direct/effect";
import { isRecord } from "../core/result.js";

function inputs(metafile: unknown): readonly string[] {
  const parsed: unknown = typeof metafile === "string" ? JSON.parse(metafile) : metafile;
  if (!isRecord(parsed) || !isRecord(parsed.inputs)) throw new Error("Invalid bundle input metadata");
  return Object.keys(parsed.inputs);
}

test("Effect is opt-in and existing browser graphs exclude its implementation", async () => {
  expect(Object.keys(effect)).toEqual(["createDirectEffectDriver"]);
  const built = await Bun.build({
    entrypoints: ["./src/index.ts", "./src/core/index.ts", "./src/testing/index.ts", "./src/react.ts", "./src/web.ts"],
    target: "browser", external: ["react"], metafile: true,
  });
  expect(built.success).toBeTrue();
  if (built.metafile === undefined) throw new Error("missing bundle input evidence");
  const paths = inputs(built.metafile);
  expect(paths.length).toBeGreaterThan(5);
  expect(paths.filter(path => /(?:node_modules\/effect\/|src\/effect\/)/u.test(path))).toEqual([]);
  const optedIn = await Bun.build({ entrypoints: ["./src/effect/index.ts"], target: "browser", metafile: true });
  expect(optedIn.success).toBeTrue();
  if (optedIn.metafile === undefined) throw new Error("missing Effect bundle input evidence");
  expect(inputs(optedIn.metafile).some(path => path.includes("node_modules/effect/"))).toBeTrue();
});
