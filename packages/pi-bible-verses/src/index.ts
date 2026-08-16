import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBibleVersePicker, formatBibleVerseMessage } from "./bible-verse-picker.js";

const pickBibleVerseMessage = createBibleVersePicker();

/** Installs Bible Verse Working Message behavior into Pi. */
export default function bibleVersesExtension(pi: ExtensionAPI): void {
  pi.on("turn_start", (_event, context) => {
    context.ui.setWorkingMessage(formatBibleVerseMessage(pickBibleVerseMessage()));
  });
  pi.on("turn_end", (_event, context) => {
    context.ui.setWorkingMessage();
  });
}
