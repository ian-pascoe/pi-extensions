import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { loadConfig, type AdaptiveThinkingConfig } from "./config-loader.js";
import {
  isThinkingLevel,
  resolveSupportedThinkingLevels,
  type PiThinkingLevel,
} from "./thinking-levels.js";

type NotifyType = "info" | "warning" | "error";

type RuntimeState = {
  config: AdaptiveThinkingConfig;
  persistedLevel?: PiThinkingLevel;
  temporaryResetLevel?: PiThinkingLevel;
  lastToolCallWasReasoningTool?: boolean;
  reasoningToolCallBackToBackById: Map<string, boolean>;
};

const ToolParameters = Type.Object(
  {
    level: Type.String({
      minLength: 1,
      description:
        "The Pi thinking level to apply. Higher levels may improve hard-task quality but may take more time and resources.",
    }),
    persist: Type.Optional(
      Type.Boolean({
        default: false,
        description:
          "Whether to persist the setting for this session; otherwise it applies only for the current turn.",
      }),
    ),
  },
  { additionalProperties: false },
);

type ToolParameters = Static<typeof ToolParameters>;

const StatusToolParameters = Type.Object({}, { additionalProperties: false });

type ThinkingLevelStatus = {
  currentLevel: PiThinkingLevel | "unknown";
  supportedLevels: PiThinkingLevel[];
};

const textResult = (text: string): AgentToolResult<undefined> => ({
  content: [{ type: "text", text }],
  details: undefined,
});

const thinkingLevelStatusResult = (
  currentLevel: PiThinkingLevel | "unknown",
  supportedLevels: PiThinkingLevel[],
): AgentToolResult<ThinkingLevelStatus> => ({
  content: [
    {
      type: "text",
      text: `Current thinking level: ${currentLevel}. Supported thinking levels: ${supportedLevels.join(", ")}.`,
    },
  ],
  details: { currentLevel, supportedLevels },
});

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const globalSettingsPath = () => join(agentDir(), "settings.json");

const sleepSync = (milliseconds: number) => {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    // Synchronous ExtensionAPI methods require a synchronous retry loop.
  }
};

const acquireSettingsLock = (lockPath: string) => {
  const maxAttempts = 100;
  const delayMs = 20;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return lockfile.lockSync(lockPath, { realpath: false });
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
      if (code !== "ELOCKED" || attempt === maxAttempts) throw error;
      sleepSync(delayMs);
    }
  }

  throw new Error(`Failed to acquire settings lock: ${lockPath}`);
};

const withSettingsLock = <T>(settingsPath: string, fn: () => T): T => {
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  const lockPath = `${settingsPath}.adaptive-thinking`;
  if (!existsSync(lockPath)) writeFileSync(lockPath, "");

  const release = acquireSettingsLock(lockPath);

  try {
    return fn();
  } finally {
    release();
  }
};

const readDefaultThinkingLevel = (settingsPath: string): PiThinkingLevel | undefined => {
  if (!existsSync(settingsPath)) return undefined;

  try {
    const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as {
      defaultThinkingLevel?: unknown;
    };
    return typeof parsed.defaultThinkingLevel === "string" &&
      isThinkingLevel(parsed.defaultThinkingLevel)
      ? parsed.defaultThinkingLevel
      : undefined;
  } catch {
    return undefined;
  }
};

const restoreDefaultThinkingLevel = (
  settingsPath: string,
  previousDefaultThinkingLevel: PiThinkingLevel | undefined,
) => {
  if (!existsSync(settingsPath)) return;

  try {
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    if (previousDefaultThinkingLevel === undefined) {
      delete settings.defaultThinkingLevel;
    } else {
      settings.defaultThinkingLevel = previousDefaultThinkingLevel;
    }
    writeFileSync(settingsPath, JSON.stringify(settings, undefined, 2) + "\n");
  } catch {
    return;
  }
};

const withSessionOnlyThinkingLevelChange = (changeThinkingLevel: () => void) => {
  const settingsPath = globalSettingsPath();

  return withSettingsLock(settingsPath, () => {
    const previousDefaultThinkingLevel = readDefaultThinkingLevel(settingsPath);

    changeThinkingLevel();

    restoreDefaultThinkingLevel(settingsPath, previousDefaultThinkingLevel);
  });
};

const notify = (
  ctx: ExtensionContext,
  type: NotifyType,
  message: string,
  config?: Pick<AdaptiveThinkingConfig, "quiet">,
) => {
  if (config?.quiet) return;
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, type);
};

