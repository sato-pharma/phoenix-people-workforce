// Where Sentry (sentry.io) may run, and what may leave in an event. Pure and import-free on purpose:
// instrumentation.ts is bundled for BOTH runtimes and imports this statically, so nothing here may pull
// in the SDK, a Node module or the Supabase stack. The SDK itself lives in sentry-server.ts (loaded
// dynamically, only when this file says yes) and sentry-client.ts (same, in the browser).
//
// PRODUCTION ONLY, decided by the DEPLOYMENT NAME and not by the build mode. A Phoenix build is
// `NODE_ENV=production` on staging, on the Hetzner previews and on a laptop's `next start` alike, so
// `isProductionRuntime()` cannot be the gate — and its `NODE_ENV` fallback is exactly how staging once
// looked like production (APP_ENV unset, 2026-08). `APP_ENV` must be literally `production`, AND the
// DSN must be present: a staging service that never receives the variables is off by construction, and a
// staging service that somehow did receive them is still off because its APP_ENV is not `production`.

export const SENTRY_ENVIRONMENT = "production";

/** A DSN is `https://<public key>@<host>/<project id>`. Anything else is treated as "not configured". */
export function parseSentryDsn(dsn: string | null | undefined): { origin: string } | null {
  const raw = String(dsn ?? "").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (!url.username) return null;
    if (url.pathname.replace(/\//g, "").length === 0) return null;
    return { origin: url.origin };
  } catch {
    return null;
  }
}

export type SentryServerStatus = { enabled: true } | { enabled: false; reason: string };

/**
 * The server-side gate. Takes the two values rather than `process.env`: Next declares NODE_ENV as a
 * required key of NodeJS.ProcessEnv, so a function taking an env bag cannot be handed a literal in a test.
 */
export function sentryServerStatus(input: { appEnv: string | undefined; dsn: string | undefined }): SentryServerStatus {
  if (String(input.appEnv ?? "").trim().toLowerCase() !== "production") {
    return { enabled: false, reason: "APP_ENV is not 'production'" };
  }
  if (!parseSentryDsn(input.dsn)) return { enabled: false, reason: "SENTRY_DSN is missing or not a valid DSN" };
  return { enabled: true };
}

/**
 * The browser-side gate. The browser cannot read APP_ENV, so it asks the one thing it does know: the
 * host it was served from. `NEXT_PUBLIC_SENTRY_DSN` is baked at build time, which means a build made for
 * staging would only carry it if someone put it there — the host check keeps that mistake harmless.
 */
export function sentryClientStatus(input: {
  dsn: string | undefined;
  hostname: string | undefined;
  productionHost: string;
}): SentryServerStatus {
  if (!parseSentryDsn(input.dsn)) return { enabled: false, reason: "NEXT_PUBLIC_SENTRY_DSN is missing or not a valid DSN" };
  if (String(input.hostname ?? "").toLowerCase() !== input.productionHost.toLowerCase()) {
    return { enabled: false, reason: "not served from the production host" };
  }
  return { enabled: true };
}

/** The shape of an event that this module is allowed to touch — structural, so no SDK type is imported. */
export type ScrubbableSentryEvent = {
  request?: {
    cookies?: unknown;
    data?: unknown;
    headers?: Record<string, unknown>;
    query_string?: unknown;
  };
  user?: unknown;
};

// Headers that identify a session or a person. Phoenix's session cookie, the dev-auth role headers and
// the usual bearer tokens: none of them has any business in a third party's database.
const SENSITIVE_HEADER = /^(cookie|set-cookie|authorization|proxy-authorization|x-phoenix-.*|x-forwarded-for|x-real-ip|x-api-key)$/i;

/**
 * Strips what identifies a person or a session from an event before it leaves the building.
 * SDK 11 has no `sendDefaultPii` switch any more, so this is the ONLY lock, not a second one: Phoenix's
 * pages carry payroll and HR identifiers in URLs and request bodies and an SDK default must not
 * quietly ship them.
 */
export function scrubSentryEvent<T extends ScrubbableSentryEvent>(event: T): T {
  const scrubbable = event as ScrubbableSentryEvent;
  delete scrubbable.user;
  const request = scrubbable.request;
  if (request) {
    delete request.cookies;
    delete request.data;
    delete request.query_string;
    if (request.headers) {
      for (const name of Object.keys(request.headers)) {
        if (SENSITIVE_HEADER.test(name)) delete request.headers[name];
      }
    }
  }
  return event;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Everything beyond errors (owner, 2026-10-16: "i want to setup everything that could be on sentry"):
// tracing, session replay, profiling, logs, cron check-ins and releases. Each one sends MORE than an
// exception does, so each is bounded here, in pure functions the tests can call:
//   - a sampling rate small enough to live inside a free quota,
//   - a scrubber that runs on the data before it leaves, because Phoenix's URLs, queries and log lines
//     carry HR ids, names and payroll figures.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Share of requests and page loads that become a trace. Small on purpose: a quota is spent per span. */
export const SENTRY_TRACES_SAMPLE_RATE = 0.05;

/**
 * Session replay records only the session of a user who hit an error (the lead-up to it), never an
 * ordinary one. `replaysSessionSampleRate` 0 is the line that keeps every normal session unrecorded.
 */
export const SENTRY_REPLAY_SESSION_SAMPLE_RATE = 0;
export const SENTRY_REPLAY_ON_ERROR_SAMPLE_RATE = 1;

/**
 * Profiling runs only INSIDE a sampled trace (`profileLifecycle: 'trace'`), so its real share of traffic is
 * this rate times the trace rate above — which is why it is OFF while the page survey below traces every
 * page: then the profiler ran on every page too. Measured on production 2026-10-16 at the same traffic, the
 * worst event-loop stall of a typical minute went from 31-88 ms to 372 ms once the survey began, with 7 of
 * 18 minutes over half a second. Read ONCE, when the process starts, so a server booted during the survey
 * keeps the profiler off until its next deploy — harmless, and never the other way round.
 */
export function sentryProfileSessionSampleRate(nowMs: number = Date.now()): number {
  return nowMs < SENTRY_PAGE_SURVEY_ENDS_AT_MS ? 0 : 1;
}

// Traffic that says nothing: the platform's own health probe, the error reporter's own endpoint (tracing the
// thing that reports failures only multiplies them) and the static asset tree.
const QUIET_ROUTE = /(^|[\s/])(api\/healthz|api\/health\b|api\/errors\/client|_next\/|favicon\.ico)/i;

/** Is this transaction name one nobody needs a trace of? */
export function isQuietSentryRoute(name: string | undefined): boolean {
  return QUIET_ROUTE.test(String(name ?? ""));
}

// Owner, 2026-10-16: "measure all pages, every single page". At 5% a page nobody opens often has no timing at all, so
// for three days every PAGE request is traced (API calls stay at the fixed rate). It ends by itself: after the
// instant below the sampler is back to the fixed rate with no deploy and nobody to remember. Cairo is UTC+3 until
// the clocks change on 2026-10-29, so this midnight is 21:00 UTC on the 19th.
export const SENTRY_PAGE_SURVEY_ENDS_AT_MS = Date.UTC(2026, 9, 19, 21, 0, 0);

const PAGE_TRANSACTION = /^(?:GET\s+)?\/(?!api\/)/i;

/** Is this transaction name a page (not an API call, not a bare "RSC GET" or "middleware GET")? */
export function isSentryPageTransaction(name: string | undefined): boolean {
  return PAGE_TRANSACTION.test(String(name ?? ""));
}

/**
 * `tracesSampler` for both runtimes: zero for quiet routes, a parent's decision wins, every page while the survey
 * window is open, and the fixed rate for everything else.
 */
export function sentryTracesSampler(
  context: { name?: string; parentSampled?: boolean | undefined },
  nowMs: number = Date.now(),
): number {
  if (isQuietSentryRoute(context.name)) return 0;
  if (typeof context.parentSampled === "boolean") return context.parentSampled ? 1 : 0;
  if (nowMs < SENTRY_PAGE_SURVEY_ENDS_AT_MS && isSentryPageTransaction(context.name)) return 1;
  return SENTRY_TRACES_SAMPLE_RATE;
}

// Path segments that name ONE thing: an HR id (B-10), a bare number, or a long token (a 36-character uuid is one). Phoenix puts
// all of them in URLs (/admin/employees/B-10, /payroll/2026-10/…), and a span name is a URL.
const IDENTIFYING_SEGMENT = /^(?:[A-Za-z]{1,3}-?\d{1,8}|\d+|[A-Za-z0-9_-]{24,})$/i;
const HR_ID_IN_TEXT = /\b[A-Z]-\d{1,6}\b/g;
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

// A PostgREST call is `/rest/v1/<table>` or `/rest/v1/rpc/<function>`: the segments after `/rest/v1/` are SCHEMA names, never
// data (the values ride in the query string, which is dropped). They must survive, or every outbound database span reads as
// the same call. Until 2026-10-17 `v1` and any table name of 24+ characters were masked as `:id`, so 100,120 spans in a day
// read `/rest/:id/:id`, and Sentry raised an "N+1 API Call" issue on a cron that reads thirty different tables.
const POSTGREST_PATH = /^(\/rest\/v1\/(?:rpc\/)?[A-Za-z_][A-Za-z0-9_]*)(?:\/.*)?$/;
// The API version after a Supabase service name (`/auth/v1/…`, `/storage/v1/…`) is the same kind of word: `v1` reads like an HR id.
const SUPABASE_SERVICE_SEGMENT = /^(?:rest|auth|storage|functions|graphql|realtime)$/;
const API_VERSION_SEGMENT = /^v\d{1,2}$/;

/** One URL path, query and fragment removed and every identifying segment replaced by `:id`. */
export function scrubSentryPath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] ?? "";
  const postgrest = POSTGREST_PATH.exec(withoutQuery);
  if (postgrest) return postgrest[1] as string;
  const segments = withoutQuery.split("/");
  return segments
    .map((segment, index) => {
      if (!segment) return segment;
      if (API_VERSION_SEGMENT.test(segment) && SUPABASE_SERVICE_SEGMENT.test(segments[index - 1] ?? "")) return segment;
      return IDENTIFYING_SEGMENT.test(segment) ? ":id" : segment;
    })
    .join("/");
}

