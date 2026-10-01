import { describe, expect, it } from "vitest";
import { paintHighlights, paintRow } from "../src/vim/row-paint.js";
import { VimHarness, parseKeys, vim } from "./vim-harness.js";

describe("key parsing helper", () => {
  it("splits named keys and graphemes", () => {
    expect(parseKeys("d2w<Esc>a<CR>é")).toEqual(["d", "2", "w", "<Esc>", "a", "<CR>", "é"]);
    expect(parseKeys("f<")).toEqual(["f", "<"]);
  });
});

describe("motions", () => {
  it.each([
    ["hello |world", "h", "hello| world"],
    ["|hello", "3l", "hel|lo"],
    ["|hello", "9l", "hell|o"],
    ["  hel|lo", "0", "|  hello"],
    ["  hel|lo", "^", "  |hello"],
    ["|hello", "$", "hell|o"],
    ["|one two three", "w", "one |two three"],
    ["|one two three", "2w", "one two |three"],
    ["|foo.bar baz", "w", "foo|.bar baz"],
    ["|foo.bar baz", "W", "foo.bar |baz"],
    ["one two |three", "b", "one |two three"],
    ["one two |three", "2b", "|one two three"],
    ["foo.bar |baz", "B", "|foo.bar baz"],
    ["|one two", "e", "on|e two"],
    ["on|e two", "e", "one tw|o"],
    ["|foo.bar baz", "E", "foo.ba|r baz"],
    ["one tw|o", "ge", "on|e two"],
    ["foo.bar b|az", "gE", "foo.ba|r baz"],
    ["|one\ntwo", "w", "one\n|two"],
    ["on|e\n\ntwo", "w", "one\n|\ntwo"],
    ["one\n\n|two", "b", "one\n|\ntwo"],
    ["|a\nb\nc", "G", "a\nb\n|c"],
    ["a\nb\n|c", "gg", "|a\nb\nc"],
    ["|a\nb\nc", "2G", "a\n|b\nc"],
    ["a\nb\n|c", "2gg", "a\n|b\nc"],
    ["|a\nb\n\nc", "}", "a\nb\n|\nc"],
    ["a\nb\n\n|c", "{", "a\nb\n|\nc"],
    ["|a\nb", "}", "a\n|b"],
    ["|(a [b] c)", "%", "(a [b] c|)"],
    ["(a [b] c|)", "%", "|(a [b] c)"],
    ["x |= f(a)", "%", "x = f(a|)"],
    ["|a,b,c", "f,", "a|,b,c"],
    ["|a,b,c", "2f,", "a,b|,c"],
    ["|a,b,c", "t,", "|a,b,c"],
    ["|ab,c", "t,", "a|b,c"],
    ["a,b,|c", "F,", "a,b|,c"],
    ["a,b,|c", "T,", "a,b,|c"],
    ["a,bc,|d", "T,", "a,bc,|d"],
    ["|a,b,c,d", "f,;", "a,b|,c,d"],
    ["|a,b,c,d", "f,;,", "a|,b,c,d"],
    ["|a.b.c.d", "t.;", "a.|b.c.d"],
  ])("%j %s -> %j", (source, keys, expected) => {
    expect(vim(source, keys)).toBe(expected);
  });

  it("keeps the preferred column across short lines", () => {
    expect(vim("hello wo|rld\nab\nhello world", "j")).toBe("hello world\na|b\nhello world");
    expect(vim("hello wo|rld\nab\nhello world", "jj")).toBe("hello world\nab\nhello wo|rld");
    expect(vim("hel|lo\nab\nhello world", "$jj")).toBe("hello\nab\nhello worl|d");
  });

  it("steps through prompt history on the first and last lines", () => {
    const harness = new VimHarness("a|bc\ndef");
    harness.type("k");
    expect(harness.effects).toEqual([{ kind: "history", direction: -1, count: 1 }]);
    harness.type("j3j");
    expect(harness.effects.at(-1)).toEqual({ kind: "history", direction: 1, count: 3 });
    expect(harness.text).toBe("abc\nd|ef");
  });

  it("searches forward and backward with wrap-around", () => {
    expect(vim("|foo bar foo bar", "/bar<CR>")).toBe("foo |bar foo bar");
    expect(vim("|foo bar foo bar", "/bar<CR>n")).toBe("foo bar foo |bar");
    expect(vim("|foo bar foo bar", "/bar<CR>nn")).toBe("foo |bar foo bar");
    expect(vim("|foo bar foo bar", "/bar<CR>N")).toBe("foo bar foo |bar");
    expect(vim("foo bar |foo bar", "?foo<CR>")).toBe("|foo bar foo bar");
    expect(vim("|foo\nbar\nfoo", "/foo<CR>")).toBe("foo\nbar\n|foo");
    expect(vim("|ab ab", "/ab<CR>/<CR>")).toBe("|ab ab");
  });

  it("reports a missing pattern", () => {
    const harness = new VimHarness("|abc").type("/zz<CR>");
    expect(harness.effects).toContainEqual({
      kind: "notify",
      message: "Pattern not found: zz",
      level: "info",
    });
    expect(harness.mode).toBe("normal");
  });

  it("searches the word under the cursor with * and #", () => {
    expect(vim("|foo foobar foo", "*")).toBe("foo foobar |foo");
    expect(vim("foo foobar |foo", "#")).toBe("|foo foobar foo");
    expect(vim("|foo foobar foo", "*n")).toBe("|foo foobar foo");
  });

  it("caps counts at 9999", () => {
    expect(vim("|abc", "99999l")).toBe("ab|c");
  });
});

