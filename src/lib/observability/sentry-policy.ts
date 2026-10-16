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
 * `sendDefaultPii: false` already withholds most of it; this is the second lock, because Phoenix's
 * pages carry payroll and HR identifiers in URLs and request bodies and a changed SDK default must not
 * quietly start shipping them.
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
