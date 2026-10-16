import * as Sentry from "@sentry/nextjs";

import {
  SENTRY_ENVIRONMENT,
  SENTRY_PROFILE_SESSION_SAMPLE_RATE,
  scrubSentryEvent,
  scrubSentryLog,
  scrubSentrySpan,
  sentryTracesSampler,
} from "@/lib/observability/sentry-policy";

// The Sentry SDK for the Node server. Imported DYNAMICALLY, and only after sentry-policy.ts has said
// production, so a staging or local process never loads the SDK at all (see instrumentation.ts).
//
// Since 2026-10-16 (owner: "everything that could be on sentry") this sends MORE than errors: sampled
// traces and profiles, warn/error log lines, and cron check-ins. Each is bounded in sentry-policy.ts
// (sample rates, and a scrubber over every span and log) — nothing here may widen what leaves without
// going through those. Still NOT here: load-time module rewriting (`enableRuntimeChannelInjection`), so
// the payroll server does not get a second set of hooks on its modules.

let started = false;

export function initSentryServer(dsn: string): void {
  if (started) return;
  started = true;
  Sentry.init({
    dsn,
    environment: SENTRY_ENVIRONMENT,
    release: process.env.COMMIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    enableRuntimeChannelInjection: false,
    tracesSampler: (context) => sentryTracesSampler(context),
    profileSessionSampleRate: SENTRY_PROFILE_SESSION_SAMPLE_RATE,
    profileLifecycle: "trace",
    // The app already prints structured warn/error lines; those two levels become Sentry logs.
    integrations: [Sentry.consoleLoggingIntegration({ levels: ["warn", "error"] })],
    beforeSend: (event) => scrubSentryEvent(event),
    beforeSendSpan: (span) => scrubSentrySpan(span),
    beforeSendLog: (log) => scrubSentryLog(log),
  });
}

export function captureRequestErrorInSentry(...args: Parameters<typeof Sentry.captureRequestError>): void {
  if (!started) return;
  Sentry.captureRequestError(...args);
}

/**
 * One cron run, reported to Sentry's cron monitoring as a check-in. NO `monitorConfig`: a monitor exists only
 * where it was created in Sentry on purpose, so a job nobody set up there sends a check-in Sentry ignores and
 * costs nothing (a monitor is billed per monitor). Never throws.
 */
export function captureCronCheckInInSentry(jobSlug: string, status: "ok" | "error"): string | undefined {
  if (!started) return undefined;
  try {
    return Sentry.captureCheckIn({ monitorSlug: jobSlug, status });
  } catch {
    return undefined;
  }
}
