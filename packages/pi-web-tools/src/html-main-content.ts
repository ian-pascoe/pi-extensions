import { Parser } from "htmlparser2";

/** HTML narrowed to the part of a page a reader came for. */
export type HtmlMainContent = {
  /** Source HTML of the selected content, with chrome elements cut out. */
  readonly html: string;
  /** Whitespace-normalized page `<title>`, when the page has a non-empty one. */
  readonly title: string | undefined;
  /** Whether visible text outside the selected content was dropped. */
  readonly chromeRemoved: boolean;
};

type Span = { readonly start: number; readonly end: number };

type ParsedElement = {
  readonly name: string;
  readonly role: string | undefined;
  readonly start: number;
  readonly parent: number;
  /** Whether an ancestor is a sectioning element, so a <header> or <footer> here is not page chrome. */
  readonly sectioned: boolean;
  /** Whether an ancestor is navigation, an aside, or a header or footer. */
  readonly insideChrome: boolean;
  /** Exclusive end offset; undefined until a matching end tag closes the element. */
  end: number | undefined;
};

type ParsedText = { readonly start: number };

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
        sectioned:
          parentElement !== undefined &&
          (parentElement.sectioned || SECTIONING_ELEMENTS.has(parentElement.name)),
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
      else if (hiddenDepth === 0 && value.trim().length > 0)
        texts.push({ start: parser.startIndex });
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
  return { elements, texts, title };
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

/** The parts of `header` outside its headings: a page title block keeps its heading, not its widgets. */
function outsideHeadings(elements: readonly ParsedElement[], header: Span): Span[] {
  const gaps: Span[] = [];
  let position = header.start;
  for (const heading of outermostSpans(elements, header, (element) =>
    HEADING_ELEMENTS.has(element.name),
  )) {
    if (heading.start > position) gaps.push({ start: position, end: heading.start });
    position = heading.end;
  }
  if (header.end > position) gaps.push({ start: position, end: header.end });
  return gaps;
}

/**
 * Spans to cut from selected content: navigation landmarks and, in `<main>`, everything but the
 * headings of a `<header>` (such as Wikipedia's language menu beside the article title).
 */
function contentCuts(
  elements: readonly ParsedElement[],
  content: Span,
  trimHeaders: boolean,
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
    } else if (trimHeaders && element.name === "header") {
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

function select(
  page: ParsedPage,
  html: string,
  within: Span,
  cuts: readonly Span[],
): HtmlMainContent {
  return {
    html: sliceWithout(html, within, cuts),
    title: page.title,
    chromeRemoved: droppedVisibleText(page.texts, within, cuts),
  };
}

/**
 * Narrow an HTML page to its main content. Prefers the first `<main>` or `[role=main]` that holds
 * text, then the page's only `<article>` (one that sits inside a sidebar, navigation, header, or
 * footer does not count), and otherwise strips navigation, `<aside>`, and `<header>` and `<footer>`
 * that belong to the page rather than to a section. Navigation is `<nav>` or a navigation or search
 * role. Selected content also loses its navigation, and a `<header>` inside `<main>` keeps only its
 * headings. Returns `undefined` when nothing qualifies or nothing would be removed, so the caller
 * converts the whole page. Only elements with an end tag are selected or cut, so an unclosed tag
 * never swallows the rest of the page. Work is linear in the page size apart from sorted lookups.
 */
export function extractMainContent(html: string): HtmlMainContent | undefined {
  const page = parsePage(html);
  const { elements, texts } = page;
  const everything: Span = { start: 0, end: html.length };

  const main = elements.find((element) => {
    const span = closedSpan(element);
    return isMainElement(element) && span !== undefined && hasText(texts, span);
  });
  const mainSpan = main === undefined ? undefined : closedSpan(main);
  if (mainSpan !== undefined) {
    return select(page, html, mainSpan, contentCuts(elements, mainSpan, true));
  }

  // An <article> inside a sidebar or header is a card, not the page's article.
  const articles = outermostSpans(
    elements,
    everything,
    (element) => element.name === "article" && !element.insideChrome,
  );
  const article = articles.length === 1 ? articles[0] : undefined;
  if (article !== undefined && hasText(texts, article)) {
    return select(page, html, article, contentCuts(elements, article, false));
  }

  const body = elements.find((element) => element.name === "body" && element.end !== undefined);
  const bodySpan = (body === undefined ? undefined : closedSpan(body)) ?? everything;
  const chrome = outermostSpans(elements, bodySpan, (element) => {
    if (isNavigation(element) || element.name === "aside") return true;
    return (element.name === "header" || element.name === "footer") && !element.sectioned;
  });
  const stripped = select(page, html, bodySpan, chrome);
  const keptTexts =
    countTexts(texts, bodySpan) - chrome.reduce((total, cut) => total + countTexts(texts, cut), 0);
  return chrome.length > 0 && stripped.chromeRemoved && keptTexts > 0 ? stripped : undefined;
}
