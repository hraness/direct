# Publish Direct

GitHub Releases are canonical for new versions after 0.7.20. Each release carries
one installable package archive and its exact packing, source, checksum, and
provenance evidence. npm is an unattended downstream mirror of that archive.
A failed npm mirror leaves the valid GitHub release available.

## Protect release authorization

Keep repository-level immutable releases enabled and two active GitHub tag
rulesets on `refs/tags/v*`:

- Restrict creation to organization administrators. A protected version-tag push
  authorizes canonical publication and the optional npm mirror.
- Block updates and deletion with no bypass actors. Never move or remove a
  version tag, replace an immutable asset, or overwrite an npm version.

Keep `main` protected by required source checks. The workflow admits repository
ID `1306913032`, owner actor and triggering actor ID `894119`, and the exact
`Release` workflow ID `320004413`. Review the complete writer, ruleset, immutable
release, and npm trust configuration at setup and after control changes. Routine
publication uses fresh source, workflow, run, artifact, and provider readback.

## Configure the optional npm mirror

`@hraness/direct` retains one GitHub Actions trusted publisher:

- organization or owner: `hraness`
- repository: `direct`
- workflow filename: `release.yml`
- allowed action: `npm publish`
- environment: none

The calling `release.yml` remains npm's trusted workflow when it invokes
`npm-publish.yml`. Both boundaries grant the required OIDC permission.

```sh
npm trust github @hraness/direct \
  --file release.yml \
  --repo hraness/direct \
  --allow-publish \
  --registry=https://registry.npmjs.org
npm trust list @hraness/direct --json --registry=https://registry.npmjs.org
```

Complete npm's required interactive authentication during trust setup. Retain
**Require two-factor authentication and disallow tokens** in Publishing access.
Routine eligible mirrors use OIDC. Do not store an npm password, session cookie,
one-time password, recovery code, or write token in GitHub. npm availability
and authentication are independent of canonical GitHub publication.

## Release a version

1. Merge one strictly increasing stable version to protected `main` after the
   source checks and independent review pass. Verify immutable-release and tag
   controls, current main, existing tags, and published versions before reserving
   a version. Public install examples remain on the last delivered version until
   the new assets are live.
2. Create one lightweight `v<package.json version>` tag on the exact checked
   commit and push only that tag. Do not use an annotated tag for this repository.
3. Follow the single **Release** run. Its read-only verification job checks owner,
   source ancestry, the lightweight tag, current helper closure, frozen install,
   the complete `bun run check`, generated cleanliness, strict package identity,
   and an isolated Bun/npm consumer installation. It packs the archive once.
4. The checkout-free attestation job rebinds four SHA-256 outputs from verification
   before requesting OIDC. It signs the archive, `npm-pack.json`,
   `release-manifest.json`, and `SHA256SUMS`. The preserved `provenance.jsonl` is the
   fifth public asset. Cryptographic verification binds every subject, the hosted
   runner certificate, repository, source, workflow, run ID, and run attempt.
5. The checkout-free publisher reauthorizes current source and helpers before
   each write, retains the positive ID returned by draft creation, and reconciles
   existing drafts through authenticated paginated inventory and ID readback.
   GitHub may hide drafts from tag lookup and use temporary draft display URLs;
   downloads use exact API asset IDs. Verify every remote byte before making the
   draft immutable Latest and again afterward, with canonical published URLs.
6. Confirm all five public assets, immutable Latest, archive integrity, attested
   source, and a clean archive installation. Then record the optional npm mirror
   outcome separately. Do not claim a mirror succeeded from a successful GitHub
   publication alone.

The helper closure includes the calling workflow, producer, package parsers,
installation smoke, npm workflow, package manifest, and lockfile. Source code
runs only in read-only jobs; privileged jobs load the reviewed standalone
built-in helper after comparing tagged and current-main Git blobs.

Keep the clean consumer's verification toolchain pinned to a tuple qualified
against Direct's own frozen dependencies. The smoke checks the five resolved
package identities and records their manifest hashes and the consumer lock hash
before compiling the original type fixtures. These verifier selectors do not
change the public package's dependency requirements or historical artifacts.

