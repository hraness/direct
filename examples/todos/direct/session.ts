import { createDirectSession } from "@hraness/direct/testing";

import type { TodoPort } from "../src/todo-port";
import {
  todoDirectDefinition,
} from "./definition";
import { createDeterministicTodoPort } from "./deterministic-todo-port";

export interface TodoDirectHarness {
  readonly port: TodoPort;
  readonly pendingOperations: () => number;
  readonly blockedNetworkRequests: () => number;
  readonly activityFailures: () => number;
  readonly recordBlockedNetworkRequest: () => void;
  readonly recordActivityFailure: () => void;
  readonly remainingWork: () => {
    readonly todo: { readonly pendingOperations: number };
    readonly blockedNetworkRequests: number;
    readonly activityFailures: number;
  };
}

export function createTodoDirectSession(source: string) {
  return createDirectSession({
    definition: todoDirectDefinition,
    activation: { kind: "query", source },
    create: (context): TodoDirectHarness => {
      const port = createDeterministicTodoPort({
        world: context.world,
        activity: context.activity,
        clock: context.clock,
        signal: context.signal,
      });
      context.onDispose(port.dispose);
      let blockedNetworkRequests = 0;
      let activityFailures = 0;
      return Object.freeze({
        port,
        pendingOperations: port.pendingOperations,
        blockedNetworkRequests: () => blockedNetworkRequests,
        activityFailures: () => activityFailures,
        recordBlockedNetworkRequest: () => {
          blockedNetworkRequests += 1;
        },
        recordActivityFailure: () => {
          activityFailures += 1;
        },
        remainingWork: () => Object.freeze({
          todo: port.remainingWork(),
          blockedNetworkRequests,
          activityFailures,
        }),
      });
    },
    observe: (harness) => ({
      pending: [{ name: "todoOperations", read: harness.pendingOperations }],
      violations: [
        { name: "blockedNetworkRequests", read: harness.blockedNetworkRequests },
        { name: "activityFailures", read: harness.activityFailures },
      ],
      readRemainingWork: harness.remainingWork,
    }),
  });
}
