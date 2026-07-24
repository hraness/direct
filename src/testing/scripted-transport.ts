import { canonicalJson, parseAndCloneWorld, parseJsonValue, type WorldParser } from "../core/json.js";
import type { JsonValue } from "../core/json-value.js";
import { renderUnknownReason } from "../core/reason.js";
import { err, isRecord, ok, type Result } from "../core/result.js";
import type { LogicalRuntime, RuntimeError } from "../core/runtime.js";
import type { DirectActivityLease, DirectActivityScope } from "./activity.js";

export const DEFAULT_SCRIPTED_TRANSPORT_LIMITS = Object.freeze({
  maxSteps: 10_000,
  maxEventsPerStep: 1_000,
  maxRecordedInternalErrors: 32,
  maxLogicalDelayPerStepMs: 60_000,
  maxTotalLogicalDelayMs: 3_600_000,
}) satisfies ScriptedTransportLimits;

export interface ScriptedTransportLimits {
  readonly maxSteps: number;
  /** Combined `eventsBefore` and `eventsAfter` entries for one step. */
  readonly maxEventsPerStep: number;
  readonly maxRecordedInternalErrors: number;
  readonly maxLogicalDelayPerStepMs: number;
  readonly maxTotalLogicalDelayMs: number;
}

export type ScriptedTransportDefinitionErrorCode =
  | "invalid-limits"
  | "invalid-options"
  | "invalid-script"
  | "invalid-step"
  | "script-too-large";

export interface ScriptedTransportDefinitionError {
  readonly code: ScriptedTransportDefinitionErrorCode;
  readonly message: string;
  readonly step: number | null;
}

export type ScriptedTransportErrorCode =
  | "activity-failed"
  | "internal-failure"
  | "invalid-request"
  | "logical-wait-failed"
  | "pending-deliveries"
  | "request-mismatch"
  | "remaining-steps"
  | "transport-disposed"
  | "unexpected-request";

export interface ScriptedTransportError {
  readonly code: ScriptedTransportErrorCode;
  readonly message: string;
  readonly step: number | null;
  readonly expectedRequest: JsonValue | null;
  readonly actualRequest: JsonValue | null;
  readonly remainingSteps: number;
  readonly pendingDeliveries: number;
}

export type ScriptedTransportFailure<Failure extends JsonValue> =
  | { readonly kind: "scripted"; readonly failure: Failure }
  | { readonly kind: "transport"; readonly error: ScriptedTransportError };

export type ScriptedTransportListener<Event extends JsonValue> = (event: Event) => undefined;
export type ScriptedTransportListenerErrorReporter = (reason: unknown) => undefined;

export interface ExactScriptedTransport<
  Response extends JsonValue,
  Event extends JsonValue,
  Failure extends JsonValue,
> {
  readonly request: (input: unknown) => Promise<Result<Response, ScriptedTransportFailure<Failure>>>;
  readonly subscribe: (listener: ScriptedTransportListener<Event>) => () => undefined;
  /** Permanently fence requests, listeners, waits, and delayed event delivery. */
  readonly dispose: () => undefined;
  readonly isDisposed: () => boolean;
  readonly remainingSteps: () => number;
  readonly pendingDeliveries: () => number;
  readonly violationCount: () => number;
  /** Wait for after-response events and activity settlement, but not unused steps. */
  readonly whenIdle: () => Promise<Result<true, ScriptedTransportError>>;
  readonly assertDrained: () => Result<true, ScriptedTransportError>;
}

export interface ExactScriptedTransportOptions<
  Request extends JsonValue,
  Response extends JsonValue,
  Event extends JsonValue,
  Failure extends JsonValue,
> {
  readonly runtime: LogicalRuntime;
  readonly parseRequest: WorldParser<Request>;
  readonly parseResponse: WorldParser<Response>;
  readonly parseEvent: WorldParser<Event>;
  readonly parseFailure: WorldParser<Failure>;
  /** An exact JSON array; unknown keys and ambiguous outcomes are rejected. */
  readonly steps: unknown;
  readonly activity?: Pick<DirectActivityScope, "begin">;
  readonly activityNamespace?: string;
  readonly limits?: ScriptedTransportLimits;
  readonly onListenerError?: ScriptedTransportListenerErrorReporter;
}

interface CapturedScriptedTransportOptions<
  Request extends JsonValue,
  Response extends JsonValue,
  Event extends JsonValue,
  Failure extends JsonValue,
