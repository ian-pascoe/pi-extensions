import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ManagedInstallation, ToolInstaller } from "@ian-pascoe/pi-tool-installer";
import {
  formatterPresetIds,
  formatterRequest,
  type FormatterPresetId,
} from "./formatter-presets.js";

function report(
  context: ExtensionContext,
  message: string,
  level: "info" | "warning" = "info",
): void {
  if (context.hasUI) context.ui.notify(message, level);
  else console.error(message);
}

function versions(installation: ManagedInstallation): string {
  return Object.entries(installation.components)
    .map(([name, component]) => `${name} ${component.version}`)
    .join(", ");
}

export function registerFormatterCommand(
  pi: ExtensionAPI,
  installer: ToolInstaller,
  lifetime: () => AbortSignal,
): () => Promise<void> {
  let active: AbortController | undefined;
  let pending: Promise<void> | undefined;
  pi.registerCommand("formatter", {
    description:
      "Update installed managed formatters: update [prettier|biome|black|ruff|gofmt|rustfmt], or update cancel",
    handler: async (args, context) => {
      const [operation, id, ...extra] = args.trim().split(/\s+/);
      if (
        operation !== "update" ||
        extra.length > 0 ||
        (id !== undefined && id !== "cancel" && !formatterPresetIds.some((preset) => preset === id))
      ) {
        report(
          context,
          "Usage: /formatter update [prettier|biome|black|ruff|gofmt|rustfmt|cancel]",
          "warning",
        );
        return;
      }
      if (id === "cancel") {
        active?.abort();
        report(
          context,
          active ? "Cancelling formatter update" : "No formatter update is running",
          "info",
        );
        return;
      }
      if (active) {
        report(context, "A formatter update is running; use /formatter update cancel", "warning");
        return;
      }
      const controller = new AbortController();
      active = controller;
      const signals = [controller.signal, lifetime()];
      if (context.signal) signals.push(context.signal);
      const signal = AbortSignal.any(signals);
      const selected = formatterPresetIds.filter((preset) => id === undefined || preset === id);
      const work = async () => {
        try {
          await updateFormatters(selected, installer, context, signal);
        } catch (error) {
          report(
            context,
            `Pi Formatter update failed: ${error instanceof Error ? error.message : String(error)}`,
            "warning",
          );
        } finally {
          context.ui.setStatus("pi-formatter-update", undefined);
        }
      };
      try {
        let started = false;
        if (context.mode === "tui") {
          await context.ui.custom<void>((tui, theme, _keys, done) => {
            started = true;
            const loader = new BorderedLoader(tui, theme, "Updating managed formatters");
            loader.onAbort = () => controller.abort();
            // Keep the command and UI alive until cancellation has stopped the installer.
            pending = work();
            void pending.finally(() => {
              loader.dispose();
              done();
            });
            return loader;
          });
        }
        if (!started) {
          pending = work();
          await pending;
        }
      } finally {
        active = undefined;
        pending = undefined;
      }
    },
  });
  return async () => {
    active?.abort();
    await pending;
  };
}

async function updateFormatters(
  ids: readonly FormatterPresetId[],
  installer: ToolInstaller,
  context: ExtensionContext,
  signal: AbortSignal,
): Promise<void> {
  let found = false;
  for (const id of ids) {
    if (signal.aborted) break;
    try {
      const request = formatterRequest(id);
      const installed = await installer.installed(request.id);
      if (!installed) continue;
      found = true;
      // A preset may own only a runtime for an externally installed tool.
      request.requirements = Object.fromEntries(
        Object.entries(request.requirements).filter(([name]) => name in installed.components),
      );
      const result = await installer.update(request, {
        signal,
        onProgress: (message) => context.ui.setStatus("pi-formatter-update", `${id}: ${message}`),
      });
      if (!result) continue;
      const previous = versions(result.previous);
      const current = versions(result.current);
      report(
        context,
        `${id}: ${previous === current ? `${current} (no change)` : `${previous} -> ${current}`}`,
        "info",
      );
    } catch (error) {
      report(
        context,
        `${id}: update ${signal.aborted ? "cancelled" : "failed"}: ${error instanceof Error ? error.message : String(error)}. The previous installation is retained.`,
        "warning",
      );
    }
  }
  if (signal.aborted) report(context, "Formatter update cancelled", "info");
  else if (!found)
    report(
      context,
      "No installed managed formatters to update; external installations are unchanged",
      "info",
    );
}
