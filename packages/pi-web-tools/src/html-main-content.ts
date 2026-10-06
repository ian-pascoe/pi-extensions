import { Parser } from "htmlparser2";

/** HTML narrowed to the part of a page a reader came for. */
export type HtmlMainContent = {
  /** Source HTML of the selected content, with chrome elements cut out. */
  readonly html: string;
  /** Whitespace-normalized page `<title>`, when the page has a non-empty one. */
  readonly title: string | undefined;
  /** Whether visible text outside the selected content was dropped. */
  readonly chromeRemoved: boolean;
  /**
   * Whole percent of the page's visible text dropped as chrome, set only when the drop is large
   * enough that the reader should be warned and told how to get the full page.
   */
  readonly largeRemovalPercent: number | undefined;
};

type Span = { readonly start: number; readonly end: number };

type ParsedElement = {
  readonly name: string;
  readonly role: string | undefined;
  readonly start: number;
  readonly parent: number;
  /** Index of the nearest sectioning ancestor, or -1; a <header> or <footer> inside one is not page chrome. */
  readonly section: number;
  /** Whether an ancestor is navigation, an aside, or a header or footer. */
  readonly insideChrome: boolean;
  /** Exclusive end offset; undefined until a matching end tag closes the element. */
  end: number | undefined;
};

type ParsedText = {
  readonly start: number;
  /** Characters of trimmed visible text before this chunk, so a span's length is a difference. */
  readonly charsBefore: number;
};

/** A large drop is at least this share of the page's visible text... */
const LARGE_REMOVAL_SHARE = 0.5;
/** ...and at least this many characters, so a tiny page with a link bar is not flagged. */
const LARGE_REMOVAL_CHARS = 1000;

/** Elements whose text is never page content. */
const HIDDEN_ELEMENTS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "object",
  "embed",
  "template",
  "head",
  "title",
]);

/** Elements that wrap a page's own sectioning, so a `<header>` or `<footer>` inside is not site chrome. */
const SECTIONING_ELEMENTS = new Set(["article", "section", "main", "aside", "nav"]);

const BANNER_ELEMENTS = new Set(["aside", "header", "footer"]);
const HEADING_ELEMENTS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

type ParsedPage = {
  readonly elements: readonly ParsedElement[];
  readonly texts: readonly ParsedText[];
  readonly title: string | undefined;
  /** Characters of trimmed visible text on the whole page. */
  readonly totalChars: number;
};

function parsePage(html: string): ParsedPage {
  const elements: ParsedElement[] = [];
  const texts: ParsedText[] = [];
  const open: number[] = [];
  let hiddenDepth = 0;
  let titleDepth = 0;
  let title: string | undefined;
  let titleDone = false;
  let titleText = "";
  let totalChars = 0;
  const hiddenOpen = new Set<number>();
  const parser = new Parser({
    onopentag(name, attributes) {
      const index = elements.length;
      const parentIndex = open.at(-1) ?? -1;
      const parentElement = elements[parentIndex];
      const parentName = parentElement?.name;
      elements.push({
        name,
        role: attributes["role"]?.trim().toLowerCase(),
        start: parser.startIndex,
        parent: parentIndex,
        section:
          parentElement === undefined
            ? -1
            : SECTIONING_ELEMENTS.has(parentElement.name)
              ? parentIndex
              : parentElement.section,
        insideChrome:
          parentElement !== undefined &&
          (parentElement.insideChrome ||
            isNavigation(parentElement) ||
            BANNER_ELEMENTS.has(parentElement.name)),
        end: undefined,
      });
      open.push(index);
      if (HIDDEN_ELEMENTS.has(name)) {
        hiddenDepth++;
        hiddenOpen.add(index);
      }
      // An inline SVG <title> is a label, not the page title.
      if (
        name === "title" &&
        !titleDone &&
        (parentName === undefined || parentName === "head" || parentName === "html")
      ) {
        titleDepth = 1;
      }
    },
    ontext(value) {
      if (titleDepth > 0) titleText += value;
      else if (hiddenDepth === 0 && value.trim().length > 0) {
        texts.push({ start: parser.startIndex, charsBefore: totalChars });
        totalChars += value.trim().length;
      }
    },
    onclosetag(name, isImplied) {
      const index = open.pop();
      if (index === undefined) return;
      const element = elements[index];
      if (element === undefined) return;
      if (!isImplied) element.end = parser.endIndex + 1;
      if (hiddenOpen.delete(index)) hiddenDepth--;
      if (name === "title" && titleDepth > 0) {
        titleDepth = 0;
        titleDone = true;
        const normalized = titleText.replace(/\s+/g, " ").trim();
        title = normalized.length === 0 ? undefined : normalized;
      }
    },
  });
  parser.write(html);
  parser.end();
  return { elements, texts, title, totalChars };
}

