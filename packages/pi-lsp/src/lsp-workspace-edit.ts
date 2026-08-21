import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateUnifiedPatch, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
  Position,
  PositionEncodingKind,
  Range,
  TextEdit,
  WorkspaceEdit,
  LSPAny,
} from "vscode-languageserver-protocol";
import {
  convertLspProtocolPosition,
  normalizeLspPositionEncoding,
} from "./lsp-position-encoding.js";
import {
  FileSnapshotSchema,
  LspWorkspaceEditPreviewRecordSchema,
  WorkspaceEditOperationSchema,
} from "./lsp-tool-contract.js";
import type { Static } from "typebox";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** A canonical file operation exposed to Pi permission hooks before an LSP apply. */
export interface LspMutationManifestEntry {
  /** Resource operation performed by the guarded batch. */
  readonly operation: "create" | "modify" | "delete" | "rename";
  /** Canonical content target, or named resource source for delete and rename. */
  readonly path: string;
  /** Named directory entry referenced by the language server. */
  readonly named_path: string;
  /** Canonical rename destination when `operation` is `rename`. */
  readonly destination_path?: string;
}

/** Exact canonical paths and operations for one Validated Workspace Edit. */
export interface LspMutationManifest {
  readonly entries: readonly LspMutationManifestEntry[];
}

/** Canonical pre-mutation snapshot of one filesystem path used by guarded rollback. */
type FileSnapshot = Static<typeof FileSnapshotSchema>;

/** Schema-derived operation with a writable `after_base64` for incremental document edits. */
type Writable<T> = { -readonly [K in keyof T]: T[K] };
type EditableOperation = Writable<
  Extract<Static<typeof WorkspaceEditOperationSchema>, { kind: "modify" | "create" }>
>;

type NormalizedWorkspaceOperation = Static<typeof WorkspaceEditOperationSchema>;

/** Schema-friendly preview record persisted in LSP tool result details. */
type LspWorkspaceEditPreview = Static<typeof LspWorkspaceEditPreviewRecordSchema>;

/** Result of one guarded Workspace Edit application. */
export interface LspWorkspaceEditApplyResult {
  readonly preview_id: string;
  readonly state: "applied";
  readonly changed_files: readonly string[];
  readonly created_files: readonly string[];
  readonly deleted_files: readonly string[];
  readonly moved_files: readonly { readonly from: string; readonly to: string }[];
}

/** Narrow filesystem mutation seam used to inject deterministic rollback failures in tests. */
export interface LspWorkspaceEditFileOperations {
  replaceFile(path: string, contents: Buffer, mode: number): Promise<void>;
  removePath(path: string): Promise<void>;
  renamePath(source: string, destination: string): Promise<void>;
}

async function replaceFile(path: string, contents: Buffer, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.pi-lsp-${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o600 });
    await chmod(temporaryPath, mode);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

/** Production file operations for temporary replacement and named resource changes. */
export const nodeLspWorkspaceEditFileOperations: LspWorkspaceEditFileOperations = {
  replaceFile,
  removePath: (path) => rm(path, { force: true }),
  renamePath: async (source, destination) => {
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
  },
};

type WorkspaceEditErrorCode =
  | "contradictory_resource_operations"
  | "directory_operation"
  | "duplicate_destination"
  | "invalid_destination"
  | "invalid_position"
  | "invalid_utf8"
  | "mutation_manifest_mismatch"
  | "non_file_uri"
  | "overlapping_text_edits"
  | "preview_already_applied"
  | "preview_not_found"
  | "stale_workspace_edit"
  | "workspace_edit_apply_failed"
  | "workspace_edit_cancelled"
  | "workspace_edit_recovery_failed";

/** Expected preview normalization, validation, apply, or rollback failure. */
export class LspWorkspaceEditError extends Error {
  /** Construct a stable Workspace Edit failure with optional unrecovered paths. */
  constructor(
    readonly code: WorkspaceEditErrorCode,
    message: string,
    readonly recoveryFailures: readonly string[] = [],
    options?: ErrorOptions,
  ) {
    super(`Pi LSP: ${message}`, options);
  }
}

interface LspWorkspaceEditStoreOptions {
  readonly createPreviewId?: () => string;
  readonly fileOperations?: LspWorkspaceEditFileOperations;
  readonly queueMutation?: <T>(path: string, operation: () => Promise<T>) => Promise<T>;
}

