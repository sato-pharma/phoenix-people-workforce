// Next.js instrumentation hook. Forwards server-side request errors (App Router)
// to our own self-hosted app_error_events table (see src/lib/error-monitor/service.ts),
// so crashes stay queryable by HR ID/module.

import type { Instrumentation } from "next";

// Both are zero-import pure modules, chosen so this stays edge-safe (see the note below and each
// file's own header). `describeThrown` is the reason a Supabase `{ message, code, hint }` throw
// reaches the error table as its own text rather than as "[object Object]";
// `isBenignClientDisconnect` is the reason an aborted request does not reach it at all.
import { isBenignClientDisconnect } from "@/lib/error-monitor/benign-disconnect";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
// Import-free as well. The SDK itself is only ever loaded dynamically, from inside the nodejs guards below.
import { sentryServerStatus } from "@/lib/observability/sentry-policy";

// Starts the continuous iReports360 live poller (src/lib/crm/live-poller.ts) exactly once per
// server process. The import MUST stay dynamic and inside the nodejs-runtime guard: this hook is
// bundled for BOTH runtimes (see the edge-safety note below), and the poller pulls in the whole
// CRM/Supabase server stack. The poller's own guards (PHOENIX_LIVE_CRM_POLL flag, production
// build, Railway production env) make this a no-op everywhere except the live Railway service —
// and a startup failure must never break boot, hence the catch.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // FIRST, before anything can make an outbound call: hold the sockets to Supabase open.
    // Node closes an idle fetch socket after 4s, and a fresh connection to Frankfurt costs
    // ~3.2 x RTT against ~1.1 x for a reused one — paid on each of the ~8 PostgREST round
    // trips a request makes. Dynamic import for the same edge-safety reason as the rest of
    // this block, and it reports rather than throws: a slower Phoenix beats one that will
    // not boot. See src/lib/observability/keep-alive.ts.
    try {
      const { pinKeepAliveDispatcher } = await import("@/lib/observability/keep-alive");
      const result = await pinKeepAliveDispatcher();
      console.log(
        result.pinned
          ? `[keep-alive] pinned: idle sockets held ${result.keepAliveTimeoutMs}ms`
          : `[keep-alive] not pinned: ${result.reason}`,
      );
    } catch (error) {
      console.error("[keep-alive] failed to pin:", error);
    }

    // Sentry (sentry.io), PRODUCTION ONLY and errors only — sentry-policy.ts decides, from APP_ENV and
    // the DSN, so staging, the previews and a laptop never load the SDK. Second, so a scheduler that
    // throws while starting below is already covered by its process handlers. Own try: Sentry must never
    // be the reason Phoenix does not boot.
    try {
      const status = sentryServerStatus({ appEnv: process.env.APP_ENV, dsn: process.env.SENTRY_DSN });
      if (status.enabled) {
        const { initSentryServer } = await import("@/lib/observability/sentry-server");
        initSentryServer(process.env.SENTRY_DSN as string);
        console.log("[sentry] started: production errors are forwarded to sentry.io");
      } else {
        console.log(`[sentry] not started: ${status.reason}`);
      }
    } catch (error) {
      console.error("[sentry] failed to start:", error);
    }

    try {
      const { startLiveCrmPoller } = await import("@/lib/crm/live-poller");
      const result = startLiveCrmPoller();
      if (!result.started) console.log(`[crm:live-poll] not started: ${result.reason}`);
    } catch (error) {
      console.error("[crm:live-poll] failed to start:", error);
    }

    // The Early Birds fortnight close runs on its own timer, started separately and in its own try:
    // it needs the poller's host guards but NOT the iReports360 credentials, so a poller that refuses
    // to start (or fails to) must not take the close down with it.
    try {
      const { startEarlyBirdsCloseScheduler } = await import("@/lib/early-birds/close-scheduler");
      const result = startEarlyBirdsCloseScheduler();
      if (!result.started) console.log(`[early-birds:close] not started: ${result.reason}`);
    } catch (error) {
      console.error("[early-birds:close] failed to start:", error);
    }

    // The CRM housekeeping timer keeps the probation double-visit capture running after the CRM
    // cutover stands the poller and the vendor crons down. Same host guards, no vendor credentials,
    // and its own try for the same reason as the close above.
    try {
      const { startCrmHousekeepingScheduler } = await import("@/lib/crm/housekeeping-scheduler");
      const result = startCrmHousekeepingScheduler();
      if (!result.started) console.log(`[crm:housekeeping] not started: ${result.reason}`);
    } catch (error) {
      console.error("[crm:housekeeping] failed to start:", error);
    }

    // One process-health line a minute (event-loop delay, heap, RSS, request timings). Production
    // only by its own guard; dynamic for the same edge-safety reason as the three above, and its
    // own try so telemetry can never take a scheduler down with it.
    try {
      const { startProcessHealthReporter } = await import("@/lib/observability/process-health");
      startProcessHealthReporter();
    } catch (error) {
      console.error("[process-health] failed to start:", error);
    }
  }
}