describe("operators", () => {
  it.each([
    ["|one two three", "dw", "|two three"],
    ["|one two three", "d2w", "|three"],
    ["|one two three", "2dw", "|three"],
    ["|one two three four", "2d2w", "|"],
    ["one |two", "dw", "one| "],
    ["one tw|o\nthree", "dw", "one t|w\nthree"],
    ["|one two", "de", "| two"],
    ["one |two", "db", "|two"],
    ["one |two three", "d$", "one| "],
    ["one |two three", "D", "one| "],
    ["one two |three", "d0", "|three"],
    ["  one |two", "d^", "  |two"],
    ["a\n|b\nc", "dd", "a\n|c"],
    ["a\nb\n|c", "dd", "a\n|b"],
    ["|a\nb\nc", "2dd", "|c"],
    ["|a\nb\nc", "dj", "|c"],
    ["a\nb\n|c", "dk", "|a"],
    ["a\n|b\nc", "dG", "|a"],
    ["a\n|b\nc", "dgg", "|c"],
    ["|only", "dd", "|"],
    ["|a,b,c", "df,", "|b,c"],
    ["|a,b,c", "dt,", "|,b,c"],
    ["a,b,|c", "dF,", "a,b|c"],
    ["x (a b|) y", "d%", "x | y"],
    ["|para one\npara two\n\nnext", "d}", "|\nnext"],
    ["first\n  |para one\npara two\n\nnext", "d}", "first\n|\nnext"],
    ["one |two three", "d/thr<CR>", "one |three"],
    ["one two |three", "d?two<CR>", "one |three"],
  ])("%j %s -> %j", (source, keys, expected) => {
    expect(vim(source, keys)).toBe(expected);
  });

  it.each([
    ["|one two", "cwX<Esc>", "|X two"],
    ["on|e two", "cwX<Esc>", "on|X two"],
    ["|one two", "cWX<Esc>", "|X two"],
    ["|one  two", "c2wX<Esc>", "|X"],
    ["one| two", "cwX<Esc>", "one|Xtwo"],
    ["a\n|b c\nd", "ccX<Esc>", "a\n|X\nd"],
    ["a\n|b c\nd", "SX<Esc>", "a\n|X\nd"],
    ["one |two", "CX<Esc>", "one |X"],
    ["|abc", "sX<Esc>", "|Xbc"],
    ["|abc", "3sX<Esc>", "|X"],
    ["|", "sX<Esc>", "|X"],
  ])("%j %s -> %j", (source, keys, expected) => {
    expect(vim(source, keys)).toBe(expected);
  });

  it("yanks and puts charwise and linewise text", () => {
    expect(vim("|one two", "ywP")).toBe("one| one two");
    expect(vim("|one two", "yw$p")).toBe("one twoone| ");
    expect(vim("|a\nb", "yyp")).toBe("a\n|a\nb");
    expect(vim("|a\nb", "yyP")).toBe("|a\na\nb");
    expect(vim("|a\nb", "Yjp")).toBe("a\nb\n|a");
    expect(vim("|a\nb", "y2jGp")).toBe("a\nb\n|a\nb");
    expect(vim("|ab", "yl3p")).toBe("aaa|ab");
    expect(vim("|a\nb", "yy2p")).toBe("a\n|a\na\nb");
    expect(vim("a\n|b", "yk")).toBe("|a\nb");
    expect(vim("one |two", "yiw0")).toBe("|one two");
    expect(vim("one |two", "yiwP")).toBe("one tw|otwo");
  });

  it("asks the host to copy yanks but not deletes or changes", () => {
    const yanks = (source: string, keys: string) =>
      new VimHarness(source).type(keys).effects.filter((effect) => effect.kind === "yank");
    expect(yanks("one |two", "yiw")).toEqual([{ kind: "yank", text: "two" }]);
    expect(yanks("|a\nb", "yj")).toEqual([{ kind: "yank", text: "a\nb\n" }]);
    expect(yanks("|abc", "vly")).toEqual([{ kind: "yank", text: "ab" }]);
    expect(yanks("|abc", "VY")).toEqual([{ kind: "yank", text: "abc\n" }]);
    expect(yanks("|abc def", "dwxcwX<Esc>")).toEqual([]);
    expect(yanks("|abc", "yt;")).toEqual([]);
  });

  it("puts text ending in a newline linewise", () => {
    expect(vim("|one\ntwo", "v$yjp")).toBe("one\ntwo\n|one");
  });

  it("deletes into the register for put", () => {
    expect(vim("|one two", "dwp")).toBe("tone| wo");
    expect(vim("|a\nb\nc", "ddp")).toBe("b\n|a\nc");
    expect(vim("|ab", "xp")).toBe("b|a");
  });

  it("changes case", () => {
    expect(vim("|hello world", "gUw")).toBe("|HELLO world");
    expect(vim("|HELLO world", "guiw")).toBe("|hello world");
    expect(vim("|Hello World", "g~~")).toBe("|hELLO wORLD");
    expect(vim("|hello\nworld", "gUj")).toBe("|HELLO\nWORLD");
    expect(vim("|ab\ncd", "gUU")).toBe("|AB\ncd");
    expect(vim("|ab\ncd", "gugu")).toBe("|ab\ncd");
    expect(vim("|abc", "~")).toBe("A|bc");
    expect(vim("|abc", "5~")).toBe("AB|C");
  });
});

