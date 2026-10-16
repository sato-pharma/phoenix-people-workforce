import * as Sentry from "@sentry/nextjs";

import { SENTRY_ENVIRONMENT, scrubSentryEvent } from "@/lib/observability/sentry-policy";

// The Sentry SDK for the Node server. Imported DYNAMICALLY, and only after sentry-policy.ts has said
// production, so a staging or local process never loads the SDK at all (see instrumentation.ts).
//
// ERRORS ONLY. No tracing, no profiling, no session replay, no OpenTelemetry tracer provider and no
// load-time module rewriting: Phoenix already measures latency itself (process-health, timings) and the
// payroll server should not gain a second set of hooks on its modules just to learn about a crash. Two
// things reach Sentry from here: an exception nothing caught (the SDK's own process handlers) and the
// request errors Next hands to `onRequestError` (captureRequestErrorInSentry).

let started = false;

export function initSentryServer(dsn: string): void {
  if (started) return;
  started = true;
  Sentry.init({
    dsn,
    environment: SENTRY_ENVIRONMENT,
    release: process.env.COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    sendDefaultPii: false,
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    beforeSend: (event) => scrubSentryEvent(event),
  });
}

export function captureRequestErrorInSentry(...args: Parameters<typeof Sentry.captureRequestError>): void {
  if (!started) return;
  Sentry.captureRequestError(...args);
}
