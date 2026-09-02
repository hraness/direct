---
name: direct
description: Use Hraness Direct to install, adopt, test, audit, or troubleshoot deterministic frontend and UI testing workbenches for web, React, React Native, and Expo. Trigger for repeatable signed-in, empty, loading, and error states; frontend fixtures and scenario URLs; strict JSON worlds; product-owned ports and adapters; logical time; fail-closed network boundaries; agent-browser, Playwright, or Bombadil verification; quiescence probes; coverage claims; property tests; and proving @hraness/direct stays out of production bundles.
---

# Direct

Direct is a development-only harness for repeatable application states. It
runs the real interface and feature code against product-owned deterministic
ports. It does not drive the browser or prove the live systems, hosts,
platforms, or devices that those ports replace.

## Choose the workflow

- If Direct is absent, the requested work includes installation, or package
  readiness is uncertain, read [references/install.md](references/install.md).
- To add, extend, repair, or troubleshoot a Direct composition, read
  [references/adoption.md](references/adoption.md).
- To test, audit, review, or report evidence from an existing composition,
  read [references/verification.md](references/verification.md).
- For end-to-end adoption, read the installation and adoption references,
  implement the smallest product seam, then apply the verification reference.

## Preserve the boundary

Keep Direct in `devDependencies`. Put provider, storage, native-module, host,
or service code behind the smallest product-owned semantic port. Production
and Direct compositions must have structurally separate entry graphs.

Never import Direct, fixture worlds, scenario catalogs, workbench code, or the
browser bridge from a production entry. Build production independently and
scan its emitted executable output. A scan that inspected no executable files
is not evidence.

Parse foreign worlds and browser contracts from `unknown`. Reject malformed
explicit activation instead of falling back to another scenario. Use logical
time and activity scopes for deterministic work, and join a stable quiet probe
before making semantic assertions.

For a design or layout audit, pair a macro screenshot critique with micro
geometry gates from `@hraness/direct/tooling/browser-verification`. Let the
product name the measured boxes, no-overlap pairs, containment, alignment,
clipping, size, and stability rules. Never substitute automatic all-pairs
collision scanning for reviewed product invariants, and never treat a passing
rectangle gate as proof of visual hierarchy or quality.

State proof limits precisely. Fixture evidence can prove the real interface
and product logic through deterministic ports; it cannot prove a substituted
adapter, service, operating system, browser host, or device.

## Finish the task

Run narrow checks while editing, then the consumer repository's complete
in-scope gate. Report the selected product port, scenarios, proof modes,
commands, production surfaces scanned, passed evidence, and direct evidence
that remains open.
