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

For a new installation, pin the reviewed public release:

```sh
bun add --dev github:hraness/direct#v0.7.2
```

The equivalent manifest entry is:

```json
{
  "devDependencies": {
    "@hraness/direct": "github:hraness/direct#v0.7.2"
  }
}
```

Then run `bun install`. Do not add another package manager or lockfile to a
repository that already defines its package manager.

If the task starts with skill installation rather than a loaded skill, install
the single repository skill with either command:

```sh
npx skills add hraness/direct
bunx skills add hraness/direct
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