describe("text objects", () => {
  it.each([
    ["one t|wo three", "diw", "one | three"],
    ["one t|wo three", "daw", "one |three"],
    ["one two t|hree", "daw", "one tw|o"],
    ["one t|wo three", "d2aw", "on|e"],
    ["one t|wo three", "d3iw", "one| "],
    ["a foo.b|ar b", "diW", "a | b"],
    ["a foo.b|ar b", "daW", "a |b"],
    ['say "he|llo" now', 'di"', 'say "|" now'],
    ['say "he|llo" now', 'da"', "say |now"],
    ['|say "hello" now', 'di"', 'say "|" now'],
    ["x 'a|b' ok", "di'", "x '|' ok"],
    ["run `l|s` now", "di`", "run `|` now"],
    ['x "a\\"|b" y', 'di"', 'x "|" y'],
    ["f(a, (b|), c)", "di(", "f(a, (|), c)"],
    ["f(a, (b|), c)", "d2i(", "f(|)"],
    ["f(a, (b|), c)", "da(", "f(a, |, c)"],
    ["f(a, (b|), c)", "dib", "f(a, (|), c)"],
    ["x [1, |2] y", "di[", "x [|] y"],
    ["x [1, |2] y", "da]", "x | y"],
    ["x {a|} y", "diB", "x {|} y"],
    ["x <a|b> y", "di<", "x <|> y"],
    ["if (x) {\n  fo|o\n  bar\n}", "di{", "if (x) {\n|}"],
    ["if (x) {\n  fo|o\n}", "da{", "if (x)| "],
    ["a\n|b\nc\n\nd", "dip", "|\nd"],
    ["a\n|b\nc\n\nd", "dap", "|d"],
    ["a\n\nb\n|c", "dap", "|a"],
  ])("%j %s -> %j", (source, keys, expected) => {
    expect(vim(source, keys)).toBe(expected);
  });

  it("changes inside an empty pair by entering insert", () => {
    expect(vim('say "|" now', 'ci"X<Esc>')).toBe('say "|X" now');
    expect(vim("f(|)", "ci(X<Esc>")).toBe("f(|X)");
  });

  it("aborts a change whose motion or text object fails", () => {
    for (const keys of ["ct;", "c/zz<CR>", "ci(", 'ci"', "cfq"]) {
      const harness = new VimHarness("ab|c d").type(keys);
      expect(harness.mode).toBe("normal");
      expect(harness.text).toBe("ab|c d");
    }
  });

  it("ignores missing text objects", () => {
    expect(vim("no |quotes", 'di"')).toBe("no |quotes");
    expect(vim("no |parens", "di(")).toBe("no |parens");
  });
});

