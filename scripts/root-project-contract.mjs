import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Value } from "typebox/value";

const manifestDependencies = Type.Object({}, { additionalProperties: Type.String() });
export const packageSettingsSourceSchema = Type.Object({
  autoload: Type.Optional(Type.Boolean()),
  extensions: Type.Optional(Type.Array(Type.String())),
  source: Type.String(),
});

/** Parses the root manifest fields that define the authoritative Pi extension order. */
export const rootPiManifestSchema = Type.Object({
  pi: Type.Object({ extensions: Type.Array(Type.String()) }),
});

/** Parses the package-manifest fields used to verify runtime dependency installation. */
export const workspacePackageManifestSchema = Type.Object({
  dependencies: Type.Optional(manifestDependencies),
  name: Type.String(),
  optionalDependencies: Type.Optional(manifestDependencies),
  pi: Type.Optional(Type.Object({ extensions: Type.Array(Type.String()) })),
});

/** Parses Pi's string and object package settings entries before callers inspect them. */
export const piSettingsDocumentSchema = Type.Object({
  packages: Type.Optional(Type.Array(Type.Union([Type.String(), packageSettingsSourceSchema]))),
});

/** Reads JSON bytes and rejects documents that do not satisfy their owning schema. */
export async function readJsonDocument(filePath, schema, documentName) {
  const document = JSON.parse(await readFile(filePath, "utf8"));
  if (!Value.Check(schema, document)) {
    throw new Error(`Root project contract failed: invalid ${documentName}`);
  }
  return document;
}