interface CreateWorkspaceEditPreviewInput {
  readonly edit: WorkspaceEdit;
  readonly serverId: string;
  readonly positionEncoding?: PositionEncodingKind;
}

interface DecodedUtf8Document {
  readonly bom: boolean;
  readonly text: string;
}

function contentsFromSnapshot(snapshot: FileSnapshot): Buffer {
  if (snapshot.kind !== "file") {
    throw new LspWorkspaceEditError("invalid_destination", "expected a regular file");
  }
  return Buffer.from(snapshot.content_base64, "base64");
}

async function snapshotNamedPath(path: string): Promise<FileSnapshot> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (cause) {
    if (cause instanceof Error && isMissingPathError(cause)) return { kind: "missing" };
    throw cause;
  }
  const mode = metadata.mode & 0o7777;
  if (metadata.isDirectory()) {
    throw new LspWorkspaceEditError(
      "directory_operation",
      `directory-tree operation is not supported: ${path}`,
    );
  }
  if (metadata.isSymbolicLink()) {
    return { kind: "symlink", link_target: await readlink(path), mode };
  }
  if (!metadata.isFile()) {
    throw new LspWorkspaceEditError("invalid_destination", `path is not a regular file: ${path}`);
  }
  const contents = await readFile(path);
  return {
    kind: "file",
    content_base64: contents.toString("base64"),
    mode,
  };
}

function isMissingPathError(cause: Error): boolean {
  return "code" in cause && (cause.code === "ENOENT" || cause.code === "ENOTDIR");
}

function filePathFromUri(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol !== "file:") throw new Error("not file");
    return resolve(fileURLToPath(url));
  } catch (cause) {
    throw new LspWorkspaceEditError("non_file_uri", `Workspace Edit URI is not file: ${uri}`, [], {
      cause,
    });
  }
}

function decodeUtf8(contents: Buffer, path: string): DecodedUtf8Document {
  try {
    const decoded = UTF8_DECODER.decode(contents);
    return {
      bom: contents.subarray(0, 3).equals(UTF8_BOM),
      text: decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded,
    };
  } catch (cause) {
    throw new LspWorkspaceEditError("invalid_utf8", `file is not valid UTF-8: ${path}`, [], {
      cause,
    });
  }
}

function encodeUtf8(text: string, bom: boolean): Buffer {
  const contents = Buffer.from(text, "utf8");
  return bom ? Buffer.concat([UTF8_BOM, contents]) : contents;
}

function textOffsetAtPosition(
  text: string,
  position: Position,
  encoding: PositionEncodingKind,
): number {
  try {
    const codePointPosition = convertLspProtocolPosition(
      text,
      position,
      normalizeLspPositionEncoding(encoding),
    );
    const lineStarts = [0];
    for (let index = 0; index < text.length; index++) {
      if (text[index] === "\r" && text[index + 1] === "\n") index++;
      if (text[index] === "\r" || text[index] === "\n") lineStarts.push(index + 1);
    }
    const lineStart = lineStarts[position.line];
    if (lineStart === undefined) throw new Error("line exceeds document length");
    const lineEnd = lineStarts[position.line + 1] ?? text.length;
    const line = text.slice(lineStart, lineEnd).replace(/\r?\n$|\r$/u, "");
    const utf16Offset = Array.from(line)
      .slice(0, codePointPosition.character - 1)
      .join("").length;
    return lineStart + utf16Offset;
  } catch (cause) {
    throw new LspWorkspaceEditError("invalid_position", "Workspace Edit position is invalid", [], {
      cause,
    });
  }
}

function applyTextEdits(
  text: string,
  edits: readonly TextEdit[],
  encoding: PositionEncodingKind,
): string {
  const replacements = edits.map((edit) => ({
    start: textOffsetAtPosition(text, edit.range.start, encoding),
    end: textOffsetAtPosition(text, edit.range.end, encoding),
    text: edit.newText,
  }));
  replacements.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < replacements.length; index++) {
    const previous = replacements[index - 1];
    const current = replacements[index];
    if (previous !== undefined && current !== undefined && current.start < previous.end) {
      throw new LspWorkspaceEditError(
        "overlapping_text_edits",
        "Workspace Edit contains overlapping text edits",
      );
    }
  }
  let result = text;
  for (const replacement of replacements.reverse()) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}

