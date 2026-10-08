import { spawn } from "node:child_process";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, matchesGlob, relative, resolve } from "node:path";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionFactory,
  type ToolResultEvent,
  type ToolResultEventResult,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { noticeText } from "@ian-pascoe/pi-utils/ui";
import { Type } from "typebox";
import { Value } from "typebox/value";
import {
  isFileFormatter,
  resolveFormatterSettings,
  type FormatterDefinition,
  type ResolvedFormatterSettings,
} from "./pi-formatter-settings.js";
import { describeChangedLines, diffChangedLines } from "./changed-lines.js";
import { TROUBLESHOOTING_HINT } from "./troubleshooting-skill.js";

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
/** How long a killed formatter's process tree may keep its stderr open before formatting moves on. */
const STOPPED_COMMAND_GRACE_MS = 2_000;
/**
 * The most changed-hunk text, shared by every file of one mutation result and counted without the
 * `Formatted by` lines: at most `MAX_DIFF_LINES` lines and `MAX_DIFF_BYTES` UTF-8 bytes. A file whose
 * diff does not fit in what remains is reported by its changed-line summary alone, so a large
 * reformat never floods the result.
 */
const MAX_DIFF_LINES = 60;
const MAX_DIFF_BYTES = 6_000;
/**
 * Pi LSP tools that apply a Workspace Edit Preview: `lsp_apply`, and the removed single `lsp` tool,
 * whose apply results remain in session history.
 */
const LSP_APPLY_TOOL_NAMES: ReadonlySet<string> = new Set(["lsp_apply", "lsp"]);

type FormatterCommandFailure =
  | { readonly kind: "spawn_error"; readonly message: string }
  | { readonly kind: "timeout"; readonly timeoutMs: number }
  | {
      readonly kind: "exit_error";
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stderr: string;
    };

/**
 * Formatter stderr wording for a syntax error. Formatters share no exit-code convention for it, so
 * `isInputFailure` also requires the formatted file's name and no mention of configuration.
 */
const SYNTAX_ERROR_PATTERN =
  /syntax ?error|parse error|parsing error|failed to parse|unexpected token|unexpected end of|unexpected character/i;
const CONFIGURATION_PATTERN = /config/i;

interface ExistingFormatterPaths {
  readonly paths: readonly string[];
  readonly warnings: readonly string[];
}

