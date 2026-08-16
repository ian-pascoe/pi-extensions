import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";

export const packageSettingsSourceSchema = Type.Object({
  autoload: Type.Optional(Type.Boolean()),
  extensions: Type.Optional(Type.Array(Type.String())),
  source: Type.String(),
});

/** Parses the root manifest fields that define the authoritative Pi extension order. */
export const rootPiManifestSchema = Type.Object({
  pi: Type.Object({ extensions: Type.Array(Type.String()) }),
});

/** Parses the package-manifest fields used by root package checks. */
export const workspacePackageManifestSchema = Type.Object({
  name: Type.String(),
  pi: Type.Optional(Type.Object({ extensions: Type.Array(Type.String()) })),
});

/** Parses Pi's string and object package settings entries before callers inspect them. */
export const piSettingsDocumentSchema = Type.Object({
  packages: Type.Optional(Type.Array(packageSettingsSourceSchema)),
});

/**
 * Reads JSON bytes and parses them into the schema-derived result.
 *
 * @template {import("typebox").TSchema} TSchema
 * @param {string} filePath
 * @param {TSchema} schema
 * @returns {Promise<import("typebox").StaticParse<TSchema>>}
 */
export async function readJsonDocument(filePath, schema) {
  return Value.Parse(schema, JSON.parse(await readFile(filePath, "utf8")));
}
