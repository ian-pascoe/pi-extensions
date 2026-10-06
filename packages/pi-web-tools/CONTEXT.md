# Pi Web Tools context

`@ian-pascoe/pi-web-tools` gives Pi model-invoked access to textual web and network content without browser automation or an extension-owned crawler.

## Glossary

- **Web Search**: a query sent to a remote Search Provider that returns model-readable search results.
- **Web Fetch**: retrieval of one URL as model-readable textual content. It preserves textual formats, converts HTML to Markdown, and does not execute page JavaScript or follow page links.
- **Search Provider**: the remote service that answers Web Search requests. A Provider may accept anonymous requests or an optional API key.
- **Continuation note**: the last line of a Web Fetch result that stops before the end of the page, naming the lines shown, the lines remaining, and the `offset` that continues from the first unseen line. It is built after the output limit is applied and is not part of the spill file.