> {
  readonly wait: LogicalRuntime["wait"];
  readonly parseRequest: WorldParser<Request>;
  readonly parseResponse: WorldParser<Response>;
  readonly parseEvent: WorldParser<Event>;
  readonly parseFailure: WorldParser<Failure>;
  readonly steps: unknown;
  readonly beginActivity: DirectActivityScope["begin"] | undefined;
  readonly activityNamespace: string;
  readonly limits: ScriptedTransportLimits;
  readonly onListenerError: ScriptedTransportListenerErrorReporter | undefined;
}

type ScriptedOutcome<Response extends JsonValue, Failure extends JsonValue> =
  | { readonly kind: "response"; readonly value: Response }
  | { readonly kind: "failure"; readonly error: Failure };

interface ScriptedStep<
  Request extends JsonValue,
  Response extends JsonValue,
  Event extends JsonValue,
  Failure extends JsonValue,
> {
  readonly request: Request;
  readonly requestCanonical: string;
  readonly outcome: ScriptedOutcome<Response, Failure>;
  readonly delayMs: number;
  readonly eventsBefore: readonly Event[];
  readonly eventsAfter: readonly Event[];
}

const STEP_KEYS = new Set(["request", "outcome", "delayMs", "eventsBefore", "eventsAfter"]);
const OUTCOME_KEYS = new Set(["kind", "value", "error"]);
const LIMIT_KEYS = new Set([
  "maxSteps",
  "maxEventsPerStep",
  "maxRecordedInternalErrors",
  "maxLogicalDelayPerStepMs",
  "maxTotalLogicalDelayMs",
]);

function definitionError(
  code: ScriptedTransportDefinitionErrorCode,
  message: string,
  step: number | null = null,
): ScriptedTransportDefinitionError {
  return Object.freeze({ code, message, step });
}

