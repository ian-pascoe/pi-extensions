# Pi Web Tools context

`@ian-pascoe/pi-web-tools` gives Pi model-invoked access to textual web and network content without browser automation or an extension-owned crawler.

## Glossary

- **Web Search**: a query sent to a remote Search Provider that returns model-readable search results. The Provider may fetch result pages when live crawling is requested.
- **Web Fetch**: retrieval of one URL as model-readable textual content. It preserves textual formats, converts HTML to Markdown, and does not execute page JavaScript or follow page links.
- **Search Provider**: the remote service that answers Web Search requests. A Provider may accept anonymous requests or an optional API key.