describe("single-key edits", () => {
  it.each([
    ["|abc", "x", "|bc"],
    ["|abc", "2x", "|c"],
    ["ab|c", "x", "a|b"],
    ["|", "x", "|"],
    ["ab|c", "X", "a|c"],
    ["abc|d", "9X", "|d"],
    ["|abc", "rx", "|xbc"],
    ["|abc", "3rx", "xx|x"],
    ["|abc", "4rx", "|abc"],
    ["a|bc", "r<CR>", "a\n|c"],
    ["|a\nb\nc", "J", "a| b\nc"],
    ["|a\nb\nc", "3J", "a b| c"],
    ["|a\n   b", "J", "a| b"],
    ["|a \nb", "J", "a |b"],
    ["|a\n)b", "J", "a|)b"],
    ["|a\n  b", "gJ", "a|  b"],
    ["|a", "J", "|a"],
  ])("%j %s -> %j", (source, keys, expected) => {
    expect(vim(source, keys)).toBe(expected);
  });

  it("enters insert at the right places", () => {
    expect(vim("a|bc", "iX<Esc>")).toBe("a|Xbc");
    expect(vim("a|bc", "aX<Esc>")).toBe("ab|Xc");
    expect(vim("  a|bc", "IX<Esc>")).toBe("  |Xabc");
    expect(vim("a|bc", "AX<Esc>")).toBe("abc|X");
    expect(vim("a|bc\nd", "oX<Esc>")).toBe("abc\n|X\nd");
    expect(vim("a|bc\nd", "OX<Esc>")).toBe("|X\nabc\nd");
    expect(vim("a|bc", "aX<Esc>0giY<Esc>")).toBe("abX|Yc");
  });

  it("repeats counted inserts", () => {
    expect(vim("|", "3ihi<Esc>")).toBe("hihih|i");
    expect(vim("|a", "2ox<Esc>")).toBe("a\nx\n|x");
    expect(vim("|a", "3A!<Esc>")).toBe("a!!|!");
  });

  it("replaces in replace mode and restores with backspace", () => {
    const harness = new VimHarness("|abcd").type("Rxy");
    expect(harness.mode).toBe("replace");
    expect(harness.text).toBe("xy|cd");
    harness.type("<BS>");
    expect(harness.text).toBe("x|bcd");
    harness.type("zzzz<Esc>");
    expect(harness.text).toBe("xzzz|z");
    expect(harness.engine.modeLabel()).toBe("NORMAL");
  });
});

