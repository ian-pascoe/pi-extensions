import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ManagedInstallation, ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import { DAP_MANAGED_REQUESTS } from "./dap-managed-tools.js";
import { sanitizeDapObserverText } from "./dap-tool-rendering.js";

function versions(installation: ManagedInstallation): string {
  return Object.entries(installation.components)
    .map(([name, value]) => `${name} ${value.version}`)
    .join(", ");
}

/** Own the cancellable lifetime of deliberate updates, never replacing a running Debug Session. */
export class DapUpdateCommand {
  private controller: AbortController | undefined;
  private pending: Promise<void> | undefined;

  constructor(private readonly installer: ToolInstaller) {}

  async execute(argumentsText: string, context: ExtensionCommandContext): Promise<void> {
    const [operation, id, ...extra] = argumentsText.trim().split(/\s+/);
    const notify = (message: string) => {
      const safe = `Pi DAP: ${sanitizeDapObserverText(message)}`;
      if (context.hasUI) context.ui.notify(safe, "info");
      else console.error(safe);
    };
    if (operation === "update" && id === "cancel" && extra.length === 0) {
      this.controller?.abort(new Error("update cancelled"));
      notify(this.controller ? "cancelling update" : "no update is running");
      return;
    }
    if (
      operation !== "update" ||
      extra.length > 0 ||
      (id !== undefined && !DAP_MANAGED_REQUESTS.has(id))
    ) {
      notify("Usage: /dap update [javascript|python] or /dap update cancel");
      return;
    }
    if (this.pending !== undefined) {
      notify("an update is already running; /dap update cancel cancels it");
      return;
    }
    const controller = new AbortController();
    this.controller = controller;
    const run = async () => {
      let found = false;
      for (const [presetId, request] of DAP_MANAGED_REQUESTS) {
        if (id !== undefined && id !== presetId) continue;
        if (controller.signal.aborted) break;
        let previous: ManagedInstallation | undefined;
        try {
          previous = await this.installer.installed(request.id);
          if (!previous) continue;
          found = true;
          const result = await this.installer.update(request, {
            signal: controller.signal,
            onProgress: (message) => {
              if (context.hasUI)
                context.ui.setStatus("pi-dap-update", sanitizeDapObserverText(message));
              else notify(message);
            },
          });
          if (result === undefined) notify(`${presetId}: no Managed Installation`);
          else {
            const oldVersion = versions(result.previous);
            const newVersion = versions(result.current);
            notify(
              `${presetId}: ${oldVersion} → ${newVersion}${oldVersion === newVersion ? " (no change)" : ""}`,
            );
          }
        } catch (error) {
          notify(
            `${presetId}${previous ? ` (${versions(previous)})` : ""}: ${controller.signal.aborted ? "update cancelled" : `update failed: ${error instanceof Error ? error.message : String(error)}`}`,
          );
        }
      }
      if (!found && !controller.signal.aborted)
        notify("no installed managed DAP presets to update");
    };
    const execute = async () => {
      let mounted = false;
      let failure: Error | undefined;
      await context.ui.custom<void>((tui, theme, _keys, done) => {
        mounted = true;
        const loader = new BorderedLoader(tui, theme, "Updating managed DAP tools");
        loader.onAbort = () => controller.abort(new Error("update cancelled"));
        void run()
          // oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: Promise rejection values are narrowed to Error at this failure boundary.
          .catch((error: unknown) => {
            failure = error instanceof Error ? error : new Error(String(error));
          })
          .finally(() => {
            loader.dispose();
            done();
          });
        return loader;
      });
      if (failure !== undefined) throw failure;
      if (!mounted) {
        notify("updating managed DAP tools; /dap update cancel cancels this operation");
        await run();
      }
    };
    this.pending = execute();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
      this.controller = undefined;
      context.ui.setStatus("pi-dap-update", undefined);
    }
  }

  async shutdown(): Promise<void> {
    this.controller?.abort(new Error("update cancelled by Pi session shutdown"));
    await this.pending;
  }
}