## Install and update from GitHub

After an asset is published and verified, install its exact stable version:

```sh
version=0.7.21
bun add --dev "https://github.com/hraness/direct/releases/download/v$version/hraness-direct-$version.tgz"
```

The archive retains the name `@hraness/direct` and every export. Pin the exact
version and lockfile; upgrade by replacing that version and running the
consumer's acceptance checks. Do not use a moving `latest` archive URL.
Before installing an archive from a downloaded handoff, check `SHA256SUMS`, the
manifest's archive SHA-256/SHA-512 and packing metadata, and use `gh attestation
verify` with the bundle, repository, exact source/ref, signer workflow/digest,
and `--deny-self-hosted-runners`. The release helper additionally admits the
verified certificate's exact run/attempt and all four subjects; merely parsing
an unsigned manifest does not establish provenance.

## Mirror the canonical archive to npm

After **Authorize release request**, **Verify**, **Attest canonical artifact**,
and **Publish** have all succeeded in the exact canonical run/attempt, the
ordinary mirror can proceed. It checks those jobs individually because the
same workflow is still running the npm jobs. A prior run whose downstream npm
job failed remains usable only when all four canonical jobs succeeded.

The read-only mirror job verifies the immutable GitHub record, all five assets,
actual bytes, and cryptographic provenance. It keeps the canonical source `C`
separate from protected current workflow `W`, checks out `C` in an isolated tree,
and retains the frozen install, complete `bun run check`, generated cleanliness,
and exact-archive isolated installation. Current helpers are bound to `W` before
running against `C`. It copies exactly the tarball, `npm-pack.json`, and
`npm-package.sha256` into the privileged handoff; it never repacks the mirror.

Within the npm workflow, the only job with OIDC authority checks out no source
and runs no repository code. It validates the bounded complete npm inventory,
rehashes all three files, and resolves every stable tag and current main in a
new bare Git directory. It rechecks original successful canonical jobs, owner,
source, current workflow, immutable release, and exact remote archive bytes.
The candidate must remain the newest remote stable tag and be newer than every
published stable npm version. Fresh main/tag reads immediately precede the exact
`npm publish --ignore-scripts --provenance` to `https://registry.npmjs.org`.

The read-only registry job compares the canonical archive with the public npm
package by complete extracted safe path, entry type, mode, size, and regular-file
SHA-256/SHA-512. Each transport must independently match its npm SHA-1/SHA-512 and
registry metadata, since registry compression can differ. It then installs that
registry archive in clean Bun/npm consumers. An existing npm version is left
unchanged and accepted only when this comparison and installation succeed.

## Retry and recover

For an incomplete draft, preserve its ID and uploaded assets. A rerun of the
original canonical attempt admits only exactly matching manifest, bytes, and
provenance; a new run attempt cannot relabel old signed artifacts. Reconcile an
uncertain write before retrying. If an attempt-bound draft cannot be completed
safely, retain it and create a new reviewed version instead of replacing it.

A failed npm mirror can be retried independently from current protected `main`:

```sh
gh workflow run release.yml --ref main -f tag=v0.7.21
```

This verifies the original canonical source and run/attempt while binding mirror
execution to the current protected workflow. It neither republishes GitHub nor
relabels provenance. Current helper drift, a moved tag or main, incomplete source
jobs, a newer stable tag, or mismatching bytes stops the operation.

Only pre-canonical versions at or below 0.7.20 may use `legacy-release.yml`,
through the owner-validated current-main dispatch. This retains the historical
full source check and registry comparison before the asset-free GitHub recovery.
The recovery path rebinds the release helpers to their reviewed Git blobs and
invokes those files by absolute path against the tagged source, with no tag-owned
config or environment loading. Keep `npm pack --ignore-scripts` so recovery never
runs a historical `prepack`; current helpers do not import a script from the
tagged tree. Existing source ancestry, newest-tag, npm identity, immutable Latest,
and final provider readback requirements remain binding.
