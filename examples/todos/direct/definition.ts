import { defineDirect } from "@hraness/direct";

import {
  createTodoDirectWorld,
  parseTodoDirectWorld,
  POPULATED_TODOS,
} from "./world";

export const todoDirectDefinition = defineDirect({
  parseWorld: parseTodoDirectWorld,
  defaultScenario: "todos.populated",
  scenarios: [
    {
      id: "todos.empty",
      title: "Empty list",
      description: "The real todo interface renders its empty state.",
      route: "/",
      world: createTodoDirectWorld({ todos: [], writeFailure: null }),
    },
    {
      id: "todos.populated",
      title: "Populated list",
      description: "Two deterministic tasks load and can be completed through the product port.",
      route: "/",
      world: createTodoDirectWorld({ todos: POPULATED_TODOS, writeFailure: null }),
    },
    {
      id: "todos.write-failure",
      title: "Write failure",
      description: "A declared persistence failure remains visible without discarding loaded tasks.",
      route: "/",
      world: createTodoDirectWorld({
        todos: POPULATED_TODOS,
        writeFailure: "The deterministic store rejected this change.",
      }),
    },
  ],
  coverage: [
    {
      key: "todos.empty.render",
      mode: "fixture",
      claim: "The real todo interface renders an empty deterministic list.",
      scenarios: ["todos.empty"],
    },
    {
      key: "todos.completion",
      mode: "fixture",
      claim: "The real todo interface loads and completes tasks through the product-owned port.",
      scenarios: ["todos.populated"],
    },
    {
      key: "todos.write.failure",
      mode: "fixture",
      claim: "The real todo interface reports a declared persistence failure and retains loaded tasks.",
      scenarios: ["todos.write-failure"],
    },
    {
      key: "storage.local.direct",
      mode: "direct",
      claim: "Browser local-storage parsing, quota behavior, and persistence require direct production-adapter evidence.",
      scenarios: [],
    },
  ],
});