/** One line appended to a mutation result; `diagnosable` lines point to the troubleshooting Skill. */
interface FormatterNote {
  readonly text: string;
  readonly diagnosable: boolean;
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
    !LSP_APPLY_TOOL_NAMES.has(event.toolName) ||
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
      if (isMissingPathError(cause)) continue;
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
    /** Why the command was stopped early; reported once its process tree lets go of stderr. */
    let stopped: FormatterCommandFailure | undefined;
    const timers: ReturnType<typeof setTimeout>[] = [];
    try {
      const child = spawn(definition.command, args, {
        cwd,
        env: formatterProcessEnvironment(definition.environment),
        killSignal: "SIGKILL",
        shell: false,
        signal,
        stdio: ["ignore", "ignore", "pipe"],
      });
      const finish = (failure: FormatterCommandFailure | undefined): void => {
        if (finished) return;
        finished = true;
        for (const timer of timers) clearTimeout(timer);
        complete(failure);
      };
      /**
       * Kill the command, then wait for `close`: a process it started, such as the formatter behind
       * an `npx` wrapper, can still write the file until it exits and releases the inherited
       * stderr. The wait is bounded because such a process may outlive the command indefinitely.
       */
      const stop = (failure: FormatterCommandFailure): void => {
        if (stopped !== undefined) return;
        stopped = failure;
        child.kill("SIGKILL");
        timers.push(setTimeout(() => finish(failure), STOPPED_COMMAND_GRACE_MS));
      };
      timers.push(setTimeout(() => stop({ kind: "timeout", timeoutMs }), timeoutMs));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-MAX_FORMATTER_STDERR_CHARACTERS);
      });
      child.on("error", (cause: Error) => {
        const failure = { kind: "spawn_error", message: cause.message } as const;
        // An abort kills a running command; a command that never started has nothing to wait for.
        if (child.pid === undefined) finish(failure);
        else stop(failure);
      });
      child.on("close", (exitCode, signalName) => {
        if (stopped !== undefined) finish(stopped);
        else if (exitCode === 0) finish(undefined);
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

/**
 * A syntax error in the changed file is an input outcome that Post-edit Diagnostics report. A File
 * Formatter's declared `syntaxErrorPattern` replaces the heuristic. Otherwise a bad configuration
 * file produces similar wording, so the stderr must name the formatted file and must not mention
 * configuration.
 */
function isInputFailure(
  definition: FormatterDefinition,
  failure: FormatterCommandFailure,
  path: string | undefined,
): boolean {
  if (path === undefined || failure.kind !== "exit_error") return false;
  if (definition.syntaxErrorPattern !== undefined) {
    return definition.syntaxErrorPattern.test(failure.stderr);
  }
  const fileName = basename(path);
  return (
    SYNTAX_ERROR_PATTERN.test(failure.stderr) &&
    failure.stderr.includes(fileName) &&
    !CONFIGURATION_PATTERN.test(
      // Paths such as `src/config/vite.config.ts` mention configuration without being one.
      failure.stderr
        .split(/\s+/)
        .filter((word) => !word.includes(fileName))
        .join(" "),
    )
  );
}

async function readTextFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
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

/**
 * Append `diff` to `summary` and spend it from the budget the result's files share. When the diff
 * is missing or does not fit in what remains, the summary stands alone.
 */
function withDiff(
  summary: string,
  diff: readonly string[] | undefined,
  budget: { lines: number; bytes: number },
): string {
  if (diff === undefined) return summary;
  const text = diff.join("\n");
  const bytes = Buffer.byteLength(text);
  if (diff.length > budget.lines || bytes > budget.bytes) return summary;
  budget.lines -= diff.length;
  budget.bytes -= bytes;
  return `${summary}\n${text}`;
}

function isMissingPathError(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ENOTDIR")
  );
}

/**
 * The key Pi's file mutation queue uses for a path: its real path, or the resolved path when it
 * does not exist. Pi does not export its own key function.
 */
async function mutationQueueKey(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (cause) {
    if (isMissingPathError(cause)) return resolve(path);
    throw cause;
  }
}

/**
 * Run `operation` while holding Pi's file mutation queue for every path, so no native `edit` or
 * `write`, and no other formatting, changes those files meanwhile. Pi's queue is not reentrant, so
 * paths sharing a key are queued once. Keys are taken in Pi LSP's Workspace Edit apply order,
 * `localeCompare`, with ties broken by code unit, so neither another formatting nor an `lsp_apply`
 * of overlapping files can wait on this one while it waits on them. Pi LSP derives the same keys
 * and comparator, so symlinked paths order identically.
 */
async function withMutationLocks<T>(
  paths: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(await Promise.all(paths.map(mutationQueueKey)))].sort(
    (left, right) => left.localeCompare(right) || (left < right ? -1 : left > right ? 1 : 0),
  );
  const acquire = (index: number): Promise<T> => {
    const key = keys[index];
    if (key === undefined) return operation();
    return withFileMutationQueue(key, () => acquire(index + 1));
  };
  return acquire(0);
}

interface FormatterInvocation {
  readonly definition: FormatterDefinition;
  /** The changed file a File Formatter runs for; undefined for a Workspace Formatter. */
  readonly path: string | undefined;
  readonly root: string;
  readonly matchingPaths: readonly string[];
}

/** Every formatter command to run for the changed files, in Formatter Definition order. */
async function planFormatterInvocations(
  paths: readonly string[],
  cwd: string,
  settings: ResolvedFormatterSettings,
): Promise<readonly FormatterInvocation[]> {
  const invocations: FormatterInvocation[] = [];
  for (const definition of settings.formatters.values()) {
    const matchingPaths = paths.filter((path) => formatterMatchesPath(definition, path));
    if (matchingPaths.length === 0) continue;
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
    if (isFileFormatter(definition)) {
      for (const { path, root } of pathsAndRoots) {
        invocations.push({ definition, path, root, matchingPaths });
      }
    } else {
      for (const root of new Set(pathsAndRoots.map(({ root }) => root))) {
        invocations.push({ definition, path: undefined, root, matchingPaths });
      }
    }
  }
  return invocations;
}

