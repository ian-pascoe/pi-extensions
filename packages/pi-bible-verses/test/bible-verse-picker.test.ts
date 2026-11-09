import { describe, expect, test } from "vitest";
import { createBibleVersePicker, RECENT_BIBLE_VERSE_LIMIT } from "../src/bible-verse-picker.js";
import type { BibleVerseMessage } from "../src/bible-verses.js";

const pickerMessages = Array.from({ length: RECENT_BIBLE_VERSE_LIMIT + 1 }, (_, index) => ({
  text: "Passage " + index,
  reference: "Book " + index + ":1",
  translation: "WEB" as const,
})) satisfies readonly BibleVerseMessage[];

describe("Bible verse picker", () => {
  test("rejects a pool that cannot exclude its recent window", () => {
    expect(() => createBibleVersePicker(pickerMessages.slice(0, RECENT_BIBLE_VERSE_LIMIT))).toThrow(
      "Bible verse picker requires more than 20 messages; received 20",
    );
  });

  test("evicts the oldest passage object after the Recent Passage Window", () => {
    const picker = createBibleVersePicker(pickerMessages);
    const selectedMessages = Array.from({ length: RECENT_BIBLE_VERSE_LIMIT + 1 }, () =>
      picker(() => 0),
    );

    expect(selectedMessages).toEqual([
      ...pickerMessages.slice(0, RECENT_BIBLE_VERSE_LIMIT),
      pickerMessages[20],
    ]);
    expect(picker(() => 0)).toBe(pickerMessages[0]);
    // The random value maps onto the whole pool: just below 1 reaches the last passage.
    expect(createBibleVersePicker(pickerMessages)(() => 0.999_999)).toBe(pickerMessages[20]);
  });
});
