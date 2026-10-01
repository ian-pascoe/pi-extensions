import { isNamedKey, parseCommand, type Command, type MotionSpec } from "./command.js";
import { resolveExCommand } from "./ex.js";
import {
  curswantOf,
  findChar,
  simpleMotion,
  wordEnd,
  type FindKey,
  type MotionContext,
  type MotionTarget,
} from "./motions.js";
import {
  applyOperator,
  insertCursor,
  joinLines,
  openLine,
  put,
  replaceChars,
  replaceRange,
  toggleCase,
  type EditOutcome,
  type Operator,
} from "./operators.js";
import { findMatch, matchHighlights, wordUnderCursor, type SearchPattern } from "./search.js";
import { applyInsertDiff, diffInsert, isEmptyDiff, type InsertDiff } from "./insert-diff.js";
import { selectTextObject } from "./text-objects.js";
import {
  measureSelection,
  putOverRange,
  selectionHighlights,
  selectionLike,
  selectionRange,
  type VisualSelection,
  type VisualSize,
} from "./visual.js";
import {
  charAt,
  clampInsertCursor,
  clampNormalCursor,
  comparePositions,
  firstNonBlankCol,
  fromOffset,
  isBlank,
  lineAt,
  nextCol,
  orderPositions,
  prevCol,
  snapRange,
  spliceText,
  toOffset,
  withPasteMarkers,
} from "./text.js";
import type {
  Highlight,
  KeyResult,
  Position,
  TextModel,
  TextRange,
  VimEffect,
  VimKey,
  VimMode,
} from "./types.js";

/** Host facts the engine needs but does not own. */
export interface VimEngineHost {
  isPiCommand(name: string): boolean;
}

/** The last change, replayable by `.`. */
interface ChangeRecord {
  keys: VimKey[];
  count: number | undefined;
  insert?: InsertDiff;
  visual?: VisualSize;
}

interface InsertSession {
  startLines: string[];
  startOffset: number;
  repeatCount: number;
  repeatPrefix: string;
  record: ChangeRecord;
  changedOnEntry: boolean;
}

/** One replace-mode keystroke, so Backspace can undo it. */
type ReplaceStep =
  | { kind: "overwrite"; original: string }
  | { kind: "append" }
  | { kind: "newline" };

interface ReplaceSession {
  steps: ReplaceStep[];
  record: ChangeRecord;
}

interface PendingOperator {
  operator: Operator;
  count: number | undefined;
  keys: VimKey[];
}

interface LineInput {
  kind: "ex" | "search";
  text: string;
  backward: boolean;
  returnMode: "normal" | "visual" | "visual-line";
  count: number | undefined;
  operator?: PendingOperator;
}

interface LastSearch {
  pattern: SearchPattern;
  backward: boolean;
}

const NO_PASTES: ReadonlySet<number> = new Set();

const isVisualMode = (mode: VimMode): mode is "visual" | "visual-line" =>
  mode === "visual" || mode === "visual-line";

function digitsOf(count: number | undefined): VimKey[] {
  return count === undefined ? [] : String(count).split("");
}

function reverseFind(key: FindKey): FindKey {
  if (key === "f") return "F";
  if (key === "F") return "f";
  return key === "t" ? "T" : "t";
}

function graphemes(text: string): VimKey[] {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map(
    (segment) => segment.segment,
  );
}

/**
 * A pure Vim state machine over a plain text model. The host feeds one key at a time with its
 * current model and applies the returned model and effects.
 */
export class VimEngine {
  private currentMode: VimMode = "insert";
  private pending: VimKey[] = [];
  private register = "";
  private lastFind: { key: FindKey; char: string } | undefined;
  private lastSearch: LastSearch | undefined;
  private lastChange: ChangeRecord | undefined;
  private lastVisual: VisualSelection | undefined;
  private lastInsert: Position | undefined;
  private visualAnchor: Position = { line: 0, col: 0 };
  private curswant = 0;
  private curswantCursor: Position | undefined;
  private insertSession: InsertSession | undefined;
  private replaceSession: ReplaceSession | undefined;
  private lineInput: LineInput | undefined;
  private replaying = false;

