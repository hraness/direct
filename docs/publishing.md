# Publish Direct

Direct uses an interactive first publication and stage-only trusted publishing
for later versions. A package name must already exist on npm before npm accepts
`npm stage publish`, so the first registry write cannot use the normal workflow.

## Prepare the first npm package

Start from the current `main` commit after its required checks pass. Use Node
24, npm 11.19.0, and Bun 1.3.14. Do not create the release tag yet.

1. Install the frozen development graph without lifecycle scripts.

   ```sh
   bun install --frozen-lockfile --ignore-scripts
   ```

2. Run the complete repository gate.

   ```sh
   bun run check
   ```

3. Confirm that the build did not change the checked generated package tree.

   ```sh
   git status --porcelain --untracked-files=all -- dist bun.lock
   ```

   Continue only when this command produces no output.

4. Create one npm tarball and preserve its exact npm metadata in a new temporary
   directory.

   ```sh
   direct_npm_artifact="$(mktemp -d)"
   bun run ./scripts/prepare-npm-package.ts "$direct_npm_artifact"
   bun run ./scripts/package-smoke.ts \
     --archive "$direct_npm_artifact/hraness-direct-0.7.5.tgz" \
     --pack-json "$direct_npm_artifact/npm-pack.json"
   ```

   Read the complete inventory, file-count, packed-size, unpacked-size, SHA-1,
   and SHA-512 result before continuing. The smoke binds those reported values
   to this exact tarball, installs it with Bun and npm in clean consumers, and
   exercises every supported package surface.

5. Publish the reviewed file with the signed-in maintainer session.

   ```sh
   direct_npm_cache="$(mktemp -d)"
   npm publish \
     "$direct_npm_artifact/hraness-direct-0.7.5.tgz" \
     --access public \
     --cache "$direct_npm_cache" \
     --ignore-scripts \
     --registry=https://registry.npmjs.org
   ```

   Complete npm's interactive two-factor authentication prompt. Never place an
   npm password, one-time password, recovery code, session cookie, or token in
   Git, a workflow, a task file, or chat.

6. Confirm that `@hraness/direct@0.7.5` is public, `latest` names `0.7.5`, and
   the registry metadata and canonical package contents match the reviewed
   artifact. Install the registry package in another clean consumer before
   creating `v0.7.5`.

The tag workflow verifies the public npm artifact before it creates the
immutable GitHub Release. A missing or different registry version stops that
release.

The source and registry `.tgz` files do not need identical transport bytes.
gzip and tar metadata can vary across operating systems even when every package
file is the same. The release gate verifies each tarball's own npm SHA-1 and
SHA-512, then compares the complete extracted package identity: entry type,
safe path, mode, size, and SHA-256 and SHA-512 of every regular file. It rejects
links, unsafe paths, unexpected files, inventory drift, and npm metadata that
does not describe the inspected archive. Registry `dist` integrity, shasum,
file count, unpacked size, and canonical tarball URL must also match. Filename
comparison or raw compressed-byte comparison is not a substitute for this
proof.

## Configure trusted publishing

After the first package is public, configure one GitHub Actions trusted
publisher in the npm package settings:

- organization or owner: `hraness`
- repository: `direct`
- workflow filename: `npm-stage.yml`
- allowed action: `npm stage publish` only
- environment: none

Then set publishing access to require two-factor authentication and disallow
traditional tokens. Do not add an npm publishing token to GitHub.

The trusted-publisher identity is exact and case-sensitive. npm does not test
the configuration when it is saved, so review each field before the first
staged release.

## Stage a later version

1. Merge a new stable version to `main` and wait for the required CI job.
2. Dispatch **Stage npm package** from the current `main` branch. The workflow
   rejects a tag, another branch, or a commit behind the current default-branch
   head.
3. Inspect the uniquely named artifact from the read-only verification job. It
   contains exactly the tarball, `npm-pack.json`, and `npm-package.sha256`.
   Compare its source commit, name, version, inventory, modes, sizes, SHA-1,
   SHA-512, and independent SHA-256 values with the workflow run.
4. Approve the staged package through npm with two-factor authentication.
5. Verify the public registry package in a clean consumer.
6. Create and push the matching `v<version>` tag on the same `main` commit. The
   existing tag workflow verifies npm delivery, then creates the immutable
   GitHub Release.

The read-only verification job uses a GitHub-hosted runner, Node 24, npm
11.19.0, Bun 1.3.14, disabled package-manager caching, and no stored npm token.
The dependent terminal staging job is the only job with OIDC authority. It
checks out no source and runs no repository code. It downloads and revalidates
the three exact files, fetches the current default-branch head into a new bare
Git directory, rehashes all three files, and only then stages the reviewed
tarball through `https://registry.npmjs.org`.

## Recover a failed tag release

Use recovery only when npm delivery and the stable tag already succeeded but
the tag workflow failed before it created the GitHub Release. Never move or
delete the tag, and never republish the npm version.

First merge the release-workflow fix to `main`. Then dispatch **Release** from
the current `main` branch and enter the exact existing stable tag. For example:

```sh
gh workflow run release.yml --ref main -f tag=v0.7.5
```

The recovery path accepts only the newest stable repository tag. It freshly
resolves that tag from GitHub, requires its commit to remain reachable from
current `main`, reads the name and version from the tagged `package.json`, and
checks and builds the tagged source in a detached worktree. This explicit
tagged `bun run check` is the only source-build boundary. Afterward, the
workflow rebinds the release helpers to their reviewed Git blobs in the current
workflow checkout and invokes those files by absolute path while retaining the
tagged tree as the package working directory. Bun is given no tag-owned config
or environment file while it loads the current helpers. The package step uses
`npm pack --ignore-scripts`, so it consumes the checked build without running
the tag's `prepack` or another tagged lifecycle script. The current helpers
import their current core-only archive inspector. They do not import a script
from the tagged tree. They download the public npm artifact and apply the same
canonical package-identity and clean-consumer gates used by future tag pushes.

Immediately before creating the Release, the write-scoped job resolves the tag
and default branch again, checks stable tag and published Release ordering, and
requires recovery to still be running from the verified current `main` commit.
Any tag movement, branch advance, newer stable tag, newer stable Release, npm
metadata drift, or package-content difference stops recovery. A successful run
creates and validates the immutable, asset-free, Latest GitHub Release. It does
not write to npm or Git tags.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/) and [staged
publishing](https://docs.npmjs.com/staged-publishing/).
