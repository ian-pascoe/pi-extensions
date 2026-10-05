import TurndownService from "turndown";
import { describe, expect, test } from "vitest";
import { convertHtmlInChunks } from "../src/html-markdown.js";

function turndown(html: string): string {
  return new TurndownService({ headingStyle: "atx", bulletListMarker: "-" }).turndown(html);
}

describe("convertHtmlInChunks", () => {
  test("matches a single conversion for many block siblings, wrapped or not", () => {
    const blocks = Array.from({ length: 700 }, (_, index) =>
      index % 7 === 0
        ? `<h2>Heading ${index}</h2>`
        : index % 5 === 0
          ? `<ul><li>item ${index}</li><li>other</li></ul>`
          : `<p>Paragraph <em>${index}</em> with <a href="/x">a link</a>.</p>`,
    ).join("\n");

    for (const html of [blocks, `<main><div>${blocks}</div></main>`]) {
      expect(convertHtmlInChunks(html, turndown)).toBe(turndown(html));
    }
  });

  test("never splits inline runs between siblings", () => {
    const inline = Array.from({ length: 400 }, (_, index) => `<b>${index}</b> `).join("");
    expect(convertHtmlInChunks(inline, turndown)).toBe(turndown(inline));
  });

  test("converts small and malformed input directly", () => {
    for (const html of ["", "plain", "<p>one<p>two", "<div><p>unclosed", "</div><p>stray</p>"]) {
      expect(convertHtmlInChunks(html, turndown)).toBe(turndown(html));
    }
  });
});
