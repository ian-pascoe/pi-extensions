/**
 * A tool input rejected locally, before any language server is asked, such as a missing file or a
 * position past the end of the document. The caller can correct it, so it is reported as an input
 * error rather than a server failure and carries no troubleshooting hint (ADR-0005).
 */
export class LspInputError extends Error {
  /** Construct an input error whose message is prefixed with `Pi LSP:`. */
  constructor(message: string) {
    super(message.startsWith("Pi LSP:") ? message : `Pi LSP: ${message}`);
  }
}
