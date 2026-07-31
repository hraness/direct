import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  scanReactNativeDirectWebOutput,
  scanReactNativeProductionOutput,
} from "./direct/check-native-boundary";

const exampleRoot = dirname(fileURLToPath(import.meta.url));
const expoExportLog = join(exampleRoot, ".expo", "dev", "logs", "export.log");
const workerBudgetVariable = "DIRECT_EXAMPLE_MAX_WORKERS";

export function expoExportWorkerCount(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  hostParallelism = availableParallelism(),
): number {
  const maximum = Math.max(1, hostParallelism);
  const configured = environment[workerBudgetVariable];
  if (configured === undefined || configured === "") {
    return Math.min(2, Math.max(1, maximum - 1));
  }
  if (!/^[1-9][0-9]*$/u.test(configured)) {
    throw new Error(`${workerBudgetVariable} must be a positive integer`);
  }
  const workerCount = Number.parseInt(configured, 10);
  if (!Number.isSafeInteger(workerCount)) {
    throw new Error(`${workerBudgetVariable} must be a safe integer`);
  }
  return Math.min(workerCount, maximum);
}

export function expoExportArguments(
  platform: "android" | "ios" | "web",
  output: string,
  workerCount: number,
): readonly string[] {
  if (!Number.isSafeInteger(workerCount) || workerCount < 1) {
    throw new Error("Expo export worker count must be a positive safe integer");
  }
  return [
    "export",
    "--platform",
    platform,
    "--output-dir",
    output,
    "--no-minify",
    "--max-workers",
    String(workerCount),
    ...(platform === "web"
      ? ["--source-maps", "external"]
      : ["--no-bytecode", "--source-maps", "external"]),
  ];
}

async function exportPlatform(
  platform: "android" | "ios" | "web",
  output: string,
  workerCount: number,
): Promise<void> {
  const arguments_ = [
    process.execPath,
    "x",
    "expo",
    ...expoExportArguments(platform, output, workerCount),
  ];
  const command = Bun.spawn(arguments_, {
    cwd: exampleRoot,
    env: {
      ...process.env,
      CI: "1",
      EXPO_NO_TELEMETRY: "1",
      NODE_ENV: "production",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    command.exited,
    new Response(command.stdout).text(),
    new Response(command.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error([
      `Expo ${platform} export failed with exit code ${String(exitCode)}.`,
      stdout.trim(),
      stderr.trim(),
    ].filter((line) => line.length > 0).join("\n"));
  }
}

async function verifyReactNativeExample(workerCount: number): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hraness-direct-react-native-"));
  const iosOutput = join(temporaryRoot, "ios");
  const androidOutput = join(temporaryRoot, "android");
  const webOutput = join(temporaryRoot, "web");

  try {
    await exportPlatform("ios", iosOutput, workerCount);
    const iosBoundary = await scanReactNativeProductionOutput(iosOutput);
    if (iosBoundary.violations.length > 0) {
      throw new Error(`iOS production output contains Direct markers: ${JSON.stringify(iosBoundary.violations)}`);
    }

    await exportPlatform("android", androidOutput, workerCount);
    const androidBoundary = await scanReactNativeProductionOutput(androidOutput);
    if (androidBoundary.violations.length > 0) {
      throw new Error(`Android production output contains Direct markers: ${JSON.stringify(androidBoundary.violations)}`);
    }

    await exportPlatform("web", webOutput, workerCount);
    const webBoundary = await scanReactNativeDirectWebOutput(webOutput);
    console.log([
      `React Native iOS boundary passed (${String(iosBoundary.scanned.length)} files).`,
      `React Native Android boundary passed (${String(androidBoundary.scanned.length)} files).`,
      `The deterministic React Native Web composition exported successfully (${String(webBoundary.scanned.length)} files).`,
    ].join("\n"));
  } finally {
    await Promise.all([
      rm(temporaryRoot, { force: true, recursive: true }),
      rm(expoExportLog, { force: true }),
    ]);
  }
}

if (import.meta.main) await verifyReactNativeExample(expoExportWorkerCount());
