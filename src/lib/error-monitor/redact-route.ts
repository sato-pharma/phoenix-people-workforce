// Strips single-use credentials out of a request path before it is stored.
//
// Eleven route families in this app carry a secret IN THE PATH ITSELF — a password-setup token, an
// unsubscribe token, a share-link token. When one of those pages throws, the error monitor
// records `route`, and the token goes into `app_error_events` in plaintext, WHILE IT IS STILL
// VALID: the row is written the moment the page opens, before anybody has used the link. A
// password-setup token is good for 48 hours and sets an employee's password; the share-link
// tables store their token unhashed, so the stored route IS the working link.
//
// Two properties make this safe to derive rather than guess:
//   - every such segment is a Next.js dynamic segment literally named `[token]`, so the set of
//     families is a fact about the filesystem, not a judgement call; and
//   - `tests/error-monitor-redact-route.test.ts` reads that set back off disk and fails if this
//     list disagrees with it — so a new `[token]` route added tomorrow turns CI red until it is
//     listed here, rather than quietly logging its own secret.
//
// Pure, no I/O. Redaction happens at CAPTURE (see logAppError), not at read time: a token that
// was never written cannot leak from a backup, an export, or an AI triage prompt.

/**
 * The route prefixes whose NEXT path segment is a credential, in the order the routes sit on
 * disk. Matched literally, so `/api/share/territory/x` redacts while a longer sibling such as
 * `/api/shareholder/...` does not.
 */
export const CREDENTIAL_ROUTE_PREFIXES: readonly string[] = [
  "/api/admin/email-templates/custom-variables",
  "/api/auth/password-setup",
  "/api/email-signature",
  "/api/email/unsubscribe",
  "/api/public/offer-acceptance",
  "/api/recruitment/interview-calendar/ics",
  "/api/sato-email/media",
  "/api/share/cv-lifecycle",
  "/api/share/direct-orders",
  "/api/share/marketing-requests",
  "/api/share/territory",
  "/join",
  "/password-setup",
  "/share/card",
  "/share/direct-orders",
  "/share/interview-calendar",
  "/share/territory",
];

/** The placeholder left behind. Matches the Next.js segment name, so the route stays readable. */
export const TOKEN_PLACEHOLDER = "[token]";

function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// One matcher per family: the prefix, a slash, then the segment up to the next delimiter.
//
// Whitespace and quotes end the segment as well as the URL delimiters, because this also runs
// over FREE TEXT — an error message reads `GET /password-setup/<token> failed`, and stopping only
// at `/?#` would have eaten the rest of the sentence. Erring toward over-redaction here is
// deliberate: a comma left inside the placeholder is cosmetic, half a token left outside it is not.
const PATH_MATCHERS: readonly RegExp[] = CREDENTIAL_ROUTE_PREFIXES.map(
  (prefix) => new RegExp(`(${escapeForRegExp(prefix)}/)[^/?#\\s"'<>]+`, "gi"),
);

// Secrets also travel as query parameters. Anchored on `?` or `&` so an ordinary parameter whose
// name merely ENDS in one of these words (`sortKey=`, `area_code=`) is left alone. `link` is the
// interview calendar's copy link, carried on the CV and download addresses a browser opens itself.
const QUERY_MATCHER =
  /([?&](?:token|access_token|refresh_token|id_token|secret|client_secret|api[-_]?key|key|code|passcode|password|signature|sig|link)=)[^&#\s]+/gi;

/**
 * Replace any credential carried in a request path or query string with `[token]`.
 *
 * Returns the route unchanged when it holds nothing secret — this runs on every logged error,
 * and an over-eager version would make the error monitor unreadable. Re-running it on an
 * already-redacted route is a no-op, so a re-log cannot corrupt the placeholder.
 */
export function redactSecretsFromRoute(route: string | null | undefined): string | null {
  if (route === null || route === undefined) return null;
  if (!route) return route;

  let out = route;
  for (const matcher of PATH_MATCHERS) {
    out = out.replace(matcher, `$1${TOKEN_PLACEHOLDER}`);
  }
  return out.replace(QUERY_MATCHER, `$1${TOKEN_PLACEHOLDER}`);
}