  private model: TextModel = { lines: [""], cursor: { line: 0, col: 0 } };
  private textChanged = false;
  private effects: VimEffect[] = [];

  constructor(private readonly host: VimEngineHost) {}

  get mode(): VimMode {
    return this.currentMode;
  }

  /** True while keys are pending or a transient mode (visual, ex, search, replace) is active. */
  hasPending(): boolean {
    return (
      this.pending.length > 0 || (this.currentMode !== "normal" && this.currentMode !== "insert")
    );
  }

  /** The plain Mode Rail label. */
  modeLabel(): string {
    const pending = this.pending.length > 0 ? ` ${this.pending.join("")}` : "";
    switch (this.currentMode) {
      case "insert":
        return "INSERT";
      case "replace":
        return "REPLACE";
      case "normal":
        return `NORMAL${pending}`;
      case "visual":
        return `VISUAL${pending}`;
      case "visual-line":
        return `V-LINE${pending}`;
      case "ex":
        return `EX :${this.lineInput?.text ?? ""}_`;
      case "search":
        return `SEARCH ${this.lineInput?.backward ? "?" : "/"}${this.lineInput?.text ?? ""}_`;
    }
  }

  /** Start a fresh implicit insert session, e.g. at startup, after submit, or after `setText`. */
  resetToInsert(model: TextModel): void {
    this.pending = [];
    this.lineInput = undefined;
    this.replaceSession = undefined;
    this.currentMode = "insert";
    this.beginInsert(model, { keys: ["i"], count: undefined }, 1, "", false);
  }

  /** Enter normal mode without a key, e.g. when a dispatch restores the draft. */
  resetToNormal(): void {
    this.pending = [];
    this.lineInput = undefined;
    this.replaceSession = undefined;
    this.insertSession = undefined;
    this.currentMode = "normal";
  }

  /**
   * Feed one key. `pastes` are the ids of Pi paste markers in the text, which edit as one
   * character each.
   */
  handleKey(key: VimKey, model: TextModel, pastes: ReadonlySet<number> = NO_PASTES): KeyResult {
    return this.run(model, pastes, () => this.feed(key));
  }

  /** Cancel pending keys and leave visual, ex, search, or replace mode, as before a host action. */
  cancel(model: TextModel, pastes: ReadonlySet<number> = NO_PASTES): KeyResult {
    return this.run(model, pastes, () => {
      this.pending = [];
      if (this.currentMode === "replace") this.finishReplace();
      else if (this.currentMode === "ex" || this.currentMode === "search") this.leaveLineInput();
      if (isVisualMode(this.currentMode)) this.exitVisual();
      return true;
    });
  }

  private run(model: TextModel, pastes: ReadonlySet<number>, body: () => boolean): KeyResult {
    this.model = model;
    this.textChanged = false;
    this.effects = [];
    const handled = withPasteMarkers(pastes, body);
    return { handled, model: this.model, textChanged: this.textChanged, effects: this.effects };
  }

  /** Append pasted text to the ex or search line. */
  appendLineInput(text: string): void {
    if (this.lineInput) this.lineInput.text += text;
  }

  /** Spans to highlight: the visual selection and incremental-search matches. */
  highlights(model: TextModel, pastes: ReadonlySet<number> = NO_PASTES): Highlight[] {
    return withPasteMarkers(pastes, () => this.currentHighlights(model));
  }

  private currentHighlights(model: TextModel): Highlight[] {
    if (isVisualMode(this.currentMode)) {
      return selectionHighlights(model, {
        anchor: this.visualAnchor,
        cursor: model.cursor,
        mode: this.currentMode,
      });
    }
    if (this.currentMode === "search" && this.lineInput?.text) {
      return matchHighlights(model, { text: this.lineInput.text, wholeWord: false });
    }
    return [];
  }