function validateLimits(limits: ScriptedTransportLimits): Result<ScriptedTransportLimits, ScriptedTransportDefinitionError> {
  for (const key of Object.keys(limits)) {
    if (!LIMIT_KEYS.has(key)) {
      return err(definitionError("invalid-limits", `Unknown scripted transport limit: ${key}`));
    }
  }
  for (const [name, value] of [
    ["maxSteps", limits.maxSteps],
    ["maxEventsPerStep", limits.maxEventsPerStep],
    ["maxRecordedInternalErrors", limits.maxRecordedInternalErrors],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) {
      return err(definitionError("invalid-limits", `${name} must be a positive safe integer no greater than 100000`));
    }
  }
  for (const [name, value] of [
    ["maxLogicalDelayPerStepMs", limits.maxLogicalDelayPerStepMs],
    ["maxTotalLogicalDelayMs", limits.maxTotalLogicalDelayMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      return err(definitionError("invalid-limits", `${name} must be a non-negative safe integer`));
    }
  }
  return ok(Object.freeze({ ...limits }));
}

function parseOwned<Value extends JsonValue>(
  input: unknown,
  parser: WorldParser<Value>,
  label: string,
  step: number,
): Result<Value, ScriptedTransportDefinitionError> {
  const parsed = parseAndCloneWorld(input, parser);
  return parsed.ok
    ? parsed
    : err(definitionError("invalid-step", `${label}: ${parsed.error.message}`, step));
}

function parseEvents<Event extends JsonValue>(
  input: unknown,
  parser: WorldParser<Event>,
  label: string,
  step: number,
): Result<readonly Event[], ScriptedTransportDefinitionError> {
  if (!Array.isArray(input)) {
    return err(definitionError("invalid-step", `${label} must be an array`, step));
  }
  const events: Event[] = [];
  for (const candidate of input) {
    const parsed = parseOwned(candidate, parser, label, step);
    if (!parsed.ok) return parsed;
    events.push(parsed.value);
  }
  return ok(Object.freeze(events));
}

function parseSteps<
  Request extends JsonValue,
  Response extends JsonValue,
  Event extends JsonValue,
  Failure extends JsonValue,
>(
  options: CapturedScriptedTransportOptions<Request, Response, Event, Failure>,
  limits: ScriptedTransportLimits,
): Result<readonly ScriptedStep<Request, Response, Event, Failure>[], ScriptedTransportDefinitionError> {
  const json = parseJsonValue(options.steps);
  if (!json.ok || !Array.isArray(json.value)) {
    return err(definitionError(
      "invalid-script",
      json.ok ? "Transport steps must be an array" : json.error.message,
    ));
  }
  if (json.value.length > limits.maxSteps) {
    return err(definitionError("script-too-large", `Transport script exceeds ${String(limits.maxSteps)} steps`));
  }

  const steps: ScriptedStep<Request, Response, Event, Failure>[] = [];
  let totalLogicalDelayMs = 0;
  for (const [index, candidate] of json.value.entries()) {
    if (!isRecord(candidate)) {
      return err(definitionError("invalid-step", "Transport steps must be objects", index));
    }
    for (const key of Object.keys(candidate)) {
      if (!STEP_KEYS.has(key)) {
        return err(definitionError("invalid-step", `Unknown transport step key: ${key}`, index));
      }
    }
    if (!("request" in candidate) || !("outcome" in candidate)) {
      return err(definitionError("invalid-step", "Transport steps require request and outcome", index));
    }
    const request = parseOwned(candidate.request, options.parseRequest, "Invalid scripted request", index);
    if (!request.ok) return request;
    const requestCanonical = canonicalJson(request.value);
    if (!requestCanonical.ok) {
      return err(definitionError("invalid-step", requestCanonical.error.message, index));
    }

    if (!isRecord(candidate.outcome)) {
      return err(definitionError("invalid-step", "Transport outcome must be an object", index));
    }
    for (const key of Object.keys(candidate.outcome)) {
      if (!OUTCOME_KEYS.has(key)) {
        return err(definitionError("invalid-step", `Unknown transport outcome key: ${key}`, index));
      }
    }

    let outcome: ScriptedOutcome<Response, Failure>;
    if (candidate.outcome.kind === "response") {
      if (!("value" in candidate.outcome) || "error" in candidate.outcome) {
        return err(definitionError("invalid-step", "A response outcome requires only value", index));
      }
      const response = parseOwned(candidate.outcome.value, options.parseResponse, "Invalid scripted response", index);
      if (!response.ok) return response;
      outcome = Object.freeze({ kind: "response", value: response.value });
    } else if (candidate.outcome.kind === "failure") {
      if (!("error" in candidate.outcome) || "value" in candidate.outcome) {
        return err(definitionError("invalid-step", "A failure outcome requires only error", index));
      }
      const failure = parseOwned(candidate.outcome.error, options.parseFailure, "Invalid scripted failure", index);
      if (!failure.ok) return failure;
      outcome = Object.freeze({ kind: "failure", error: failure.value });
    } else {
      return err(definitionError("invalid-step", "Transport outcome kind must be response or failure", index));
    }

    const delayMs = "delayMs" in candidate ? candidate.delayMs : 0;
    if (typeof delayMs !== "number" || !Number.isSafeInteger(delayMs) || delayMs < 0) {
      return err(definitionError("invalid-step", "Transport delayMs must be a non-negative safe integer", index));
    }
    if (delayMs > limits.maxLogicalDelayPerStepMs) {
      return err(definitionError(
        "script-too-large",
        `Transport delayMs exceeds the per-step limit of ${String(limits.maxLogicalDelayPerStepMs)}`,
        index,
      ));
    }
    if (totalLogicalDelayMs > limits.maxTotalLogicalDelayMs - delayMs) {
      return err(definitionError(
        "script-too-large",
        `Transport script exceeds the total logical delay limit of ${String(limits.maxTotalLogicalDelayMs)}`,
        index,
      ));
    }
    totalLogicalDelayMs += delayMs;

    const eventsBeforeInput = "eventsBefore" in candidate ? candidate.eventsBefore : [];
    const eventsAfterInput = "eventsAfter" in candidate ? candidate.eventsAfter : [];
    if (!Array.isArray(eventsBeforeInput) || !Array.isArray(eventsAfterInput)) {
      return err(definitionError("invalid-step", "eventsBefore and eventsAfter must be arrays", index));
    }
    if (
      eventsBeforeInput.length > limits.maxEventsPerStep
      || eventsAfterInput.length > limits.maxEventsPerStep - eventsBeforeInput.length
    ) {
      return err(definitionError(
        "script-too-large",
        `Transport step exceeds the combined event limit of ${String(limits.maxEventsPerStep)}`,
        index,
      ));
    }
    const eventsBefore = parseEvents(
      eventsBeforeInput,
      options.parseEvent,
      "eventsBefore",
      index,
    );
    if (!eventsBefore.ok) return eventsBefore;
    const eventsAfter = parseEvents(
      eventsAfterInput,
      options.parseEvent,
      "eventsAfter",
      index,
    );
    if (!eventsAfter.ok) return eventsAfter;
    steps.push(Object.freeze({
      request: request.value,
      requestCanonical: requestCanonical.value,
      outcome,
      delayMs,
      eventsBefore: eventsBefore.value,
      eventsAfter: eventsAfter.value,
    }));
  }
  return ok(Object.freeze(steps));
}

function transportError(
  code: ScriptedTransportErrorCode,
  message: string,
  step: number | null,
  expectedRequest: JsonValue | null,
  actualRequest: JsonValue | null,
  remainingSteps: number,
  pendingDeliveries: number,
): ScriptedTransportError {
  return Object.freeze({
    code,
    message,
    step,
    expectedRequest,
    actualRequest,
    remainingSteps,
    pendingDeliveries,
  });
}

function runtimeFailureMessage(error: RuntimeError): string {
  return `Logical wait failed: ${renderUnknownReason(error, "Unknown logical runtime failure")}`;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof Reflect.get(value, "then") === "function";
}

function synchronousReturnViolation(value: unknown, label: string): Error | null {
  if (value === undefined) return null;
  if (isPromiseLike(value)) {
    void Promise.resolve(value).catch(() => undefined);
  }
  return new Error(`${label} must complete synchronously and return undefined`);
}

/**
 * Build an ordered transport double whose script is exact JSON. A response
 * settles before its `eventsAfter` microtask; `whenIdle` joins that tail.
 */
export function createExactScriptedTransport<
  Request extends JsonValue,
  Response extends JsonValue,
  Event extends JsonValue,
  Failure extends JsonValue,
>(
  options: ExactScriptedTransportOptions<Request, Response, Event, Failure>,
): Result<ExactScriptedTransport<Response, Event, Failure>, ScriptedTransportDefinitionError> {
  let captured: CapturedScriptedTransportOptions<Request, Response, Event, Failure>;
  try {
    captured = Object.freeze({
      wait: options.runtime.wait,
      parseRequest: options.parseRequest,
      parseResponse: options.parseResponse,
      parseEvent: options.parseEvent,
      parseFailure: options.parseFailure,
      steps: options.steps,
      beginActivity: options.activity?.begin,
      activityNamespace: options.activityNamespace ?? "transport",
      limits: options.limits ?? DEFAULT_SCRIPTED_TRANSPORT_LIMITS,
      onListenerError: options.onListenerError,
    });
  } catch (reason) {
    return err(definitionError(
      "invalid-options",
      renderUnknownReason(reason, "Scripted transport options could not be inspected"),
    ));
  }

  let limits: Result<ScriptedTransportLimits, ScriptedTransportDefinitionError>;
  try {
    limits = validateLimits(captured.limits);
  } catch (reason) {
    return err(definitionError(
      "invalid-options",
      renderUnknownReason(reason, "Scripted transport limits could not be inspected"),
    ));
  }
  if (!limits.ok) return limits;
  const parsedSteps = parseSteps(captured, limits.value);
  if (!parsedSteps.ok) return parsedSteps;

  const listeners = new Set<ScriptedTransportListener<Event>>();
  const activeCancellations = new Set<() => void>();
  const disposalController = new AbortController();
  const internalErrors: string[] = [];
  let droppedInternalErrors = 0;
  let nextStep = 0;
  let pending = 0;
  let disposed = false;
  let idleWaiters: (() => void)[] = [];

  const remainingSteps = (): number => parsedSteps.value.length - nextStep;
  const recordInternalError = (reason: unknown): void => {
    const message = renderUnknownReason(reason, "Uninspectable internal transport failure").slice(0, 500);
    if (internalErrors.length < limits.value.maxRecordedInternalErrors) internalErrors.push(message);
    else droppedInternalErrors += 1;
  };
  const notifyIdle = (): void => {
    if (pending !== 0) return;
    const waiting = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiting) resolve();
  };
  const reportListenerError = (reason: unknown): void => {
    if (captured.onListenerError === undefined) return;
    try {
      const returned: unknown = captured.onListenerError(reason);
      const violation = synchronousReturnViolation(returned, "Scripted transport listener-error reporters");
      if (violation !== null) recordInternalError(violation);
    } catch (reporterReason) {
      recordInternalError(reporterReason);
    }
  };
  const emit = (events: readonly Event[]): boolean => {
    if (disposed) return false;
    for (const event of events) {
      if (disposed) return false;
      for (const listener of [...listeners]) {
        if (disposed) return false;
        try {
          const returned: unknown = listener(event);
          const violation = synchronousReturnViolation(returned, "Scripted transport listeners");
          if (violation !== null) {
            recordInternalError(violation);
            reportListenerError(violation);
          }
        } catch (reason) {
          recordInternalError(reason);
          reportListenerError(reason);
        }
      }
    }
    return !disposed;
  };
  const currentError = (
    code: ScriptedTransportErrorCode,
    message: string,
    step: number | null = null,
    expected: JsonValue | null = null,
    actual: JsonValue | null = null,
  ): ScriptedTransportError => transportError(
    code,
    message,
    step,
    expected,
    actual,
    remainingSteps(),
    pending,
  );
  const internalError = (): ScriptedTransportError | null => {
    if (internalErrors.length === 0 && droppedInternalErrors === 0) return null;
    const suffix = droppedInternalErrors === 0 ? "" : `; ${String(droppedInternalErrors)} more omitted`;
    return currentError("internal-failure", `${internalErrors.join("; ")}${suffix}`);
  };
  const settleLease = (lease: DirectActivityLease | null): void => {
    if (lease === null) return;
    try {
      const released = lease.release();
      if (!released.ok) recordInternalError(released.error);
    } catch (reason) {
      recordInternalError(reason);
    }
  };
  const beginLease = (): Result<DirectActivityLease | null, string> => {
    if (captured.beginActivity === undefined) return ok(null);
    try {
      const started = captured.beginActivity(captured.activityNamespace);
      return started.ok
        ? ok(started.value)
        : err(renderUnknownReason(started.error, "Activity scope failed"));
    } catch (reason) {
      return err(renderUnknownReason(reason, "Activity scope threw"));
    }
  };
  const fail = (error: ScriptedTransportError): Result<never, ScriptedTransportFailure<Failure>> => {
    recordInternalError(`${error.code}: ${error.message}`);
    return err(Object.freeze({ kind: "transport", error }));
  };
  const disposedFailure = (
    step: number | null = null,
    expected: JsonValue | null = null,
    actual: JsonValue | null = null,
  ): Result<never, ScriptedTransportFailure<Failure>> => err(Object.freeze({
    kind: "transport",
    error: currentError(
      "transport-disposed",
      "The scripted transport has been disposed",
      step,
      expected,
      actual,
    ),
  }));
  const dispose = (): undefined => {
    if (disposed) return undefined;
    disposed = true;
    listeners.clear();
    for (const cancel of [...activeCancellations]) {
      try {
        cancel();
      } catch (reason) {
        recordInternalError(reason);
      }
    }
    activeCancellations.clear();
    try {
      disposalController.abort();
    } catch (reason) {
      recordInternalError(reason);
    }
    notifyIdle();
    return undefined;
  };

  const request: ExactScriptedTransport<Response, Event, Failure>["request"] = (input) => {
    if (disposed) return Promise.resolve(disposedFailure());
    const parsedRequest = parseAndCloneWorld(input, captured.parseRequest);
    if (!parsedRequest.ok) {
      if (disposed) return Promise.resolve(disposedFailure());
      return Promise.resolve(fail(currentError(
        "invalid-request",
        parsedRequest.error.message,
      )));
    }
    if (disposed) return Promise.resolve(disposedFailure(null, null, parsedRequest.value));
    const requestCanonical = canonicalJson(parsedRequest.value);
    if (!requestCanonical.ok) {
      return Promise.resolve(fail(currentError(
        "invalid-request",
        requestCanonical.error.message,
      )));
    }
    if (disposed) return Promise.resolve(disposedFailure(null, null, parsedRequest.value));
    const step = parsedSteps.value[nextStep];
    if (step === undefined) {
      return Promise.resolve(fail(currentError(
        "unexpected-request",
        "Transport received a request after its script was exhausted",
        nextStep,
        null,
        parsedRequest.value,
      )));
    }
    if (requestCanonical.value !== step.requestCanonical) {
      return Promise.resolve(fail(currentError(
        "request-mismatch",
        `Request does not match scripted step ${String(nextStep)}`,
        nextStep,
        step.request,
        parsedRequest.value,
      )));
    }
    const stepIndex = nextStep;
    nextStep += 1;
    pending += 1;
    const lease = beginLease();
    if (!lease.ok) {
      pending -= 1;
      notifyIdle();
      if (disposed) {
        return Promise.resolve(disposedFailure(
          stepIndex,
          step.request,
          parsedRequest.value,
        ));
      }
      return Promise.resolve(fail(currentError(
        "activity-failed",
        lease.error,
        stepIndex,
        step.request,
        parsedRequest.value,
      )));
    }
    if (disposed) {
      settleLease(lease.value);
      pending -= 1;
      notifyIdle();
      return Promise.resolve(disposedFailure(
        stepIndex,
        step.request,
        parsedRequest.value,
      ));
    }
    return new Promise((resolve) => {
      let completed = false;
      let finalized = false;
      const finalize = (deliverAfterEvents: boolean): void => {
        if (finalized) return;
        finalized = true;
        activeCancellations.delete(cancel);
        if (deliverAfterEvents && !disposed) emit(step.eventsAfter);
        settleLease(lease.value);
        if (pending > 0) pending -= 1;
        else recordInternalError("Transport pending-delivery accounting underflow");
        notifyIdle();
      };
      const scheduleFinalize = (deliverAfterEvents: boolean): void => {
        try {
          queueMicrotask(() => finalize(deliverAfterEvents));
        } catch (reason) {
          recordInternalError(reason);
          finalize(deliverAfterEvents);
        }
      };
      const complete = (
        result: Result<Response, ScriptedTransportFailure<Failure>>,
        deliverAfterEvents: boolean,
      ): void => {
        if (completed) return;
        completed = true;
        resolve(result);
        scheduleFinalize(deliverAfterEvents);
      };
      const completeTransportFailure = (
        code: ScriptedTransportErrorCode,
        message: string,
      ): void => {
        complete(fail(currentError(
          code,
          message,
          stepIndex,
          step.request,
          parsedRequest.value,
        )), false);
      };
      const cancel = (): void => {
        if (!completed) {
          completed = true;
          resolve(disposedFailure(
            stepIndex,
            step.request,
            parsedRequest.value,
          ));
        }
        finalize(false);
      };
      activeCancellations.add(cancel);
      if (disposed) {
        cancel();
        return;
      }
      const execute = async (): Promise<void> => {
        if (!emit(step.eventsBefore)) {
          cancel();
          return;
        }
        let waited: Result<number, RuntimeError>;
        try {
          waited = await captured.wait(step.delayMs, disposalController.signal);
        } catch (reason) {
          if (disposed) {
            cancel();
            return;
          }
          completeTransportFailure(
            "logical-wait-failed",
            `Logical wait failed: ${renderUnknownReason(reason, "Logical wait threw")}`,
          );
          return;
        }
        if (disposed) {
          cancel();
          return;
        }
        if (!waited.ok) {
          completeTransportFailure("logical-wait-failed", runtimeFailureMessage(waited.error));
          return;
        }

        const outcome = step.outcome.kind === "response"
          ? ok<Response>(step.outcome.value)
          : err<ScriptedTransportFailure<Failure>>(Object.freeze({
            kind: "scripted",
            failure: step.outcome.error,
          }));
        complete(outcome, true);
      };
      void execute().catch((reason: unknown) => {
        completeTransportFailure(
          "internal-failure",
          `Transport delivery failed: ${renderUnknownReason(reason)}`,
        );
      });
    });
  };

  const assertNoInternalError = (): Result<true, ScriptedTransportError> => {
    const failure = internalError();
    return failure === null ? ok<true>(true) : err(failure);
  };
  const transport: ExactScriptedTransport<Response, Event, Failure> = {
    request,
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      let active = true;
      return () => {
        if (!active) return undefined;
        active = false;
        listeners.delete(listener);
        return undefined;
      };
    },
    dispose,
    isDisposed: () => disposed,
    remainingSteps,
    pendingDeliveries: () => pending,
    violationCount: () => internalErrors.length + droppedInternalErrors,
    whenIdle: async () => {
      while (pending !== 0) {
        await new Promise<void>((resolve) => {
          idleWaiters.push(resolve);
        });
      }
      return assertNoInternalError();
    },
    assertDrained: () => {
      const failure = internalError();
      if (failure !== null) return err(failure);
      if (pending !== 0) {
        return err(currentError("pending-deliveries", `${String(pending)} transport deliveries are still pending`));
      }
      if (remainingSteps() !== 0) {
        return err(currentError("remaining-steps", `${String(remainingSteps())} scripted transport steps remain`));
      }
      return ok<true>(true);
    },
  };
  return ok(Object.freeze(transport));
}
