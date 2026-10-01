import { VimEngine } from "../src/vim/engine.js";
import { clampNormalCursor, nextCol } from "../src/vim/text.js";
import type { TextModel, VimEffect, VimKey, VimMode } from "../src/vim/types.js";

/** Split `"d2w<Esc>"` into Vim key tokens. */
export function parseKeys(input: string): VimKey[] {
  const keys: VimKey[] = [];
  const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(input)];
  for (let index = 0; index < segments.length; index++) {
    const char = segments[index]?.segment ?? "";
    if (char === "<") {
      const close = input.indexOf(">", segments[index]?.index ?? 0);
      const name = close === -1 ? "" : input.slice(segments[index]?.index ?? 0, close + 1);
      if (/^<[A-Za-z][A-Za-z-]*>$/u.test(name)) {
        keys.push(name);
        while ((segments[index]?.index ?? 0) < close) index += 1;
        continue;
      }
    }
    keys.push(char);
  }
  return keys;
}

/** Parse text with a `|` cursor marker. */
export function parseModel(source: string): TextModel {
  const offset = source.indexOf("|");
  const text = source.replace("|", "");
  const before = text.slice(0, offset).split("\n");
  return {
    lines: text.split("\n"),
    cursor: { line: before.length - 1, col: (before.at(-1) ?? "").length },
  };
}

export function formatModel(model: TextModel): string {
  return model.lines
    .map((line, index) =>
      index === model.cursor.line
        ? `${line.slice(0, model.cursor.col)}|${line.slice(model.cursor.col)}`
        : line,
    )
    .join("\n");
}

/**
 * A minimal host editor: insert-mode typing, one undo snapshot per Vim change, insert sessions
 * collapsed into one step, and a Vim-owned redo stack — the same contract as the Pi adapter.
 */
export class VimHarness {
  readonly engine: VimEngine;
  model: TextModel;
  readonly effects: VimEffect[] = [];
  readonly commands = new Set<string>(["tree", "model"]);
  /** Ids of Pi paste markers in the text, which edit as one character each. */
  pastes: ReadonlySet<number> = new Set();
  private undoStack: TextModel[] = [];
  private redoStack: TextModel[] = [];
  private sessionFloor = 0;

  constructor(source: string, mode: "normal" | "insert" = "normal") {
    this.engine = new VimEngine({ isPiCommand: (name) => this.commands.has(name) });
    const model = parseModel(source);
    if (mode === "insert") {
      this.model = model;
      this.engine.resetToInsert(model);
      return;
    }
    const line = model.lines[model.cursor.line] ?? "";
    this.model = {
      lines: model.lines,
      cursor: { ...model.cursor, col: nextCol(line, model.cursor.col) },
    };
    this.engine.resetToInsert(this.model);
    this.press("<Esc>");
    this.effects.length = 0;
  }

  get text(): string {
    return formatModel(this.model);
  }

  get mode(): VimMode {
    return this.engine.mode;
  }

  type(input: string): this {
    for (const key of parseKeys(input)) this.press(key);
    return this;
  }

  press(key: VimKey): void {
    const before = this.engine.mode;
    const inSession = (mode: VimMode) => mode === "insert" || mode === "replace";
    const depth = this.undoStack.length;
    const result = this.engine.handleKey(key, this.model, this.pastes);
    if (!result.handled) {
      this.hostInsert(key);
      return;
    }
    if (result.textChanged) {
      this.undoStack.push(this.model);
      this.redoStack = [];
    }
    this.model = result.model;
    for (const effect of result.effects) this.apply(effect);
    const after = this.engine.mode;
    if (!inSession(before) && inSession(after)) this.sessionFloor = depth;
    if (inSession(before) && !inSession(after)) {
      if (this.undoStack.length > this.sessionFloor + 1)
        this.undoStack.length = this.sessionFloor + 1;
    }
  }

  private hostInsert(key: VimKey): void {
    if (key.length > 1 && key.startsWith("<") && key !== "<BS>" && key !== "<CR>") return;
    const { lines, cursor } = this.model;
    const line = lines[cursor.line] ?? "";
    this.undoStack.push(this.model);
    this.redoStack = [];
    if (key === "<BS>") {
      if (cursor.col === 0) return;
      const updated = line.slice(0, cursor.col - 1) + line.slice(cursor.col);
      this.model = {
        lines: lines.map((text, index) => (index === cursor.line ? updated : text)),
        cursor: { line: cursor.line, col: cursor.col - 1 },
      };
      return;
    }
    const insert = key === "<CR>" ? "\n" : key;
    const text = lines.join("\n");
    let offset = cursor.col;
    for (let index = 0; index < cursor.line; index++) offset += (lines[index] ?? "").length + 1;
    const next = `${text.slice(0, offset)}${insert}${text.slice(offset)}`;
    const nextLines = next.split("\n");
    const before = next.slice(0, offset + insert.length).split("\n");
    this.model = {
      lines: nextLines,
      cursor: { line: before.length - 1, col: (before.at(-1) ?? "").length },
    };
  }

  private apply(effect: VimEffect): void {
    this.effects.push(effect);
    if (effect.kind === "undo") {
      for (let index = 0; index < effect.count; index++) {
        const snapshot = this.undoStack.pop();
        if (!snapshot) break;
        this.redoStack.push(this.model);
        this.model = snapshot;
      }
    } else if (effect.kind === "redo") {
      for (let index = 0; index < effect.count; index++) {
        const snapshot = this.redoStack.pop();
        if (!snapshot) break;
        this.undoStack.push(this.model);
        this.model = snapshot;
      }
    }
    if (effect.kind === "undo" || effect.kind === "redo") {
      this.model = { lines: this.model.lines, cursor: clampNormalCursor(this.model) };
    }
  }
}

/** Run keys from a starting text and return the formatted result. */
export function vim(source: string, keys: string): string {
  return new VimHarness(source).type(keys).text;
}