describe("visual mode", () => {
  it.each([
    ["|one two", "vlld", "| two"],
    ["one |two", "vbd", "|wo"],
    ["|one two", "vex", "| two"],
    ["|ab\ncd\nef", "Vjd", "|ef"],
    ["|ab\ncd", "vjd", "|d"],
    ["a|b\ncd", "vD", "|cd"],
    ["a|b\ncd", "vX", "|cd"],
    ["|one two", "veyP", "on|eone two"],
    ["|one two", "vecX<Esc>", "|X two"],
    ["|one two", "vesX<Esc>", "|X two"],
    ["a|b\ncd", "vCX<Esc>", "|X\ncd"],
    ["a|b\ncd", "vSX<Esc>", "|X\ncd"],
    ["|one two", "ve~", "|ONE two"],
    ["|ONE two", "veu", "|one two"],
    ["|one two", "veU", "|ONE two"],
    ["|a\nb\nc", "VjJ", "a| b\nc"],
    ["|abc d", "vlrx", "|xxc d"],
    ["one t|wo three", "viwd", "one | three"],
    ["say (a |b) x", "va(d", "say | x"],
    ["a\n|b\nc\n\nd", "vipd", "|\nd"],
    ["|one two", "vlohd", "|e two"],
    ["|one two", "vVd", "|"],
    ["|one\ntwo", "Vvd", "|ne\ntwo"],
  ])("%j %s -> %j", (source, keys, expected) => {
    expect(vim(source, keys)).toBe(expected);
  });

  it("puts over a selection and keeps the replaced text", () => {
    expect(vim("|one two", "yiwwviwp")).toBe("one on|e");
    expect(vim("|one two", "yiwwviwp0P")).toBe("tw|oone one");
    expect(vim("|a\nb", "yyjVp")).toBe("a\n|a");
  });

  it("yanks a selection and returns the cursor to its start", () => {
    expect(vim("one |two", "vey$p")).toBe("one twotw|o");
    expect(vim("one tw|o", "vby")).toBe("one |two");
  });

  it("reselects the last selection with gv", () => {
    const harness = new VimHarness("|one two").type("vl<Esc>$gv");
    expect(harness.mode).toBe("visual");
    expect(harness.engine.highlights(harness.model)).toEqual([{ line: 0, from: 0, to: 2 }]);
  });

  it("highlights selections across lines", () => {
    const harness = new VimHarness("a|bc\n\ndef").type("vjj");
    expect(harness.engine.highlights(harness.model)).toEqual([
      { line: 0, from: 1, to: 4 },
      { line: 1, from: 0, to: 1 },
      { line: 2, from: 0, to: 2 },
    ]);
    harness.type("V");
    expect(harness.engine.highlights(harness.model)).toEqual([
      { line: 0, from: 0, to: 3 },
      { line: 1, from: 0, to: 1 },
      { line: 2, from: 0, to: 3 },
    ]);
  });

  it("returns to normal with Escape", () => {
    const harness = new VimHarness("|abc").type("vl<Esc>");
    expect(harness.mode).toBe("normal");
    expect(harness.effects).toEqual([]);
  });
});

describe("dot repeat", () => {
  it.each([
    ["|a b c d", "dw.", "|c d"],
    ["|a b c d", "dw2.", "|d"],
    ["|abcdef", "x..", "|def"],
    ["|abcdef", "2x.", "|ef"],
    ["|one two three", "cwX<Esc>w.", "X |X three"],
    ["|ab\ncd", "ihi<Esc>j.", "hiab\nch|id"],
    ["|a\nb\nc", "dd.", "|c"],
    ["|ab", "A!<Esc>.", "ab!|!"],
    ["|abc", "3ix<Esc>.", "xxxx|xxabc"],
    ["|abc", "ix<Esc>3.", "xx|xxabc"],
    ["|a.b.c", "rx2l.", "x.|x.c"],
    ["|abcd", "~.", "AB|cd"],
    ["|one two three", "vecX<Esc>w.", "X |X three"],
    ["|abcdef", "vld.", "|ef"],
    ["|a\nb\nc\nd", "Vjd.", "|"],
    ["|one two one two", "d/two<CR>.", "|two"],
    ["|abcd", "Rxy<Esc>l.", "xyx|y"],
    ["|a\nb", "yyp.", "a\na\n|a\nb"],
    ["|ab", "J", "|ab"],
  ])("%j %s -> %j", (source, keys, expected) => {
    expect(vim(source, keys)).toBe(expected);
  });

  it("repeats typing from the implicit insert session", () => {
    const harness = new VimHarness("|", "insert").type("hi<Esc>.");
    expect(harness.text).toBe("hh|ii");
  });

  it("repeats an insert session that used backspace", () => {
    expect(vim("|abc\nabc", "Axy<BS>z<Esc>j0.")).toBe("abcxz\nabcx|z");
    expect(vim("|abc\nabc", "A<BS>z<Esc>j0.")).toBe("abz\nab|z");
  });

  it("does not record motions or yanks", () => {
    expect(vim("|a b c", "xwyw.")).toBe(" | c");
  });
});

