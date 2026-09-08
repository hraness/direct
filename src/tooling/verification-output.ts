/** Private stream capture used only by the Bun host tooling. */
export const VERIFICATION_OUTPUT_TAIL_LIMIT = 12_000;
const ERROR_DESCRIPTION_LIMIT = 1_024;

interface VerificationStreamCounts {
  readonly bytesRead: number;
  readonly chunksRead: number;
  readonly countersSaturated: boolean;
  /** At most 12,000 UTF-16 code units, independent of the command log limit. */
  readonly tail: string;
}

export type VerificationStreamSnapshot = VerificationStreamCounts & (
  | { readonly state: "pending"; readonly inFlightRead: boolean }
  | { readonly state: "eof"; readonly inFlightRead: false }
  | { readonly state: "error"; readonly inFlightRead: false; readonly error: string }
);

export interface VerificationOutputSnapshot {
  readonly schema: "direct.verification-output/v1";
  readonly stdout: VerificationStreamSnapshot;
  readonly stderr: VerificationStreamSnapshot;
}

function tail(value: string, limit: number): string {
  return value.length <= limit ? value : value.slice(-limit);
}

/** Diagnostics must not invoke foreign error getters or replace a rejection. */
export function describeVerificationOutputFailure(reason: unknown): string {
  if (typeof reason === "string") return tail(reason, ERROR_DESCRIPTION_LIMIT);
  if (reason === null || (typeof reason !== "object" && typeof reason !== "function")) {
    return tail(String(reason), ERROR_DESCRIPTION_LIMIT);
  }
  try {
    const message = Object.getOwnPropertyDescriptor(reason, "message");
    if (message !== undefined && "value" in message && typeof message.value === "string") {
      return tail(message.value, ERROR_DESCRIPTION_LIMIT);
    }
  } catch { /* A hostile descriptor is diagnostic data, never the primary error. */ }
  return "Output capture rejected with a non-text failure";
}

/** Drain until real EOF. A snapshot observes this work and cannot settle it. */
export function captureVerificationOutput(stream: ReadableStream<Uint8Array>, logLimit: number): {
  readonly output: Promise<string>;
  readonly snapshot: () => VerificationStreamSnapshot;
} {
  let bytesRead = 0;
  let chunksRead = 0;
  let countersSaturated = false;
  let retainedTail = "";
  let state: "pending" | "eof" | "error" = "pending";
  let inFlightRead = false;
  let errorDescription = "";

  const output = (async () => {
    try {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let output = "";
      for (;;) {
        inFlightRead = true;
        const chunk = await reader.read();
        inFlightRead = false;
        if (chunk.done) {
          const suffix = decoder.decode();
          retainedTail = tail(`${retainedTail}${suffix}`, VERIFICATION_OUTPUT_TAIL_LIMIT);
          state = "eof";
          return tail(`${output}${suffix}`, logLimit);
        }
        const nextBytes = bytesRead + chunk.value.byteLength;
        const nextChunks = chunksRead + 1;
        countersSaturated ||= nextBytes > Number.MAX_SAFE_INTEGER || nextChunks > Number.MAX_SAFE_INTEGER;
        bytesRead = Math.min(nextBytes, Number.MAX_SAFE_INTEGER);
        chunksRead = Math.min(nextChunks, Number.MAX_SAFE_INTEGER);
        const text = decoder.decode(chunk.value, { stream: true });
        output = tail(`${output}${text}`, logLimit);
        retainedTail = tail(`${retainedTail}${text}`, VERIFICATION_OUTPUT_TAIL_LIMIT);
      }
    } catch (error: unknown) {
      inFlightRead = false;
      state = "error";
      errorDescription = describeVerificationOutputFailure(error);
      throw error;
    }
  })();

  return {
    output,
    snapshot: () => {
      const counts = { bytesRead, chunksRead, countersSaturated, tail: retainedTail };
      if (state === "error") return Object.freeze({ ...counts, state, inFlightRead: false, error: errorDescription });
      if (state === "eof") return Object.freeze({ ...counts, state, inFlightRead: false });
      return Object.freeze({ ...counts, state, inFlightRead });
    },
  };
}

function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid verification output snapshot object");
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new Error("Invalid verification output snapshot field");
  }
  return descriptor.value;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid verification output snapshot counter");
  }
  return value;
}

function copyStreamSnapshot(value: unknown): VerificationStreamSnapshot {
  const bytesRead = count(own(value, "bytesRead"));
  const chunksRead = count(own(value, "chunksRead"));
  const countersSaturated = own(value, "countersSaturated");
  const retainedTail = own(value, "tail");
  const state = own(value, "state");
  const inFlightRead = own(value, "inFlightRead");
  if (typeof countersSaturated !== "boolean" || typeof retainedTail !== "string"
    || retainedTail.length > VERIFICATION_OUTPUT_TAIL_LIMIT || typeof inFlightRead !== "boolean") {
    throw new Error("Invalid verification output snapshot bounds");
  }
  const counts = { bytesRead, chunksRead, countersSaturated, tail: retainedTail };
  if (state === "pending") return Object.freeze({ ...counts, state, inFlightRead });
  if (inFlightRead) throw new Error("Terminal verification output snapshot has a pending read");
  if (state === "eof") return Object.freeze({ ...counts, state, inFlightRead: false });
  if (state === "error") {
    const error = own(value, "error");
    if (typeof error !== "string" || error.length > ERROR_DESCRIPTION_LIMIT) {
      throw new Error("Invalid verification output snapshot error");
    }
    return Object.freeze({ ...counts, state, inFlightRead: false, error });
  }
  throw new Error("Invalid verification output snapshot state");
}

/** Copy only bounded data fields; custom server snapshots cannot retain state. */
export function copyVerificationOutputSnapshot(value: unknown): VerificationOutputSnapshot {
  if (own(value, "schema") !== "direct.verification-output/v1") {
    throw new Error("Invalid verification output snapshot schema");
  }
  return Object.freeze({ schema: "direct.verification-output/v1",
    stdout: copyStreamSnapshot(own(value, "stdout")),
    stderr: copyStreamSnapshot(own(value, "stderr")) });
}
