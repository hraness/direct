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

4. Create one npm tarball in a new temporary directory.

   ```sh
   direct_npm_artifact="$(mktemp -d)"
   bun run ./scripts/prepare-npm-package.ts "$direct_npm_artifact"
   bun run ./scripts/package-smoke.ts \
     "$direct_npm_artifact/hraness-direct-0.7.5.tgz"
   ```

   Read the complete inventory and its file-count, packed-size, and
   unpacked-size result before continuing. The smoke installs this exact file
   into a clean consumer and exercises every supported package surface.

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
   the registry metadata and tarball match the reviewed artifact. Install the
   registry package in another clean consumer before creating `v0.7.5`.

The tag workflow verifies the public npm artifact before it creates the
immutable GitHub Release. A missing or different registry version stops that
release.

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
3. Download or inspect the uploaded tarball and the npm staged package. Compare
   its version, inventory, integrity, and source commit with the workflow run.
4. Approve the staged package through npm with two-factor authentication.
5. Verify the public registry package in a clean consumer.
6. Create and push the matching `v<version>` tag on the same `main` commit. The
   existing tag workflow verifies npm delivery, then creates the immutable
   GitHub Release.

The stage workflow uses a GitHub-hosted runner, Node 24, npm 11.19.0, Bun
1.3.14, disabled package-manager caching, and no stored npm token. It uploads
the exact tarball that it submits to npm.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/) and [staged
publishing](https://docs.npmjs.com/staged-publishing/).
