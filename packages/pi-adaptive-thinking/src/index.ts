import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import type {
  AgentToolResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
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
  currentLevel?: PiThinkingLevel;
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

const textResult = (text: string): AgentToolResult<undefined> => ({
  content: [{ type: "text", text }],
  details: undefined,
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

const appendSystemPromptBlock = (systemPrompt: string, block: string) => {
  const trimmedBlock = block.trim();
  if (!trimmedBlock) return systemPrompt;
  if (!systemPrompt.trim()) return trimmedBlock;
  return `${systemPrompt.trimEnd()}\n\n${trimmedBlock}`;
};

const formatGuidance = (
  config: AdaptiveThinkingConfig,
  currentLevel: string | undefined,
  validLevels: string[],
) => {
  return (
    config.systemPrompt.trim() +
    " " +
    (currentLevel ? `Current thinking level: ${currentLevel}. ` : "") +
    `Valid thinking levels for this session: ${validLevels.join(", ")}. ` +
    `To change the thinking level, use the \`${config.toolName}\` tool with one of the valid levels. ` +
    "Only call it when the task complexity justifies changing levels. " +
    `Do not call ${config.toolName} if the current thinking level already matches the target level. ` +
    `Do not call ${config.toolName} twice in a row; reassess only after new evidence from other tool calls or user input.`
  );
};

export default function adaptiveThinking(pi: ExtensionAPI) {
  let runtime: RuntimeState | undefined;
  let runtimeHandlersRegistered = false;

  const registerRuntimeHandlers = () => {
    if (runtimeHandlersRegistered) return;
    runtimeHandlersRegistered = true;

    pi.on("thinking_level_select", async (event) => {
      if (!runtime) return;
      if (isThinkingLevel(event.level)) runtime.currentLevel = event.level;
    });

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

    pi.on("before_agent_start", async (event, ctx) => beforeAgentStart(event, ctx));

    pi.on("agent_end", async (_event, ctx) => {
      await resetTemporaryLevel(ctx);
      if (!runtime) return;
      runtime.lastToolCallWasReasoningTool = false;
      runtime.reasoningToolCallBackToBackById.clear();
    });
  };

  const beforeAgentStart = async (
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext,
  ): Promise<BeforeAgentStartEventResult> => {
    const state = runtime;
    if (!state) return { systemPrompt: event.systemPrompt };

    state.lastToolCallWasReasoningTool = false;
    state.reasoningToolCallBackToBackById.clear();

    const currentLevel = state.currentLevel ?? pi.getThinkingLevel();
    if (isThinkingLevel(currentLevel)) state.currentLevel = currentLevel;

    const validLevels = resolveSupportedThinkingLevels(ctx.model);
    return {
      systemPrompt: appendSystemPromptBlock(
        event.systemPrompt,
        formatGuidance(state.config, state.currentLevel, validLevels),
      ),
    };
  };

  const resetTemporaryLevel = async (ctx: ExtensionContext) => {
    const state = runtime;
    const resetLevel = state?.temporaryResetLevel;
    if (!state || !resetLevel) return;

    try {
      withSessionOnlyThinkingLevelChange(() => pi.setThinkingLevel(resetLevel));
      state.currentLevel = resetLevel;
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

    const initialLevel = pi.getThinkingLevel();
    runtime = { config, reasoningToolCallBackToBackById: new Map() };
    if (isThinkingLevel(initialLevel)) runtime.currentLevel = initialLevel;

    pi.registerTool({
      name: config.toolName,
      label: "Set Thinking Level",
      description: config.toolDescription,
      promptSnippet: "Set the current Pi thinking level.",
      promptGuidelines: [
        `Use ${config.toolName} to change the thinking level when task complexity justifies a different level.`,
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
        const currentLevel = state.currentLevel ?? pi.getThinkingLevel();
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

        try {
          withSessionOnlyThinkingLevelChange(() => pi.setThinkingLevel(level));
        } catch (error) {
          return textResult(`Failed to set thinking level: ${errorMessage(error)}`);
        }

        state.currentLevel = level;
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

    registerRuntimeHandlers();
  });
}
