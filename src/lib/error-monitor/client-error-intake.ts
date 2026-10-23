// The limits on /api/errors/client — the one endpoint anyone, signed in or not, can write a row into
// System Issues through.
//
// WHY (23 Oct 2026 audit, P5-03). The route is unauthenticated on purpose (a crash on the login page must
// still be reported), but it had no rate limit and no size cap on `route`, `digest`, `routeType`,
// `componentStack` or `clientContext`, so one script could fill `app_error_events`, the System Issues
// screen and the weekly Telegram digest with whatever it liked. These limits are generous for a real
// browser — a crashing page reports a handful of errors — and close the flood.
//
// Pure, so the caps are tested without a request or a database.

/** Reports one address may send per window. A real crash loop reports a few; a flood is cut here. */
export const CLIENT_ERROR_RATE_LIMIT = 30;
export const CLIENT_ERROR_RATE_WINDOW_MS = 60_000;

/** The whole body. A real report is a message, a stack and a little context — far below this. */
export const CLIENT_ERROR_MAX_BODY_BYTES = 64 * 1024;

export const CLIENT_ERROR_FIELD_CAPS = {
  clientContext: 4_000,
  componentStack: 8_000,
  digest: 128,
  message: 4_000,
  route: 512,
  routeType: 64,
  stack: 16_000,
} as const;

type CappedField = keyof typeof CLIENT_ERROR_FIELD_CAPS;

export type ClientErrorReport = {
  clientContext: string | null;
  componentStack: string | null;
  digest: string | null;
  message: string | null;
  route: string | null;
  routeType: string | null;
  source: "client" | "server";
  stack: string | null;
};

function capped(body: Record<string, unknown> | null, field: CappedField): string | null {
  const value = body?.[field];
  if (typeof value !== "string") return null;
  const cap = CLIENT_ERROR_FIELD_CAPS[field];
  return value.length > cap ? value.slice(0, cap) : value;
}

/** Every field the route stores, as a string no longer than its cap, or null. */
export function sanitizeClientErrorReport(body: unknown): ClientErrorReport {
  const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  return {
    clientContext: capped(record, "clientContext"),
    componentStack: capped(record, "componentStack"),
    digest: capped(record, "digest"),
    message: capped(record, "message"),
    route: capped(record, "route"),
    routeType: capped(record, "routeType"),
    source: record?.source === "server" ? "server" : "client",
    stack: capped(record, "stack"),
  };
}

/** Is a declared Content-Length over the body cap? A missing or unreadable header is not (the read is capped too). */
export function clientErrorBodyTooLarge(contentLength: string | null): boolean {
  const length = Number(contentLength);
  return Number.isFinite(length) && length > CLIENT_ERROR_MAX_BODY_BYTES;
}
