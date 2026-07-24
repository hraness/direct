// src/react.ts
import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore
} from "react";
function createDirectReactBindings() {
  const StoreContext = createContext(null);
  const useStore = () => {
    const store = useContext(StoreContext);
    if (store === null) {
      throw new Error("Direct hooks require their matching Direct Provider");
    }
    return store;
  };
  const useSnapshot = () => {
    const store = useStore();
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  };
  const bindings = {
    Context: StoreContext,
    Provider: ({ store, children }) => createElement(StoreContext.Provider, { value: store }, children),
    useStore,
    useSnapshot,
    useWorld: () => useSnapshot().world
  };
  return Object.freeze(bindings);
}
export {
  createDirectReactBindings
};