// Deliberately avoids importing any server-only module (session/crypto code
// lives behind resolveAccessContext, which needs Node's crypto — unavailable
// in the Edge Runtime). This hook runs in BOTH runtimes, and Turbopack bundles
// it for both regardless of runtime checks, so a direct import here would
// break the edge build. Forwarding to our own /api/errors/client endpoint
// (which does the HR-ID/module resolution safely inside its own nodejs-only
// route) keeps instrumentation.ts itself edge-safe with only `fetch`.
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function forwardServerErrorToIngestion(
  error: unknown,
  request: { headers?: Record<string, string | string[] | undefined>; path?: string },
  context: { routeType?: string },
) {
  try {
    const host = firstHeaderValue(request.headers?.host) || firstHeaderValue(request.headers?.["x-forwarded-host"]);
    if (!host) return;

    const protocol =
      firstHeaderValue(request.headers?.["x-forwarded-proto"]) || (host.startsWith("localhost") ? "http" : "https");
    const cookie = firstHeaderValue(request.headers?.cookie);
    const origin = `${protocol}://${host}`;

    // The app-wide CSRF guard (src/lib/security/csrf.ts) rejects any mutation
    // request that lacks an Origin/Referer matching the request's own host —
    // this server-to-server call needs an explicit Origin for the same reason
    // a browser's same-origin fetch would carry one automatically.
    const headers: Record<string, string> = { "Content-Type": "application/json", Origin: origin };
    if (cookie) headers.cookie = cookie;

    await fetch(`${origin}/api/errors/client`, {
      body: JSON.stringify({
        // NOT `String(error)` — that was the bug. This hook is the catch-all under every route
        // handler and server component, so a plain-object throw (every Supabase PostgrestError)
        // arrived here and was forwarded as the literal string "[object Object]". The receiving
        // route stores whatever it is handed, so the loss happened HERE and nothing downstream
        // could recover it. 7 such rows on /api/auth/heartbeat are still in production.
        message: describeThrown(error),
        route: request.path || null,
        routeType: context?.routeType ?? null,
        source: "server",
        stack: error instanceof Error ? (error.stack ?? null) : null,
      }),
      headers,
      method: "POST",
    });
  } catch (loggingError) {
    // Never let our own logging break request-error reporting.
    console.error("Failed to forward server request error to app_error_events:", loggingError);
  }
}

// The Sentry half of onRequestError. Reached only in the nodejs runtime AND only when the policy says
// production, so on every other deployment this is a no-op that never imports the SDK. Never throws.
async function forwardRequestErrorToSentry(
  ...args: Parameters<Instrumentation.onRequestError>
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!sentryServerStatus({ appEnv: process.env.APP_ENV, dsn: process.env.SENTRY_DSN }).enabled) return;
  try {
    const { captureRequestErrorInSentry } = await import("@/lib/observability/sentry-server");
    captureRequestErrorInSentry(...args);
  } catch (sentryError) {
    console.error("Failed to forward request error to Sentry:", sentryError);
  }
}

// Captures errors thrown in nested React Server Components / route handlers —
// forwards to our own error table.
//
// The disconnect test lives in @/lib/error-monitor/benign-disconnect rather than inline here. It
// used to be an inline set of errno codes, which stopped covering the case the moment Next 16.3.3
// began throwing "The destination stream closed early." with no `code` on it — 15 rows in eight
// hours against a 3-to-7-a-day baseline. Keeping the rule in one pinned, testable module is what
// makes the next such wording change a one-line edit with a test behind it.
export async function onRequestError(...args: Parameters<Instrumentation.onRequestError>) {
  const [error, request, context] = args;
  if (isBenignClientDisconnect(error)) return;
  await forwardRequestErrorToSentry(error, request, context);
  await forwardServerErrorToIngestion(error, request, context);
}
