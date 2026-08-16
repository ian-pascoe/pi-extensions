import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
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

/** Runtime construction effects kept narrow so tests can select an isolated Pi agent directory. */
export interface PiFormatterLifecycleEffects {
  /** Return Pi's trust-aware global settings directory. */
  getAgentDirectory(): string;
}

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

const productionPiFormatterLifecycleEffects: PiFormatterLifecycleEffects = {
  getAgentDirectory: getAgentDir,
};

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
    const invocations = usesFile ? matchingPaths : [undefined];
    for (const path of invocations) {
      const args = definition.args.map((argument) =>
        path === undefined ? argument : argument.replaceAll("$FILE", path),
      );
      const failure = await runFormatterCommand(definition, args, cwd, settings.timeoutMs, signal);
      if (failure !== undefined) {
        warnings.push(
          formatFormatterFailure(
            definition,
            path ?? `workspace triggered by ${matchingPaths.join(", ")}`,
            failure,
          ),
        );
      }
    }
  }
  return warnings;
}

/** Own settings loading and post-mutation formatter execution for one extension instance. */
export class PiFormatterLifecycleController {
  private settings: ResolvedFormatterSettings | undefined;

  /** Bind one formatter lifecycle controller to Pi. */
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly effects: PiFormatterLifecycleEffects,
  ) {}

  /** Register startup and tool-result formatting handlers. */
  register(): void {
    this.pi.on("session_start", (_event, context) => this.startSession(context));
    this.pi.on("tool_result", (event, context) => this.handleToolResult(event, context));
  }

  private startSession(context: ExtensionContext): void {
    const reader = SettingsManager.create(context.cwd, this.effects.getAgentDirectory(), {
      projectTrusted: context.isProjectTrusted(),
    });
    this.settings = resolveFormatterSettings(reader);
    if (this.settings.warnings.length > 0) {
      context.ui.notify(
        `Pi Formatter settings:\n- ${this.settings.warnings.join("\n- ")}`,
        "warning",
      );
    }
  }

  private async handleToolResult(
    event: ToolResultEvent,
    context: ExtensionContext,
  ): Promise<{ readonly content: ToolResultEvent["content"] } | undefined> {
    const paths = extractFormatterMutationPaths(event);
    if (paths === undefined || paths.length === 0 || this.settings === undefined) return undefined;
    const warnings = await formatMutationPaths(paths, context.cwd, this.settings, context.signal);
    if (warnings.length === 0) return undefined;
    return {
      content: [...event.content, { type: "text", text: warnings.join("\n") }],
    };
  }
}

/** Compose the source-TypeScript Pi Formatter extension without running commands at load time. */
export function createPiFormatterExtension(
  effects: PiFormatterLifecycleEffects = productionPiFormatterLifecycleEffects,
): ExtensionFactory {
  return (pi) => new PiFormatterLifecycleController(pi, effects).register();
}

const piFormatterExtension = createPiFormatterExtension();

export default piFormatterExtension;
