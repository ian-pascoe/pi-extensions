import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  AgentEndEvent,
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";
import { loadConfig, type AdaptiveThinkingConfig } from "./config-loader.js";
import {
  fallbackThinkingLevels,
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

const ThinkingLevelSchema = StringEnum(fallbackThinkingLevels);

/** Exact final-details schema returned by the Thinking Level Status tool. */
export const ThinkingLevelStatusSchema = Type.Object(
  {
    currentLevel: Type.Union([ThinkingLevelSchema, Type.Literal("unknown")]),
    supportedLevels: Type.Array(ThinkingLevelSchema),
  },
  { additionalProperties: false },
);

const UndefinedToolOutputSchema = Type.Undefined();

type ThinkingLevelStatus = Static<typeof ThinkingLevelStatusSchema>;

type ToolDefinitionWithOutputSchema<
  TParameters extends TSchema,
  TOutputSchema extends TSchema,
> = ToolDefinition<TParameters, Static<TOutputSchema>> & {
  outputSchema: TOutputSchema;
};

/** The extension-context fields Adaptive Thinking reads at its lifecycle and tool seams. */
export type AdaptiveThinkingContext = {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly model: ExtensionContext["model"];
  readonly ui: Pick<ExtensionContext["ui"], "notify">;
};

type AdaptiveThinkingHandler<Event, Result = undefined> = (
  event: Event,
  context: AdaptiveThinkingContext,
) => Promise<Result | void> | Result | void;

type AdaptiveThinkingToolExecution<Args, Details> = (
  toolCallId: string,
  parameters: Args,
  signal: AbortSignal | undefined,
  onUpdate: globalThis.Parameters<ToolDefinition<typeof ToolParameters, Details>["execute"]>[3],
  context: AdaptiveThinkingContext,
) => Promise<AgentToolResult<Details>>;

/** Set-thinking-level parameters accepted after Pi has validated the tool schema. */
export type AdaptiveThinkingSetThinkingLevelParameters = Static<typeof ToolParameters>;

/** Current and supported thinking levels returned by the status tool. */
export type AdaptiveThinkingLevelStatus = ThinkingLevelStatus;

type SetThinkingLevelTool = Omit<
  ToolDefinitionWithOutputSchema<typeof ToolParameters, typeof UndefinedToolOutputSchema>,
  "execute"
> & {
  execute: AdaptiveThinkingToolExecution<AdaptiveThinkingSetThinkingLevelParameters, undefined>;
};
type GetThinkingLevelTool = Omit<
  ToolDefinitionWithOutputSchema<typeof StatusToolParameters, typeof ThinkingLevelStatusSchema>,
  "execute"
> & {
  execute: AdaptiveThinkingToolExecution<Record<string, never>, ThinkingLevelStatus>;
};

/** Tool definitions registered by the Adaptive Thinking extension. */
export type AdaptiveThinkingToolDefinition = SetThinkingLevelTool | GetThinkingLevelTool;

/** Identifies the set-thinking-level tool without relying on its configurable name. */
export const isAdaptiveThinkingSetThinkingLevelTool = (
  tool: AdaptiveThinkingToolDefinition,
): tool is SetThinkingLevelTool => tool.parameters === ToolParameters;

/** Identifies the status tool without relying on its configurable name. */
export const isAdaptiveThinkingStatusTool = (
  tool: AdaptiveThinkingToolDefinition,
): tool is GetThinkingLevelTool => tool.parameters === StatusToolParameters;

/** Minimal Pi host capability required by the Adaptive Thinking extension. */
export type AdaptiveThinkingExtensionHost = {
  onSessionStart(handler: AdaptiveThinkingHandler<SessionStartEvent>): void;
  onToolCall(handler: AdaptiveThinkingHandler<ToolCallEvent, ToolCallEventResult>): void;
  onAgentEnd(handler: AdaptiveThinkingHandler<AgentEndEvent>): void;
  registerTool(tool: AdaptiveThinkingToolDefinition): void;
  getThinkingLevel(): string;
  setThinkingLevel(level: PiThinkingLevel): void;
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

const errorMessage = (cause: Error) => cause.message;

const SettingsDocumentSchema = Type.Object(
  { defaultThinkingLevel: Type.Optional(Type.String()) },
  { additionalProperties: Type.Unknown() },
);

const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

const globalSettingsPath = () => join(agentDir(), "settings.json");

// ponytail: Node's wx exclusive-create plus an asynchronous fixed-delay retry loop replaces
// proper-lockfile; the bound matches its previous policy (99 retries at a fixed 20 ms delay).
// The .lock suffix distinguishes owned lock files from the legacy always-present marker the
// previous implementation pre-created next to the settings document.
// Stale recovery assumes the critical section stays synchronous; use a heartbeat lock if it gains
// asynchronous work.
const SETTINGS_LOCK_RETRY_DELAY_MS = 20;
const SETTINGS_LOCK_RETRIES = 99;
const SETTINGS_LOCK_STALE_MS = 10_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

const acquireSettingsLock = async (lockPath: string): Promise<void> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      return;
    } catch (cause) {
      if (!(cause instanceof Error) || !("code" in cause) || cause.code !== "EEXIST") throw cause;
      try {
        const lock = await stat(lockPath);
        if (lock.mtimeMs < Date.now() - SETTINGS_LOCK_STALE_MS) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch (statCause) {
        if (!(statCause instanceof Error) || !("code" in statCause) || statCause.code !== "ENOENT")
          throw statCause;
        continue;
      }
      if (attempt >= SETTINGS_LOCK_RETRIES) throw cause;
    }
    await sleep(SETTINGS_LOCK_RETRY_DELAY_MS);
  }
};

