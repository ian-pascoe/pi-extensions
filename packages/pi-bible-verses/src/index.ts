import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBibleVersePicker, formatBibleVerseMessage } from "./bible-verse-picker.js";

const pickBibleVerseMessage = createBibleVersePicker();

export default function bibleVersesExtension(pi: ExtensionAPI) {
  pi.on("turn_start", async (_event, ctx) => {
    ctx.ui.setWorkingMessage(formatBibleVerseMessage(pickBibleVerseMessage()));
  });

  pi.on("turn_end", async (_event, ctx) => {
    ctx.ui.setWorkingMessage(); // Reset for next time
  });
}
