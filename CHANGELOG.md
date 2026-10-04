# Changelog

Each section below is the release page text for one Direct version: a summary, then the changes. The release workflow copies the section whose heading matches the tagged version and adds the install and verification steps itself.

## 0.7.29 - 2026-10-04

The semantic browser proxy now chooses outgoing network destinations only from the approved origins configured by its owner.

- Read the outgoing HTTP(S) and CONNECT host, port, and protocol from the approved origin, not the browser request; forward only the validated request path and query.
- Verify that a double-slash path and a conflicting Host header cannot change the destination. Keep foreign-origin denials, HTTPS handling, and cleanup unchanged.

## 0.7.28 - 2026-10-04

Direct can prefer a provisioned Lightpanda 1.0.0 for fresh semantic checks, while Chromium remains the browser for rendering and compatibility checks.

- Export `createVerificationBrowser` with explicit allowed origins and capability-based Chromium selection for visual checks and Chromium launch options.
- Run Lightpanda through a filtering HTTP(S) proxy and private empty driver configuration; reject visibility, CSS, geometry, media, download, and multi-target requests.
- Verify the executable and loopback CDP identity, finish owned browser and process cleanup, and reject further work after containment or cleanup failures. Never replay failed assertions or actions in another engine.

## 0.7.27 - 2026-10-03

Direct now provides an opt-in Lightpanda 1.0 semantic browser lane for faster, lower-memory DOM verification while keeping provisioned Chromium authoritative for visual and layout evidence.

- Export `createLightpandaSemanticBrowser` from the browser-verification tooling subpath. It starts a task-owned Lightpanda CDP server, creates its initial target, and bounds teardown around an explicit pinned executable.
- Guard Lightpanda commands and evaluations to semantic checks, rejecting screenshots, PDFs, downloads, CSS and geometry reads, media, and multi-target operations before they reach the browser.
- Keep Chromium as the default backend and the required source for visual, layout, media, authentication, geometry, and contained semantic-plus-visual evidence.
- Release publication resolves the protected annotated version tag to its exact commit before admitting or publishing the immutable archive.

## 0.7.26 - 2026-10-03

Direct now provides an opt-in Lightpanda 1.0 semantic browser lane for faster, lower-memory DOM verification while keeping provisioned Chromium authoritative for visual and layout evidence.

- Export `createLightpandaSemanticBrowser` from the browser-verification tooling subpath. It starts a task-owned Lightpanda CDP server, creates its initial target, and bounds teardown around an explicit pinned executable.
- Guard Lightpanda commands and evaluations to semantic checks, rejecting screenshots, PDFs, downloads, CSS and geometry reads, media, and multi-target operations before they reach the browser.
- Keep Chromium as the default backend and the required source for visual, layout, media, authentication, geometry, and contained semantic-plus-visual evidence.
- Release publication now resolves the protected annotated version tag to its exact commit before admitting or publishing the immutable archive.

## 0.7.24 - 2026-09-29

Direct's browser verification helper now requires an explicitly provisioned automation browser, preventing agent-browser from silently selecting installed, auto-updating Chrome.

- Set `executablePath` in `scripts/direct/agent-browser.verify.json` to Chrome for Testing or provisioned Chromium. The helper resolves the path, rejects installed Chrome bundles, checks the browser version with bounded output and execution time, and reports the selected executable and version.
- Browser attachment, alternate providers, and executable overrides are rejected by the owned-browser helper. `run()` requires the command first; batches support plain unquoted command strings and `--bail`. Use individual calls for complex payloads.
- The verification guide and Agent Skill recipe select and check the automation browser explicitly. Existing session isolation and browser cleanup requirements remain in place.

## 0.7.23 - 2026-09-28

This release updates Direct's package description, README, and Agent Skill guidance. The library's exports and browser tooling are unchanged.

- The npm package description now reads "Direct gives browser agents repeatable app states that open by URL, with your real interface running on fixture data."
- The README opens with what Direct does, then shows how it differs from Storybook and Mock Service Worker. Its "When to use Direct" section has a table comparing Direct with Playwright's route mocking, saved sign-in, and clock, Mock Service Worker, and Storybook, and says when each of them is the better choice.
- The README overview leads with a Playwright check against the Todo example, names the example's empty and write-failure states, and no longer repeats install commands in its closing section.
- The `$direct` skill describes Direct as a development-only TypeScript library, closes each task with a short plain-language report of what changed, what was checked, and what remains unverified, and presents any support offer as one plain sentence.
- The skill's adoption guide gives an example of when to use `parseDirectDefinition`.

## 0.7.22 - 2026-09-16

The Direct Agent Skill can offer optional support for Direct at the end of useful work for a person. The library's exports and browser tooling are unchanged.

- The skill ships a standalone `scripts/support.mjs` helper that runs with Node.js and needs no package installation. After useful work for a person, the skill may show one support invitation; it skips unattended runs, tool loops, and subagent phases.
- `support dismiss` turns invitations off across participating tools on the machine, `support snooze` pauses them for thirty days, and `support enable` turns them back on. `HRANESS_SUPPORT=off` or `HRANESS_SUPPORT_AUDIENCE=off` suppresses incidental offers. No command signs up, authenticates, or pays.
- Importing Direct and running its verification tooling never show an invitation or read support preferences.
- The skill's install guide and `skills add` commands name this version.
