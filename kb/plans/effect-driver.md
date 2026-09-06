---
type: plan
area: effect-driver
status: in-progress
---

# Optional Effect driver

Design issue: https://github.com/hraness/direct/issues/43. Base: `bbd15adaa29c14c0e04856d729817816f5ee2c59`.

## Outcome and invariants

Add `@hraness/direct/effect` as an opt-in async owner and deadline test adapter. Keep the existing default/core/testing/web graph free of Effect, FIFO waits additive, session construction and disposal synchronous, and all wire manifests unchanged. Public examples remain neutral and application-owned.

Use Effect 3.22.1 through an optional exact peer plus development pin, with the existing compiler retained. One Layer and ManagedRuntime belong to each driver. The existing logical runtime stores the single clock value. Effect sleeps use absolute deadlines; mixing FIFO waits or manual logical advancement with this mode is unsupported and detected when possible. Deadline ties wake in admission order; resumed continuations obey Effect scheduler priority then insertion order. Never imply that this controls native audio, browser callbacks or foreign Promise work.

## Work and verification

1. Open design issue and publish the public API proposal. Complete.
2. Add typed opt-in driver, scope ownership, captured-generation commit guards, activity/probe integration, bounded deadline scheduling and async close. Implemented; review pending.
3. Exercise independent deadline/property oracles, existing FIFO compatibility, cancellation/reset/finalizer failure and a neutral application controller. Complete focused checks.
4. Add actual CLI architecture checks with paired fixtures, export/package consumption checks, and current adoption documentation.
5. Run focused tests, typecheck, package and repository aggregate through the installed host scheduler; independently review before publishing or merging.

## Recovery and limitations

The existing API requires no migration and the new export can be removed before release without changing existing callers. A user-supplied synchronous infinite loop cannot be preempted; the continuation budget bounds cooperative scheduler work only. Foreign callbacks must honor cancellation or use a guarded commit and tracked completion. Async cleanup requiring simulated time needs the test owner to keep advancing time while awaiting close. A completed close report retains operation Causes, activity settlement failures and runtime teardown failure separately.

## Evidence

Focused driver, public-controller and browser graph tests pass: `bun test src/effect` reports 18 tests and 175 assertions, including 30 generated deadline schedules. `bun test src/core/runtime.property.test.ts src/testing/activity.test.ts src/testing/session.test.ts src/exports.test.ts` reports 28 compatibility tests and 1,323 assertions. `bun run typecheck`, targeted ESLint, and `bun run check:effect` pass; the copied v1.2.1 policy has 7 tests and 30 assertions. Knowledge-base refresh, check and agent-guide check pass with one advisory orphan plan.

Independent review found two issues, each reproduced before its fix: a suspended Layer worker was omitted from quiescence, and an unjoined child failure disappeared when its root succeeded. The Supervisor now counts suspended workers and retains operation, child and background failure evidence separately.

The first admitted aggregate stopped in `test:npm-release`: 10 tests passed and 13 failed because the old file-count budget rejected the added files and historical smoke tests incorrectly required the new export. The file ceiling now allows exactly six additional files, while existing byte/path/mode guards remain. Effect-specific smoke runs only when the governed source manifest declares that export. These package corrections still require focused recovery and installed-consumer proof.

The integration owner takes the queued final rebuild, focused package/recovery checks, final aggregate, independent review and release. Generated `dist` output must be regenerated for the final source before it is committed for delivery. Package and final-gate success are not yet claimed.
