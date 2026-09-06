import { expect, test } from "bun:test";
import { Effect, Exit, Layer } from "effect";
import { createDocumentTestSession, DocumentSource, loadDocument } from "../../examples/effect/document-controller.js";

test("neutral document controller decodes a delayed response and commits through Direct", async () => {
  const source = Layer.succeed(DocumentSource, { read: Effect.sleep(20).pipe(Effect.as({ text: "A public example" })) });
  const created = createDocumentTestSession(source);
  if (!created.ok) throw new Error(created.error.message);
  const session = created.value;
  const run = session.harness.runExit("document", loadDocument);
  expect(session.store.getSnapshot().world.text).toBe("");
  expect(session.probe.isQuiescent()).toEqual({ ok: true, value: false });
  expect(session.harness.advance(20)).toEqual({ ok: true, value: 20 });
  expect(Exit.isSuccess(await run)).toBeTrue();
  expect(session.store.getSnapshot().world.text).toBe("A public example");
  expect(session.probe.isQuiescent()).toEqual({ ok: true, value: true });
  session.dispose();
  expect(Exit.isSuccess((await session.harness.close()).runtime)).toBeTrue();
});

test("neutral controller projects invalid boundary data without committing", async () => {
  const source = Layer.succeed(DocumentSource, { read: Effect.succeed({ text: 1 }) });
  const created = createDocumentTestSession(source);
  if (!created.ok) throw new Error(created.error.message);
  const session = created.value;
  const exit = await session.harness.runExit("document", loadDocument);
  expect(exit).toMatchObject({ _tag: "Failure", cause: { error: { _tag: "DocumentUnavailable" } } });
  expect(session.store.getSnapshot().world.text).toBe("");
  session.dispose();
  const report = await session.harness.close();
  expect(report.operationFailures).toHaveLength(1);
});
