import { stripVTControlCharacters } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component, type TUI } from "@earendil-works/pi-tui";
import {
  ACTIVITY_RAIL_WIDTH,
  drawActivityRail,
  renderMinimalSubagentsMessage,
  renderMinimalSubagentsResult,
  type MinimalSubagentsRenderTheme,
} from "./minimal-subagents-rendering.js";
import type { ChildAgentTranscriptSnapshot } from "./minimal-subagents-types.js";

interface CachedTranscriptMessage {
  container: Container;
  tools: Map<string, ToolExecutionComponent>;
  expanded: boolean;
  streaming: boolean;
}

/** Rendered transcript lines and the first line of each message. */
export interface TranscriptLayout {
  lines: string[];
  messageStarts: number[];
  /** First line of each native component, such as one assistant reply or one tool execution. */
  itemStarts: number[];
}

/** Native components reused across renders while their source messages are unchanged. */
export interface TranscriptRenderCache {
  messages: WeakMap<AgentMessage, CachedTranscriptMessage>;
  results: WeakMap<ToolExecutionComponent, AgentMessage>;
}

/** Render a Child Session Transcript with Pi's native message and tool components. */
export function renderTranscriptSnapshot(
  snapshot: ChildAgentTranscriptSnapshot,
  tui: TUI,
  cwd: string,
  expanded: boolean,
  width: number,
  cache: TranscriptRenderCache,
): TranscriptLayout {
  if (snapshot.messages.length === 0) {
    return {
      lines: new Text(snapshot.fallback || "No conversation messages yet.", 3, 0).render(width),
      messageStarts: [0],
      itemStarts: [0],
    };
  }
  const blocks: Container[] = [];
  const tools = new Map(
    snapshot.toolDefinitions.map((definition) => [definition.name, definition]),
  );
  const pendingTools = new Map<string, ToolExecutionComponent>();
  const currentMessages = new Set(snapshot.messages);

  for (const [messageIndex, message] of snapshot.messages.entries()) {
    if (message.role === "toolResult") {
      const paired = pendingTools.get(message.toolCallId);
      if (paired) {
        if (cache.results.get(paired) !== message) {
          paired.updateResult(message);
          cache.results.set(paired, message);
        }
        pendingTools.delete(message.toolCallId);
        blocks.push(new Container());
        continue;
      }
    }
    const streaming = messageIndex === snapshot.streamingAssistantIndex;
    const cached = cache.messages.get(message);
    const staleResult =
      cached &&
      [...cached.tools.values()].some((tool) => {
        const result = cache.results.get(tool);
        return result !== undefined && !currentMessages.has(result);
      });
    if (cached && !staleResult && cached.expanded === expanded && cached.streaming === streaming) {
      blocks.push(cached.container);
      for (const [id, tool] of cached.tools) pendingTools.set(id, tool);
      continue;
    }
    const container = new Container();
    const messageTools = new Map<string, ToolExecutionComponent>();
    switch (message.role) {
      case "user": {
        const text = contentText(message.content, "\n\n");
        if (text) container.addChild(new UserMessageComponent(text));
        break;
      }
      case "assistant": {
        const assistant = new AssistantMessageComponent(message);
        assistant.updateContent(message, messageIndex === snapshot.streamingAssistantIndex);
        container.addChild(assistant);
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const tool = new ToolExecutionComponent(
            content.name,
            content.id,
            content.arguments,
            { showImages: false },
            tools.get(content.name) ?? {},
            tui,
            cwd,
          );
          tool.setExpanded(expanded);
          container.addChild(tool);
          if (message.stopReason === "aborted" || message.stopReason === "error") {
            tool.updateResult({
              content: [
                {
                  type: "text",
                  text:
                    message.stopReason === "aborted"
                      ? "Operation aborted"
                      : (message.errorMessage ?? "Error"),
                },
              ],
              isError: true,
            });
          } else {
            pendingTools.set(content.id, tool);
            messageTools.set(content.id, tool);
          }
        }
        break;
      }
      case "toolResult": {
        const inherited = new ToolExecutionComponent(
          message.toolName,
          message.toolCallId,
          {},
          { showImages: false },
          {},
          tui,
          cwd,
        );
        inherited.setExpanded(expanded);
        inherited.updateResult(message);
        container.addChild(inherited);
        break;
      }
      case "custom": {
        if (!message.display) break;
        const renderer =
          message.customType === "minimal-subagents.message"
            ? renderMinimalSubagentsMessage
            : message.customType === "minimal-subagents.result"
              ? renderMinimalSubagentsResult
              : undefined;
        const custom = new CustomMessageComponent(message, renderer);
        custom.setExpanded(expanded);
        container.addChild(custom);
        break;
      }
      case "bashExecution": {
        const bash = new BashExecutionComponent(message.command, tui, message.excludeFromContext);
        if (message.output) bash.appendOutput(message.output);
        bash.setComplete(
          message.exitCode,
          message.cancelled,
          // SAFETY: Persisted bash messages retain only the truncation flag; BashExecutionComponent reads that flag here.
          message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
          message.fullOutputPath,
        );
        bash.setExpanded(expanded);
        container.addChild(bash);
        break;
      }
      case "branchSummary": {
        const summary = new BranchSummaryMessageComponent(message);
        summary.setExpanded(expanded);
        container.addChild(summary);
        break;
      }
      case "compactionSummary": {
        const summary = new CompactionSummaryMessageComponent(message);
        summary.setExpanded(expanded);
        container.addChild(summary);
        break;
      }
    }
    cache.messages.set(message, { container, tools: messageTools, expanded, streaming });
    blocks.push(container);
  }
  let length = 0;
  const messageStarts: number[] = [];
  const itemStarts: number[] = [];
  // Containers concatenate their children, so rendering children one by one yields the same lines.
  const lines = blocks.flatMap((block) => {
    messageStarts.push(length);
    return block.children.flatMap((child) => {
      itemStarts.push(length);
      // Native user-message prompt zones belong to the main terminal, not an embedded overlay.
      const rendered = child
        .render(width)
        .map((line) =>
          line
            .replaceAll("\x1b]133;A\x07", "")
            .replaceAll("\x1b]133;B\x07", "")
            .replaceAll("\x1b]133;C\x07", ""),
        );
      length += rendered.length;
      return rendered;
    });
  });
  return { lines, messageStarts, itemStarts };
}