/** Free text (a span name, a log message): paths lose their ids and queries, HR ids and e-mail addresses are masked. */
export function scrubSentryText(text: string): string {
  return text
    .replace(/(?:https?:\/\/[^\s/]+)?(\/[^\s"'<>)]*)/g, (match, path: string) => {
      const host = match.slice(0, match.length - path.length);
      return `${host}${scrubSentryPath(path)}`;
    })
    .replace(EMAIL_IN_TEXT, "[email]")
    .replace(HR_ID_IN_TEXT, ":id");
}

// Attributes that must not leave at all: who the user is, the caller's address, every header value, the
// query string and the SQL text (which carries the values).
const DROPPED_ATTRIBUTE = /^(user\.|enduser\.|client\.address|client\.ip|http\.request\.header\.|http\.response\.header\.|http\.request\.body|url\.query|http\.query|db\.statement|db\.query\.text|db\.query\.parameter)/i;
// Attributes that hold a URL or a name and are kept after scrubbing.
const SCRUBBED_ATTRIBUTE = /(url|path|target|route|name|description|address|message)/i;

type AttributeBag = Record<string, unknown>;

function scrubAttributeValue(value: unknown): unknown {
  if (typeof value === "string") return scrubSentryText(value);
  if (value && typeof value === "object" && typeof (value as { value?: unknown }).value === "string") {
    return { ...(value as object), value: scrubSentryText((value as { value: string }).value) };
  }
  return value;
}

function scrubAttributes(attributes: AttributeBag | undefined): void {
  if (!attributes) return;
  for (const key of Object.keys(attributes)) {
    if (DROPPED_ATTRIBUTE.test(key)) delete attributes[key];
    else if (SCRUBBED_ATTRIBUTE.test(key)) attributes[key] = scrubAttributeValue(attributes[key]);
  }
}

/** `beforeSendSpan` for both runtimes (SDK 11 streams spans, so `beforeSendTransaction` never runs). */
export function scrubSentrySpan<T extends { name: string; attributes?: AttributeBag }>(span: T): T {
  span.name = scrubSentryText(String(span.name ?? ""));
  scrubAttributes(span.attributes);
  return span;
}

// Log attributes that name a person, a credential or a figure.
const SENSITIVE_LOG_KEY = /(email|name|phone|salary|wage|amount|token|cookie|authorization|password|secret|hr_?id|user|employee|candidate)/i;

/** `beforeSendLog`: the message is scrubbed like a span name, a sensitive attribute is dropped, the rest is scrubbed. */
export function scrubSentryLog<T extends { message: unknown; attributes?: AttributeBag }>(log: T): T {
  if (typeof log.message === "string") (log as { message: unknown }).message = scrubSentryText(log.message);
  const attributes = log.attributes;
  if (attributes) {
    for (const key of Object.keys(attributes)) {
      if (key.startsWith("sentry.")) continue;
      if (SENSITIVE_LOG_KEY.test(key) || DROPPED_ATTRIBUTE.test(key)) delete attributes[key];
      else attributes[key] = scrubAttributeValue(attributes[key]);
    }
  }
  return log;
}
