import { Type } from "typebox";
import { Value } from "typebox/value";

const nodeProcessErrorProperties = Type.Object({
  code: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  stderr: Type.Optional(Type.String()),
});

/** Parses an execFile failure into its process error code and captured stderr, or null. */
export function parseNodeProcessError(cause) {
  if (!(cause instanceof Error) || !Value.Check(nodeProcessErrorProperties, cause)) return null;
  const processError = {};
  if (cause.code !== undefined) processError.code = cause.code;
  if (cause.stderr !== undefined) processError.stderr = cause.stderr;
  return Object.keys(processError).length > 0 ? processError : null;
}

/** Returns whether an execFile failure carries the requested Node process error code. */
export function hasNodeProcessErrorCode(processError, code) {
  return processError?.code === code;
}

/** Returns execFile stderr without inventing output for failures that omit it. */
export function getNodeProcessErrorStderr(processError) {
  return processError?.stderr ?? "";
}
