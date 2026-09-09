import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { required, admitAttempt, admitCanonicalJobs, canonicalJobs, admitExpectedHandoff, admitMirrorAuthority, admitRelease, admitRemoteAssetBytes, authorizeRelease, authorityPaths, admitVerifiedProvenance, checksums, compareVersions, findReleaseForTag, hash, parseManifest, releaseBody, verifyHandoff } from "./github-release.js";

const archive = Buffer.from("exact canonical bytes");
function manifest() {
  return parseManifest({ schema: "hraness-github-release-v1", repository: "hraness/direct", repositoryId: 1306913032,
    package: "@hraness/direct", version: "0.7.21", tag: "v0.7.21", sourceSha: "a".repeat(40),
    workflow: ".github/workflows/release.yml", workflowSha: "a".repeat(40), runId: 123, runAttempt: 1,
    archive: { name: "hraness-direct-0.7.21.tgz", bytes: archive.length, sha256: hash(archive), sha512: hash(archive, "sha512") } });
}
function files() {
  const m = manifest();
  const pack = [{ name: m.package, version: m.version, filename: m.archive.name, size: archive.length,
    integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`, shasum: hash(archive, "sha1") }];
  const result = new Map([[m.archive.name, archive], ["npm-pack.json", Buffer.from(JSON.stringify(pack))], ["release-manifest.json", Buffer.from(JSON.stringify(m))]]);
  result.set("SHA256SUMS", Buffer.from(checksums(result)));
  return result;
}
function attempt() {
  const m = manifest();
  return { id: m.runId, run_attempt: m.runAttempt, head_sha: m.sourceSha, head_branch: m.tag,
    workflow_id: 320004413, name: "Release", path: m.workflow, event: "push", status: "in_progress", conclusion: null,
    actor: { id: 894119, type: "User" }, triggering_actor: { id: 894119, type: "User" },
    repository: { id: 1306913032, full_name: "hraness/direct", private: false } };
}
test("canonical manifest rejects identity, bounds, override and path drift", () => {
  const m = manifest();
  expect(parseManifest(m)).toEqual(m);
  for (const change of [{ unexpected: true }, { repository: "other/direct" }, { repositoryId: 1 }, { package: "direct" }, { version: "0.7.21-beta.1" },
    { tag: "v0.7.22" }, { sourceSha: "main" }, { workflowSha: "main" }, { runId: 0 }, { runAttempt: 1.5 }, { workflow: ".github/workflows/npm-stage.yml" },
    { archive: { ...m.archive, name: "../package.tgz" } }, { archive: { ...m.archive, bytes: 4_000_001 } }, { archive: { ...m.archive, sha256: "0" } }]) {
    expect(() => parseManifest({ ...m, ...change })).toThrow();
  }
  expect(compareVersions("0.7.21", "0.7.20")).toBe(1);
  expect(() => compareVersions("9007199254740992.0.0", "0.7.20")).toThrow();
});
test("artifact admission binds exact files, bytes, metadata, source and trusted outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "direct-canonical-handoff-"));
  try {
    const inputs = files();
    for (const [name, bytes] of inputs) await writeFile(join(root, name), bytes);
    const result = await verifyHandoff(root, false);
    const expected = { GITHUB_SHA: result.manifest.sourceSha, GITHUB_REF_NAME: result.manifest.tag,
      GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", EXPECTED_ARCHIVE_SHA256: hash(archive),
      EXPECTED_PACK_SHA256: hash(required(inputs.get("npm-pack.json"))), EXPECTED_MANIFEST_SHA256: hash(required(inputs.get("release-manifest.json"))),
      EXPECTED_SUMS_SHA256: hash(required(inputs.get("SHA256SUMS"))) };
    expect(() => admitExpectedHandoff(result, expected)).not.toThrow();
    expect(() => admitExpectedHandoff(result, { ...expected, GITHUB_RUN_ATTEMPT: "2" })).toThrow("exact run");
    expect(() => admitExpectedHandoff(result, { ...expected, EXPECTED_PACK_SHA256: "0".repeat(64) })).toThrow("trusted");
    await writeFile(join(root, "unexpected"), "injected");
    await expect(verifyHandoff(root, false)).rejects.toThrow("unexpected");
    await rm(join(root, "unexpected"));
    await writeFile(join(root, result.manifest.archive.name), "changed");
    await expect(verifyHandoff(root, false)).rejects.toThrow("archive differs");
    await rm(join(root, result.manifest.archive.name));
    await symlink("npm-pack.json", join(root, result.manifest.archive.name));
    await expect(verifyHandoff(root, false)).rejects.toThrow("regular release file");
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("release authorization rejects collaborator reruns and stale source or attempt", () => {
  const m = manifest();
  expect(() => admitAttempt(attempt(), m)).not.toThrow();
  for (const change of [{ triggering_actor: { id: 99, type: "User" } }, { actor: { id: 894119, type: "Bot" } }, { head_sha: "b".repeat(40) },
    { run_attempt: 2 }, { head_branch: "main" }, { workflow_id: 1 }, { event: "workflow_dispatch" }, { status: "completed", conclusion: "failure" },
    { repository: { id: 1306913032, full_name: "other/direct", private: false } }]) {
    expect(() => admitAttempt({ ...attempt(), ...change }, m)).toThrow("exact authorized");
  }
  expect(() => admitAttempt({ ...attempt(), status: "completed", conclusion: "success" }, m, true)).not.toThrow();
  expect(() => admitAttempt(attempt(), m, true)).toThrow("exact authorized");
  expect(() => admitAttempt({ ...attempt(), status: "completed", conclusion: "failure" }, m, true)).toThrow("exact authorized");
});
function verified() {
  const m = manifest();
  return [{ verificationResult: { signature: { certificate: {
    issuer: "https://token.actions.githubusercontent.com", runnerEnvironment: "github-hosted",
    sourceRepositoryURI: "https://github.com/hraness/direct", sourceRepositoryIdentifier: "1306913032",
    sourceRepositoryDigest: m.sourceSha, sourceRepositoryRef: `refs/tags/${m.tag}`,
    buildSignerDigest: m.sourceSha, buildConfigDigest: m.sourceSha, buildTrigger: "push",
    buildSignerURI: `https://github.com/hraness/direct/${m.workflow}@refs/tags/${m.tag}`,
    buildConfigURI: `https://github.com/hraness/direct/${m.workflow}@refs/tags/${m.tag}`,
    runInvocationURI: `https://github.com/hraness/direct/actions/runs/${m.runId}/attempts/${m.runAttempt}`,
  } }, statement: { _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1",
    subject: [...files()].map(([name, bytes]) => ({ name, digest: { sha256: hash(bytes) } })),
    predicate: { buildDefinition: { buildType: "https://actions.github.io/buildtypes/workflow/v1",
      externalParameters: { workflow: { repository: "https://github.com/hraness/direct", path: m.workflow, ref: `refs/tags/${m.tag}` } },
      internalParameters: { github: { event_name: "push", repository_id: "1306913032", repository_owner_id: "307125679", runner_environment: "github-hosted" } },
      resolvedDependencies: [{ uri: `git+https://github.com/hraness/direct@refs/tags/${m.tag}`, digest: { gitCommit: m.sourceSha } }] },
    runDetails: { builder: { id: `https://github.com/hraness/direct/${m.workflow}@refs/tags/${m.tag}` },
      metadata: { invocationId: `https://github.com/hraness/direct/actions/runs/${m.runId}/attempts/${m.runAttempt}` } } } } } }];
}
test("verified provenance binds every subject and exact hosted workflow/source/attempt", () => {
  const m = manifest();
  const subjects = new Map([...files()].map(([name, bytes]) => [name, hash(bytes)]));
  expect(() => admitVerifiedProvenance(verified(), m, subjects)).not.toThrow();
  expect(() => admitVerifiedProvenance(verified(), m, new Map(subjects).set(m.archive.name, "0".repeat(64)))).toThrow();
  expect(() => admitVerifiedProvenance(verified(), { ...m, runAttempt: 2 }, subjects)).toThrow("certificate");
  expect(() => admitVerifiedProvenance(verified(), { ...m, sourceSha: "b".repeat(40) }, subjects)).toThrow();
  const selfHosted = verified();
  required(selfHosted[0]).verificationResult.statement.predicate.buildDefinition.internalParameters.github.runner_environment = "self-hosted";
  expect(() => admitVerifiedProvenance(selfHosted, m, subjects)).toThrow();
  const wrongBuilder = verified();
  required(wrongBuilder[0]).verificationResult.statement.predicate.runDetails.builder.id = "https://github.com/hraness/direct/.github/workflows/other.yml@main";
  expect(() => admitVerifiedProvenance(wrongBuilder, m, subjects)).toThrow();
  const relabeledAttempt = verified();
  required(relabeledAttempt[0]).verificationResult.signature.certificate.runInvocationURI = "https://github.com/hraness/direct/actions/runs/123/attempts/2";
  expect(() => admitVerifiedProvenance(relabeledAttempt, m, subjects)).toThrow("certificate");
  const duplicate = verified();
  required(duplicate[0]).verificationResult.statement.subject[1] = required(required(duplicate[0]).verificationResult.statement.subject[0]);
  expect(() => admitVerifiedProvenance(duplicate, m, subjects)).toThrow("subject");

});
test("draft reconciliation admits only matching state and never substitutes historical provenance", () => {
  const m = manifest();
  const inputs = files(); inputs.set("provenance.jsonl", Buffer.from("signed bundle"));
  const draft = { id: 5, tag_name: m.tag, name: `Direct ${m.tag}`, target_commitish: m.sourceSha, draft: true,
    prerelease: false, immutable: false, body: releaseBody(m), author: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    assets: [...inputs].map(([name, bytes], index) => ({ id: index + 1, name, browser_download_url: `https://github.com/hraness/direct/releases/download/${m.tag}/${name}`, state: "uploaded", size: bytes.length, digest: `sha256:${hash(bytes)}` })) };
  expect(() => admitRelease({ ...draft, id: 6 }, m, inputs, true, 5)).toThrow("Release ID changed");
  expect(() => admitRelease({ ...draft, id: 6, draft: false, immutable: true }, m, inputs, false, 5)).toThrow("Release ID changed");
  expect(admitRelease({ ...draft, assets: draft.assets.slice(0, 1) }, m, inputs, true).present.size).toBe(1);
  expect(() => admitRelease({ ...draft, assets: [] }, m, inputs, false)).toThrow("missing");
  expect(() => admitRelease({ ...draft, author: { id: 123, login: "other" } }, m, inputs, true)).toThrow();
  expect(() => admitRelease({ ...draft, body: releaseBody({ ...m, runAttempt: 2 }) }, m, inputs, true)).toThrow();
  expect(() => admitRelease({ ...draft, draft: false }, m, inputs, false)).toThrow();
  expect(admitRelease({ ...draft, draft: false, immutable: true }, m, inputs, false).draft).toBe(false);
  expect(() => admitRelease({ ...draft, assets: [{ ...required(draft.assets[0]), digest: `sha256:${"0".repeat(64)}` }] }, m, inputs, true)).toThrow("differs");
  expect(() => admitRelease({ ...draft, assets: [{ ...required(draft.assets[0]), id: 0 }] }, m, inputs, true)).toThrow("positive");
  expect(() => admitRelease({ ...draft, assets: [draft.assets[0], { ...required(draft.assets[1]), id: required(draft.assets[0]).id }] }, m, inputs, true)).toThrow("duplicated");
  const downloaded = new Map(draft.assets.map(asset => [asset.id, required(inputs.get(asset.name))]));
  expect(() => admitRemoteAssetBytes(draft, inputs, downloaded)).not.toThrow();
  expect(() => admitRemoteAssetBytes(draft, inputs, new Map(downloaded).set(1, Buffer.from("changed after digest response")))).toThrow("bytes differ");
});
test("draft discovery uses the complete authenticated list and exact ID when tag lookup returns 404", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-draft-fixture-token";
  const draft = { id: 501, tag_name: "v0.7.21", draft: true };
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, tag_name: `v1.0.${index}`, draft: false }));
  let secondPage: unknown[] = [draft];
  let readback: unknown = draft;
  const paths: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname
      + new URL(typeof input === "string" || input instanceof URL ? input : input.url).search;
    paths.push(path);
    if (path === "/repos/hraness/direct/releases/tags/v0.7.21") return new Response("Not Found", { status: 404 });
    if (path === "/repos/hraness/direct/releases?per_page=100&page=1") return Response.json(firstPage);
    if (path === "/repos/hraness/direct/releases?per_page=100&page=2") return Response.json(secondPage);
    if (path === "/repos/hraness/direct/releases/501") return Response.json(readback);
    throw new Error(`Unexpected draft fixture request: ${path}`);
  }) as typeof fetch;
  try {
    expect(await findReleaseForTag("v0.7.21")).toEqual(draft);
    expect(paths).toEqual(["/repos/hraness/direct/releases?per_page=100&page=1", "/repos/hraness/direct/releases?per_page=100&page=2", "/repos/hraness/direct/releases/501"]);
    secondPage = [draft, { ...draft, id: 502 }];
    await expect(findReleaseForTag("v0.7.21")).rejects.toThrow("Multiple releases");
    secondPage = [draft];
    readback = { ...draft, id: 502 };
    await expect(findReleaseForTag("v0.7.21")).rejects.toThrow("identity changed");
    readback = { ...draft, tag_name: "v0.7.22" };
    await expect(findReleaseForTag("v0.7.21")).rejects.toThrow("identity changed");
    secondPage = [{ ...draft, id: 0 }];
    await expect(findReleaseForTag("v0.7.21")).rejects.toThrow("positive");
    secondPage = [];
    expect(await findReleaseForTag("v0.7.21")).toBeNull();
    secondPage = [{ id: 1, tag_name: "v1.0.0", draft: false }];
    await expect(findReleaseForTag("v0.7.21")).rejects.toThrow("repeated an ID");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = originalToken;
  }
});
test("live admission rejects drift anywhere in the transitive release helper closure", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "inert-test-token";
  const m = manifest();
  const current = "b".repeat(40);
  let changedPath: string | undefined;
  const reads = new Set<string>();
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    expect(url.origin).toBe("https://api.github.com");
    const path = url.pathname;
    let value: unknown;
    if (path === "/repos/hraness/direct") value = { id: 1306913032, full_name: "hraness/direct", private: false, visibility: "public", default_branch: "main" };
    else if (path.endsWith("/actions/workflows/320004413")) value = { id: 320004413, path: m.workflow, name: "Release", state: "active" };
    else if (path.endsWith("/actions/runs/123/attempts/1")) value = attempt();
    else if (path.endsWith("/git/ref/heads/main")) value = { object: { type: "commit", sha: current } };
    else if (path.endsWith("/branches/main")) value = { protected: true, commit: { sha: current } };
    else if (path.includes("/compare/")) value = { status: "ahead" };
    else if (path.endsWith("/git/ref/tags/v0.7.21")) value = { object: { type: "commit", sha: m.sourceSha } };
    else if (path.includes("/git/tags/")) value = { object: { type: "commit", sha: m.sourceSha } };
    else if (path.includes("/contents/")) {
      const relative = required(path.split("/contents/")[1]);
      reads.add(relative);
      value = { type: "file", encoding: "base64", content: Buffer.from(relative === changedPath && url.searchParams.get("ref") === current ? "changed authority" : "reviewed bytes").toString("base64") };
    } else throw new Error(`Unexpected test route ${path}`);
    return Response.json(value);
  }) as typeof fetch;
  const environment = { GITHUB_SHA: m.sourceSha, GITHUB_REF_NAME: m.tag, GITHUB_REF: `refs/tags/${m.tag}`, GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_NAME: "push", GITHUB_ACTOR_ID: "894119", GITHUB_REPOSITORY: "hraness/direct",
    GITHUB_REPOSITORY_ID: "1306913032", GITHUB_WORKFLOW_REF: `hraness/direct/${m.workflow}@refs/tags/${m.tag}` };
  try {
    expect(await authorizeRelease(environment)).toBe(current);
    expect([...reads].sort()).toEqual([...authorityPaths].sort());
    for (const path of authorityPaths) {
      changedPath = path;
      await expect(authorizeRelease(environment)).rejects.toThrow("Current release authority changed");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = originalToken;
  }
});

