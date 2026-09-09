import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { required, checksums, hash, packageName, parseManifest, record, repository, repositoryId, stableVersion, verifyHandoff, workflow } from "./github-release.js";
import { inspectPackageArtifact } from "./package-artifact.js";

const [directoryArgument, ...extra] = process.argv.slice(2);
if (!directoryArgument || extra.length !== 0) throw new Error("Usage: bun scripts/prepare-github-release.ts <packed-directory>");
const directory = resolve(directoryArgument);
const source = record(JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as unknown, "Source package");
const version = stableVersion(source.version);
if (source.name !== packageName) throw new Error("Unexpected package identity.");
const archiveName = `hraness-direct-${version}.tgz`;
await inspectPackageArtifact(join(directory, archiveName));
const archive = await readFile(join(directory, archiveName));
const manifest = parseManifest({ schema: "hraness-github-release-v1", repository, repositoryId, package: packageName,
  version, tag: `v${version}`, sourceSha: process.env.GITHUB_SHA, workflow, workflowSha: process.env.CURRENT_AUTHORITY_SHA,
  runId: Number(process.env.GITHUB_RUN_ID), runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
  archive: { name: archiveName, bytes: archive.length, sha256: hash(archive), sha512: hash(archive, "sha512") } });
await writeFile(join(directory, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
const files = new Map<string, Buffer>();
for (const name of [archiveName, "npm-pack.json", "release-manifest.json"]) files.set(name, await readFile(join(directory, name)));
await writeFile(join(directory, "SHA256SUMS"), checksums(files), { flag: "wx" });
const handoff = await verifyHandoff(directory, false);
if (!process.env.GITHUB_OUTPUT) throw new Error("Release preparation requires an Actions output boundary.");
for (const [name, key] of [[archiveName, "archive_sha256"], ["npm-pack.json", "pack_sha256"], ["release-manifest.json", "manifest_sha256"], ["SHA256SUMS", "sums_sha256"]] as const) {
  await writeFile(process.env.GITHUB_OUTPUT, `${key}=${hash(required(handoff.files.get(name)))}\n`, { flag: "a" });
}
