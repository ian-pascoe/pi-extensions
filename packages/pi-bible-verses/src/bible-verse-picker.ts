import { bibleVerseMessages, type BibleVerseMessage } from "./bible-verses.js";

/** Number of prior readings excluded from random selection. */
export const RECENT_BIBLE_VERSE_LIMIT = 20;

/** Formats one passage for the Pi working-message area. */
export function formatBibleVerseMessage(message: BibleVerseMessage): string {
  return `${message.text} — ${message.reference} (${message.translation})`;
}

/** Creates an independent random picker that excludes recently returned passage IDs. */
export function createBibleVersePicker(
  messages: readonly BibleVerseMessage[] = bibleVerseMessages,
  recentLimit = RECENT_BIBLE_VERSE_LIMIT,
): (random?: () => number) => BibleVerseMessage {
  if (messages.length <= recentLimit) {
    throw new Error(
      `Bible verse picker requires more than ${recentLimit} messages; received ${messages.length}`,
    );
  }

  const recentMessageIds: string[] = [];

  return (random = Math.random) => {
    const availableMessages = messages.filter((message) => !recentMessageIds.includes(message.id));
    const randomIndex = Math.floor(random() * availableMessages.length);
    const message = availableMessages[randomIndex];
    if (!message) {
      throw new Error(`Bible verse picker received an out-of-range random index: ${randomIndex}`);
    }

    recentMessageIds.push(message.id);
    if (recentMessageIds.length > recentLimit) {
      recentMessageIds.shift();
    }

    return message;
  };
}
