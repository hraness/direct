---
title: Repository seams
type: concept
tags:
  - architecture
  - dependencies
  - repositories
repository_scopes:
  - AGENTS.md
  - docs
  - examples
  - kb
  - skills
  - WRITING.md
  - STYLE.md
  - package.json
  - src
---

# Repository seams

Direct publishes a product-neutral deterministic-development harness. Its stable runtime seam is the versioned scenario, fixture, store, effect, resource, evidence, manifest, probe, session, and browser-bridge contract. Each product still owns its semantic ports, strict JSON world, deterministic adapters, scenarios, coverage claims, and workbench.

The package also exposes two independently imported host-tooling seams. Browser verification supplies protocol-bound atomic bridge reads, bounded agent-browser process mechanics, local server leases, and artifact persistence. Bundle-boundary verification supplies deterministic emitted-file scans and exact versioned-marker evidence. These Bun/Node exports are built separately and must remain absent from the default, core, React, testing, and web graphs. Products own driver commands, semantic and visual assertions, included output patterns, product markers, and positive production identity evidence.

Consumers pin a reviewed immutable release or full commit and validate upgrades on their own schedule. Do not replace that boundary with sibling paths, Git submodules, or coordinated `main` workflows. Direct remains development-only: production entries and emitted assets must not import the package, fixture worlds, scenario catalogs, workbenches, or browser bridge.

Keep the package headless and do not make it depend on a design system or product composition. Add a shared abstraction only after two concrete consumers need the same stable interface. Freeze public interfaces before parallel work and give manifests, locks, generated artifacts, and release convergence surfaces one owner.

## Related

The normative rules remain in the root `AGENTS.md`. [[documentation-ownership|Documentation ownership]] explains how those rules relate to executable contracts and this pull-based context.
