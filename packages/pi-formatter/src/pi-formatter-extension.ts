import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, matchesGlob, resolve } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionFactory,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  resolveFormatterSettings,
  type FormatterDefinition,
  type ResolvedFormatterSettings,
} from "./pi-formatter-settings.js";

const NativeMutationInputSchema = Type.Object(
  { path: Type.String() },
  { additionalProperties: true },
);
const ApplyPatchDetailsSchema = Type.Object(
  {
    status: Type.Union([Type.Literal("success"), Type.Literal("partial_failure")]),
    result: Type.Object(
      {
        changedFiles: Type.Array(Type.String()),
        createdFiles: Type.Array(Type.String()),
        deletedFiles: Type.Array(Type.String()),
        movedFiles: Type.Array(
          Type.Object({ from: Type.String(), to: Type.String() }, { additionalProperties: true }),
        ),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);
const MutationManifestSchema = Type.Array(
  Type.Union([
    Type.Object(
      {
        operation: Type.Union([
          Type.Literal("create"),
          Type.Literal("modify"),
          Type.Literal("delete"),
        ]),
        path: Type.String(),
      },
      { additionalProperties: true },
    ),
    Type.Object(
      {
        operation: Type.Literal("rename"),
        path: Type.String(),
        destination_path: Type.String(),
      },
      { additionalProperties: true },
    ),
  ]),
);
const WorkspaceEditApplyDetailsSchema = Type.Object(
  {
    kind: Type.Literal("workspace_edit_apply"),
    state: Type.Union([Type.Literal("applied"), Type.Literal("partial_failure")]),
    changed_paths: Type.Array(Type.String()),
  },
  { additionalProperties: true },
);
const MAX_FORMATTER_STDERR_CHARACTERS = 50_000;

type FormatterCommandFailure =
  | { readonly kind: "spawn_error"; readonly message: string }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | {
      readonly kind: "exit_error";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stderr: string;
    };

interface ExistingFormatterPaths {
  readonly paths: readonly string[];
  readonly warnings: readonly string[];
}

function extractFormatterMutationPaths(event: ToolResultEvent): readonly string[] | undefined {
  if (event.toolName === "edit" || event.toolName === "write") {
    if (event.isError || !Value.Check(NativeMutationInputSchema, event.input)) return undefined;
    return [event.input.path];
  }
  if (event.toolName === "apply_patch") {
    if (!Value.Check(ApplyPatchDetailsSchema, event.details)) return undefined;
    const deleted = new Set(event.details.result.deletedFiles);
    return [
      ...new Set([
        ...event.details.result.changedFiles,
        ...event.details.result.createdFiles,
        ...event.details.result.movedFiles.map(({ to }) => to),
      ]),
    ]
      .filter((path) => !deleted.has(path))
      .sort((left, right) => left.localeCompare(right));
  }
  if (
    event.toolName !== "lsp" ||
    event.input.operation !== "apply" ||
    !Value.Check(MutationManifestSchema, event.input.mutation_manifest) ||
    !Value.Check(WorkspaceEditApplyDetailsSchema, event.details)
  ) {
    return undefined;
  }
  const changedPaths = new Set(event.details.changed_paths);
  return event.input.mutation_manifest
    .flatMap((entry) => {
      if (entry.operation === "delete") return [];
      return [entry.operation === "rename" ? entry.destination_path : entry.path];
    })
    .filter((path) => changedPaths.has(path))
    .sort((left, right) => left.localeCompare(right));
}

async function existingFormatterPaths(
  cwd: string,
  paths: readonly string[],
): Promise<ExistingFormatterPaths> {
  const existing: string[] = [];
  const warnings: string[] = [];
  for (const path of new Set(paths.map((path) => resolve(cwd, path)))) {
    try {
      if ((await stat(path)).isFile()) existing.push(path);
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ENOTDIR")
      ) {
        continue;
      }
      warnings.push(
        `Pi Formatter: unable to inspect ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }
  return { paths: existing, warnings };
}

function formatterMatchesPath(definition: FormatterDefinition, path: string): boolean {
  return (
    definition.extensions.includes(extname(path)) || definition.fileNames.includes(basename(path))
  );
}

async function findFormatterRoot(
  filePath: string,
  rootMarkers: readonly string[],
  fallbackCwd: string,
  requireRootMarker: boolean,
): Promise<string | undefined> {
  if (rootMarkers.length === 0) return requireRootMarker ? undefined : resolve(fallbackCwd);
  let directory = dirname(filePath);
  for (;;) {
    try {
      const entryNames = await readdir(directory);
      if (
        entryNames.some((entryName) =>
          rootMarkers.some((rootMarker) => matchesGlob(entryName, rootMarker)),
        )
      ) {
        return directory;
      }
    } catch {
      // Match Pi LSP root discovery: continue to an existing ancestor.
    }
    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) {
      return requireRootMarker ? undefined : resolve(fallbackCwd);
    }
    directory = parentDirectory;
  }
}

function formatterProcessEnvironment(configured: Readonly<Record<string, string | null>>) {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(configured)) {
    if (value === null) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}

function runFormatterCommand(
  definition: FormatterDefinition,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<FormatterCommandFailure | undefined> {
  return new Promise((complete) => {
    let stderr = "";
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const child = spawn(definition.command, args, {
        cwd,
        env: formatterProcessEnvironment(definition.environment),
        shell: false,
        signal,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const finish = (failure: FormatterCommandFailure | undefined): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        complete(failure);
      };
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ kind: "timeout", timeoutMs });
      }, timeoutMs);
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_FORMATTER_STDERR_CHARACTERS);
      });
      child.on("error", (cause: Error) => {
        finish({ kind: "spawn_error", message: cause.message });
      });
      child.on("close", (exitCode, signalName) => {
        if (exitCode === 0) finish(undefined);
        else {
          finish({
            kind: "exit_error",
            exitCode,
            signal: signalName,
            stderr: stderr.trim(),
          });
        }
      });
    } catch (cause) {
      complete({
        kind: "spawn_error",
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  });
}

function formatFormatterFailure(
  definition: FormatterDefinition,
  target: string,
  failure: FormatterCommandFailure,
): string {
  if (failure.kind === "spawn_error") {
    return `Pi Formatter: ${definition.id} failed for ${target} (spawn error): ${failure.message}`;
  }
  if (failure.kind === "timeout") {
    return `Pi Formatter: ${definition.id} failed for ${target} (timeout after ${failure.timeoutMs}ms)`;
  }
  const status =
    failure.exitCode === null
      ? `signal ${failure.signal ?? "unknown"}`
      : `exit code ${failure.exitCode}`;
  return `Pi Formatter: ${definition.id} failed for ${target} (${status})${failure.stderr === "" ? "" : `: ${failure.stderr}`}`;
}

async function formatMutationPaths(
  paths: readonly string[],
  cwd: string,
  settings: ResolvedFormatterSettings,
  signal: AbortSignal | undefined,
): Promise<readonly string[]> {
  const existing = await existingFormatterPaths(cwd, paths);
  const warnings = [...existing.warnings];
  for (const definition of settings.formatters.values()) {
    const matchingPaths = existing.paths.filter((path) => formatterMatchesPath(definition, path));
    if (matchingPaths.length === 0) continue;
    const usesFile = definition.args.some((argument) => argument.includes("$FILE"));
    const discoveredRoots = await Promise.all(
      matchingPaths.map(async (path) => ({
        path,
        root: await findFormatterRoot(
          path,
          definition.rootMarkers,
          cwd,
          definition.requireRootMarker,
        ),
      })),
    );
    const pathsAndRoots = discoveredRoots.flatMap(({ path, root }) =>
      root === undefined ? [] : [{ path, root }],
    );
    const invocations = usesFile
      ? pathsAndRoots
      : [...new Set(pathsAndRoots.map(({ root }) => root))].map((root) => ({
          path: undefined,
          root,
        }));
    for (const { path, root } of invocations) {
      const args = definition.args.map((argument) =>
        path === undefined ? argument : argument.replaceAll("$FILE", path),
      );
      const failure = await runFormatterCommand(definition, args, root, settings.timeoutMs, signal);
      if (failure !== undefined) {
        warnings.push(
          formatFormatterFailure(
            definition,
            path ?? `workspace ${root} triggered by ${matchingPaths.join(", ")}`,
            failure,
          ),
        );
      }
    }
  }
  return warnings;
}

/** Compose the source-TypeScript Pi Formatter extension without running commands at load time. */
export function createPiFormatterExtension(
  getAgentDirectory: () => string = getAgentDir,
): ExtensionFactory {
  let settings: ResolvedFormatterSettings | undefined;
  return (pi) => {
    pi.on("session_start", (_event, context) => {
      const reader = SettingsManager.create(context.cwd, getAgentDirectory(), {
        projectTrusted: context.isProjectTrusted(),
      });
      settings = resolveFormatterSettings(reader);
      if (settings.warnings.length > 0) {
        context.ui.notify(`Pi Formatter settings:\n- ${settings.warnings.join("\n- ")}`, "warning");
      }
    });
    pi.on("tool_result", async (event, context) => {
      const paths = extractFormatterMutationPaths(event);
      if (paths === undefined || paths.length === 0 || settings === undefined) return undefined;
      const warnings = await formatMutationPaths(paths, context.cwd, settings, context.signal);
      if (warnings.length === 0) return undefined;
      return { content: [...event.content, { type: "text", text: warnings.join("\n") }] };
    });
  };
}

const piFormatterExtension = createPiFormatterExtension();

export default piFormatterExtension;