  private feed(key: VimKey): boolean {
    switch (this.currentMode) {
      case "insert":
        if (key !== "<Esc>") return false;
        this.finishInsert();
        return true;
      case "replace":
        this.replaceKey(key);
        return true;
      case "ex":
      case "search":
        this.lineKey(key);
        return true;
      case "normal":
      case "visual":
      case "visual-line":
        this.commandKey(key);
        return true;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Model helpers

  private setModel(model: TextModel, textChanged: boolean): void {
    this.model = model;
    if (textChanged) this.textChanged = true;
  }

  private setCursor(cursor: Position): void {
    this.model = { lines: this.model.lines, cursor };
  }

  private clampCursor(): void {
    if (this.currentMode === "insert") {
      this.setCursor(clampInsertCursor(this.model));
      return;
    }
    const cursor = clampNormalCursor(this.model);
    // Visual `$` selects through the line end, so the cursor may sit on it.
    if (isVisualMode(this.currentMode) && this.curswant === Number.POSITIVE_INFINITY) {
      cursor.col = lineAt(this.model, cursor.line).length;
    }
    this.setCursor(cursor);
  }

  private moveTo(target: MotionTarget): void {
    this.setCursor(target.pos);
    if (!target.keepCurswant) this.curswant = target.curswant ?? curswantOf(this.model, target.pos);
    this.clampCursor();
    this.curswantCursor = { ...this.model.cursor };
  }

  private rememberCurswant(value?: number): void {
    this.curswant = value ?? curswantOf(this.model, this.model.cursor);
    this.curswantCursor = { ...this.model.cursor };
  }

  private currentCurswant(): number {
    const cursor = this.model.cursor;
    if (!this.curswantCursor || comparePositions(this.curswantCursor, cursor) !== 0) {
      this.rememberCurswant();
    }
    return this.curswant;
  }

  private record(change: ChangeRecord): void {
    if (!this.replaying) this.lastChange = change;
  }

  // ---------------------------------------------------------------------------------------------
  // Normal and visual commands

  private commandKey(key: VimKey): void {
    if (key === "<Esc>") {
      if (this.pending.length > 0) this.pending = [];
      else if (isVisualMode(this.currentMode)) this.exitVisual();
      return;
    }
    if (key === "<CR>" && this.pending.length === 0) return;
    this.pending.push(key);
    const parsed = parseCommand(this.pending, isVisualMode(this.currentMode));
    if (parsed.status === "incomplete") return;
    this.pending = [];
    if (parsed.status === "invalid") return;
    if (isVisualMode(this.currentMode)) this.executeVisual(parsed.command, parsed.keys);
    else this.executeNormal(parsed.command, parsed.keys);
  }

  private motionContext(count: number | undefined, operator: boolean): MotionContext {
    return {
      model: this.model,
      cursor: this.model.cursor,
      count: count ?? 1,
      hasCount: count !== undefined,
      operator,
      curswant: this.currentCurswant(),
    };
  }

  /** Resolve a motion; `undefined` means it failed. Search motions are handled by the caller. */
  private resolveMotion(
    motion: MotionSpec,
    count: number | undefined,
    operator: boolean,
  ): MotionTarget | undefined {
    const context = this.motionContext(count, operator);
    switch (motion.kind) {
      case "simple": {
        const target = simpleMotion(motion.key, context);
        return target === false ? undefined : target;
      }
      case "find":
        this.lastFind = { key: motion.key, char: motion.char };
        return findChar(context, motion.key, motion.char, false);
      case "repeat-find": {
        if (!this.lastFind) return undefined;
        const key = motion.reverse ? reverseFind(this.lastFind.key) : this.lastFind.key;
        return findChar(context, key, this.lastFind.char, true);
      }
      case "search-next": {
        if (!this.lastSearch) {
          this.effects.push({
            kind: "notify",
            message: "No previous search pattern",
            level: "info",
          });
          return undefined;
        }
        const backward = this.lastSearch.backward !== motion.reverse;
        return this.searchTarget(this.lastSearch.pattern, backward, context.count);
      }
      case "word-search": {
        const pattern = wordUnderCursor(this.model);
        if (!pattern) return undefined;
        this.lastSearch = { pattern, backward: motion.backward };
        return this.searchTarget(pattern, motion.backward, context.count);
      }
      case "search":
        return undefined;
    }
  }

  private searchTarget(
    pattern: SearchPattern,
    backward: boolean,
    count: number,
  ): MotionTarget | undefined {
    let pos = this.model.cursor;
    for (let index = 0; index < count; index++) {
      const match = findMatch(this.model, pos, pattern, backward ? -1 : 1);
      if (!match) {
        this.effects.push({
          kind: "notify",
          message: `Pattern not found: ${pattern.text}`,
          level: "info",
        });
        return undefined;
      }
      pos = match.pos;
    }
    return { pos, linewise: false, inclusive: false };
  }

  /** Convert a motion into the range an operator covers, applying Vim's exclusive adjustments. */
  private motionRange(target: MotionTarget): TextRange {
    const [start, end] = orderPositions(this.model.cursor, target.pos);
    if (target.linewise) return { start, end, linewise: true };
    if (target.inclusive) {
      const text = lineAt(this.model, end.line);
      return { start, end: { line: end.line, col: nextCol(text, end.col) }, linewise: false };
    }
    if (end.col === 0 && end.line > start.line) {
      if (start.col <= firstNonBlankCol(lineAt(this.model, start.line))) {
        return {
          start: { line: start.line, col: 0 },
          end: { line: end.line - 1, col: 0 },
          linewise: true,
        };
      }
      return {
        start,
        end: { line: end.line - 1, col: lineAt(this.model, end.line - 1).length },
        linewise: false,
      };
    }
    return { start, end, linewise: false };
  }

  private executeNormal(command: Command, keys: VimKey[]): void {
    switch (command.kind) {
      case "motion":
        this.normalMotion(command.motion, command.count);
        return;
      case "operator":
        this.operate(command.operator, command, keys);
        return;
      case "action":
        this.normalAction(command.action, command.count, keys, command.char);
        return;
      case "select":
        return;
    }
  }

  private normalMotion(motion: MotionSpec, count: number | undefined): void {
    if (motion.kind === "search") {
      this.beginLineInput("search", motion.backward, count, undefined);
      return;
    }
    if (motion.kind === "simple" && this.currentMode === "normal") {
      const up = motion.key === "k" || motion.key === "<Up>";
      const down = motion.key === "j" || motion.key === "<Down>";
      const { line } = this.model.cursor;
      if ((up && line === 0) || (down && line === this.model.lines.length - 1)) {
        this.effects.push({ kind: "history", direction: up ? -1 : 1, count: count ?? 1 });
        return;
      }
    }
    const target = this.resolveMotion(motion, count, false);
    if (target) this.moveTo(target);
  }

  private operate(
    operator: Operator,
    command: Extract<Command, { kind: "operator" }>,
    keys: VimKey[],
  ): void {
    const { target, count } = command;
    const record = { keys, count };
    let range: TextRange | undefined;
    if (target.kind === "line") {
      const { line } = this.model.cursor;
      const last = Math.min(this.model.lines.length - 1, line + (count ?? 1) - 1);
      range = {
        start: { line, col: this.model.cursor.col },
        end: { line: last, col: 0 },
        linewise: true,
      };
    } else if (target.kind === "object") {
      range = selectTextObject(
        this.model,
        this.model.cursor,
        target.around,
        target.object,
        count ?? 1,
      );
    } else if (target.kind === "motion") {
      const { motion } = target;
      if (motion.kind === "search") {
        this.beginLineInput("search", motion.backward, count, { operator, count, keys });
        return;
      }
      const onWord = !isBlank(
        charAt(lineAt(this.model, this.model.cursor.line), this.model.cursor.col),
      );
      const motionTarget =
        operator === "c" &&
        motion.kind === "simple" &&
        (motion.key === "w" || motion.key === "W") &&
        onWord
          ? wordEnd(this.motionContext(count, true), motion.key === "W", true)
          : this.resolveMotion(motion, count, true);
      if (motionTarget) range = this.motionRange(motionTarget);
    }
    this.applyRange(operator, range, record);
  }

  /** Apply an operator to a resolved range; a failed motion or text object aborts the command. */
  private applyRange(operator: Operator, range: TextRange | undefined, record: ChangeRecord): void {
    if (!range) return;
    const cursor = this.model.cursor;
    const outcome = applyOperator(
      this.model,
      operator,
      snapRange(this.model, range),
      cursor,
      false,
    );
    this.applyOutcome(outcome);
    if (operator === "y") this.yank(outcome);
    if (outcome.insert) {
      this.startInsert(record, 1, "", outcome.textChanged);
      return;
    }
    if (operator !== "y" && outcome.textChanged) this.record(record);
    this.clampCursor();
    this.rememberCurswant();
  }

  private applyOutcome(outcome: EditOutcome): void {
    this.setModel(outcome.model, outcome.textChanged);
    if (outcome.register !== undefined && outcome.register !== "") this.register = outcome.register;
  }

  /** Ask the host to copy a yank to the system clipboard; deletes and changes stay internal. */
  private yank(outcome: EditOutcome): void {
    if (outcome.register) this.effects.push({ kind: "yank", text: outcome.register });
  }

  private normalAction(
    action: string,
    count: number | undefined,
    keys: VimKey[],
    char?: string,
  ): void {
    const record: ChangeRecord = { keys, count };
    const times = count ?? 1;
    const alias = (operator: Operator, target: Extract<Command, { kind: "operator" }>["target"]) =>
      this.operate(operator, { kind: "operator", count, operator, target }, keys);
    const simple = (key: string) => ({
      kind: "motion" as const,
      motion: { kind: "simple" as const, key },
    });
    switch (action) {
      case "x":
      case "<Del>":
        alias("d", simple("l"));
        return;
      case "X":
        alias("d", simple("h"));
        return;
      case "D":
        alias("d", simple("$"));
        return;
      case "C":
        alias("c", simple("$"));
        return;
      case "s":
        alias("c", simple("l"));
        return;
      case "S":
        alias("c", { kind: "line" });
        return;
      case "Y":
        alias("y", { kind: "line" });
        return;
      case "p":
      case "P":
        this.edit(put(this.model, this.register, action === "p", times), record);
        return;
      case "J":
      case "gJ":
        this.edit(joinLines(this.model, times, action === "J"), record);
        return;
      case "~":
        this.edit(toggleCase(this.model, times), record);
        return;
      case "r":
        this.edit(replaceChars(this.model, char === "<CR>" ? "\n" : (char ?? ""), times), record);
        return;
      case "u":
      case "<Undo>":
        this.effects.push({ kind: "undo", count: times });
        return;
      case "<C-r>":
        this.effects.push({ kind: "redo", count: times });
        return;
      case ".":
        this.repeat(count);
        return;
      case "i":
      case "a":
      case "I":
      case "A":
        this.setCursor(insertCursor(this.model, action));
        this.startInsert(record, times, "", false);
        return;
      case "gi":
        this.setCursor(this.lastInsert ?? this.model.cursor);
        this.startInsert(record, times, "", false);
        return;
      case "o":
      case "O":
        this.setModel(openLine(this.model, action === "o"), true);
        this.startInsert(record, times, "\n", true);
        return;
      case "R":
        this.currentMode = "replace";
        this.replaceSession = { steps: [], record: { keys: [...keys], count: undefined } };
        return;
      case "v":
      case "V":
        this.rememberCurswant();
        this.enterVisual(action === "v" ? "visual" : "visual-line", this.model.cursor);
        return;
      case "gv":
        if (this.lastVisual) {
          this.enterVisual(this.lastVisual.mode, this.lastVisual.anchor);
          this.moveTo({ pos: this.lastVisual.cursor, linewise: false, inclusive: false });
        }
        return;
      case ":":
        this.beginLineInput("ex", false, count, undefined);
        return;
      default:
        return;
    }
  }

  private edit(outcome: EditOutcome, record: ChangeRecord): void {
    this.applyOutcome(outcome);
    if (outcome.textChanged) this.record(record);
    this.clampCursor();
    this.rememberCurswant();
  }

  // ---------------------------------------------------------------------------------------------
  // Visual mode

  private enterVisual(mode: "visual" | "visual-line", anchor: Position): void {
    this.currentMode = mode;
    this.visualAnchor = { ...anchor };
  }

  private exitVisual(): void {
    if (isVisualMode(this.currentMode)) {
      this.lastVisual = {
        anchor: this.visualAnchor,
        cursor: this.model.cursor,
        mode: this.currentMode,
      };
    }
    this.currentMode = "normal";
    this.clampCursor();
  }

  private executeVisual(command: Command, keys: VimKey[]): void {
    const mode = this.currentMode === "visual-line" ? "visual-line" : "visual";
    const selection: VisualSelection = {
      anchor: this.visualAnchor,
      cursor: this.model.cursor,
      mode,
    };
    switch (command.kind) {
      case "motion":
        if (command.motion.kind === "search") {
          this.beginLineInput("search", command.motion.backward, command.count, undefined);
          return;
        }
        this.visualMotion(command.motion, command.count);
        return;
      case "select":
        this.visualSelect(command.around, command.object, command.count);
        return;
      case "operator":
        this.visualOperate(command.operator, selection, keys, false);
        return;
      case "action":
        this.visualAction(command.action, selection, keys, command.char);
        return;
    }
  }

  private visualMotion(motion: MotionSpec, count: number | undefined): void {
    const target = this.resolveMotion(motion, count, false);
    if (target) this.moveTo(target);
  }

  private visualSelect(around: boolean, object: string, count: number | undefined): void {
    const range = selectTextObject(this.model, this.model.cursor, around, object, count ?? 1);
    if (!range) return;
    if (range.linewise) {
      this.currentMode = "visual-line";
      this.visualAnchor = { line: range.start.line, col: 0 };
      this.setCursor({ line: range.end.line, col: 0 });
      return;
    }
    if (comparePositions(range.start, range.end) >= 0) return;
    this.visualAnchor = range.start;
    const endLine = lineAt(this.model, range.end.line);
    this.setCursor(
      range.end.col === 0 && range.end.line > range.start.line
        ? { line: range.end.line - 1, col: lineAt(this.model, range.end.line - 1).length }
        : { line: range.end.line, col: prevCol(endLine, range.end.col) },
    );
  }

  private visualOperate(
    operator: Operator,
    selection: VisualSelection,
    keys: VimKey[],
    linewise: boolean,
  ): void {
    const size = measureSelection(this.model, selection);
    const range = snapRange(
      this.model,
      selectionRange(this.model, linewise ? { ...selection, mode: "visual-line" } : selection),
    );
    this.exitVisual();
    const record: ChangeRecord = { keys, count: undefined, visual: size };
    const outcome = applyOperator(this.model, operator, range, range.start, true);
    this.applyOutcome(outcome);
    if (operator === "y") this.yank(outcome);
    if (outcome.insert) {
      this.startInsert(record, 1, "", outcome.textChanged);
      return;
    }
    if (operator === "y")
      this.setCursor(range.linewise ? { line: range.start.line, col: 0 } : range.start);
    if (operator !== "y" && outcome.textChanged) this.record(record);
    this.clampCursor();
    this.rememberCurswant();
  }

  private visualAction(
    action: string,
    selection: VisualSelection,
    keys: VimKey[],
    char?: string,
  ): void {
    switch (action) {
      case "o":
      case "O":
        this.visualAnchor = selection.cursor;
        this.setCursor(selection.anchor);
        return;
      case "v":
      case "V": {
        const target = action === "v" ? "visual" : "visual-line";
        if (this.currentMode === target) this.exitVisual();
        else this.currentMode = target;
        return;
      }
      case "x":
      case "<Del>":
        this.visualOperate("d", selection, keys, false);
        return;
      case "s":
        this.visualOperate("c", selection, keys, false);
        return;
      case "X":
      case "D":
        this.visualOperate("d", selection, keys, true);
        return;
      case "Y":
        this.visualOperate("y", selection, keys, true);
        return;
      case "C":
      case "S":
        this.visualOperate("c", selection, keys, true);
        return;
      case "~":
        this.visualOperate("g~", selection, keys, false);
        return;
      case "u":
        this.visualOperate("gu", selection, keys, false);
        return;
      case "U":
        this.visualOperate("gU", selection, keys, false);
        return;
      default:
        this.visualEdit(action, selection, keys, char);
    }
  }

  /** Visual edits that are not plain operators: `J`, `gJ`, `r{char}`, `p`, `P`. */
  private visualEdit(
    action: string,
    selection: VisualSelection,
    keys: VimKey[],
    char?: string,
  ): void {
    const size = measureSelection(this.model, selection);
    const range = snapRange(this.model, selectionRange(this.model, selection));
    const record: ChangeRecord = { keys, count: undefined, visual: size };
    this.exitVisual();
    let outcome: EditOutcome;
    if (action === "J" || action === "gJ") {
      this.setCursor({ line: range.start.line, col: 0 });
      outcome = joinLines(this.model, range.end.line - range.start.line + 1, action === "J");
    } else if (action === "r") {
      outcome = replaceRange(this.model, range, char === "<CR>" ? "\n" : (char ?? ""));
    } else {
      outcome = putOverRange(this.model, range, this.register);
    }
    this.applyOutcome(outcome);
    if (outcome.textChanged) this.record(record);
    this.clampCursor();
    this.rememberCurswant();
  }

  // ---------------------------------------------------------------------------------------------
  // Insert and replace sessions

  private beginInsert(
    model: TextModel,
    record: ChangeRecord,
    repeatCount: number,
    repeatPrefix: string,
    changedOnEntry: boolean,
  ): void {
    this.insertSession = {
      startLines: [...model.lines],
      startOffset: toOffset(model.lines, clampInsertCursor(model)),
      repeatCount,
      repeatPrefix,
      record,
      changedOnEntry,
    };
  }

  private startInsert(
    record: ChangeRecord,
    repeatCount: number,
    repeatPrefix: string,
    changedOnEntry: boolean,
  ): void {
    this.currentMode = "insert";
    this.clampCursor();
    this.beginInsert(this.model, record, repeatCount, repeatPrefix, changedOnEntry);
  }

  private finishInsert(): void {
    const session = this.insertSession;
    this.insertSession = undefined;
    this.currentMode = "normal";
    if (!session) {
      this.leaveInsertCursor();
      return;
    }
    const before = session.startLines.join("\n");
    const diff = diffInsert(before, this.model.lines.join("\n"), session.startOffset);
    const pure = diff.deleteBefore === 0 && diff.deleteAfter === 0 && diff.text !== "";
    if (session.repeatCount > 1 && pure) {
      const unit = `${session.repeatPrefix}${diff.text}`.repeat(session.repeatCount - 1);
      const cursor = this.model.cursor;
      const offset = toOffset(this.model.lines, cursor);
      const lines = spliceText(this.model.lines, cursor, cursor, unit);
      this.setModel({ lines, cursor: fromOffset(lines, offset + unit.length) }, true);
    }
    if (!isEmptyDiff(diff) || session.changedOnEntry)
      this.record({ ...session.record, insert: diff });
    this.leaveInsertCursor();
  }

  private leaveInsertCursor(): void {
    const { cursor } = this.model;
    this.lastInsert = { ...cursor };
    this.setCursor({
      line: cursor.line,
      col: prevCol(lineAt(this.model, cursor.line), cursor.col),
    });
    this.clampCursor();
    this.rememberCurswant();
  }

  private replaceKey(key: VimKey): void {
    const session = this.replaceSession;
    if (!session) {
      this.currentMode = "normal";
      return;
    }
    if (key === "<Esc>") {
      this.finishReplace();
      return;
    }
    const { cursor } = this.model;
    const text = lineAt(this.model, cursor.line);
    if (key === "<BS>") {
      session.record.keys.push(key);
      const step = session.steps.pop();
      if (!step) {
        if (cursor.col > 0) this.setCursor({ line: cursor.line, col: prevCol(text, cursor.col) });
        return;
      }
      if (step.kind === "newline") {
        const previous = lineAt(this.model, cursor.line - 1);
        const at = { line: cursor.line - 1, col: previous.length };
        this.setModel({ lines: spliceText(this.model.lines, at, cursor, ""), cursor: at }, true);
        return;
      }
      const col = prevCol(text, cursor.col);
      const restored = step.kind === "overwrite" ? step.original : "";
      const lines = spliceText(this.model.lines, { line: cursor.line, col }, cursor, restored);
      this.setModel({ lines, cursor: { line: cursor.line, col } }, true);
      return;
    }
    if (key === "<CR>") {
      session.record.keys.push(key);
      session.steps.push({ kind: "newline" });
      const lines = spliceText(this.model.lines, cursor, cursor, "\n");
      this.setModel({ lines, cursor: { line: cursor.line + 1, col: 0 } }, true);
      return;
    }
    if (isNamedKey(key)) return;
    session.record.keys.push(key);
    const original = charAt(text, cursor.col);
    session.steps.push(original === "" ? { kind: "append" } : { kind: "overwrite", original });
    const end = { line: cursor.line, col: cursor.col + original.length };
    const lines = spliceText(this.model.lines, cursor, end, key);
    this.setModel({ lines, cursor: { line: cursor.line, col: cursor.col + key.length } }, true);
  }

  private finishReplace(): void {
    const session = this.replaceSession;
    this.replaceSession = undefined;
    this.currentMode = "normal";
    if (session && session.steps.length > 0) this.record(session.record);
    this.leaveInsertCursor();
  }

  // ---------------------------------------------------------------------------------------------
  // Ex and search lines

  private beginLineInput(
    kind: "ex" | "search",
    backward: boolean,
    count: number | undefined,
    operator: PendingOperator | undefined,
  ): void {
    const returnMode = isVisualMode(this.currentMode) ? this.currentMode : "normal";
    this.lineInput = operator
      ? { kind, text: "", backward, returnMode, count, operator }
      : { kind, text: "", backward, returnMode, count };
    if (isVisualMode(this.currentMode))
      this.lastVisual = {
        anchor: this.visualAnchor,
        cursor: this.model.cursor,
        mode: this.currentMode,
      };
    this.currentMode = kind;
  }

  private leaveLineInput(): void {
    const input = this.lineInput;
    this.lineInput = undefined;
    this.currentMode = input?.returnMode ?? "normal";
  }

  private lineKey(key: VimKey): void {
    const input = this.lineInput;
    if (!input) {
      this.currentMode = "normal";
      return;
    }
    switch (key) {
      case "<Esc>":
        this.leaveLineInput();
        return;
      case "<BS>":
        if (input.text === "") this.leaveLineInput();
        else input.text = input.text.slice(0, prevCol(input.text, input.text.length));
        return;
      case "<C-u>":
        input.text = "";
        return;
      case "<C-w>":
        input.text = input.text.replace(/\S*\s*$/u, "");
        return;
      case "<CR>":
        if (input.kind === "ex") this.runEx(input);
        else this.runSearch(input);
        return;
      default:
        if (!isNamedKey(key)) input.text += key;
    }
  }

  private runEx(input: LineInput): void {
    this.leaveLineInput();
    const effect = resolveExCommand(input.text, this.model.lines.join("\n"), (name) =>
      this.host.isPiCommand(name),
    );
    if (effect) this.effects.push(effect);
  }

  private runSearch(input: LineInput): void {
    this.leaveLineInput();
    const pattern: SearchPattern | undefined =
      input.text === "" ? this.lastSearch?.pattern : { text: input.text, wholeWord: false };
    if (!pattern) {
      this.effects.push({ kind: "notify", message: "No previous search pattern", level: "info" });
      return;
    }
    this.lastSearch = { pattern, backward: input.backward };
    const target = this.searchTarget(pattern, input.backward, input.count ?? 1);
    if (input.operator) {
      const { operator, count } = input.operator;
      const keys = [...input.operator.keys, ...graphemes(input.text), "<CR>"];
      this.applyRange(operator, target ? this.motionRange(target) : undefined, { keys, count });
      return;
    }
    if (!target) return;
    this.setCursor(target.pos);
    this.clampCursor();
    this.rememberCurswant();
  }

  // ---------------------------------------------------------------------------------------------
  // Dot repeat

  private repeat(count: number | undefined): void {
    const change = this.lastChange;
    if (!change) return;
    const effectiveCount = count ?? change.count;
    this.replaying = true;
    try {
      if (change.visual) {
        const selection = selectionLike(this.model, change.visual);
        this.enterVisual(selection.mode, selection.anchor);
        this.setCursor(selection.cursor);
      }
      const keys = change.visual ? change.keys : [...digitsOf(effectiveCount), ...change.keys];
      for (const key of keys) this.feed(key);
      if (this.currentMode === "insert") {
        if (change.insert) this.setModel(applyInsertDiff(this.model, change.insert), true);
        this.feed("<Esc>");
      } else if (this.currentMode === "replace") {
        this.feed("<Esc>");
      }
    } finally {
      this.replaying = false;
    }
    this.lastChange = { ...change, count: change.visual ? undefined : effectiveCount };
  }
}
