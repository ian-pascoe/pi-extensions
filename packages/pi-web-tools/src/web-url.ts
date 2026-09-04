/** Remove URL user information before a Web Tool value reaches errors or Transcript Presentation. */
export function redactWebUrlUserinfo(input: string): string {
  try {
    const url = new URL(input);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return input.replace(/^([a-z][a-z\d+.-]*:\/\/)[^/@]*@/i, "$1");
  }
}

/** Reduce an absolute Web Fetch URL to the host and request target shown in a compact call row. */
export function webFetchUrlTarget(input: string): string {
  const safeUrl = redactWebUrlUserinfo(input);
  try {
    const url = new URL(safeUrl);
    return `${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return safeUrl;
  }
}