async function formatMutationPaths(
  paths: readonly string[],
  cwd: string,
  settings: ResolvedFormatterSettings,
  signal: AbortSignal | undefined,
): Promise<readonly FormatterNote[]> {
  const existing = await existingFormatterPaths(cwd, paths);
  const notes = existing.warnings.map((text) => ({ text, diagnosable: true }));
  const invocations = await planFormatterInvocations(existing.paths, cwd, settings);
  if (invocations.length === 0 || signal?.aborted === true) return notes;
  // Inside the queue, the snapshot holds every change made before formatting, and the diff only
  // the formatters' changes; a mutation arriving meanwhile waits rather than being overwritten.
  const formatted = await withMutationLocks(existing.paths, async () => {
    // A mutation queued ahead of formatting may have deleted or renamed a file meanwhile.
    const present = await existingFormatterPaths(cwd, existing.paths);
    const runnable = invocations.filter(({ path, matchingPaths }) =>
      path === undefined
        ? matchingPaths.some((matchingPath) => present.paths.includes(matchingPath))
        : present.paths.includes(path),
    );
    const presentNotes = present.warnings.map((text) => ({ text, diagnosable: true }));
    return [
      ...presentNotes,
      ...(await runFormatterInvocations(existing.paths, runnable, cwd, settings, signal)),
    ];
  });
  return [...notes, ...formatted];
}

/** Run the invocations in order and describe what failed and what each changed file became. */
async function runFormatterInvocations(
  paths: readonly string[],
  invocations: readonly FormatterInvocation[],
  cwd: string,
  settings: ResolvedFormatterSettings,
  signal: AbortSignal | undefined,
): Promise<readonly FormatterNote[]> {
  const notes: FormatterNote[] = [];
  const original = new Map<string, string | undefined>();
  const current = new Map<string, string | undefined>();
  const changedBy = new Map<string, string[]>();
  for (const path of paths) {
    const content = await readTextFile(path);
    original.set(path, content);
    current.set(path, content);
  }
  /**
   * Record which formatters changed each mutation path, comparing against the content the last run
   * left. Every path is checked because a Workspace Formatter can rewrite files it was not run for.
   */
  const recordChanges = async (definition: FormatterDefinition): Promise<void> => {
    for (const path of paths) {
      const content = await readTextFile(path);
      if (content === current.get(path)) continue;
      current.set(path, content);
      const formatters = changedBy.get(path) ?? [];
      if (!formatters.includes(definition.id)) formatters.push(definition.id);
      changedBy.set(path, formatters);
    }
  };
  for (const { definition, path, root, matchingPaths } of invocations) {
    if (signal?.aborted === true) break;
    const args = definition.args.map((argument) =>
      path === undefined ? argument : argument.replaceAll("$FILE", path),
    );
    const failure = await runFormatterCommand(definition, args, root, settings.timeoutMs, signal);
    if (failure !== undefined) {
      notes.push({
        text: formatFormatterFailure(
          definition,
          path ?? `workspace ${root} triggered by ${matchingPaths.join(", ")}`,
          failure,
        ),
        diagnosable: !isInputFailure(definition, failure, path),
      });
    }
    // Formatters such as `eslint --fix` exit non-zero after writing fixes, so compare regardless.
    await recordChanges(definition);
  }
  const diffBudget = { lines: MAX_DIFF_LINES, bytes: MAX_DIFF_BYTES };
  for (const path of paths) {
    const formatters = changedBy.get(path);
    const before = original.get(path);
    const after = current.get(path);
    if (formatters === undefined || before === undefined || after === undefined) continue;
    const changedLines = describeChangedLines(before, after);
    if (changedLines === undefined) continue;
    const file = paths.length > 1 ? `${relative(cwd, path)}: ` : "";
    const summary = `Formatted by ${formatters.join(", ")}: ${file}${changedLines}`;
    notes.push({
      text: withDiff(summary, diffChangedLines(before, after), diffBudget),
      diagnosable: false,
    });
  }
  return notes;
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
        context.ui.notify(
          noticeText(
            "Formatter",
            `settings:\n- ${settings.warnings.join("\n- ")}\nRun /skill:pi-formatter to diagnose.`,
          ),
          "warning",
        );
      }
    });
    pi.on("tool_result", async (event, context) => {
      const paths = extractFormatterMutationPaths(event);
      if (paths === undefined || paths.length === 0 || settings === undefined) return undefined;
      const notes = await formatMutationPaths(paths, context.cwd, settings, context.signal);
      if (notes.length === 0) return undefined;
      const text = notes.map((note) => note.text).join("\n");
      const result: ToolResultEventResult = {
        content: [
          ...event.content,
          {
            type: "text",
            text: notes.some((note) => note.diagnosable)
              ? `${text}\n\n${TROUBLESHOOTING_HINT}`
              : text,
          },
        ],
      };
      // Pi drops structured content whose content was replaced unless the handler returns it.
      if (event.structuredContent !== undefined) result.structuredContent = event.structuredContent;
      return result;
    });
  };
}

const piFormatterExtension = createPiFormatterExtension();

export default piFormatterExtension;
