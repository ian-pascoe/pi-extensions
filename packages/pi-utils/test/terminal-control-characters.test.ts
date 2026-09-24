import { expect, test } from "vitest";
import { stripControlCharacters } from "../src/terminal-control-characters.js";

test("normalizes line breaks and removes C0/C1 controls except tabs and newlines", () => {
  expect(stripControlCharacters("a\r\nb\rc\td\u0000e\u0007f\u001bg\u007fh\u009bi\n")).toBe(
    "a\nb\nc\tdefghi\n",
  );
});