function isMainElement(element: ParsedElement): boolean {
  return element.name === "main" || element.role?.split(/\s+/).includes("main") === true;
}

/** Navigation landmarks: `<nav>` and elements with a navigation or search role. */
function isNavigation(element: ParsedElement): boolean {
  if (element.name === "nav") return true;
  const roles = element.role?.split(/\s+/);
  return roles?.includes("navigation") === true || roles?.includes("search") === true;
}

function closedSpan(element: ParsedElement): Span | undefined {
  return element.end === undefined ? undefined : { start: element.start, end: element.end };
}

/** Index of the first item whose `start` is at or after `offset`; items are sorted by `start`. */
function lowerBound(items: readonly { readonly start: number }[], offset: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((items[middle]?.start ?? Infinity) < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Visible text chunks that start inside `span`. */
function countTexts(texts: readonly ParsedText[], span: Span): number {
  return lowerBound(texts, span.end) - lowerBound(texts, span.start);
}

/** Characters of visible text that start inside `span`. */
function countChars(page: ParsedPage, span: Span): number {
  const charsAt = (index: number) => page.texts[index]?.charsBefore ?? page.totalChars;
  return charsAt(lowerBound(page.texts, span.end)) - charsAt(lowerBound(page.texts, span.start));
}

function hasText(texts: readonly ParsedText[], span: Span): boolean {
  return countTexts(texts, span) > 0;
}

/** Outermost closed elements inside `within` that satisfy `predicate`, in document order. */
function outermostSpans(
  elements: readonly ParsedElement[],
  within: Span,
  predicate: (element: ParsedElement) => boolean,
): Span[] {
  const spans: Span[] = [];
  let coveredUntil = within.start;
  for (let index = lowerBound(elements, within.start); index < elements.length; index++) {
    const element = elements[index];
    if (element === undefined || element.start >= within.end) break;
    if (element.start < coveredUntil) continue;
    const span = closedSpan(element);
    if (span === undefined || span.end > within.end || !predicate(element)) continue;
    spans.push(span);
    coveredUntil = span.end;
  }
  return spans;
}

/**
 * The parts of `header` outside its headings: a page title block keeps its heading, not its widgets.
 * A heading without an end tag, as in `<h1>Title<h2>`, runs to the next heading or the header's end.
 */
function outsideHeadings(elements: readonly ParsedElement[], header: Span): Span[] {
  const headings: ParsedElement[] = [];
  for (let index = lowerBound(elements, header.start); index < elements.length; index++) {
    const element = elements[index];
    if (element === undefined || element.start >= header.end) break;
    if (HEADING_ELEMENTS.has(element.name)) headings.push(element);
  }
  const gaps: Span[] = [];
  let position = header.start;
  headings.forEach((heading, index) => {
    if (heading.start < position) return;
    const end = Math.min(heading.end ?? headings[index + 1]?.start ?? header.end, header.end);
    if (heading.start > position) gaps.push({ start: position, end: heading.start });
    position = Math.max(end, heading.start);
  });
  if (header.end > position) gaps.push({ start: position, end: header.end });
  return gaps;
}

/**
 * Spans to cut from selected content: navigation landmarks and, when `mainIndex` names the selected
 * main element, everything but the headings of a `<header>` that belongs to the main itself (such
 * as Wikipedia's language menu beside the article title). A `<header>` inside an `<article>` or
 * `<section>` within the main keeps its byline and summary.
 */
function contentCuts(
  elements: readonly ParsedElement[],
  content: Span,
  mainIndex: number | undefined,
): Span[] {
  const cuts: Span[] = [];
  let coveredUntil = content.start;
  for (let index = lowerBound(elements, content.start); index < elements.length; index++) {
    const element = elements[index];
    if (element === undefined || element.start >= content.end) break;
    if (element.start < coveredUntil) continue;
    const span = closedSpan(element);
    if (span === undefined || span.end > content.end) continue;
    if (isNavigation(element)) {
      cuts.push(span);
      coveredUntil = span.end;
    } else if (
      mainIndex !== undefined &&
      element.name === "header" &&
      element.section <= mainIndex
    ) {
      cuts.push(...outsideHeadings(elements, span));
      coveredUntil = span.end;
    }
  }
  return cuts;
}

function sliceWithout(html: string, within: Span, cuts: readonly Span[]): string {
  let result = "";
  let position = within.start;
  for (const cut of cuts) {
    result += html.slice(position, cut.start);
    position = cut.end;
  }
  return result + html.slice(position, within.end);
}

/** Visible text outside the kept part of the page, such as navigation labels. */
function droppedVisibleText(
  texts: readonly ParsedText[],
  within: Span,
  cuts: readonly Span[],
): boolean {
  return countTexts(texts, within) < texts.length || cuts.some((cut) => hasText(texts, cut));
}

function isLargeRemoval(removedChars: number, totalChars: number): boolean {
  return removedChars >= LARGE_REMOVAL_CHARS && removedChars >= totalChars * LARGE_REMOVAL_SHARE;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function select(
  page: ParsedPage,
  html: string,
  within: Span,
  cuts: readonly Span[],
): HtmlMainContent {
  const keptChars = countChars(page, within) - sum(cuts.map((cut) => countChars(page, cut)));
  const removedChars = page.totalChars - keptChars;
  return {
    html: sliceWithout(html, within, cuts),
    title: page.title,
    chromeRemoved: droppedVisibleText(page.texts, within, cuts),
    largeRemovalPercent: isLargeRemoval(removedChars, page.totalChars)
      ? Math.round((removedChars / page.totalChars) * 100)
      : undefined,
  };
}

/**
 * Narrow an HTML page to its main content. Prefers the first `<main>` or `[role=main]` that holds
 * text, then the page's only `<article>` (one that sits inside a sidebar, navigation, header, or
 * footer does not count), and otherwise strips navigation, `<aside>`, and `<header>` and `<footer>`
 * that belong to the page rather than to a section. Navigation is `<nav>` or a navigation or search
 * role. Selected content also loses its navigation, and a `<header>` that belongs to `<main>` itself
 * keeps only its headings. A fallback landmark that holds most of the body text is kept, and when the
 * remaining cuts would still drop most of it the whole page is kept. Returns `undefined` when nothing qualifies or nothing would be removed, so the caller
 * converts the whole page. Only elements with an end tag are selected or cut, so an unclosed tag
 * never swallows the rest of the page. Work is linear in the page size apart from sorted lookups.
 */
export function extractMainContent(html: string): HtmlMainContent | undefined {
  const page = parsePage(html);
  const { elements, texts } = page;
  const everything: Span = { start: 0, end: html.length };

  const mainIndex = elements.findIndex((element) => {
    const span = closedSpan(element);
    return isMainElement(element) && span !== undefined && hasText(texts, span);
  });
  const main = elements[mainIndex];
  const mainSpan = main === undefined ? undefined : closedSpan(main);
  if (mainSpan !== undefined) {
    return select(page, html, mainSpan, contentCuts(elements, mainSpan, mainIndex));
  }

  // An <article> inside a sidebar or header is a card, not the page's article.
  const articles = outermostSpans(
    elements,
    everything,
    (element) => element.name === "article" && !element.insideChrome,
  );
  const article = articles.length === 1 ? articles[0] : undefined;
  if (article !== undefined && hasText(texts, article)) {
    return select(page, html, article, contentCuts(elements, article, undefined));
  }

  const body = elements.find((element) => element.name === "body" && element.end !== undefined);
  const bodySpan = (body === undefined ? undefined : closedSpan(body)) ?? everything;
  const bodyChars = countChars(page, bodySpan);
  // A landmark holding most of the body text is the content column in chrome's clothing, as on
  // sites that mark the page body `role="navigation"`; keep it and look for chrome inside it.
  const holdsMostText = (span: Span) => countChars(page, span) * 2 > bodyChars;
  const chrome = outermostSpans(elements, bodySpan, (element) => {
    const span = closedSpan(element);
    if (span === undefined || holdsMostText(span)) return false;
    if (isNavigation(element) || element.name === "aside") return true;
    return (element.name === "header" || element.name === "footer") && element.section < 0;
  });
  const cutChars = sum(chrome.map((cut) => countChars(page, cut)));
  // When cuts would drop most of the text, the page has no recognizable content column.
  if (chrome.length === 0 || (isLargeRemoval(cutChars, bodyChars) && cutChars * 2 > bodyChars)) {
    return undefined;
  }
  const stripped = select(page, html, bodySpan, chrome);
  return stripped.chromeRemoved && bodyChars > cutChars ? stripped : undefined;
}
