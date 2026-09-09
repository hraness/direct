---
type: plan
area: distribution
status: in-progress
description: Make immutable GitHub archives canonical while preserving unattended exact-archive npm mirrors and complete source acceptance.
repository_scopes:
  - .github/workflows
  - scripts
---

# Canonical GitHub releases

Publish new Direct versions independently of npm, with the same package name,
exports, development-only boundaries, and isolated installation. Preserve npm
as an ordinary OIDC mirror of the exact canonical archive.

## Decisions and scope

The protected lightweight version tag owns canonical source `C`. The current
protected workflow `W` owns a mirror dispatch; older `C` remains immutable and
must be an ancestor of `W`. All required original canonical jobs must have
succeeded in their exact run and attempt before any mirror. A failed downstream
npm job does not invalidate a valid canonical release.

The GitHub publisher binds the five-file handoff, verified certificate and
four attested subjects, current transitive helper closure, actor and triggering
actor, repository, tag, source, and original run/attempt. It retains draft IDs,
reconciles by authenticated inventory and API ID, verifies remote bytes before
immutability and afterward, and requires canonical published asset URLs.

Existing complete release and mirror source checks, archive budgets, extracted
identity comparison, isolated consumer installation, newest-tag and npm-version
ordering, owner-only tag creation, immutable-tag rules, OIDC identity, and
provider readback remain required. Historical asset-free recovery is confined
to versions at or below 0.7.20. No production runtime or consumer APIs change.

## Work and verification

- Implement canonical preparation, checkout-free attestation and publication,
  downstream mirror and registry readback, plus bounded historical routing.
- Keep current-main helpers distinct from immutable source and test stale actor,
  source, workflow, attempt, job, file, digest, URL, and inventory refusals.
- Verify actual mirror CLI output and terminal OIDC shell with bounded inert
  provider fixtures. These fixtures prove admission behavior, not live GitHub
  or npm qualification.
- Preserve the exact existing `bun run check` in CI. Contributor source
  acceptance uses complete current-candidate `check` and `Required` success,
  with focused local checks and independent review, following CONTRIBUTING.
  Coverage drift tests retain every phase and failure propagation. Separate
  explicit local/native/browser/install/release/provider gates remain binding.
- Run the existing canonical package comparison and historical installation
  fixtures, focused type/lint and metadata checks, isolated candidate install,
  KB refresh/check, and complete exact-head/current-base PR CI before delivery.

Implementation evidence: the complete focused release suite passed 38 tests
with 1109 assertions, including the unchanged historical recovery installations.
A subsequent fixture proves the privileged metadata validator preserves the
parser's existing single named-file allowance for verification-output.ts while
rejecting unrelated extra paths. Typecheck and changed-file lint pass.
Candidate installation caught a stale packaged skill pin; the install guide now
uses the candidate's exact archive after public availability is verified.
Independent control-path review and final candidate installation passed.
Final changed-input helper/coverage tests pass 16 cases with 693 assertions;
terminal workflow cases pass 3 tests with 180 assertions. The subsequent
constant-release-ID regression passes with the helper suite (13 tests, 351
assertions). Typecheck, changed-file lint, workflow YAML/shell syntax, and KB
validation pass. Complete protected PR CI and live canonical publication and
the npm mirror remain pending.

## Recovery and durable ownership

Preserve uncertain drafts, released assets, source tags, and npm versions.
Reconcile an interrupted operation before another mutation. A mismatching
attempt-bound draft needs a new reviewed release version, not overwritten
provenance. Current operational rules live in `docs/publishing.md`, source
acceptance in CONTRIBUTING, and mandatory boundaries in AGENTS.
