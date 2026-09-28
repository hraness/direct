# Changelog

Each section below is the release page text for one Direct version: a summary, then the changes. The release workflow copies the section whose heading matches the tagged version and adds the install and verification steps itself.

## 0.7.23 - 2026-09-28

This release updates Direct's package description, README, and Agent Skill guidance. The library's exports and browser tooling are unchanged.

- The npm package description now reads "Direct gives browser agents repeatable app states that open by URL, with your real interface running on fixture data."
- The README opens with what Direct does, then shows how it differs from Storybook and Mock Service Worker. A new section compares Direct with Storybook, Mock Service Worker, and Playwright's saved sign-in and network stubs, and says where each of them is the better choice.
- The README overview leads with a Playwright check against the Todo example, names the example's empty and write-failure states, and no longer repeats install commands in its closing section.
- The `$direct` skill describes Direct as a development-only TypeScript library, closes each task with a short plain-language report of what changed, what was checked, and what remains unverified, and presents any support offer as one plain sentence.
- The skill's adoption guide gives an example of when to use `parseDirectDefinition`.

## 0.7.22 - 2026-09-16

The Direct Agent Skill can offer optional support for Direct at the end of useful work for a person. The library's exports and browser tooling are unchanged.

- The skill ships a standalone `scripts/support.mjs` helper that runs with Node.js and needs no package installation. After useful work for a person, the skill may show one support invitation; it skips unattended runs, tool loops, and subagent phases.
- `support dismiss` turns invitations off across participating tools on the machine, `support snooze` pauses them for thirty days, and `support enable` turns them back on. `HRANESS_SUPPORT=off` or `HRANESS_SUPPORT_AUDIENCE=off` suppresses incidental offers. No command signs up, authenticates, or pays.
- Importing Direct and running its verification tooling never show an invitation or read support preferences.
- The skill's install guide and `skills add` commands name this version.
