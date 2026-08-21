import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { DapSession } from "./dap-session.js";
import { createDapSessionFiles, type DapSessionFiles } from "./dap-session-files.js";
import { DapObserverUiController } from "./dap-observer-ui.js";
import { createDapToolDefinition, type DapToolRuntime } from "./dap-tool.js";
import { resolveDapSettings } from "./pi-dap-settings.js";

interface ActivePiDapSession extends DapToolRuntime {
  readonly observer: DapObserverUiController;
  readonly session: DapSession;
  readonly sessionFiles: DapSessionFiles;
}

/** Own settings, one Debug Session, one registered tool, and cleanup for a Pi conversation session. */
export class PiDapLifecycleController {
  private activeSession: ActivePiDapSession | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private toolRegistered = false;

  /** Bind lifecycle handlers to Pi; `getAgentDirectory` may be overridden by tests to isolate settings. */
  constructor(
    private readonly pi: ExtensionAPI,
    private readonly getAgentDirectory: () => string = getAgentDir,
  ) {}

  /** Register the Pi conversation session start and shutdown handlers. */
  register(): void {
    this.pi.on("session_start", (_event, context) => this.startSession(context));
    this.pi.on("session_shutdown", () => this.shutdownSession());
  }

  private async startSession(context: ExtensionContext): Promise<void> {
    await this.shutdownSession();
    const settingsManager = SettingsManager.create(context.cwd, this.getAgentDirectory(), {
      projectTrusted: context.isProjectTrusted(),
    });
    const settings = resolveDapSettings(settingsManager);
    if (settings.warnings.length > 0) {
      context.ui.notify(`Pi DAP settings:\n- ${settings.warnings.join("\n- ")}`, "warning");
    }

    const sessionFiles = await createDapSessionFiles(context.sessionManager.getSessionDir());
    const observer = new DapObserverUiController(context);
    this.activeSession = {
      observer,
      session: new DapSession({
        cwd: context.cwd,
        settings,
        sessionFiles,
        onSnapshotChange: (snapshot) => observer.onSessionSnapshot(snapshot),
        onUnexpectedFailure: (error) => observer.onUnexpectedFailure(error),
      }),
      sessionFiles,
    };
    if (!this.toolRegistered) {
      this.pi.registerTool(createDapToolDefinition(() => this.activeSession));
      this.toolRegistered = true;
    }
  }

  private async shutdownSession(): Promise<void> {
    if (this.activeSession === undefined) {
      await this.shutdownPromise;
      return;
    }
    const activeSession = this.activeSession;
    this.activeSession = undefined;
    const shutdown = (async () => {
      activeSession.observer.dispose();
      try {
        await activeSession.session.shutdown();
      } finally {
        await activeSession.sessionFiles.close();
      }
    })();
    this.shutdownPromise = shutdown;
    try {
      await shutdown;
    } finally {
      if (this.shutdownPromise === shutdown) this.shutdownPromise = undefined;
    }
  }
}

/** Compose the source-TypeScript Pi DAP extension without starting a Debug Adapter at load time. */
export function createPiDapExtension(
  getAgentDirectory: () => string = getAgentDir,
): ExtensionFactory {
  return (pi) => new PiDapLifecycleController(pi, getAgentDirectory).register();
}

const piDapExtension = createPiDapExtension();

export default piDapExtension;
