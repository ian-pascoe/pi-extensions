import { describe, expect, test } from "vitest";
import { bibleTranslationMetadata } from "../src/bible-translations.js";
import { bibleVerseMessages } from "../src/bible-verses.js";

describe("Offline Bible translation data", () => {
  test("records rights and provenance for every translation", () => {
    for (const [abbreviation, metadata] of Object.entries(bibleTranslationMetadata)) {
      expect(metadata.license, abbreviation).not.toBe("");
      expect(metadata.sourceUrl, abbreviation).not.toBe("");
      expect(metadata.rightsUrl, abbreviation).not.toBe("");
      expect(metadata.provenanceNotice, abbreviation).not.toBe("");
      expect(metadata.sourceArchiveSha256, abbreviation).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("contains unique, usable passages with known translations", () => {
    expect(bibleVerseMessages.length).toBeGreaterThan(0);
    expect(new Set(bibleVerseMessages.map(({ reference }) => reference)).size).toBe(
      bibleVerseMessages.length,
    );

    for (const message of bibleVerseMessages) {
      expect(Object.keys(message)).toEqual(["text", "reference", "translation"]);
      expect(message.text).not.toBe("");
      expect(message.reference).not.toBe("");
      expect(bibleTranslationMetadata).toHaveProperty(message.translation);
    }
  });
});