describe("undo and redo", () => {
  it("undoes one change at a time", () => {
    expect(vim("|a b c", "dwdwu")).toBe("|b c");
    expect(vim("|a b c", "dwdw2u")).toBe("|a b c");
    expect(vim("|a b c", "dwdw2u<C-r>")).toBe("|b c");
    expect(vim("|a b c", "dwdw2u9<C-r>")).toBe("|c");
  });

  it("undoes a whole insert session at once", () => {
    expect(vim("|x", "ione two<CR>three<Esc>u")).toBe("|x");
    expect(vim("|one two", "cwa b c<Esc>u")).toBe("|one two");
  });

  it("undoes a whole replace session at once", () => {
    expect(vim("|abcd", "Rxyz<Esc>u")).toBe("|abcd");
  });

  it("clears redo after a new change", () => {
    expect(vim("|a b c", "dwux<C-r>")).toBe("| b c");
  });
});

describe("ex line", () => {
  const run = (source: string, keys: string) => {
    const harness = new VimHarness(source).type(keys);
    return harness.effects;
  };

  it("quits only with an empty prompt unless forced", () => {
    expect(run("|", ":q<CR>")).toEqual([{ kind: "quit" }]);
    expect(run("|  ", ":quitall<CR>")).toEqual([{ kind: "quit" }]);
    expect(run("|draft", ":qa!<CR>")).toEqual([{ kind: "quit" }]);
    expect(run("|draft", ":q<CR>")).toEqual([
      {
        kind: "notify",
        message: "The prompt has unsent text; use :q! to quit anyway.",
        level: "warning",
      },
    ]);
  });

  it("dispatches shell and Pi commands", () => {
    expect(run("|", ":!ls -la<CR>")).toEqual([{ kind: "dispatch", text: "!ls -la" }]);
    expect(run("|", ":!!git status<CR>")).toEqual([{ kind: "dispatch", text: "!!git status" }]);
    expect(run("|", ":tree<CR>")).toEqual([{ kind: "dispatch", text: "/tree" }]);
    expect(run("|", ":model   opus 4<CR>")).toEqual([{ kind: "dispatch", text: "/model opus 4" }]);
  });

  it("reports unsupported commands", () => {
    expect(run("|", ":wq<CR>")).toEqual([
      { kind: "notify", message: "Unsupported ex command: wq", level: "warning" },
    ]);
    expect(run("|", ":!<CR>")).toEqual([
      { kind: "notify", message: "Unsupported ex command: !", level: "warning" },
    ]);
  });

  it("edits the ex line and shows it in the label", () => {
    const harness = new VimHarness("|").type(":wqx<BS>");
    expect(harness.engine.modeLabel()).toBe("EX :wq_");
    harness.type("<BS><BS>");
    expect(harness.engine.modeLabel()).toBe("EX :_");
    harness.type("<BS>");
    expect(harness.mode).toBe("normal");
    harness.type(":abc<C-u>q<Esc>");
    expect(harness.mode).toBe("normal");
    expect(harness.effects).toEqual([]);
  });
});