/** Create an empty cache for {@link renderTranscriptSnapshot}. */
export function createTranscriptRenderCache(): TranscriptRenderCache {
  return { messages: new WeakMap(), results: new WeakMap() };
}

/** Collapsed live views keep at most this many lines of the child's recent work. */
const COLLAPSED_TRANSCRIPT_RAIL_LINES = 20;

function isSpacerLine(line: string): boolean {
  // Includes a tool box's coloured padding rows, so each rail connector meets visible content.
  return stripVTControlCharacters(line).trim().length === 0;
}

function withoutSpacerEdges(lines: string[]): string[] {
  const start = lines.findIndex((line) => !isSpacerLine(line));
  if (start < 0) return [];
  const end = lines.findLastIndex((line) => !isSpacerLine(line));
  return lines.slice(start, end + 1);
}

/**
 * A child's recent transcript drawn with Pi's native message and tool components, one rail item
 * per component. Collapsed, it keeps the latest items that fit the line budget.
 */
export class TranscriptRail implements Component {
  constructor(
    private readonly snapshot: ChildAgentTranscriptSnapshot,
    private readonly tui: TUI,
    private readonly cwd: string,
    private readonly expanded: boolean,
    private readonly cache: TranscriptRenderCache,
    private readonly theme: MinimalSubagentsRenderTheme,
  ) {}

  render(width: number): string[] {
    const layout = renderTranscriptSnapshot(
      this.snapshot,
      this.tui,
      this.cwd,
      this.expanded,
      Math.max(1, width - ACTIVITY_RAIL_WIDTH),
      this.cache,
    );
    const items = layout.itemStarts
      .map((start, index) =>
        withoutSpacerEdges(layout.lines.slice(start, layout.itemStarts[index + 1])),
      )
      .filter((lines) => lines.length > 0);
    if (this.expanded) return drawActivityRail(items, this.theme);
    let shown = 0;
    let lineCount = 0;
    for (const item of items.toReversed()) {
      if (shown > 0 && lineCount + item.length > COLLAPSED_TRANSCRIPT_RAIL_LINES) break;
      shown++;
      lineCount += item.length;
    }
    const kept = items
      .slice(items.length - shown)
      .map((lines) => lines.slice(0, COLLAPSED_TRANSCRIPT_RAIL_LINES));
    const earlier = items.length - shown;
    return drawActivityRail(
      earlier > 0
        ? [
            [this.theme.fg("dim", `… ${earlier} earlier ${earlier === 1 ? "step" : "steps"}`)],
            ...kept,
          ]
        : kept,
      this.theme,
    );
  }

  invalidate(): void {
    this.cache.messages = new WeakMap();
    this.cache.results = new WeakMap();
  }
}
