# Install and verify Direct

Installing this Agent Skill does not install the Direct library into a
consumer project. Direct is a development dependency and does not provide a
global `direct` CLI.

## Check readiness

1. Read the consumer's repository instructions and package manifest.
2. Confirm Bun is available with `command -v bun`. If it is absent, follow the
   reviewed environment setup or the official [Bun installation
   guide](https://bun.sh/docs/installation); do not run an unreviewed remote
   install script.
3. Inspect `devDependencies` for `@hraness/direct`. Do not move it into
   `dependencies`.
4. Reuse the repository's existing immutable Direct pin when it is compatible.
   Do not upgrade an existing pin unless the user asked for an upgrade.

## Add the library

For a new installation, verify that the immutable v0.7.21 GitHub release and
its archive are published before using this version. Source candidates do not
establish public availability. Check the release manifest, checksums, and
provenance using the tagged publishing guide, then install the exact archive:

```sh
bun add --dev https://github.com/hraness/direct/releases/download/v0.7.21/hraness-direct-0.7.21.tgz
# or, in an npm project
npm install --save-dev https://github.com/hraness/direct/releases/download/v0.7.21/hraness-direct-0.7.21.tgz
```

The package keeps the name `@hraness/direct`. An independently verified npm
mirror may instead use the immutable pin `@hraness/direct@0.7.21`. Use the
consumer's existing package manager and lockfile. To upgrade, replace the
exact archive version and run the consumer's type, installation, and emitted
production-boundary checks; do not use a moving Latest URL.

If the task starts with skill installation rather than a loaded skill, install
the single repository skill with either command:

```sh
npx skills add hraness/direct#v0.7.21
bunx skills add hraness/direct#v0.7.21
```

Restart or reload the agent runner if it does not discover newly installed
skills during the current session, then invoke `$direct`.

## Optional browser verification dependency

Direct's runtime is driver-neutral. Install `agent-browser@0.32.3` only when
the requested verification workflow uses Direct's optional agent-browser host
tooling and the consumer does not already supply the compatible peer:

```sh
bun add --dev agent-browser@0.32.3
```

Playwright MCP or another browser driver can instead read the same exact
`window.__direct` contract when it independently establishes the required
containment, fresh-context, and cleanup evidence. Do not install a browser
driver for an adoption-only task.

Install Bombadil only when the product requests bounded diagnostic fuzzing
through Direct's optional campaign and host-runner subpaths. The integration
supports one exact release:

```sh
bun add --dev @antithesishq/bombadil@0.7.2
```

Bombadil is an optional Direct peer. Keep the direct development dependency in
the consumer root because the host runner resolves and validates that root
package and its native platform binary.

## Verify the boundary

After installation:

- ensure the lockfile resolves the intended immutable release;
- typecheck the consumer's intended Direct imports;
- build Direct and production entries separately; and
- run the product-owned emitted-bundle boundary gate against every production
  surface.

Package installation alone does not activate fixtures and does not prove
production exclusion.
