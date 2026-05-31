// Sentry initialization for the Edge runtime (proxy.ts middleware, edge routes).
// Loaded from instrumentation.ts when NEXT_RUNTIME === "edge".
// Inert until a DSN is provided.
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
  tracesSampleRate: parseSentrySampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.02),
  sendDefaultPii: false,
});
