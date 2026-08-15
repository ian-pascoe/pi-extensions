import { Type } from "typebox";
import { Value } from "typebox/value";

const nodeProcessErrorProperties = Type.Object({
  code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  stderr: Type.Optional(Type.String()),
});

/** Parses an execFile failure while retaining its original Error cause. */
export function parseNodeProcessError(cause) {
  if (!(cause instanceof Error) || !Value.Check(nodeProcessErrorProperties, cause)) {
    return { kind: "unrecognized", cause };
  }

  const parsedError = { cause, kind: "process-error" };
  if (Object.hasOwn(cause, "code") && cause.code !== undefined) parsedError.code = cause.code;
  if (Object.hasOwn(cause, "stderr") && cause.stderr !== undefined)
    parsedError.stderr = cause.stderr;
  return parsedError;
}

/** Returns whether an execFile failure has the requested Node process error code. */
export function hasNodeProcessErrorCode(processError, code) {
  return processError.kind === "process-error" && processError.code === code;
}

/** Returns execFile stderr without inventing output for failures that omit it. */
export function getNodeProcessErrorStderr(processError) {
  return processError.kind === "process-error" ? (processError.stderr ?? "") : "";
}
