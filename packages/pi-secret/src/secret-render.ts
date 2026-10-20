import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";
import {
  appendDurationFooter,
  callDurationFooter,
  COLLAPSED_LINES,
  type DurationContext,
  previewBody,
  type PreviewOptions,
  toolHeader,
  type UiTheme,
} from "@ian-pascoe/pi-utils/ui";

/** The theme methods the Secret renderers draw with. */
export type SecretRenderTheme = Pick<UiTheme, "fg" | "bold">;

/** What a `secret_*` call row shows: Secret Names only, since the tools never take values. */
export interface SecretCallArguments {
  readonly names?: readonly string[];
  readonly reason?: string | null | undefined;
}

/** A `secret_*` call row: the tool name, the Secret Names it targets, then the reason. */
export function renderSecretCall(
  name: string,
  params: SecretCallArguments,
  theme: SecretRenderTheme,
  context: DurationContext,
): Component {
  const container = new Container();
  const reason = params.reason?.trim();
  container.addChild(
    new Text(
      toolHeader(theme, name, params.names?.join(", "), reason ? `· ${reason}` : undefined),
      0,
      0,
    ),
  );
  container.addChild(callDurationFooter(theme, context));
  return container;
}

/** A `secret_*` result row: its text in Pi's fallback Collapsed View, red when it failed. */
export function renderSecretResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: SecretRenderTheme,
  context: DurationContext & { readonly isError: boolean },
): Component {
  const text = result.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("\n")
    .trim();
  const preview: PreviewOptions = { limit: COLLAPSED_LINES.fallback, expanded: options.expanded };
  if (context.isError) preview.color = "error";
  const body = previewBody(theme, (text || "Done").split("\n"), preview);
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(new Text(body.join("\n"), 0, 0));
  appendDurationFooter(container, theme, context, { isPartial: options.isPartial });
  return container;
}