test("draft display URLs do not grant authority and published assets require their canonical repository, tag and name", () => {
  const m = manifest(), inputs = files();
  inputs.set("provenance.jsonl", Buffer.from("signed bundle"));
  const release = { id: 5, tag_name: m.tag, name: `Direct ${m.tag}`, target_commitish: m.sourceSha, draft: true,
    prerelease: false, immutable: false, body: releaseBody(m), author: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    assets: [...inputs].map(([name, bytes], index) => ({ id: index + 1, name, state: "uploaded", size: bytes.length, digest: `sha256:${hash(bytes)}`,
      browser_download_url: `https://github.com/hraness/direct/releases/download/untagged-ef6c1bd779e9dd4032bb/${name}` })) };
  expect(() => admitRelease(release, m, inputs, false)).not.toThrow();
  expect(() => admitRemoteAssetBytes(release, inputs, new Map(release.assets.map(asset => [asset.id, required(inputs.get(asset.name))])))).not.toThrow();
  const published = { ...release, draft: false, immutable: true, assets: release.assets.map(asset => ({ ...asset,
    browser_download_url: `https://github.com/hraness/direct/releases/download/${m.tag}/${asset.name}` })) };
  expect(() => admitRelease(published, m, inputs, false)).not.toThrow();
  for (const url of [required(release.assets[0]).browser_download_url,
    `https://github.com/other/direct/releases/download/${m.tag}/${m.archive.name}`,
    `https://github.com/hraness/direct/releases/download/${m.tag}/wrong.tgz`]) {
    expect(() => admitRelease({ ...published, assets: published.assets.map((asset, index) => index ? asset : { ...asset, browser_download_url: url }) }, m, inputs, false)).toThrow("Published asset URL");
  }
});
test("mirror admission binds all canonical jobs without making downstream npm success a prerequisite", () => {
  const m = manifest();
  const jobs = canonicalJobs.map((name, index) => ({ id: index + 1, name, run_id: m.runId, run_attempt: m.runAttempt, head_sha: m.sourceSha, status: "completed", conclusion: "success" }));
  for (const state of [{ status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" }, { status: "completed", conclusion: "success" }]) {
    expect(() => admitAttempt({ ...attempt(), ...state }, m, "canonical")).not.toThrow();
    expect(() => admitCanonicalJobs([...jobs, { id: 99, name: "Mirror canonical package to npm / Publish exact package", run_id: m.runId, run_attempt: m.runAttempt, head_sha: m.sourceSha, status: "completed", conclusion: "failure" }], m)).not.toThrow();
  }
  for (const conclusion of ["failure", "cancelled", "skipped", null]) {
    expect(() => admitCanonicalJobs(jobs.map((job, index) => index ? job : { ...job, conclusion }), m)).toThrow();
  }
  expect(() => admitCanonicalJobs(jobs.map(job => ({ ...job, run_attempt: 2 })), m)).toThrow("identity");
  expect(() => admitCanonicalJobs(jobs.slice(0, 3), m)).toThrow("incomplete");
  expect(() => admitCanonicalJobs([...jobs, jobs[0]], m)).toThrow("identity");
  expect(() => admitCanonicalJobs(jobs.map(job => ({ ...job, head_sha: "b".repeat(40) })), m)).toThrow("identity");
  expect(() => admitCanonicalJobs(jobs.map(job => ({ ...job, run_id: 124 })), m)).toThrow("identity");
  expect(() => admitAttempt(attempt(), { ...m, runAttempt: 2 }, "canonical")).toThrow();
});
test("ordinary mirror binds push source or current-main dispatch while preserving the canonical source", () => {
  const m = manifest(), current = "b".repeat(40);
  const ref = { object: { type: "commit", sha: current } }, branch = { protected: true, commit: { sha: current } }, comparison = { status: "ahead" };
  for (const dispatch of [false, true]) {
    const source = dispatch ? current : m.sourceSha;
    const refName = dispatch ? "refs/heads/main" : `refs/tags/${m.tag}`;
    const environment = { GITHUB_SHA: source, GITHUB_REF: refName, GITHUB_EVENT_NAME: dispatch ? "workflow_dispatch" : "push",
      GITHUB_REPOSITORY: "hraness/direct", GITHUB_REPOSITORY_ID: "1306913032", GITHUB_ACTOR_ID: "894119", GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "2",
      GITHUB_WORKFLOW_REF: `hraness/direct/${m.workflow}@${refName}` };
    const run = { ...attempt(), id: 456, run_attempt: 2, head_sha: source, head_branch: dispatch ? "main" : m.tag, event: environment.GITHUB_EVENT_NAME };
    expect(() => admitMirrorAuthority(m, current, environment, ref, branch, comparison, run)).not.toThrow();
    for (const patch of [{ GITHUB_SHA: "c".repeat(40) }, { GITHUB_ACTOR_ID: "99" }, { GITHUB_WORKFLOW_REF: `hraness/direct/.github/workflows/npm-publish.yml@${refName}` }]) {
      expect(() => admitMirrorAuthority(m, current, { ...environment, ...patch }, ref, branch, comparison, run)).toThrow();
    }
    expect(() => admitMirrorAuthority(m, current, environment, ref, { ...branch, protected: false }, comparison, run)).toThrow();
    expect(() => admitMirrorAuthority(m, current, environment, ref, branch, { status: "diverged" }, run)).toThrow();
    expect(() => admitMirrorAuthority(m, current, environment, ref, branch, comparison, { ...run, triggering_actor: { id: 99, type: "User" } })).toThrow();
  }
});

test("canonical jobs precede optional npm and all source/install and signing boundaries remain enforced", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const mirror = await readFile(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
  const canonical = workflow.slice(0, workflow.indexOf("\n  npm:\n"));
  expect(canonical).not.toContain("needs: npm");
  expect(canonical).toContain("needs: [verify, attest]");
  for (const command of ["bun run check", "bun install --frozen-lockfile --ignore-scripts", "scripts/package-smoke.ts", "scripts/prepare-npm-package.ts", "scripts/prepare-github-release.ts"])
    expect(canonical).toContain(command);
  const privileged = canonical.slice(canonical.indexOf("\n  attest:\n"));
  expect(privileged).not.toContain("actions/checkout@");
  expect(privileged).not.toContain("bun install");
  expect(privileged).not.toContain("bun run check");
  for (const path of authorityPaths) expect(privileged).toContain(path);
  expect(privileged.indexOf("Rebind verified artifact before OIDC")).toBeLessThan(privileged.indexOf("uses: actions/attest@"));
  expect(workflow).toContain("needs: [authorize, publish]");
  expect(workflow).toContain("needs.publish.result == 'success'");
  expect(workflow).toContain("uses: ./.github/workflows/npm-publish.yml");
  expect(mirror).toContain("bun run check");
  expect(mirror).toContain('cp "$CANONICAL_DIRECTORY/$tarball_name" "$archive"');
  expect(mirror).toContain("Verify registry mirror identity and installation");
  const registry = mirror.slice(mirror.indexOf("\n  registry:\n"));
  expect(registry).not.toContain("id-token: write");
  expect(registry).toContain('--source-archive "$source_archive"');
  expect(registry).toContain('--registry-archive "$registry_archive"');
  expect(registry).toContain('run "$current_smoke"');
});

test("mirror and mirror-verify CLI rebind provider proof and emit exact canonical output", async () => {
  const { chmod, mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "direct-mirror-cli-"));
  const helper = new URL("./github-release.ts", import.meta.url).pathname;
  const m = manifest(), current = "b".repeat(40), inputs = files();
  inputs.set("provenance.jsonl", Buffer.from("fixture cryptographic verifier input"));
  const release = { id: 55, tag_name: m.tag, name: `Direct ${m.tag}`, target_commitish: m.sourceSha,
    draft: false, prerelease: false, immutable: true, body: releaseBody(m), author: { id: 41898282, login: "github-actions[bot]", type: "Bot" },
    assets: [...inputs].map(([name, bytes], index) => ({ id: index + 1, name, state: "uploaded", size: bytes.length,
      digest: `sha256:${hash(bytes)}`, browser_download_url: `https://github.com/hraness/direct/releases/download/${m.tag}/${name}` })) };
  const run = { ...attempt(), id: 456, head_sha: current, head_branch: "main", event: "workflow_dispatch" };
  const jobs = canonicalJobs.map((name, index) => ({ id: index + 1, name, run_id: m.runId, run_attempt: m.runAttempt,
    head_sha: m.sourceSha, status: "completed", conclusion: "success" }));
  const fixture = { release, run, canonical: { ...attempt(), status: "completed", conclusion: "failure" }, jobs, current,
    verified: verified(), files: Object.fromEntries([...inputs].map(([name, bytes]) => [name, bytes.toString("base64")])) };
  try {
    const fixturePath = join(root, "fixture.json"), binary = join(root, "bin"), runner = join(root, "runner.ts");
    await writeFile(fixturePath, JSON.stringify(fixture));
    await mkdir(binary);
    await writeFile(join(binary, "gh"), `#!${process.execPath}
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const f = JSON.parse(readFileSync(process.env.CLI_FIXTURE, 'utf8')), a = process.argv.slice(2);
if (a[0] === 'attestation') process.stdout.write(JSON.stringify(f.verified));
else if (a[0] === 'release' && a[1] === 'download') {
  const directory = a[a.indexOf('--dir') + 1];
  for (const [name, bytes] of Object.entries(f.files)) writeFileSync(join(directory, name), Buffer.from(bytes, 'base64'), { flag: 'wx' });
} else if (a[0] === 'api') {
  const path = a.find(x => x.startsWith('/repos/')), id = Number(path.split('/').pop());
  const asset = f.release.assets.find(x => x.id === id);
  if (!path.includes('/releases/assets/') || !asset) throw new Error('Unexpected fixture asset request');
  process.stdout.write(Buffer.from(f.files[asset.name], 'base64'));
} else throw new Error('Unexpected fixture gh command');
`);
    await chmod(join(binary, "gh"), 0o755);
    await writeFile(runner, `import { readFileSync } from 'node:fs';
const f = JSON.parse(readFileSync(process.env.CLI_FIXTURE, 'utf8'));
globalThis.fetch = async input => {
  const url = new URL(input), p = url.pathname;
  let value;
  if (p.includes('/releases/tags/')) value = f.release;
  else if (p.endsWith('/actions/runs/123/attempts/1')) value = f.canonical;
  else if (p.endsWith('/actions/runs/456/attempts/1')) value = f.run;
  else if (p.endsWith('/jobs')) value = { jobs: f.jobs };
  else if (p.includes('/git/ref/tags/')) value = { object: { type: 'commit', sha: f.release.target_commitish } };
  else if (p.endsWith('/git/ref/heads/main')) value = { object: { type: 'commit', sha: f.current } };
  else if (p.endsWith('/branches/main')) value = { protected: true, commit: { sha: f.current } };
  else if (p.includes('/compare/')) value = { status: 'ahead' };
  else if (p.includes('/contents/')) value = { type: 'file', encoding: 'base64', content: Buffer.from('reviewed authority').toString('base64') };
  else throw new Error('Unexpected fixture API route: ' + p);
  return Response.json(value);
};
const [helper, mode, directory] = process.argv.slice(2);
process.argv = [process.execPath, helper, mode, directory];
await import(helper);
`);
    for (const mode of ["mirror", "mirror-verify"]) {
      const directory = join(root, mode), output = join(root, `${mode}.output`);
      if (mode === "mirror-verify") {
        await mkdir(directory);
        for (const [name, bytes] of inputs) await writeFile(join(directory, name), bytes);
      }
      const child = Bun.spawn([process.execPath, runner, helper, mode, directory], { env: {
        NODE_ENV: "test", PATH: `${binary}:${process.env.PATH ?? ""}`, CLI_FIXTURE: fixturePath,
        GH_TOKEN: "inert-cli-fixture-token", EXPECTED_VERSION: m.version, EXPECTED_WORKFLOW_SHA: current,
        GITHUB_SHA: current, GITHUB_REF: "refs/heads/main", GITHUB_EVENT_NAME: "workflow_dispatch",
        GITHUB_WORKFLOW_REF: "hraness/direct/.github/workflows/release.yml@refs/heads/main", GITHUB_REPOSITORY: "hraness/direct",
        GITHUB_REPOSITORY_ID: "1306913032", GITHUB_ACTOR_ID: "894119", GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "1", GITHUB_OUTPUT: output,
      }, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000 });
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(await readFile(output, "utf8")).toBe(`canonical_source_sha=${m.sourceSha}\npackage_version=${m.version}\ncanonical_release_id=55\ncanonical_run_id=123\ncanonical_run_attempt=1\narchive_sha256=${m.archive.sha256}\npack_sha256=${hash(required(inputs.get("npm-pack.json")))}\n`);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);

test("terminal metadata admission retains only the parser's exact named extra-file allowance", async () => {
  const workflow = await readFile(new URL("../.github/workflows/npm-publish.yml", import.meta.url), "utf8");
  const marker = '            TARBALL="$tarball" node > "$rebound_output" <<\'NODE\'\n';
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const code = workflow.slice(start + marker.length, workflow.indexOf("          NODE\n", start)).split("\n").map(line => line.slice(10)).join("\n");
  const root = await mkdtemp(join(tmpdir(), "direct-mirror-metadata-"));
  const requiredPaths = ["LICENSE", "README.md", "dist/core/index.js", "dist/index.js", "dist/react.js", "dist/testing/index.js", "dist/tooling/bombadil.js",
    "dist/tooling/browser-verification-entry.js", "dist/tooling/bundle-boundary.js", "dist/web.js", "package.json", "skills/direct/SKILL.md"];
  const archiveBytes = Buffer.alloc(140_000, 9), filename = "hraness-direct-0.7.21.tgz";
  const archivePath = join(root, filename), metadata = join(root, "npm-pack.json"), digest = join(root, "npm-package.sha256");
  try {
    await writeFile(archivePath, archiveBytes);
    const execute = async (extraPath: string, additional = false) => {
      const paths = [...requiredPaths, ...Array.from({ length: 54 }, (_, index) => `src/fixture-${index}.ts`), extraPath, ...(additional ? ["src/unreviewed.ts"] : [])];
      const packing = Buffer.from(JSON.stringify([{ name: "@hraness/direct", id: "@hraness/direct@0.7.21", version: "0.7.21", filename,
        size: archiveBytes.length, entryCount: paths.length, unpackedSize: paths.length * 10_000,
        files: paths.map(path => ({ path, size: 10_000, mode: 0o644 })), shasum: hash(archiveBytes, "sha1"),
        integrity: `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}` }]));
      await writeFile(metadata, packing);
      await writeFile(digest, `${hash(archiveBytes)}  ${filename}\n${hash(packing)}  npm-pack.json\n`);
      return Bun.spawnSync(["node", "-e", code], { env: { NODE_ENV: "test", PATH: process.env.PATH, EXPECTED_VERSION: "0.7.21", EXPECTED_TARBALL_NAME: filename,
        TARBALL: archivePath, METADATA: metadata, DIGEST: digest, CANONICAL_ARCHIVE_SHA256: hash(archiveBytes), CANONICAL_PACK_SHA256: hash(packing) },
        stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 2_000 });
    };
    const valid = await execute("src/tooling/verification-output.ts");
    expect({ exit: valid.exitCode, stderr: valid.stderr.toString(), stdout: valid.stdout.toString() }).toEqual({ exit: 0, stderr: "", stdout: expect.stringContaining(hash(archiveBytes)) });
    for (const [path, additional] of [["src/other.ts", false], ["src/tooling/verification-output.ts", true]] as const) {
      const result = await execute(path, additional);
      expect({ path, additional, exit: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString() }).toMatchObject({ exit: 1 });
      expect(result.stderr.toString()).toContain("excessive entryCount");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
