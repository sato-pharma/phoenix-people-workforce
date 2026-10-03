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

// Starts the continuous iReports360 live poller (src/lib/crm/live-poller.ts) exactly once per
// server process. The import MUST stay dynamic and inside the nodejs-runtime guard: this hook is
// bundled for BOTH runtimes (see the edge-safety note below), and the poller pulls in the whole
// CRM/Supabase server stack. The poller's own guards (PHOENIX_LIVE_CRM_POLL flag, production
// build, Railway production env) make this a no-op everywhere except the live Railway service —
// and a startup failure must never break boot, hence the catch.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
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
  await forwardServerErrorToIngestion(error, request, context);
}
