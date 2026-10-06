import {
  getAgentDir,
  getShellConfig,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
  type SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { createBashReplacement, RunningBashCalls } from "./bash-replacement.js";
import {
  EXIT_NOTIFICATION_TYPE,
  formatExitNotification,
  renderExitNotification,
} from "./exit-notification.js";
import { TermctrlPsController } from "./ps-panel.js";
import { resolveTermctrlBinary, type TermctrlBinaryResolution } from "./termctrl-binary.js";
import { createTermctrlDriver } from "./termctrl-driver.js";
import { TermctrlRegistry } from "./termctrl-registry.js";
import { resolveTermctrlSettings, type TerminalViewport } from "./pi-termctrl-settings.js";
import type { TerminalDriver } from "./terminal-driver.js";
import {
  createTerminalListTool,
  createTerminalSendTool,
  createTerminalStartTool,
  createTerminalStopTool,
  createTerminalWaitTool,
  type TerminalShell,
} from "./terminal-tools.js";

/** Collaborators tests replace; production uses Pi's agent directory and the packaged binary. */
export interface PiTermctrlExtensionOptions {
  readonly getAgentDirectory?: () => string;
  readonly resolveBinary?: () => TermctrlBinaryResolution;
  readonly createDriver?: (binaryPath: string) => Promise<TerminalDriver>;
}

interface ActiveSession {
  readonly owner: string;
  readonly calls: RunningBashCalls;
  readonly ps: TermctrlPsController;
  readonly shell: () => TerminalShell;
  readonly viewport: TerminalViewport;
  readonly exitTailLines: number;
}

/**
 * Owns one Pi session's binding to the process-wide registry, its tools, and its UI. Terminal
 * tools register at load so hosts that check tool availability before `session_start`, such as
 * Minimal Subagents child agents, see them; tools that depend on settings register at
 * `session_start`.
 */
class PiTermctrlController {
  private active: ActiveSession | undefined;
  /**
   * Exit notifications sent mid-turn would queue in Pi as steering messages, beyond recall, while
   * a tool call in the same turn, such as `terminal_wait`, can still report the exit. During an
   * agent run they therefore wait for the turn's end, when Pi reads steering messages and those
   * tool results are known.
   */
  private runActive = false;
  private atTurnEnd = false;
  private readonly binary: TermctrlBinaryResolution;
  private readonly registry: TermctrlRegistry;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly options: PiTermctrlExtensionOptions,
  ) {
    const binary = (options.resolveBinary ?? resolveTermctrlBinary)();
    const createDriver = options.createDriver ?? createTermctrlDriver;
    this.binary = binary;
    this.registry = TermctrlRegistry.acquire({
      createDriver: () =>
        binary.kind === "available"
          ? createDriver(binary.path)
          : Promise.reject(new Error(`termctrl is unavailable: ${binary.reason}`)),
    });
  }

  register(): void {
    this.pi.registerMessageRenderer(EXIT_NOTIFICATION_TYPE, renderExitNotification);
    this.pi.registerCommand("ps", {
      description: "Show and stop Terminals and Background jobs",
      handler: async () => {
        await this.active?.ps.open();
      },
    });
    if (this.binary.kind === "available") {
      const runtime = {
        registry: this.registry,
        shell: () => this.session().shell(),
        viewport: () => this.session().viewport,
      };
      this.pi.registerTool(createTerminalStartTool(runtime));
      this.pi.registerTool(createTerminalSendTool(runtime));
      this.registerManagementTools();
    }
    this.pi.on("session_start", (_event, context) => this.start(context));
    this.pi.on("session_shutdown", (event) => this.shutdown(event));
    this.pi.on("agent_start", () => {
      this.runActive = true;
    });
    this.pi.on("turn_end", () => {
      this.atTurnEnd = true;
      try {
        this.flushNotifications();
      } finally {
        this.atTurnEnd = false;
      }
    });
    this.pi.on("agent_end", () => {
      this.runActive = false;
      this.flushNotifications();
    });
  }

  private flushNotifications(): void {
    (TermctrlRegistry.current() ?? this.registry).flush();
  }

  private registerManagementTools(): void {
    this.pi.registerTool(createTerminalStopTool(this.registry));
    this.pi.registerTool(createTerminalListTool(this.registry));
    this.pi.registerTool(
      createTerminalWaitTool({
        registry: this.registry,
        exitTailLines: () => this.session().exitTailLines,
      }),
    );
  }

  private session(): ActiveSession {
    if (this.active === undefined) throw new Error("Pi Termctrl has no active session.");
    return this.active;
  }

  private start(context: ExtensionContext): void {
    const settingsManager = SettingsManager.create(
      context.cwd,
      (this.options.getAgentDirectory ?? getAgentDir)(),
      { projectTrusted: context.isProjectTrusted() },
    );
    const settings = resolveTermctrlSettings(settingsManager);
    if (settings.warnings.length > 0) {
      context.ui.notify(`Pi Termctrl settings:\n- ${settings.warnings.join("\n- ")}`, "warning");
    }
    const registry = this.registry;
    const owner = context.sessionManager.getSessionId();
    this.runActive = false;
    registry.bindOwner(owner, (notices) => {
      if (this.runActive && !this.atTurnEnd) return false;
      const message = formatExitNotification(notices, settings.exitTailLines);
      this.pi.sendMessage(
        {
          customType: EXIT_NOTIFICATION_TYPE,
          content: message.content,
          display: true,
          details: message.details,
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      return true;
    });

    const shellPath = settingsManager.getShellPath();
    const commandPrefix = settingsManager.getShellCommandPrefix();
    if (this.binary.kind === "missing") {
      context.ui.notify(
        `Pi Termctrl: Terminal tools are unavailable: ${this.binary.reason}\nRun /skill:pi-termctrl to diagnose.`,
        "warning",
      );
      if (settings.replaceBash) this.registerManagementTools();
    }
    const currentRegistry = () => TermctrlRegistry.current() ?? registry;
    const calls = new RunningBashCalls(currentRegistry);
    if (settings.replaceBash) {
      this.pi.registerTool(
        createBashReplacement({
          cwd: context.cwd,
          commandPrefix,
          shellPath,
          registry: currentRegistry,
          calls,
          bashTail: settings.bashTail,
        }),
      );
    }
    this.active = {
      owner,
      calls,
      ps: new TermctrlPsController(registry, context),
      shell: () => {
        const shell = getShellConfig(shellPath);
        return { shell: shell.shell, args: shell.args, commandPrefix };
      },
      viewport: settings.defaultViewport,
      exitTailLines: settings.exitTailLines,
    };
  }

  private async shutdown(event: SessionShutdownEvent): Promise<void> {
    const active = this.active;
    this.active = undefined;
    if (active === undefined) return;
    active.calls.dispose();
    const reload = event.reason === "reload";
    active.ps.dispose(!reload);
    if (reload) {
      this.registry.unbindOwner(active.owner);
      return;
    }
    await this.registry.shutdownOwner(active.owner);
  }
}

/** Compose the Pi Termctrl extension. Nothing starts until a Terminal or Background job is needed. */
export function createPiTermctrlExtension(
  options: PiTermctrlExtensionOptions = {},
): ExtensionFactory {
  return (pi) => new PiTermctrlController(pi, options).register();
}

const piTermctrlExtension = createPiTermctrlExtension();

export default piTermctrlExtension;
