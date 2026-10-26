/**
 * The browser's copy of an error that was thrown while the SERVER rendered the page.
 *
 * A production build redacts it before it leaves the server: the browser receives a digest and a
 * placeholder, and React's production client throws that placeholder as error #441. It arrives in
 * either of two spellings — minified ("Minified React error #441; visit https://react.dev/errors/441
 * …", which is what every browser sent in the 14 days to 26 Oct 2026) or spelled out ("An error
 * occurred in the Server Components render. The specific message is omitted in production builds …").
 * The server already recorded the real error through `onRequestError`, so this copy carries no cause.
 *
 * ZERO IMPORTS, DELIBERATELY — read by the browser's Sentry forwarder.
 */
const REDACTED_SERVER_RENDER = [
  /\bMinified React error #441\b/,
  /An error occurred in the Server Components render/,
];

export function isRedactedServerRenderError(message: string): boolean {
  return REDACTED_SERVER_RENDER.some((pattern) => pattern.test(message));
}
