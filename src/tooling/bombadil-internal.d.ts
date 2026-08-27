/**
 * Bombadil 0.7.2's public declarations reference this subpath, but its npm
 * export map omits it. Keep this ambient declaration pinned to that release's
 * public type dependency until the package exports the declaration itself.
 */
declare module "@antithesishq/bombadil/internal" {
  export type TimeUnit = "milliseconds" | "seconds";

  export interface Cell<T> {
    readonly current: T;
    update(snapshot: T): void;
  }

  export type JSON =
    | string
    | number
    | boolean
    | null
    | JSON[]
    | { [key: string | number | symbol]: JSON }
    | { toJSON(): JSON };

  export class ExtractorCell<T extends JSON, S> implements Cell<T> {
    readonly current: T;
    readonly index: number;
    name: string | null;
    constructor(runtime: Runtime<S>, extract: (state: S) => T);
    named(name: string): this;
    run(state: S): T;
    update(snapshot: T): void;
  }

  export class Runtime<S> {
    readonly extractors: readonly ExtractorCell<JSON, S>[];
    checkNotExtracting(): void;
    recordAccess(index: number): void;
    registerExtractor(cell: ExtractorCell<JSON, S>): number;
    runExtractors(state: S): readonly {
      readonly index: number;
      readonly name: string | null;
      readonly value: JSON;
    }[];
    startTracking(): void;
    stopTracking(): number[];
  }
}