const withSettingsLock = async <T>(settingsPath: string, fn: () => T): Promise<T> => {
  mkdirSync(join(settingsPath, ".."), { recursive: true });
  const lockPath = `${settingsPath}.adaptive-thinking.lock`;
  await acquireSettingsLock(lockPath);

  try {
    return await fn();
  } finally {
    await rm(lockPath, { force: true });
  }
};

const readDefaultThinkingLevel = (settingsPath: string): PiThinkingLevel | undefined => {
  if (!existsSync(settingsPath)) return undefined;

  try {
    const settings = Parse(SettingsDocumentSchema, JSON.parse(readFileSync(settingsPath, "utf-8")));
    const level = settings.defaultThinkingLevel;
    return level !== undefined && isThinkingLevel(level) ? level : undefined;
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
    const settings = Parse(SettingsDocumentSchema, JSON.parse(readFileSync(settingsPath, "utf-8")));
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

const withSessionOnlyThinkingLevelChange = async (changeThinkingLevel: () => void) => {
  const settingsPath = globalSettingsPath();

  await withSettingsLock(settingsPath, () => {
    const previousDefaultThinkingLevel = readDefaultThinkingLevel(settingsPath);

    changeThinkingLevel();

    restoreDefaultThinkingLevel(settingsPath, previousDefaultThinkingLevel);
  });
};

const notify = (
  ctx: AdaptiveThinkingContext,
  type: NotifyType,
  message: string,
  config?: Pick<AdaptiveThinkingConfig, "quiet">,
) => {
  if (config?.quiet) return;
  if (!ctx.hasUI) return;
  ctx.ui.notify(message, type);
};

/** Registers Adaptive Thinking against its narrow lifecycle, tool, and thinking-level host. */
export function registerAdaptiveThinking(pi: AdaptiveThinkingExtensionHost) {
  let runtime: RuntimeState | undefined;
  let runtimeHandlersRegistered = false;

  const registerRuntimeHandlers = () => {
    if (runtimeHandlersRegistered) return;
    runtimeHandlersRegistered = true;

    pi.onToolCall(async (event) => {
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

    pi.onAgentEnd(async (_event, ctx) => {
      await resetTemporaryLevel(ctx);
      if (!runtime) return;
      runtime.lastToolCallWasReasoningTool = false;
      runtime.reasoningToolCallBackToBackById.clear();
    });
  };

  const resetTemporaryLevel = async (ctx: AdaptiveThinkingContext) => {
    const state = runtime;
    const resetLevel = state?.temporaryResetLevel;
    if (!state || !resetLevel) return;

    try {
      await withSessionOnlyThinkingLevelChange(() => pi.setThinkingLevel(resetLevel));
      delete state.temporaryResetLevel;
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      notify(ctx, "error", `Failed to reset thinking level: ${errorMessage(error)}`, state.config);
    }
  };

  const registerSetThinkingLevelTool = (tool: SetThinkingLevelTool) => pi.registerTool(tool);
  const registerGetThinkingLevelTool = (tool: GetThinkingLevelTool) => pi.registerTool(tool);

  pi.onSessionStart(async (_event, ctx) => {
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

    registerSetThinkingLevelTool({
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
      outputSchema: UndefinedToolOutputSchema,
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
          await withSessionOnlyThinkingLevelChange(() => pi.setThinkingLevel(level));
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
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

    registerGetThinkingLevelTool({
      name: config.statusToolName,
      label: "Get Thinking Level",
      description: "Get the current and supported Pi thinking levels",
      promptSnippet: "Inspect the current and supported Pi thinking levels.",
      promptGuidelines: [
        `Use ${config.statusToolName} only when thinking-level state is uncertain; do not poll it routinely.`,
      ],
      parameters: StatusToolParameters,
      outputSchema: ThinkingLevelStatusSchema,
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

/** Adapts Pi's complete ExtensionAPI to the Adaptive Thinking lifecycle capability. */
export default function adaptiveThinkingExtension(pi: ExtensionAPI) {
  registerAdaptiveThinking({
    onSessionStart: (handler) => pi.on("session_start", handler),
    onToolCall: (handler) => pi.on("tool_call", handler),
    onAgentEnd: (handler) => pi.on("agent_end", handler),
    // ponytail: the branches look identical but narrow the union so registerTool's
    // generics infer per concrete ToolDefinition instead of falling back to defaults.
    registerTool: (tool) => {
      if (isAdaptiveThinkingSetThinkingLevelTool(tool)) pi.registerTool(tool);
      else pi.registerTool(tool);
    },
    getThinkingLevel: () => pi.getThinkingLevel(),
    setThinkingLevel: (level) => pi.setThinkingLevel(level),
  });
}
