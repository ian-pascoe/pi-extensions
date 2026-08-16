import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PositionEncodingKind, type WorkspaceEdit } from "vscode-languageserver-protocol";
import { afterEach, describe, expect, test } from "vitest";
import {
  LspWorkspaceEditError,
  LspWorkspaceEditStore,
  nodeLspWorkspaceEditFileOperations,
  type LspWorkspaceEditFileOperations,
} from "../src/lsp-workspace-edit.js";

const temporaryDirectories: string[] = [];

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "pi-lsp-workspace-edit-"));
  temporaryDirectories.push(directory);
  return directory;
}

function fileUri(path: string): string {
  return pathToFileURL(path).href;
}

function textEdit(path: string, oldEnd: number, newText: string): WorkspaceEdit {
  return {
    changes: {
      [fileUri(path)]: [
        {
          newText,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: oldEnd },
          },
        },
      ],
    },
  };
}

async function expectWorkspaceEditCode(
  promise: Promise<unknown>,
  code: LspWorkspaceEditError["code"],
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Workspace Edit Preview and Validated Workspace Edit", () => {
  test("previews and applies deterministic multi-file text changes while preserving BOMs and modes", async () => {
    const root = await makeTemporaryDirectory();
    const first = resolve(root, "first.ts");
    const second = resolve(root, "second.ts");
    await writeFile(first, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("old\n")]));
    await writeFile(second, "two\n");
    await chmod(first, 0o640);
    await chmod(second, 0o600);
    const store = new LspWorkspaceEditStore({ createPreviewId: () => "preview-1" });

    const preview = await store.createPreview({
      edit: {
        changes: {
          [fileUri(second)]: [
            {
              newText: "second",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
          [fileUri(first)]: [
            {
              newText: "new",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
        },
      },
      serverId: "typescript",
    });

    expect(preview.preview_id).toBe("preview-1");
    expect(preview.summary).toBe(
      [
        `--- ${first}`,
        `+++ ${first}`,
        "@@ -1,2 +1,2 @@",
        "-old",
        "-",
        "+new",
        "+",
        `--- ${second}`,
        `+++ ${second}`,
        "@@ -1,2 +1,2 @@",
        "-two",
        "-",
        "+second",
        "+",
      ].join("\n"),
    );
    const manifest = store.prepareMutationManifest(preview.preview_id);
    expect(manifest.entries).toEqual([
      { named_path: first, operation: "modify", path: first },
      { named_path: second, operation: "modify", path: second },
    ]);

    const applied = await store.applyPreview(preview.preview_id, manifest);
    expect(applied).toMatchObject({
      changed_files: [first, second],
      created_files: [],
      deleted_files: [],
      moved_files: [],
      preview_id: "preview-1",
      state: "applied",
    });
    expect(await readFile(first)).toEqual(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("new\n")]),
    );
    expect((await stat(first)).mode & 0o777).toBe(0o640);
    expect(await readFile(second, "utf8")).toBe("second\n");
    expect((await stat(second)).mode & 0o777).toBe(0o600);
    await expectWorkspaceEditCode(
      store.applyPreview(preview.preview_id, manifest),
      "preview_already_applied",
    );
  });

  test("supports create, modify, delete, and rename resource operations including flags", async () => {
    const root = await makeTemporaryDirectory();
    const source = resolve(root, "source.ts");
    const destination = resolve(root, "destination.ts");
    const created = resolve(root, "created.ts");
    const ignored = resolve(root, "ignored.ts");
    const deleted = resolve(root, "deleted.ts");
    await writeFile(source, "source\n");
    await writeFile(destination, "replace me\n");
    await writeFile(ignored, "keep me\n");
    await writeFile(deleted, "delete me\n");
    const store = new LspWorkspaceEditStore({ createPreviewId: () => "resources" });

    const preview = await store.createPreview({
      edit: {
        documentChanges: [
          { kind: "create", options: { ignoreIfExists: true }, uri: fileUri(ignored) },
          { kind: "create", uri: fileUri(created) },
          {
            edits: [
              {
                newText: "created",
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              },
            ],
            textDocument: { uri: fileUri(created), version: null },
          },
          {
            kind: "rename",
            newUri: fileUri(destination),
            oldUri: fileUri(source),
            options: { overwrite: true },
          },
          { kind: "delete", uri: fileUri(deleted) },
          {
            kind: "delete",
            options: { ignoreIfNotExists: true },
            uri: fileUri(resolve(root, "missing.ts")),
          },
        ],
      },
      serverId: "typescript",
    });

    const result = await store.applyPreview(
      preview.preview_id,
      store.prepareMutationManifest(preview.preview_id),
    );
    expect(result.created_files).toEqual([created]);
    expect(result.deleted_files).toEqual([deleted]);
    expect(result.moved_files).toEqual([{ from: source, to: destination }]);
    expect(await readFile(created, "utf8")).toBe("created");
    expect(await readFile(destination, "utf8")).toBe("source\n");
    expect(await readFile(ignored, "utf8")).toBe("keep me\n");
    await expect(lstat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(deleted)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects unsafe or contradictory workspace edits before persistence", async () => {
    const root = await makeTemporaryDirectory();
    const file = resolve(root, "file.ts");
    const binary = resolve(root, "binary.ts");
    const directory = resolve(root, "directory");
    await writeFile(file, "abcd");
    await writeFile(binary, Buffer.from([0xff, 0xfe]));
    await mkdir(directory);
    const store = new LspWorkspaceEditStore();

    await expectWorkspaceEditCode(
      store.createPreview({
        edit: { changes: { "jar:file:///library.jar!/a.ts": [] } },
        serverId: "typescript",
      }),
      "non_file_uri",
    );
    await expectWorkspaceEditCode(
      store.createPreview({ edit: textEdit(binary, 0, "x"), serverId: "typescript" }),
      "invalid_utf8",
    );
    await expectWorkspaceEditCode(
      store.createPreview({
        edit: { documentChanges: [{ kind: "delete", uri: fileUri(directory) }] },
        serverId: "typescript",
      }),
      "directory_operation",
    );
    await expectWorkspaceEditCode(
      store.createPreview({
        edit: {
          changes: {
            [fileUri(file)]: [
              {
                newText: "x",
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
              },
              {
                newText: "y",
                range: { start: { line: 0, character: 2 }, end: { line: 0, character: 4 } },
              },
            ],
          },
        },
        serverId: "typescript",
      }),
      "overlapping_text_edits",
    );
    const duplicateDestination = resolve(root, "same.ts");
    await expectWorkspaceEditCode(
      store.createPreview({
        edit: {
          documentChanges: [
            { kind: "create", uri: fileUri(duplicateDestination) },
            {
              kind: "rename",
              newUri: fileUri(duplicateDestination),
              oldUri: fileUri(file),
            },
          ],
        },
        serverId: "typescript",
      }),
      "duplicate_destination",
    );
    await expectWorkspaceEditCode(
      store.createPreview({
        edit: {
          documentChanges: [
            { kind: "create", uri: fileUri(duplicateDestination) },
            { kind: "delete", uri: fileUri(duplicateDestination) },
          ],
        },
        serverId: "typescript",
      }),
      "contradictory_resource_operations",
    );
  });

  test("content edits follow symlinks while resource operations address the named entry", async () => {
    const root = await makeTemporaryDirectory();
    const target = resolve(root, "target.ts");
    const link = resolve(root, "link.ts");
    const movedLink = resolve(root, "moved-link.ts");
    await writeFile(target, "target\n");
    await symlink("target.ts", link);
    const contentStore = new LspWorkspaceEditStore({ createPreviewId: () => "symlink-content" });
    const contentPreview = await contentStore.createPreview({
      edit: textEdit(link, 6, "changed"),
      serverId: "typescript",
    });
    expect(contentStore.prepareMutationManifest(contentPreview.preview_id).entries).toEqual([
      { named_path: link, operation: "modify", path: target },
    ]);
    await contentStore.applyPreview(
      contentPreview.preview_id,
      contentStore.prepareMutationManifest(contentPreview.preview_id),
    );
    expect(await readFile(target, "utf8")).toBe("changed\n");
    expect(await readlink(link)).toBe("target.ts");

    const resourceStore = new LspWorkspaceEditStore({ createPreviewId: () => "symlink-resource" });
    const resourcePreview = await resourceStore.createPreview({
      edit: {
        documentChanges: [{ kind: "rename", newUri: fileUri(movedLink), oldUri: fileUri(link) }],
      },
      serverId: "typescript",
    });
    await resourceStore.applyPreview(
      resourcePreview.preview_id,
      resourceStore.prepareMutationManifest(resourcePreview.preview_id),
    );
    expect(await readlink(movedLink)).toBe("target.ts");
    expect(await readFile(target, "utf8")).toBe("changed\n");
  });

  test("normalizes text edits with the server's negotiated position encoding", async () => {
    const root = await makeTemporaryDirectory();
    const file = resolve(root, "unicode.ts");
    await writeFile(file, "😀x");
    const store = new LspWorkspaceEditStore({ createPreviewId: () => "utf8-position" });
    const preview = await store.createPreview({
      edit: {
        changes: {
          [fileUri(file)]: [
            {
              newText: "Q",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
            },
          ],
        },
      },
      positionEncoding: PositionEncodingKind.UTF8,
      serverId: "typescript",
    });
    await store.applyPreview(preview.preview_id, store.prepareMutationManifest(preview.preview_id));
    expect(await readFile(file, "utf8")).toBe("Qx");
  });

  test("replays persisted preview state and rejects stale files and mutated manifests", async () => {
    const root = await makeTemporaryDirectory();
    const file = resolve(root, "file.ts");
    await writeFile(file, "before\n");
    const firstStore = new LspWorkspaceEditStore({ createPreviewId: () => "replay" });
    const preview = await firstStore.createPreview({
      edit: textEdit(file, 6, "after"),
      serverId: "typescript",
    });
    const replayedStore = new LspWorkspaceEditStore();
    expect(replayedStore.replayPreviewRecords([preview])).toEqual({ accepted: 1, rejected: 0 });
    const manifest = replayedStore.prepareMutationManifest(preview.preview_id);
    await expectWorkspaceEditCode(
      replayedStore.applyPreview(preview.preview_id, {
        ...manifest,
        entries: [{ named_path: file, operation: "modify", path: resolve(root, "other.ts") }],
      }),
      "mutation_manifest_mismatch",
    );
    await writeFile(file, "stale\n");
    await expectWorkspaceEditCode(
      replayedStore.applyPreview(preview.preview_id, manifest),
      "stale_workspace_edit",
    );
    expect(await readFile(file, "utf8")).toBe("stale\n");
  });

  test("acquires sorted canonical queues and honors cancellation before mutation", async () => {
    const root = await makeTemporaryDirectory();
    const a = resolve(root, "a.ts");
    const z = resolve(root, "z.ts");
    await writeFile(a, "a");
    await writeFile(z, "z");
    const queued: string[] = [];
    const store = new LspWorkspaceEditStore({
      createPreviewId: () => "queues",
      queueMutation: async (path, operation) => {
        queued.push(path);
        return operation();
      },
    });
    const preview = await store.createPreview({
      edit: {
        changes: {
          [fileUri(z)]: [
            {
              newText: "Z",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
          ],
          [fileUri(a)]: [
            {
              newText: "A",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
            },
          ],
        },
      },
      serverId: "typescript",
    });
    const abortController = new AbortController();
    abortController.abort();
    await expectWorkspaceEditCode(
      store.applyPreview(
        preview.preview_id,
        store.prepareMutationManifest(preview.preview_id),
        abortController.signal,
      ),
      "workspace_edit_cancelled",
    );
    expect(queued).toEqual([a, z]);
    expect(await readFile(a, "utf8")).toBe("a");
    expect(await readFile(z, "utf8")).toBe("z");
  });

  test("rolls a failed batch back in reverse and reports exact rollback failures", async () => {
    const root = await makeTemporaryDirectory();
    const first = resolve(root, "first.ts");
    const second = resolve(root, "second.ts");
    await writeFile(first, "one");
    await writeFile(second, "two");
    const calls: string[] = [];
    let replacements = 0;
    const failingOperations: LspWorkspaceEditFileOperations = {
      ...nodeLspWorkspaceEditFileOperations,
      async replaceFile(path, contents, mode) {
        calls.push(`replace:${path}:${contents.toString("utf8")}`);
        replacements++;
        if (replacements === 2) throw new Error("injected second write failure");
        await nodeLspWorkspaceEditFileOperations.replaceFile(path, contents, mode);
      },
    };
    const store = new LspWorkspaceEditStore({
      createPreviewId: () => "rollback",
      fileOperations: failingOperations,
    });
    const preview = await store.createPreview({
      edit: {
        changes: {
          [fileUri(first)]: [
            {
              newText: "ONE",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
          [fileUri(second)]: [
            {
              newText: "TWO",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
        },
      },
      serverId: "typescript",
    });
    await expectWorkspaceEditCode(
      store.applyPreview(preview.preview_id, store.prepareMutationManifest(preview.preview_id)),
      "workspace_edit_apply_failed",
    );
    expect(await readFile(first, "utf8")).toBe("one");
    expect(await readFile(second, "utf8")).toBe("two");
    expect(calls.at(-1)).toBe(`replace:${first}:one`);

    replacements = 0;
    const unrecoverableOperations: LspWorkspaceEditFileOperations = {
      ...nodeLspWorkspaceEditFileOperations,
      async replaceFile(path, contents, mode) {
        replacements++;
        if (replacements >= 2) throw new Error(`injected failure ${replacements}`);
        await nodeLspWorkspaceEditFileOperations.replaceFile(path, contents, mode);
      },
    };
    const recoveryStore = new LspWorkspaceEditStore({
      createPreviewId: () => "recovery",
      fileOperations: unrecoverableOperations,
    });
    const recoveryPreview = await recoveryStore.createPreview({
      edit: {
        changes: {
          [fileUri(first)]: [
            {
              newText: "ONE",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
          [fileUri(second)]: [
            {
              newText: "TWO",
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
            },
          ],
        },
      },
      serverId: "typescript",
    });
    await expect(
      recoveryStore.applyPreview(
        recoveryPreview.preview_id,
        recoveryStore.prepareMutationManifest(recoveryPreview.preview_id),
      ),
    ).rejects.toMatchObject({
      code: "workspace_edit_recovery_failed",
      recoveryFailures: [first],
    });
  });

  test("restores an overwritten rename destination when the rename itself fails", async () => {
    const root = await makeTemporaryDirectory();
    const source = resolve(root, "source.ts");
    const destination = resolve(root, "destination.ts");
    await writeFile(source, "source");
    await writeFile(destination, "destination");
    const store = new LspWorkspaceEditStore({
      createPreviewId: () => "rename-failure",
      fileOperations: {
        ...nodeLspWorkspaceEditFileOperations,
        async renamePath() {
          throw new Error("injected rename failure");
        },
      },
    });
    const preview = await store.createPreview({
      edit: {
        documentChanges: [
          {
            kind: "rename",
            oldUri: fileUri(source),
            newUri: fileUri(destination),
            options: { overwrite: true },
          },
        ],
      },
      serverId: "typescript",
    });
    await expectWorkspaceEditCode(
      store.applyPreview(preview.preview_id, store.prepareMutationManifest(preview.preview_id)),
      "workspace_edit_apply_failed",
    );
    expect(await readFile(source, "utf8")).toBe("source");
    expect(await readFile(destination, "utf8")).toBe("destination");
  });
});