export default function adaptiveThinking(pi: ExtensionAPI) {
  let runtime: RuntimeState | undefined;
  let runtimeHandlersRegistered = false;

  const registerRuntimeHandlers = () => {
    if (runtimeHandlersRegistered) return;
    runtimeHandlersRegistered = true;

    pi.on("tool_call", async (event) => {
      const state = runtime;
      if (!state) return;

      if (event.toolName === state.config.toolName) {
        state.reasoningToolCallBackToBackById.set(
          event.toolCallId,
          state.lastToolCallWasReasoningTool ?? false,
        );
        state.lastToolCallWasReasoningTool = true;
      } else {
        state.lastToolCallWasReasoningTool = false;
      }
    });

    pi.on("agent_end", async (_event, ctx) => {
      await resetTemporaryLevel(ctx);
      if (!runtime) return;
      runtime.lastToolCallWasReasoningTool = false;
      runtime.reasoningToolCallBackToBackById.clear();
    });
  };

  const resetTemporaryLevel = async (ctx: ExtensionContext) => {
    const state = runtime;
    const resetLevel = state?.temporaryResetLevel;
    if (!state || !resetLevel) return;

    try {
      withSessionOnlyThinkingLevelChange(() => pi.setThinkingLevel(resetLevel));
      delete state.temporaryResetLevel;
    } catch (error) {
      notify(ctx, "error", `Failed to reset thinking level: ${errorMessage(error)}`, state.config);
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    const configResult = await loadConfig({ cwd: ctx.cwd });
    if (!configResult.success) {
      runtime = undefined;
      notify(ctx, "error", configResult.error.message);
      return;
    }

    const { config } = configResult;
    if (!config.enabled) {
      runtime = undefined;
      return;
    }

    runtime = { config, reasoningToolCallBackToBackById: new Map() };

    if (configResult.usedDeprecatedSystemPrompt) {
      notify(
        ctx,
        "warning",
        "Adaptive Thinking configuration: systemPrompt is deprecated; rename it to guidance.",
        config,
      );
    }

    pi.registerTool({
      name: config.toolName,
      label: "Set Thinking Level",
      description: config.toolDescription,
      promptSnippet: "Set the current Pi thinking level.",
      promptGuidelines: [
        config.guidance,
        `Use ${config.toolName} to change the thinking level when task complexity justifies a different level.`,
        `Use ${config.statusToolName} only when the current or supported thinking levels are uncertain; do not poll it routinely.`,
        `Do not call ${config.toolName} twice in a row; reassess only after new evidence from other tool calls or user input.`,
      ],
      parameters: ToolParameters,
      execute: async (toolCallId, params: ToolParameters, _signal, _onUpdate, ctx) => {
        const state = runtime;
        if (!state) return textResult("Adaptive Thinking is not enabled for this session.");

        const level = params.level.trim();
        const validLevels = resolveSupportedThinkingLevels(ctx.model);
        if (!isThinkingLevel(level) || !validLevels.includes(level)) {
          return textResult(
            `Invalid thinking level: ${level}. Valid levels: ${validLevels.join(", ")}.`,
          );
        }

        const persist = params.persist ?? false;
        const currentLevel = pi.getThinkingLevel();
        if (currentLevel === level) {
          return textResult(`Thinking level is already ${level}; no change made.`);
        }

        if (state.reasoningToolCallBackToBackById.get(toolCallId) ?? false) {
          return textResult(
            `Thinking level change skipped because the previous tool call was also ${state.config.toolName}. Reassess after another tool call or new user input.`,
          );
        }

        const resetLevel =
          state.persistedLevel ?? (isThinkingLevel(currentLevel) ? currentLevel : undefined);

        if (!persist && !resetLevel) {
          return textResult(
            "Cannot apply a temporary thinking level because the Session Baseline is unknown.",
          );
        }

        try {
          withSessionOnlyThinkingLevelChange(() => pi.setThinkingLevel(level));
        } catch (error) {
          return textResult(`Failed to set thinking level: ${errorMessage(error)}`);
        }

        if (persist) {
          state.persistedLevel = level;
          delete state.temporaryResetLevel;
        } else if (resetLevel && resetLevel !== level) {
          state.temporaryResetLevel = resetLevel;
        } else {
          delete state.temporaryResetLevel;
        }

        return textResult(`Thinking level set to ${level}`);
      },
    });

    pi.registerTool({
      name: config.statusToolName,
      label: "Get Thinking Level",
      description: "Get the current and supported Pi thinking levels",
      promptSnippet: "Inspect the current and supported Pi thinking levels.",
      promptGuidelines: [
        `Use ${config.statusToolName} only when thinking-level state is uncertain; do not poll it routinely.`,
      ],
      parameters: StatusToolParameters,
      execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
        const currentLevel = pi.getThinkingLevel();
        return thinkingLevelStatusResult(
          isThinkingLevel(currentLevel) ? currentLevel : "unknown",
          resolveSupportedThinkingLevels(ctx.model),
        );
      },
    });

    registerRuntimeHandlers();
  });
}
