import TurndownService from "turndown";
import { describe, expect, test } from "vitest";
import { convertHtmlInChunks, type HtmlChunkLimits } from "../src/html-markdown.js";

function turndown(html: string): string {
  return new TurndownService({
    headingStyle: "atx",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
  }).turndown(html);
}

const NO_TEXT = (): string => {
  throw new Error("plain-text backstop must not run");
};

// Small limits make every split path run on input small enough to compare with one conversion.
const SMALL: HtmlChunkLimits = {
  directBytes: 300,
  groupSize: 5,
  groupBytes: 600,
  atomicBytes: Number.MAX_SAFE_INTEGER,
};

function blocks(count: number): string {
  return Array.from({ length: count }, (_, index) =>
    index % 7 === 0
      ? `<h2>Heading ${index}</h2>`
      : index % 5 === 0
        ? `<ul><li>item ${index}</li><li>other <b>bold</b></li></ul>`
        : `<p>Paragraph <em>${index}</em> with <a href="/x">a link</a>.</p>`,
  ).join("\n");
}

function expectSameAsOneConversion(html: string, limits: HtmlChunkLimits = SMALL): void {
  expect(convertHtmlInChunks(html, turndown, NO_TEXT, limits)).toBe(turndown(html));
}

describe("convertHtmlInChunks", () => {
  test("matches one conversion for many block siblings, wrapped or not", () => {
    const content = blocks(150);
    for (const html of [
      content,
      `<main><div>${content}</div></main>`,
      `<main>${content}</main><footer>Foot</footer>`,
    ]) {
      expectSameAsOneConversion(html);
    }
  });

  test("shape A: a plain page with head and body", () => {
    expectSameAsOneConversion(
      `<!doctype html><html><head><title>Page Title</title><meta charset="utf-8"></head><body>${blocks(150)}</body></html>`,
    );
  });

  test("shape B: containers that each hold many siblings", () => {
    expectSameAsOneConversion(
      `<main><div id="a">${blocks(120)}</div><div id="b">${blocks(120)}</div><section>text <b>inline</b> <div>${blocks(40)}</div> tail</section></main>`,
    );
  });

  test("shape C: a long list splits between items", () => {
    const items = Array.from({ length: 200 }, (_, index) => `<li>item ${index}</li>`).join("");
    expectSameAsOneConversion(`<main><ul>${items}</ul></main>`);
    expectSameAsOneConversion(`<ul>${items}</ul><p>after</p>`);
    // Items with nested lists and unclosed items keep their content.
    const nested = Array.from(
      { length: 80 },
      (_, index) => `<li>parent ${index}<ul><li>child a</li><li>child b</li></ul></li>`,
    ).join("");
    expectSameAsOneConversion(`<ul>${nested}</ul>`);
    expectSameAsOneConversion(`<ul>${"<li>open item ".repeat(90)}</ul>`);
  });

  test("keeps <ol> numbering continuous across groups and honors start", () => {
    const items = Array.from({ length: 200 }, (_, index) => `<li>step ${index}</li>`).join("");
    for (const open of ["<ol>", '<ol start="7">', '<ol start="0">', "<ol reversed>"]) {
      const html = `${open}${items}</ol>`;
      expectSameAsOneConversion(html);
    }
    const markdown = convertHtmlInChunks(`<ol start="10">${items}</ol>`, turndown, NO_TEXT, SMALL);
    expect(markdown).toContain("10.  step 0");
    expect(markdown).toContain("209.  step 199");
  });

  test("never splits inline runs or leaves an orphan list item", () => {
    const inline = Array.from({ length: 200 }, (_, index) => `<b>${index}</b> `).join("");
    expectSameAsOneConversion(inline);
    expectSameAsOneConversion(`<p>start</p>${inline}<p>end</p>`);
    const mixed = `${blocks(40)} loose text <span>inline</span> ${blocks(40)}`;
    expectSameAsOneConversion(mixed);
    const output = convertHtmlInChunks(
      `<ul>${Array.from({ length: 99 }, (_, index) => `<li>x${index}</li>`).join("")}</ul>`,
      turndown,
      NO_TEXT,
      SMALL,
    );
    expect(output.split("\n").every((line) => /^-\s+x\d+$/.test(line))).toBe(true);
  });

  test("converts small and malformed input directly", () => {
    for (const html of ["", "plain", "<p>one<p>two", "<div><p>unclosed", "</div><p>stray</p>"]) {
      expectSameAsOneConversion(html);
      expectSameAsOneConversion(html, { ...SMALL, directBytes: 0 });
    }
  });

  test("falls back to plain text for a piece too large to split", () => {
    const rows = Array.from({ length: 200 }, (_, index) => `<tr><td>cell ${index}</td></tr>`).join(
      "",
    );
    const output = convertHtmlInChunks(
      `<p>before</p><table>${rows}</table><p>after</p>`,
      turndown,
      (html) => `PLAIN(${html.length})`,
      { ...SMALL, atomicBytes: 1000 },
    );
    expect(output).toMatch(/^before\n\nPLAIN\(\d+\)\n\nafter$/);
  });
});
