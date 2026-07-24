import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type Context,
  type ReactElement,
  type ReactNode,
} from "react";
import type { JsonValue } from "./core/json-value.js";
import type { DirectStore, DirectStoreSnapshot } from "./core/store.js";

export interface DirectProviderProps<World extends JsonValue> {
  readonly store: DirectStore<World>;
  readonly children: ReactNode;
}

export interface DirectReactBindings<World extends JsonValue> {
  readonly Context: Context<DirectStore<World> | null>;
  readonly Provider: (props: DirectProviderProps<World>) => ReactElement;
  readonly useStore: () => DirectStore<World>;
  readonly useSnapshot: () => DirectStoreSnapshot<World>;
  readonly useWorld: () => World;
}

export function createDirectReactBindings<World extends JsonValue>(): DirectReactBindings<World> {
  const StoreContext = createContext<DirectStore<World> | null>(null);

  const useStore = (): DirectStore<World> => {
    const store = useContext(StoreContext);
    if (store === null) {
      throw new Error("Direct hooks require their matching Direct Provider");
    }
    return store;
  };

  const useSnapshot = (): DirectStoreSnapshot<World> => {
    const store = useStore();
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  };

  const bindings: DirectReactBindings<World> = {
    Context: StoreContext,
    Provider: ({ store, children }: DirectProviderProps<World>) => createElement(
      StoreContext.Provider,
      { value: store },
      children,
    ),
    useStore,
    useSnapshot,
    useWorld: () => useSnapshot().world,
  };
  return Object.freeze(bindings);
}