function regularTextEdits(
  edits: readonly { readonly range: Range; readonly newText?: string }[],
): TextEdit[] {
  return edits.map((edit) => {
    if (edit.newText === undefined) {
      throw new LspWorkspaceEditError(
        "invalid_destination",
        "Workspace Edit snippet edits are not supported",
      );
    }
    return { range: edit.range, newText: edit.newText };
  });
}

function fileSummary(path: string, before: Buffer, after: Buffer): string {
  const beforeText = decodeUtf8(before, path).text;
  const afterText = decodeUtf8(after, path).text;
  return generateUnifiedPatch(path, beforeText, afterText);
}

function snapshotMatches(left: FileSnapshot, right: FileSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function manifestForOperations(
  operations: readonly NormalizedWorkspaceOperation[],
): LspMutationManifest {
  return {
    entries: operations
      .map((operation): LspMutationManifestEntry => {
        if (operation.kind === "modify") {
          return {
            named_path: operation.named_path,
            operation: "modify",
            path: operation.path,
          };
        }
        if (operation.kind === "create") {
          return {
            named_path: operation.named_path,
            operation: "create",
            path: operation.named_path,
          };
        }
        if (operation.kind === "delete") {
          return {
            named_path: operation.named_path,
            operation: "delete",
            path: operation.named_path,
          };
        }
        return {
          destination_path: operation.destination_path,
          named_path: operation.named_path,
          operation: "rename",
          path: operation.named_path,
        };
      })
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function manifestQueuePaths(manifest: LspMutationManifest): string[] {
  const paths = new Set<string>();
  for (const entry of manifest.entries) {
    paths.add(entry.path);
    if (entry.destination_path !== undefined) paths.add(entry.destination_path);
  }
  return [...paths].sort((left, right) => left.localeCompare(right));
}

async function restorePath(
  path: string,
  snapshot: FileSnapshot,
  files: LspWorkspaceEditFileOperations,
): Promise<void> {
  if (snapshot.kind === "missing") {
    await files.removePath(path);
    return;
  }
  if (snapshot.kind === "file") {
    await files.replaceFile(path, contentsFromSnapshot(snapshot), snapshot.mode);
    return;
  }
  await files.removePath(path);
  await mkdir(dirname(path), { recursive: true });
  await symlink(snapshot.link_target, path);
}

/** Own persisted Workspace Edit Preview state and guarded one-use application. */
export class LspWorkspaceEditStore {
  private readonly previews = new Map<string, LspWorkspaceEditPreview>();
  private readonly unreportedPreviews = new Map<string, LspWorkspaceEditPreview>();
  private readonly createPreviewId: () => string;
  private readonly files: LspWorkspaceEditFileOperations;
  private readonly queueMutation: <T>(path: string, operation: () => Promise<T>) => Promise<T>;

  /** Construct a preview store with optional deterministic IDs, queues, and failure points. */
  constructor(options: LspWorkspaceEditStoreOptions = {}) {
    this.createPreviewId = options.createPreviewId ?? randomUUID;
    this.files = options.fileOperations ?? nodeLspWorkspaceEditFileOperations;
    this.queueMutation = options.queueMutation ?? withFileMutationQueue;
  }

  /** Normalize and persist one language-server Workspace Edit without mutating files. */
  async createPreview(input: CreateWorkspaceEditPreviewInput): Promise<LspWorkspaceEditPreview> {
    const operations: NormalizedWorkspaceOperation[] = [];
    const editableOperations = new Map<string, EditableOperation>();
    const resourceActions = new Map<string, string>();
    const destinations = new Set<string>();
    const encoding = input.positionEncoding ?? "utf-16";

    const rememberResourceAction = (path: string, action: string): void => {
      const previous = resourceActions.get(path);
      if (previous !== undefined && previous !== action) {
        throw new LspWorkspaceEditError(
          "contradictory_resource_operations",
          `contradictory resource operations target ${path}`,
        );
      }
      resourceActions.set(path, action);
    };

    const applyDocumentEdits = async (uri: string, edits: readonly TextEdit[]): Promise<void> => {
      const namedPath = filePathFromUri(uri);
      const editable = editableOperations.get(namedPath);
      if (editable !== undefined) {
        const current = Buffer.from(editable.after_base64, "base64");
        const decoded = decodeUtf8(current, namedPath);
        editable.after_base64 = encodeUtf8(
          applyTextEdits(decoded.text, edits, encoding),
          decoded.bom,
        ).toString("base64");
        return;
      }

      const namedBefore = await snapshotNamedPath(namedPath);
      if (namedBefore.kind === "missing") {
        throw new LspWorkspaceEditError(
          "invalid_destination",
          `text edit file is missing: ${namedPath}`,
        );
      }
      const targetPath = await realpath(namedPath);
      const targetMetadata = await stat(targetPath);
      if (!targetMetadata.isFile()) {
        throw new LspWorkspaceEditError(
          "directory_operation",
          `text edit target is not a file: ${namedPath}`,
        );
      }
      const before = await snapshotNamedPath(targetPath);
      if (before.kind !== "file") {
        throw new LspWorkspaceEditError(
          "invalid_destination",
          `text edit target is not a file: ${targetPath}`,
        );
      }
      const current = contentsFromSnapshot(before);
      const decoded = decodeUtf8(current, targetPath);
      const after = encodeUtf8(applyTextEdits(decoded.text, edits, encoding), decoded.bom);
      const operation: EditableOperation = {
        kind: "modify",
        named_path: namedPath,
        path: targetPath,
        named_before: namedBefore,
        before,
        after_base64: after.toString("base64"),
        mode: before.mode,
      };
      operations.push(operation);
      editableOperations.set(namedPath, operation);
    };

    for (const [uri, edits] of Object.entries(input.edit.changes ?? {})) {
      await applyDocumentEdits(uri, edits);
    }

    for (const change of input.edit.documentChanges ?? []) {
      if (!("kind" in change)) {
        await applyDocumentEdits(change.textDocument.uri, regularTextEdits(change.edits));
        continue;
      }
      if (change.kind === "create") {
        const path = filePathFromUri(change.uri);
        if (destinations.has(path)) {
          throw new LspWorkspaceEditError(
            "duplicate_destination",
            `duplicate destination: ${path}`,
          );
        }
        destinations.add(path);
        rememberResourceAction(path, "create");
        const before = await snapshotNamedPath(path);
        if (before.kind !== "missing" && change.options?.ignoreIfExists === true) continue;
        if (before.kind !== "missing" && change.options?.overwrite !== true) {
          throw new LspWorkspaceEditError(
            "invalid_destination",
            `create destination exists: ${path}`,
          );
        }
        const operation: EditableOperation = {
          kind: "create",
          named_path: path,
          before,
          after_base64: "",
          mode: before.kind === "file" ? before.mode : 0o600,
        };
        operations.push(operation);
        editableOperations.set(path, operation);
        continue;
      }
      if (change.kind === "delete") {
        const path = filePathFromUri(change.uri);
        rememberResourceAction(path, "delete");
        const before = await snapshotNamedPath(path);
        if (before.kind === "missing" && change.options?.ignoreIfNotExists === true) continue;
        if (before.kind === "missing") {
          throw new LspWorkspaceEditError(
            "invalid_destination",
            `delete source is missing: ${path}`,
          );
        }
        operations.push({ kind: "delete", named_path: path, before });
        continue;
      }

      const source = filePathFromUri(change.oldUri);
      const destination = filePathFromUri(change.newUri);
      if (destinations.has(destination)) {
        throw new LspWorkspaceEditError(
          "duplicate_destination",
          `duplicate destination: ${destination}`,
        );
      }
      destinations.add(destination);
      rememberResourceAction(source, "rename-source");
      rememberResourceAction(destination, "rename-destination");
      const before = await snapshotNamedPath(source);
      if (before.kind === "missing") {
        throw new LspWorkspaceEditError(
          "invalid_destination",
          `rename source is missing: ${source}`,
        );
      }
      const destinationBefore = await snapshotNamedPath(destination);
      if (destinationBefore.kind !== "missing" && change.options?.ignoreIfExists === true) continue;
      if (destinationBefore.kind !== "missing" && change.options?.overwrite !== true) {
        throw new LspWorkspaceEditError(
          "invalid_destination",
          `rename destination exists: ${destination}`,
        );
      }
      operations.push({
        kind: "rename",
        named_path: source,
        destination_path: destination,
        before,
        destination_before: destinationBefore,
      });
    }

    const summaries = operations
      .flatMap((operation) => {
        if (operation.kind === "modify") {
          return [
            fileSummary(
              operation.named_path,
              contentsFromSnapshot(operation.before),
              Buffer.from(operation.after_base64, "base64"),
            ),
          ];
        }
        return [];
      })
      .sort((left, right) => left.localeCompare(right));
    const preview: LspWorkspaceEditPreview = {
      kind: "workspace_edit_preview",
      preview_id: this.createPreviewId(),
      server_id: input.serverId,
      summary: summaries.join("\n"),
      state: "available",
      operations,
    };
    this.previews.set(preview.preview_id, preview);
    this.unreportedPreviews.set(preview.preview_id, preview);
    return structuredClone(preview);
  }

  /** Mark a tool-created preview as already included in its originating LSP result. */
  markPreviewReported(previewId: string): void {
    this.unreportedPreviews.delete(previewId);
  }

  /** Take server-initiated previews that must be exposed through the active LSP result. */
  takeUnreportedPreviewRecords(): LspWorkspaceEditPreview[] {
    const records = [...this.unreportedPreviews.values()].map((preview) =>
      structuredClone(preview),
    );
    this.unreportedPreviews.clear();
    return records;
  }

  /** Return the canonical Mutation Manifest prepared before Pi's `tool_call` hooks run. */
  prepareMutationManifest(previewId: string): LspMutationManifest {
    const preview = this.requireAvailablePreview(previewId);
    return structuredClone(manifestForOperations(preview.operations));
  }

  /** Rebuild branch-local available/applied preview state from persisted tool result records. */
  replayPreviewRecords(records: readonly LSPAny[]): number {
    let rejected = 0;
    for (const record of records) {
      if (!isWorkspaceEditPreview(record)) {
        rejected++;
        continue;
      }
      this.previews.set(record.preview_id, structuredClone(record));
    }
    return rejected;
  }

  /** Revalidate and apply one preview inside every sorted canonical mutation queue. */
  async applyPreview(
    previewId: string,
    manifest: LspMutationManifest,
    signal?: AbortSignal,
  ): Promise<LspWorkspaceEditApplyResult> {
    const preview = this.requireAvailablePreview(previewId);
    const canonical = manifestForOperations(preview.operations);
    if (JSON.stringify(manifest) !== JSON.stringify(canonical)) {
      throw new LspWorkspaceEditError(
        "mutation_manifest_mismatch",
        "Mutation Manifest no longer matches its preview",
      );
    }
    const queuePaths = manifestQueuePaths(canonical);
    const acquire = async (index: number): Promise<LspWorkspaceEditApplyResult> => {
      const path = queuePaths[index];
      if (path === undefined) return this.applyInsideQueues(preview, canonical, signal);
      return this.queueMutation(path, () => acquire(index + 1));
    };
    return acquire(0);
  }

  private requireAvailablePreview(previewId: string): LspWorkspaceEditPreview {
    const preview = this.previews.get(previewId);
    if (preview === undefined) {
      throw new LspWorkspaceEditError(
        "preview_not_found",
        `Workspace Edit Preview not found: ${previewId}`,
      );
    }
    if (preview.state === "applied") {
      throw new LspWorkspaceEditError(
        "preview_already_applied",
        `Workspace Edit Preview was already applied: ${previewId}`,
      );
    }
    return preview;
  }

  private async applyInsideQueues(
    preview: LspWorkspaceEditPreview,
    manifest: LspMutationManifest,
    signal?: AbortSignal,
  ): Promise<LspWorkspaceEditApplyResult> {
    if (JSON.stringify(manifest) !== JSON.stringify(manifestForOperations(preview.operations))) {
      throw new LspWorkspaceEditError(
        "mutation_manifest_mismatch",
        "Mutation Manifest changed while waiting for file queues",
      );
    }
    await this.assertPreviewFresh(preview);
    if (signal?.aborted === true) {
      throw new LspWorkspaceEditError(
        "workspace_edit_cancelled",
        "Workspace Edit cancelled before its first mutation",
      );
    }

    const rollback: Array<{ readonly path: string; readonly snapshot: FileSnapshot }> = [];
    const changedFiles: string[] = [];
    const createdFiles: string[] = [];
    const deletedFiles: string[] = [];
    const movedFiles: Array<{ readonly from: string; readonly to: string }> = [];
    try {
      for (const operation of preview.operations) {
        if (operation.kind === "modify") {
          await this.files.replaceFile(
            operation.path,
            Buffer.from(operation.after_base64, "base64"),
            operation.mode,
          );
          rollback.push({ path: operation.path, snapshot: operation.before });
          changedFiles.push(operation.named_path);
          continue;
        }
        if (operation.kind === "create") {
          await this.files.replaceFile(
            operation.named_path,
            Buffer.from(operation.after_base64, "base64"),
            operation.mode,
          );
          rollback.push({ path: operation.named_path, snapshot: operation.before });
          if (operation.before.kind === "missing") createdFiles.push(operation.named_path);
          else changedFiles.push(operation.named_path);
          continue;
        }
        if (operation.kind === "delete") {
          await this.files.removePath(operation.named_path);
          rollback.push({ path: operation.named_path, snapshot: operation.before });
          deletedFiles.push(operation.named_path);
          continue;
        }
        if (operation.destination_before.kind !== "missing") {
          await this.files.removePath(operation.destination_path);
          rollback.push({
            path: operation.destination_path,
            snapshot: operation.destination_before,
          });
        }
        await this.files.renamePath(operation.named_path, operation.destination_path);
        rollback.push({ path: operation.named_path, snapshot: operation.before });
        if (operation.destination_before.kind === "missing") {
          rollback.push({
            path: operation.destination_path,
            snapshot: operation.destination_before,
          });
        }
        movedFiles.push({ from: operation.named_path, to: operation.destination_path });
      }
    } catch (cause) {
      const recoveryFailures: string[] = [];
      for (const entry of rollback.reverse()) {
        try {
          await restorePath(entry.path, entry.snapshot, this.files);
        } catch {
          recoveryFailures.push(entry.path);
        }
      }
      if (recoveryFailures.length > 0) {
        throw new LspWorkspaceEditError(
          "workspace_edit_recovery_failed",
          `Workspace Edit rollback failed for: ${recoveryFailures.join(", ")}`,
          recoveryFailures,
          { cause },
        );
      }
      throw new LspWorkspaceEditError(
        "workspace_edit_apply_failed",
        "Workspace Edit failed and was rolled back",
        [],
        { cause },
      );
    }

    this.previews.set(preview.preview_id, { ...preview, state: "applied" });
    return {
      preview_id: preview.preview_id,
      state: "applied",
      changed_files: changedFiles.sort(),
      created_files: createdFiles.sort(),
      deleted_files: deletedFiles.sort(),
      moved_files: movedFiles,
    };
  }

  private async assertPreviewFresh(preview: LspWorkspaceEditPreview): Promise<void> {
    for (const operation of preview.operations) {
      if (operation.kind === "modify") {
        if (
          !snapshotMatches(await snapshotNamedPath(operation.named_path), operation.named_before) ||
          !snapshotMatches(await snapshotNamedPath(operation.path), operation.before)
        ) {
          throw new LspWorkspaceEditError(
            "stale_workspace_edit",
            `file changed: ${operation.named_path}`,
          );
        }
        continue;
      }
      if (operation.kind === "rename") {
        if (
          !snapshotMatches(await snapshotNamedPath(operation.named_path), operation.before) ||
          !snapshotMatches(
            await snapshotNamedPath(operation.destination_path),
            operation.destination_before,
          )
        ) {
          throw new LspWorkspaceEditError(
            "stale_workspace_edit",
            `rename source or destination changed: ${operation.named_path}`,
          );
        }
        continue;
      }
      if (!snapshotMatches(await snapshotNamedPath(operation.named_path), operation.before)) {
        throw new LspWorkspaceEditError(
          "stale_workspace_edit",
          `file changed: ${operation.named_path}`,
        );
      }
    }
  }
}

function isWorkspaceEditPreview(value: LSPAny): value is LspWorkspaceEditPreview {
  return (
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- This is the persisted-preview parser boundary; every field is refined before replay.
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "workspace_edit_preview" &&
    "preview_id" in value &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Persisted preview field refinement.
    typeof value.preview_id === "string" &&
    "server_id" in value &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Persisted preview field refinement.
    typeof value.server_id === "string" &&
    "summary" in value &&
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Persisted preview field refinement.
    typeof value.summary === "string" &&
    "state" in value &&
    (value.state === "available" || value.state === "applied") &&
    "operations" in value &&
    Array.isArray(value.operations)
  );
}
