import type { ExtensionContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { IssuingCall, ToolInput } from "./guardian-evidence.js";

/** A call a Rejection or Review Failure would block, offered to the user as a User Override. */
export interface OverrideRequest {
  /** Why Guardian would block the call. */
  headline: string;
  toolName: string;
  input: ToolInput;
  parent: IssuingCall | undefined;
}

/** Calls whose serialized arguments fit this many characters are shown in full in the dialog. */
const previewLimit = 2_000;
const choices = { block: "Block", allow: "Allow once", view: "View full call" } as const;

/** The whole call, for the read-only viewer. */
function fullCall(request: OverrideRequest): string {
  const lines = [`Tool: ${request.toolName}`, "Arguments:", JSON.stringify(request.input, null, 2)];
  if (request.parent)
    lines.push(
      `Issued by tool call: ${request.parent.toolName}`,
      "Issuing call arguments:",
      JSON.stringify(request.parent.input, null, 2),
    );
  return lines.join("\n");
}

/**
 * Ask whether to allow one call. A call short enough is shown in full; a longer one offers
 * Allow once only after the user opened the full call, never on a cut-down preview.
 */
async function ask(ctx: ExtensionContext, request: OverrideRequest): Promise<boolean> {
  if (!ctx.hasUI || ctx.signal?.aborted) return false;
  const args = JSON.stringify(request.input);
  const parentArgs = request.parent ? JSON.stringify(request.parent.input) : "";
  const short = args.length + parentArgs.length <= previewLimit;
  const title = short
    ? [
        request.headline,
        `Arguments: ${args}`,
        ...(request.parent
          ? [`Issued by ${request.parent.toolName} with arguments: ${parentArgs}`]
          : []),
      ].join("\n")
    : `${request.headline}\nThe call is ${args.length + parentArgs.length} characters long, too long to show here; view the full call before allowing it.`;
  const options: ExtensionUIDialogOptions = {};
  if (ctx.signal) options.signal = ctx.signal;
  let viewed = short;
  try {
    for (;;) {
      const offered: string[] = short
        ? [choices.block, choices.allow]
        : [choices.block, choices.view, ...(viewed ? [choices.allow] : [])];
      const choice = await ctx.ui.select(title, offered, options);
      if (ctx.signal?.aborted) return false;
      if (choice !== choices.view) return choice === choices.allow;
      await ctx.ui.editor(
        `Full ${request.toolName} call under review (read-only: edits are ignored)`,
        fullCall(request),
      );
      viewed = true;
    }
  } catch {
    return false;
  }
}

/**
 * User Override dialogs, one at a time: nested calls (such as a codemode script's `Promise.all`)
 * run Guardian's handlers concurrently, so later dialogs wait for earlier ones.
 */
export function overrideDialogs(): (
  ctx: ExtensionContext,
  request: OverrideRequest,
) => Promise<boolean> {
  let queue: Promise<unknown> = Promise.resolve();
  return (ctx, request) => {
    const answer = queue.then(() => ask(ctx, request));
    queue = answer.catch(() => undefined);
    return answer;
  };
}
