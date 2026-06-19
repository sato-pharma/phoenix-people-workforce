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

const dsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  beforeBreadcrumb: scrubSentryBreadcrumb,
  beforeSend: scrubSentryErrorEvent,
  beforeSendTransaction: scrubSentryTransactionEvent,
  denyUrls: [/extensions\//i, /^chrome:\/\//i, /^moz-extension:\/\//i],
  dsn,
  enabled: Boolean(dsn),
  environment: resolveSentryEnvironment(process.env.VERCEL_ENV),
  ignoreErrors: sentryIgnoredErrors,
  maxBreadcrumbs: 30,
  normalizeDepth: 3,
  release: resolveSentryRelease(process.env.VERCEL_GIT_COMMIT_SHA),
  sampleRate: parseSentrySampleRate(process.env.SENTRY_ERROR_SAMPLE_RATE, 1),
  sendDefaultPii: false,
  tracesSampleRate: parseSentrySampleRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.02),
});
