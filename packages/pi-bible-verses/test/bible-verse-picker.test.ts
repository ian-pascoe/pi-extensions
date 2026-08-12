import { describe, expect, test } from "vitest";
import {
  createBibleVersePicker,
  formatBibleVerseMessage,
  RECENT_BIBLE_VERSE_LIMIT,
} from "../src/bible-verse-picker.js";
import type { BibleVerseMessage } from "../src/bible-verses.js";

const pickerMessages = Array.from({ length: RECENT_BIBLE_VERSE_LIMIT + 1 }, (_, index) => ({
  id: "passage-" + index,
  text: "Passage " + index,
  reference: "Book " + index + ":1",
  translation: "WEB" as const,
  verseCount: 1,
  book: "Book",
})) satisfies readonly BibleVerseMessage[];

describe("Bible verse picker", () => {
  test("formats a passage for Pi's working message", () => {
    expect(formatBibleVerseMessage(pickerMessages[0]!)).toBe("Passage 0 — Book 0:1 (WEB)");
  });

  test("rejects a pool that cannot exclude its recent window", () => {
    expect(() => createBibleVersePicker(pickerMessages.slice(0, RECENT_BIBLE_VERSE_LIMIT))).toThrow(
      "Bible verse picker requires more than 20 messages; received 20",
    );
  });

  test("uses deterministic random boundaries and never repeats within the recent window", () => {
    const picker = createBibleVersePicker(pickerMessages);

    expect(picker(() => 0)).toMatchObject({ id: "passage-0" });
    expect(picker(() => 0.999_999)).toMatchObject({ id: "passage-20" });

    const remainingSelections = Array.from({ length: RECENT_BIBLE_VERSE_LIMIT - 2 }, () =>
      picker(() => 0),
    );
    const selectedIds = ["passage-0", "passage-20", ...remainingSelections.map(({ id }) => id)];
    expect(new Set(selectedIds).size).toBe(RECENT_BIBLE_VERSE_LIMIT);
  });

  test("evicts the oldest passage after the recent window", () => {
    const picker = createBibleVersePicker(pickerMessages);
    const selectedIds = Array.from(
      { length: RECENT_BIBLE_VERSE_LIMIT + 1 },
      () => picker(() => 0).id,
    );

    expect(selectedIds).toEqual([
      ...Array.from({ length: RECENT_BIBLE_VERSE_LIMIT }, (_, index) => "passage-" + index),
      "passage-20",
    ]);
    expect(picker(() => 0)).toMatchObject({ id: "passage-0" });
  });

  test("keeps independent recent windows for independent pickers", () => {
    const firstPicker = createBibleVersePicker(pickerMessages);
    const secondPicker = createBibleVersePicker(pickerMessages);

    expect(firstPicker(() => 0)).toMatchObject({ id: "passage-0" });
    expect(firstPicker(() => 0)).toMatchObject({ id: "passage-1" });
    expect(secondPicker(() => 0)).toMatchObject({ id: "passage-0" });
  });
});
