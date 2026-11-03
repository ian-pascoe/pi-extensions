import { type TUnsafe, Type } from "typebox";

/**
 * A string enum tool-parameter schema, `{ type: "string", enum: [...] }`, typed for TypeBox's
 * `Static`. Providers such as Google reject `anyOf`/`const` enums, so tool parameters use this shape.
 *
 * Since Pi 1.5 the published `@earendil-works/pi-ai` types its `StringEnum` as a pi-schema
 * `Schema<T>`, which TypeBox's `Static` (and so `ToolDefinition`'s parameter inference) reads as
 * `unknown`. Inside Pi, extensions importing `@earendil-works/pi-ai` get Pi's extension view, whose
 * `StringEnum` is this same `Type.Unsafe` schema; this helper gives packages that shape wherever
 * they are type-checked or tested, with byte-identical JSON.
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
