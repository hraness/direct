# Publish Direct

Direct publishes each new stable npm version from its protected version tag.
The same release workflow verifies the public registry package before it
creates the immutable GitHub Release.

## Protect release authorization

Keep two active GitHub tag rulesets on `refs/tags/v*`:

- Restrict creation to organization administrators. A version-tag push is the
  authorization to publish npm, so ordinary repository write access must not
  be enough to create one.
- Block updates and deletion with no bypass actors. After creation, no
  maintainer or automation may move or remove a version tag.

The publishing and release jobs also resolve the tag from GitHub immediately
before each mutation. Repository rules and workflow checks are both required.

## Configure trusted publishing

`@hraness/direct` must have one GitHub Actions trusted publisher with this
exact identity:

- organization or owner: `hraness`
- repository: `direct`
- workflow filename: `release.yml`
- allowed action: `npm publish`
- environment: none

Configure the publisher after `.github/workflows/release.yml` and
`.github/workflows/npm-publish.yml` are on `main`:

```sh
npm trust github @hraness/direct \
  --file release.yml \
  --repo hraness/direct \
  --allow-publish \
  --registry=https://registry.npmjs.org
npm trust list @hraness/direct \
  --json \
  --registry=https://registry.npmjs.org
```

Complete npm's interactive two-factor authentication. The trusted-publisher
identity is exact and case-sensitive. npm validates the calling
`release.yml` workflow when it invokes the repository-owned reusable
publication workflow. Both workflow boundaries grant the required OIDC
permission.

In the package's npm settings, select **Require two-factor authentication and
disallow tokens** under Publishing access. Do not add an npm password, session
cookie, one-time password, recovery code, or write token to GitHub.

## Release a version

1. Merge one strictly increasing stable version to `main` after the required
   checks pass. Confirm that repository-level immutable releases remain
   enabled.

2. Create and push one protected tag on that exact commit. The tag must equal
   `v<package.json version>`.

   ```sh
   git tag v0.7.11
   git push origin refs/tags/v0.7.11
   ```

3. Wait for **Release**. The workflow runs these boundaries in order:

   - A read-only job checks the tag, current default-branch ancestry, package
     identity, frozen install, complete repository gate, generated tree, and
     package boundary. It prepares and smokes one artifact containing exactly the
     tarball, `npm-pack.json`, and `npm-package.sha256`.
   - The only job with OIDC authority checks out no source and runs no
     repository code. It downloads the three-file artifact, validates its
     complete npm inventory, rehashes all three files, resolves every remote
     stable tag and the default branch in a new bare Git directory, requires the
     candidate to remain the newest remote stable tag, proves its version is
     newer than every published stable version, and publishes that exact tarball
     with `npm publish`.
   - A read-only verification job rebuilds the tagged package and compares it
     with the public registry package by safe path, entry type, mode, size, and
     regular-file hashes. Each transport must also match its own npm SHA-1,
     SHA-512, and registry metadata.
   - A final job with `contents: write` creates the asset-free immutable
     GitHub Release and verifies that it is non-draft, non-prerelease, and
     Latest.

4. Confirm that npm shows the new version, its trusted-publishing provenance,
   and the expected `latest` tag. Confirm that the matching GitHub Release is
   immutable and Latest before creating another version tag.

The workflow does not use `NODE_AUTH_TOKEN` or a long-lived npm credential.
If a tag run is retried after npm accepted the package, the OIDC job leaves the
existing version unchanged and the later canonical comparison proves that it
matches the tagged source.

The terminal tag check does not depend on GitHub's concurrency order. It reads
the remote stable-tag set before publication and stops if a newer stable tag
exists.

## Package identity

npm can encode equivalent package contents into different gzip or tar bytes
on different operating systems. The release gate verifies each tarball's own
npm SHA-1 and SHA-512, then compares the complete extracted package identity:
entry type, safe path, mode, size, SHA-256, and SHA-512 for every regular file.
It rejects links, unsafe paths, unexpected files, inventory drift, and npm
metadata that does not describe the inspected archive.

Filename comparison or raw compressed-byte comparison is not a substitute for
this proof.

## Recover an already-published release

First rerun the failed tag workflow. GitHub retains the original tag and source
commit, and the idempotent npm boundary accepts only an existing package that
the later registry gate proves byte-equivalent.

If the workflow itself needs a fix, keep the tag and npm version immutable.
Merge the fix to `main`, then dispatch **Release** from current `main` with
the exact existing stable tag:

```sh
gh workflow run release.yml --ref main -f tag=v0.7.11
```

The recovery path skips npm publication. It accepts only the newest stable
repository tag, freshly resolves that tag from GitHub, requires its commit to
remain reachable from current `main`, and reads the name and version from the
tagged `package.json`.

The workflow checks and builds the tagged source in a detached worktree, then
rebinds the release helpers to their reviewed Git blobs in the current workflow
checkout. It invokes those files by absolute path while retaining the tagged
tree as the package working directory. Bun loads no tag-owned config or
environment file, and `npm pack --ignore-scripts` prevents a historical
`prepack` from running. The current helpers do not import a script from the
tagged tree.

Immediately before creating the Release, the write-scoped job resolves the tag
and default branch again, checks stable tag and published Release ordering, and
requires recovery to still run from the verified current `main` commit. Any
tag movement, branch advance, newer stable tag, newer stable Release, npm
metadata drift, or package-content difference stops recovery.

See npm's documentation for [trusted
publishing](https://docs.npmjs.com/trusted-publishers/) and [package
publication](https://docs.npmjs.com/cli/v11/commands/npm-publish/).
