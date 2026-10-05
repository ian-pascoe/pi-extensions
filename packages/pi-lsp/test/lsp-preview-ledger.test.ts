import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { LspPreviewLedger } from "../src/lsp-preview-ledger.js";
import { LspWorkspaceEditStore } from "../src/lsp-workspace-edit.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function editFor() {
  const directory = await mkdtemp(join(tmpdir(), "pi-lsp-ledger-"));
  directories.push(directory);
  const path = join(directory, "source.ts");
  await writeFile(path, "const a = 1;\n");
  return {
    changes: {
      [pathToFileURL(path).href]: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: "// edit\n",
        },
      ],
    },
  };
}

describe("LspPreviewLedger", () => {
  test("discards the previews a result does not name and keeps the named ones", async () => {
    const store = new LspWorkspaceEditStore();
    const ledger = new LspPreviewLedger(store);
    const named = await ledger.createPreview({ edit: await editFor(), serverId: "typescript" });
    const unnamed = await ledger.createPreview({ edit: await editFor(), serverId: "typescript" });

    ledger.discardUnnamed(new Set([named.preview_id]));

    expect(() => store.prepareMutationManifest(named.preview_id)).not.toThrow();
    expect(() => store.prepareMutationManifest(unnamed.preview_id)).toThrow();
  });

  test("creates previews already reported, so only the ledger owns them", async () => {
    const store = new LspWorkspaceEditStore();
    const ledger = new LspPreviewLedger(store);

    await ledger.createPreview({ edit: await editFor(), serverId: "typescript" });

    expect(store.takeUnreportedPreviewRecords()).toEqual([]);
  });

  test("discards a preview created after the call has ended", async () => {
    const store = new LspWorkspaceEditStore();
    const ledger = new LspPreviewLedger(store);
    ledger.discardUnnamed(new Set());
    const edit = await editFor();
    let createdId: string | undefined;
    const realCreatePreview = store.createPreview.bind(store);
    store.createPreview = async (input) => {
      const preview = await realCreatePreview(input);
      createdId = preview.preview_id;
      return preview;
    };

    await expect(ledger.createPreview({ edit, serverId: "typescript" })).rejects.toThrow(
      "already ended",
    );

    expect(createdId).toBeDefined();
    expect(() => store.prepareMutationManifest(createdId ?? "")).toThrow();
  });
});
