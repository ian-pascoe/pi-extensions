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
      const parentName = elements[open.at(-1) ?? -1]?.name;
      elements.push({
        name,
        role: attributes["role"]?.trim().toLowerCase(),
        start: parser.startIndex,
        parent: open.at(-1) ?? -1,
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

function closedSpan(element: ParsedElement): Span | undefined {
  return element.end === undefined ? undefined : { start: element.start, end: element.end };
}

function hasText(texts: readonly ParsedText[], span: Span): boolean {
  return texts.some(({ start }) => start >= span.start && start < span.end);
}

function hasSectioningAncestor(
  elements: readonly ParsedElement[],
  element: ParsedElement,
): boolean {
  for (let index = element.parent; index >= 0;) {
    const ancestor = elements[index];
    if (ancestor === undefined) return false;
    if (SECTIONING_ELEMENTS.has(ancestor.name)) return true;
    index = ancestor.parent;
  }
  return false;
}

/** Outermost closed elements inside `within` that satisfy `predicate`, in document order. */
function outermostSpans(
  elements: readonly ParsedElement[],
  within: Span,
  predicate: (element: ParsedElement) => boolean,
): Span[] {
  const spans: Span[] = [];
  let coveredUntil = within.start;
  for (const element of elements) {
    if (element.start < coveredUntil || element.start >= within.end) continue;
    const span = closedSpan(element);
    if (span === undefined || span.end > within.end || !predicate(element)) continue;
    spans.push(span);
    coveredUntil = span.end;
  }
  return spans;
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
  return texts.some(
    ({ start }) =>
      start < within.start ||
      start >= within.end ||
      cuts.some((cut) => start >= cut.start && start < cut.end),
  );
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
 * text, then the page's only `<article>`, and otherwise strips `<nav>` and `<aside>` plus
 * `<header>` and `<footer>` that belong to the page rather than to a section. `<nav>` elements are
 * also cut from selected main content. Returns `undefined` when nothing qualifies or nothing would
 * be removed, so the caller converts the whole page. Only elements with an end tag are selected or
 * cut, so an unclosed tag never swallows the rest of the page.
 */
export function extractMainContent(html: string): HtmlMainContent | undefined {
  const page = parsePage(html);
  const { elements, texts } = page;
  const everything: Span = { start: 0, end: html.length };
  const isNavigation = (element: ParsedElement): boolean => element.name === "nav";

  const main = elements.find((element) => {
    const span = closedSpan(element);
    return isMainElement(element) && span !== undefined && hasText(texts, span);
  });
  const mainSpan = main === undefined ? undefined : closedSpan(main);
  if (mainSpan !== undefined) {
    return select(page, html, mainSpan, outermostSpans(elements, mainSpan, isNavigation));
  }

  const articles = outermostSpans(elements, everything, (element) => element.name === "article");
  const article = articles.length === 1 ? articles[0] : undefined;
  if (article !== undefined && hasText(texts, article)) {
    return select(page, html, article, outermostSpans(elements, article, isNavigation));
  }

  const body = elements.find((element) => element.name === "body" && element.end !== undefined);
  const bodySpan = (body === undefined ? undefined : closedSpan(body)) ?? everything;
  const chrome = outermostSpans(elements, bodySpan, (element) => {
    if (element.name === "nav" || element.name === "aside") return true;
    return (
      (element.name === "header" || element.name === "footer") &&
      !hasSectioningAncestor(elements, element)
    );
  });
  const stripped = select(page, html, bodySpan, chrome);
  const remaining = texts.some(
    ({ start }) =>
      start >= bodySpan.start &&
      start < bodySpan.end &&
      !chrome.some((cut) => start >= cut.start && start < cut.end),
  );
  return chrome.length > 0 && stripped.chromeRemoved && remaining ? stripped : undefined;
}
