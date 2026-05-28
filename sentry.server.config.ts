// Sentry initialization for the Node.js server runtime (API routes, server components).
// Loaded from instrumentation.ts when NEXT_RUNTIME === "nodejs".
// Stays completely inert until a DSN is provided, so local/dev and un-configured
// environments behave exactly as before.
import * as Sentry from "@sentry/nextjs";

import {
  parseSentrySampleRate,
  resolveSentryEnvironment,
  resolveSentryRelease,
  scrubSentryBreadcrumb,
  scrubSentryErrorEvent,
  scrubSentryTransactionEvent,
  sentryIgnoredErrors,
} from "@/lib/observability/sentry";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  beforeBreadcrumb: scrubSentryBreadcrumb,
  beforeSend: scrubSentryErrorEvent,
  beforeSendTransaction: scrubSentryTransactionEvent,
  enabled: Boolean(dsn),
  environment: resolveSentryEnvironment(),
  ignoreErrors: sentryIgnoredErrors,
  maxBreadcrumbs: 30,
  normalizeDepth: 3,
  release: resolveSentryRelease(),
  sampleRate: parseSentrySampleRate(process.env.SENTRY_ERROR_SAMPLE_RATE, 1),
  // Capture errors always; sample a small slice of performance traces to stay
  // comfortably inside the free tier. Override with SENTRY_TRACES_SAMPLE_RATE.
  tracesSampleRate: parseSentrySampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.02),
  // HR data is sensitive - do not attach request bodies / user PII to events.
  sendDefaultPii: false,
});
