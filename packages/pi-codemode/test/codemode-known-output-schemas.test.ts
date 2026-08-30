import type { ApplyPatchToolDetails } from "@howaboua/pi-codex-conversion";
import type { UnifiedExecResult } from "@howaboua/pi-codex-conversion/dist/tools/exec/session-manager.js";
import type { createImageGenerationTool } from "@howaboua/pi-codex-conversion/dist/tools/imagegen/tool.js";
import type { executeCodexWebSearch } from "@howaboua/pi-codex-conversion/dist/tools/web-run/tool.js";
import type { ViewImageContent } from "@howaboua/pi-codex-conversion/dist/tools/view-image/output.js";
import type {
  BashToolDetails,
  EditToolDetails,
  FindToolDetails,
  GrepToolDetails,
  LsToolDetails,
  PowerShellToolDetails,
  ReadToolDetails,
  SourceInfo,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import {
  CodeModeKnownOutputSchemas,
  resolveKnownToolOutputSchema,
} from "../src/codemode-known-output-schemas.js";
import { renderCodeModeToolCatalogue } from "../src/codemode-tool-catalog.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false;
type ToolDefinitionDetails<Definition> =
  Definition extends ToolDefinition<infer _Parameters, infer Details, infer _State>
    ? Details
    : never;
type ImagegenDetails = ToolDefinitionDetails<ReturnType<typeof createImageGenerationTool>>;
type WebRunDetails = {
  webRun: Awaited<ReturnType<typeof executeCodexWebSearch>>["details"];
};
type ViewImageDetails =
  | { viewImage: true }
  | {
      viewImageDescription: {
        image: ViewImageContent;
        path: string;
        description: string;
      };
    };

const OutputSchemaTypeParity = {
  bash: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.builtin.bash>,
    BashToolDetails
  >,
  powershell: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.builtin.powershell>,
    PowerShellToolDetails
  >,
  read: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.builtin.read>,
    ReadToolDetails
  >,
  edit: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.builtin.edit>,
    EditToolDetails
  >,
  write: true satisfies Equal<Static<typeof CodeModeKnownOutputSchemas.builtin.write>, undefined>,
  grep: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.builtin.grep>,
    GrepToolDetails
  >,
  find: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.builtin.find>,
    FindToolDetails
  >,
  ls: true satisfies Equal<Static<typeof CodeModeKnownOutputSchemas.builtin.ls>, LsToolDetails>,
  apply_patch: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.codexConversion.apply_patch>,
    ApplyPatchToolDetails
  >,
  exec_command: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.codexConversion.exec_command>,
    UnifiedExecResult
  >,
  write_stdin: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.codexConversion.write_stdin>,
    UnifiedExecResult
  >,
  imagegen: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.codexConversion.imagegen>,
    ImagegenDetails
  >,
  web_run: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.codexConversion.web_run>,
    WebRunDetails
  >,
  view_image: true satisfies Equal<
    Static<typeof CodeModeKnownOutputSchemas.codexConversion.view_image>,
    ViewImageDetails
  >,
};

function sourceInfo(
  source: string,
  origin: SourceInfo["origin"],
  path = `/extensions/${source}`,
): SourceInfo {
  return { path, source, scope: "temporary", origin };
}

function schemaEntries(
  schemas: Readonly<Record<string, TSchema>>,
): Array<readonly [string, TSchema]> {
  return Object.entries(schemas);
}

describe("known CodeMode output schemas", () => {
  test("stay compile-time compatible with their upstream detail types", () => {
    expect(Object.values(OutputSchemaTypeParity)).toEqual(Array(14).fill(true));
  });

  test("resolve only for the owning built-in or pi-codex-conversion source", () => {
    for (const [name, schema] of schemaEntries(CodeModeKnownOutputSchemas.builtin)) {
      expect(
        resolveKnownToolOutputSchema({
          name,
          sourceInfo: sourceInfo("builtin", "top-level", `<builtin:${name}>`),
        }),
      ).toBe(schema);
    }
    for (const [name, schema] of schemaEntries(CodeModeKnownOutputSchemas.codexConversion)) {
      expect(
        resolveKnownToolOutputSchema({
          name,
          sourceInfo: sourceInfo("npm:@howaboua/pi-codex-conversion@3.0.23", "package"),
        }),
      ).toBe(schema);
    }

    expect(
      resolveKnownToolOutputSchema({
        name: "read",
        sourceInfo: sourceInfo("builtin", "top-level"),
      }),
    ).toBeUndefined();
    expect(
      resolveKnownToolOutputSchema({
        name: "apply_patch",
        sourceInfo: sourceInfo("local", "top-level"),
      }),
    ).toBeUndefined();
    expect(
      resolveKnownToolOutputSchema({
        name: "apply_patch",
        sourceInfo: sourceInfo("npm:@howaboua/pi-codex-conversion", "top-level"),
      }),
    ).toBeUndefined();
  });

  test("accept both view_image result variants", () => {
    const schema = CodeModeKnownOutputSchemas.codexConversion.view_image;
    expect(Value.Check(schema, { viewImage: true })).toBe(true);
    expect(
      Value.Check(schema, {
        viewImageDescription: {
          image: { type: "image", data: "base64", mimeType: "image/png", detail: "high" },
          path: "image.png",
          description: "A test image",
        },
      }),
    ).toBe(true);
  });

  test("render concrete declarations for every known schema", () => {
    const schemas = [
      ...schemaEntries(CodeModeKnownOutputSchemas.builtin),
      ...schemaEntries(CodeModeKnownOutputSchemas.codexConversion),
    ];
    const rendered = renderCodeModeToolCatalogue(
      schemas.map(([name, outputSchema]) => ({
        name,
        group: "known",
        inputSchema: { type: "object", additionalProperties: true },
        outputSchema,
      })),
    );

    expect(rendered).toMatchObject({ ok: true });
    if (!rendered.ok) return;
    for (const [name] of schemas) {
      const declaration = rendered.searchEntries.find((entry) => entry.name === name)?.declaration;
      if (declaration === undefined) {
        throw new Error(`Known CodeMode output schema test: missing ${name} declaration`);
      }
      expect(declaration).not.toContain("PiToolResult<unknown>");
    }
  });
});
