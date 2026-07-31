import { expect, test } from "bun:test";

import {
  expoExportArguments,
  expoExportWorkerCount,
} from "./verify";

test("uses an admitted worker budget and a conservative standalone default", () => {
  expect(expoExportWorkerCount(
    { DIRECT_EXAMPLE_MAX_WORKERS: "3" },
    16,
  )).toBe(3);
  expect(expoExportWorkerCount(
    { DIRECT_EXAMPLE_MAX_WORKERS: "20" },
    8,
  )).toBe(8);
  expect(expoExportWorkerCount({}, 16)).toBe(2);
  expect(expoExportWorkerCount({ DIRECT_EXAMPLE_MAX_WORKERS: "" }, 2)).toBe(1);
  expect(expoExportWorkerCount({}, 1)).toBe(1);
});

test("rejects malformed worker budgets", () => {
  expect(() => expoExportWorkerCount(
    { DIRECT_EXAMPLE_MAX_WORKERS: "0" },
    8,
  )).toThrow("DIRECT_EXAMPLE_MAX_WORKERS must be a positive integer");
  expect(() => expoExportWorkerCount(
    { DIRECT_EXAMPLE_MAX_WORKERS: "many" },
    8,
  )).toThrow("DIRECT_EXAMPLE_MAX_WORKERS must be a positive integer");
  expect(() => expoExportWorkerCount(
    { DIRECT_EXAMPLE_MAX_WORKERS: "9007199254740992" },
    8,
  )).toThrow("DIRECT_EXAMPLE_MAX_WORKERS must be a safe integer");
});

test("passes the exact worker limit to each Expo export", () => {
  expect(expoExportArguments("ios", "/tmp/ios", 2)).toEqual([
    "export",
    "--platform",
    "ios",
    "--output-dir",
    "/tmp/ios",
    "--no-minify",
    "--max-workers",
    "2",
    "--no-bytecode",
    "--source-maps",
    "external",
  ]);
  expect(expoExportArguments("web", "/tmp/web", 1)).toEqual([
    "export",
    "--platform",
    "web",
    "--output-dir",
    "/tmp/web",
    "--no-minify",
    "--max-workers",
    "1",
    "--source-maps",
    "external",
  ]);
});
