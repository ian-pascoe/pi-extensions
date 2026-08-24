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

  test("uses deterministic random boundaries and never repeats within the Recent Passage Window", () => {
    const picker = createBibleVersePicker(pickerMessages);

    expect(picker(() => 0)).toBe(pickerMessages[0]);
    expect(picker(() => 0.999_999)).toBe(pickerMessages[20]);

    const remainingSelections = Array.from({ length: RECENT_BIBLE_VERSE_LIMIT - 2 }, () =>
      picker(() => 0),
    );
    const selectedMessages = [pickerMessages[0], pickerMessages[20], ...remainingSelections];
    expect(new Set(selectedMessages).size).toBe(RECENT_BIBLE_VERSE_LIMIT);
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
  });
});