describe("mode label and escape", () => {
  it("shows pending keys", () => {
    const harness = new VimHarness("|abc");
    expect(harness.engine.modeLabel()).toBe("NORMAL");
    harness.type("2d");
    expect(harness.engine.modeLabel()).toBe("NORMAL 2d");
    harness.type("<Esc>g");
    expect(harness.engine.modeLabel()).toBe("NORMAL g");
    harness.type("<Esc>r");
    expect(harness.engine.modeLabel()).toBe("NORMAL r");
    harness.type("<Esc>v");
    expect(harness.engine.modeLabel()).toBe("VISUAL");
    harness.type("V");
    expect(harness.engine.modeLabel()).toBe("V-LINE");
    harness.type("<Esc>/fo");
    expect(harness.engine.modeLabel()).toBe("SEARCH /fo_");
    harness.type("<Esc>R");
    expect(harness.engine.modeLabel()).toBe("REPLACE");
    harness.type("<Esc>i");
    expect(harness.engine.modeLabel()).toBe("INSERT");
  });

  it("cancels pending keys with Escape and leaves interrupting to the host", () => {
    const harness = new VimHarness("|abc").type("d<Esc>");
    expect(harness.engine.modeLabel()).toBe("NORMAL");
    harness.type("<Esc>x");
    expect(harness.effects).toEqual([]);
    expect(harness.text).toBe("|bc");
  });

  it("highlights incremental search matches", () => {
    const harness = new VimHarness("|foo bar foo").type("/foo");
    expect(harness.engine.highlights(harness.model)).toEqual([
      { line: 0, from: 0, to: 3 },
      { line: 0, from: 8, to: 11 },
    ]);
  });

  it("moves the cursor back on Escape from insert", () => {
    expect(vim("ab|c", "i<Esc>")).toBe("a|bc");
    expect(vim("|abc", "i<Esc>")).toBe("|abc");
  });
});

describe("paste markers", () => {
  const MARKER = "[paste #1 +12 lines]";
  const withMarker = (source: string, keys: string) => {
    const harness = new VimHarness(source);
    harness.pastes = new Set([1]);
    return harness.type(keys).text;
  };

  it("steps over and deletes a marker as one character", () => {
    expect(withMarker(`|x${MARKER}y`, "l")).toBe(`x|${MARKER}y`);
    expect(withMarker(`|x${MARKER}y`, "ll")).toBe(`x${MARKER}|y`);
    expect(withMarker(`|x${MARKER}y`, "lx")).toBe("x|y");
    expect(withMarker(`|x${MARKER}y`, "$X")).toBe("x|y");
    expect(withMarker(`|a ${MARKER} b`, "wdw")).toBe("a |b");
  });

  it("never splits a marker with ranges or case changes", () => {
    expect(withMarker(`|x${MARKER}y`, "ldi[")).toBe("x|y");
    expect(withMarker(`|x${MARKER}y`, "lvd")).toBe("x|y");
    expect(withMarker(`|x${MARKER}y`, "gUU")).toBe(`|X${MARKER}Y`);
    expect(withMarker(`|x${MARKER}y`, "f+")).toBe(`|x${MARKER}y`);
  });

  it("treats unknown ids as plain text", () => {
    expect(vim(`|x${MARKER}`, "lx")).toBe("x|paste #1 +12 lines]");
  });
});

describe("visual deletes", () => {
  it("keeps a charwise selection charwise", () => {
    expect(vim("|ab\ncd", "vj$d")).toBe("|");
    expect(vim("|ab\ncd", "vj$dp")).toBe("|ab\ncd");
  });
});

describe("unicode", () => {
  it("moves and deletes by grapheme", () => {
    expect(vim("|é👍🏽x", "l")).toBe("é|👍🏽x");
    expect(vim("|é👍🏽x", "llx")).toBe("é|👍🏽");
    expect(vim("é|👍🏽x", "x")).toBe("é|x");
  });
});

describe("row painting", () => {
  it("never cancels the software cursor that follows a highlight", () => {
    const cursor = "\x1b[7mc\x1b[0m";
    expect(paintRow(`ab${cursor}d`, [{ from: 0, to: 2 }])).toBe(`\x1b[7mab${cursor}d`);
    expect(paintRow(`ab${cursor}d`, [{ from: 1, to: 4 }])).toBe(
      `a\x1b[7mb${cursor}\x1b[7md\x1b[27m`,
    );
  });

  it("paints a wrapped line's rows only up to each row's text", () => {
    const rendered = ["top", "aaaa bbbb  ", "cccc dddd  ", "bottom"];
    paintHighlights(
      rendered,
      {
        rows: [
          { line: 0, startCol: 0, length: 10 },
          { line: 0, startCol: 10, length: 9 },
        ],
        scrollOffset: 0,
        visibleCount: 2,
        paddingX: 0,
      },
      [{ line: 0, from: 0, to: 20 }],
    );
    expect(rendered[1]).toBe("\x1b[7maaaa bbbb \x1b[27m ");
    expect(rendered[2]).toBe("\x1b[7mcccc dddd \x1b[27m ");
  });
});
