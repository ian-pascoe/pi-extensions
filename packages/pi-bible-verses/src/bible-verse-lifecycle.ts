import type {
  ExtensionAPI,
  ExtensionContext,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createBibleVersePicker, formatBibleVerseMessage } from "./bible-verse-picker.js";

/** The narrow Working Message capability used by the Bible Verses lifecycle. */
export interface BibleVerseWorkingMessageHost {
  setWorkingMessage(message?: string): void;
}

/** Registers turn lifecycle handlers that update Pi's Working Message. */
export interface BibleVerseLifecycleHost {
  onTurnStart(
    handler: (event: TurnStartEvent, workingMessage: BibleVerseWorkingMessageHost) => Promise<void>,
  ): void;
  onTurnEnd(
    handler: (event: TurnEndEvent, workingMessage: BibleVerseWorkingMessageHost) => Promise<void>,
  ): void;
}

const pickBibleVerseMessage = createBibleVersePicker();

/** Installs the Offline Verse Pool into a narrow typed turn lifecycle. */
export function registerBibleVerseLifecycle(host: BibleVerseLifecycleHost) {
  host.onTurnStart(async (_event, workingMessage) => {
    workingMessage.setWorkingMessage(formatBibleVerseMessage(pickBibleVerseMessage()));
  });
  host.onTurnEnd(async (_event, workingMessage) => {
    workingMessage.setWorkingMessage();
  });
}

/** Installs Bible Verse Working Message behavior into Pi. */
export default function bibleVersesExtension(pi: ExtensionAPI) {
  registerBibleVerseLifecycle({
    onTurnStart: (handler) =>
      pi.on("turn_start", (event, context: ExtensionContext) => handler(event, context.ui)),
    onTurnEnd: (handler) =>
      pi.on("turn_end", (event, context: ExtensionContext) => handler(event, context.ui)),
  });
}
