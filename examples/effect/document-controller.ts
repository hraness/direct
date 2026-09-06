import { Context, Data, Effect, Layer, Schema } from "effect";
import { defineDirect } from "@hraness/direct";
import { createDirectEffectDriver, type DirectEffectDriverError, type DirectEffectOperation } from "@hraness/direct/effect";
import { createDirectSession } from "@hraness/direct/testing";

const DocumentWorld = Schema.Struct({ text: Schema.String });
type DocumentWorld = typeof DocumentWorld.Type;
const DocumentResponse = Schema.Struct({ text: Schema.String });

export class DocumentUnavailable extends Data.TaggedError("DocumentUnavailable")<{
  readonly reason: unknown;
}> {}

/** The application owns this port. Direct knows nothing about documents. */
export class DocumentSource extends Context.Tag("@hraness/direct/example/DocumentSource")<
  DocumentSource, { readonly read: Effect.Effect<unknown, DocumentUnavailable> }
>() {}

/** A complete application workflow whose boundary, time and commit are testable. */
export function loadDocument(
  operation: DirectEffectOperation<DocumentWorld>,
): Effect.Effect<void, DocumentUnavailable | DirectEffectDriverError, DocumentSource> {
  return Effect.gen(function* () {
    const source = yield* DocumentSource;
    const response = yield* source.read;
    const document = yield* Schema.decodeUnknown(DocumentResponse)(response).pipe(
      Effect.mapError(reason => new DocumentUnavailable({ reason })),
    );
    yield* operation.transact(() => ({ text: document.text }));
  });
}

export function createDocumentTestSession(source: Layer.Layer<DocumentSource>) {
  return createDirectSession({
    definition: defineDirect({
      parseWorld: Schema.decodeUnknownSync(DocumentWorld),
      defaultScenario: "document.empty",
      scenarios: [{ id: "document.empty", title: "Empty document", route: "/", world: { text: "" } }],
      coverage: [],
    }),
    activation: { kind: "query", source: "" },
    create: context => createDirectEffectDriver({ context, layer: source, clock: "deadline" }),
    observe: driver => driver.observation,
  });
}
