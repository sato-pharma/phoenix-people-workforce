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
import { isModuleLockRefusal } from "@/lib/error-monitor/expected-refusal";
import { SERVER_FORWARD_PROOF_HEADER, signServerErrorForward } from "@/lib/error-monitor/server-forward-proof";

// Starts this process's in-process schedulers (the Early Birds fortnight close and the CRM
// housekeeping timer) exactly once per server process. Their imports MUST stay dynamic and inside
// the nodejs-runtime guard: this hook is bundled for BOTH runtimes (see the edge-safety note below),
// and each pulls in the whole CRM/Supabase server stack. Their own host guards
// (src/lib/platform/in-process-host.ts) make them a no-op everywhere except the Railway worker — and
// a startup failure must never break boot, hence the catches. (The iReports360 live poller that
// started here was removed with the vendor, retired on 6 November 2026.)
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // THE TEST-ACCOUNT FENCE, before any call can leave: a test account's save outside Phoenix CRM runs
    // every check and saves nothing (owner, 2026-11-06) because this wrapper answers each write it makes
    // (src/lib/auth/test-dry-run.ts). If it fails to install, resolveAccessContext refuses those saves
    // as before (testDryRunFenceIsLive) — so a failure here costs the dry run, never a real write.
    try {
      const { installTestDryRunFetchFence, testDryRunFenceIsLive } = await import("@/lib/auth/test-dry-run");
      installTestDryRunFetchFence();
      console.log(`[test-dry-run] fence ${(await testDryRunFenceIsLive()) ? "installed" : "NOT installed — test accounts' saves stay refused"}`);
    } catch (error) {
      console.error("[test-dry-run] failed to install:", error);
    }

    // Then, before anything can make an outbound call: hold the sockets to Supabase open.
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

    // Which process this is. A `web` process answers pages and starts none of the schedulers below
    // (resolveInProcessHostRefusal refuses them); the `worker` service runs them, so a heavy job can no
    // longer freeze every page (src/lib/platform/process-role.ts). Said once at boot, a typo loudest.
    try {
      const { isUnrecognisedProcessRole, resolveProcessRole } = await import("@/lib/platform/process-role");
      const raw = process.env.PHOENIX_PROCESS_ROLE;
      if (isUnrecognisedProcessRole(raw)) {
        console.error(`[process-role] PHOENIX_PROCESS_ROLE=${JSON.stringify(raw)} is not web, worker, robot or all — running as "all"`);
      }
      const role = resolveProcessRole(raw);
      console.log(`[process-role] ${role}`);
      // Production pages must not share their thread with the schedulers. "all" there means the
      // web/worker split was never configured, and every heavy job freezes every page again.
      if (role === "all" && process.env.RAILWAY_ENVIRONMENT_NAME === "production" && process.env.NODE_ENV === "production") {
        console.error(
          '[process-role] production is running as "all" — background jobs share the page server\'s event loop. ' +
            "Set PHOENIX_PROCESS_ROLE=web here and run a worker service with PHOENIX_PROCESS_ROLE=worker.",
        );
      }
    } catch (error) {
      console.error("[process-role] failed to resolve:", error);
    }

    // 🔴 THE TWO SCHEDULERS AND PROCESS-HEALTH ARE COMPILED ONLY IN A PRODUCTION BUILD. Each refuses a
    // non-production build at run time anyway (resolveInProcessHostRefusal: "not a production build";
    // startProcessHealthReporter returns on NODE_ENV), so under `next dev` they were compiled and never
    // run: 465 repo files and 52 MB of emitted code, more than half of everything a dev server compiled
    // before its first page (measured on the Hetzner box, 2026-10-17). A BLOCK-form NODE_ENV test is the
    // only shape webpack prunes — Next inlines the value, so the branch is `if (false)` in dev — and the
    // nodejs block above is the proof: it keeps all three out of the edge bundle the same way.
    if (process.env.NODE_ENV === "production") {
      // The Early Birds fortnight close runs on its own timer, in its own try, so a scheduler that
      // refuses to start (or fails to) never takes the other one down with it.
      try {
        const { startEarlyBirdsCloseScheduler } = await import("@/lib/early-birds/close-scheduler");
        const result = startEarlyBirdsCloseScheduler();
        if (!result.started) console.log(`[early-birds:close] not started: ${result.reason}`);
      } catch (error) {
        console.error("[early-birds:close] failed to start:", error);
      }

      // The CRM housekeeping timer: the contact-master refresh and the probation double-visit capture.
      // Same host guards, and its own try for the same reason as the close above.
      try {
        const { startCrmHousekeepingScheduler } = await import("@/lib/crm/housekeeping-scheduler");
        const result = startCrmHousekeepingScheduler();
        if (!result.started) console.log(`[crm:housekeeping] not started: ${result.reason}`);
      } catch (error) {
        console.error("[crm:housekeeping] failed to start:", error);
      }

      // One process-health line a minute (event-loop delay, heap, RSS, request timings). Production
      // only by its own guard; dynamic for the same edge-safety reason as the two above, and its
      // own try so telemetry can never take a scheduler down with it.
      try {
        const { startProcessHealthReporter } = await import("@/lib/observability/process-health");
        startProcessHealthReporter();
      } catch (error) {
        console.error("[process-health] failed to start:", error);
      }

      // One `db_host` line a minute about the DATABASE SERVER (memory, swap, CPU, disks, start times),
      // read from Supabase's metrics endpoint. One process only — the worker, or "all" before a split —
      // and production by APP_ENV; db-host-metrics.ts decides and says why when it does not start.
      try {
        const { startDbHostSampler } = await import("@/lib/observability/db-host-sampler");
        const result = startDbHostSampler();
        console.log(result.started ? "[db-host] sampling once a minute" : `[db-host] not started: ${result.reason}`);
      } catch (error) {
        console.error("[db-host] failed to start:", error);
      }

      // The film studio for the ChatGPT connector: one queued film at a time, rendered as the person who
      // asked. Worker (or "all") on Railway only — a laptop's server, whose .env.local is PRODUCTION, must
      // never pick up a film (src/lib/chatgpt-connector/films/worker.ts). Its own try, like the rest.
      try {
        const { startFilmWorker } = await import("@/lib/chatgpt-connector/films/worker");
        const result = startFilmWorker();
        console.log(result.started ? "[films] studio running" : `[films] not started: ${result.reason}`);
      } catch (error) {
        console.error("[films] failed to start:", error);
      }
    } else {
      console.log("[schedulers] not started: not a production build (next dev does not compile them)");
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
    // The proof only this server can sign: it is what lets the route send the new-error Telegram for a
    // server error that carried no cookie (a cron hit, a webhook), and refuse it for anyone who merely
    // posts `source: "server"` themselves. An HMAC with a one-minute expiry, never the secret (the origin
    // above is built from the request's own Host header).
    const proof = await signServerErrorForward();
    if (proof) headers[SERVER_FORWARD_PROOF_HEADER] = proof;

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
  if (isModuleLockRefusal(error)) return;
  await forwardServerErrorToIngestion(error, request, context);
}
