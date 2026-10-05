import type { LspWorkspaceEditStore } from "./lsp-workspace-edit.js";

type CreatePreviewInput = Omit<Parameters<LspWorkspaceEditStore["createPreview"]>[0], "reported">;

/**
 * Own the Workspace Edit Previews that one tool call creates, so none outlives a call whose result
 * does not name it. Every preview-creating executor records through the ledger; the call then
 * discards the unnamed ones once, however it ends: a server listing that failed, an action whose
 * edit could not be reported, or a failure while building the result after the servers answered.
 *
 * The ledger's previews are created as already reported, so they never enter the queue of
 * server-initiated previews that the next result takes; the ledger alone owns their lifecycle.
 */
export class LspPreviewLedger {
  private readonly createdIds = new Set<string>();
  private ended = false;

  /** Bind the ledger to the store that persists the previews. */
  constructor(private readonly store: LspWorkspaceEditStore) {}

  /**
   * Create a preview in the store and remember it as belonging to this call. A preview that
   * completes after the call has ended is discarded at once, since no result can name it.
   */
  async createPreview(
    input: CreatePreviewInput,
  ): Promise<Awaited<ReturnType<LspWorkspaceEditStore["createPreview"]>>> {
    const preview = await this.store.createPreview({ ...input, reported: true });
    if (this.ended) {
      this.store.discardPreview(preview.preview_id);
      throw new Error("Pi LSP: the tool call already ended, so its preview was discarded");
    }
    this.createdIds.add(preview.preview_id);
    return preview;
  }

  /** End the call: forget every preview of it that the returned result does not name. */
  discardUnnamed(namedIds: ReadonlySet<string>): void {
    this.ended = true;
    for (const previewId of this.createdIds) {
      if (!namedIds.has(previewId)) this.store.discardPreview(previewId);
    }
    this.createdIds.clear();
  }
}
