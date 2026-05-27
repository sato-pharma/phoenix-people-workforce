// Sentry initialization for the browser. Next.js 16 loads this automatically.
// The DSN must be public (NEXT_PUBLIC_*) to be available in the browser. A Sentry
// DSN is a publishable identifier, not a secret. Inert until the DSN is set.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV,
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  // Session Replay is intentionally disabled: it consumes free-tier quota and would
  // require additional CSP allowances (worker-src/blob). Errors are the priority.
  sendDefaultPii: false,
});

// Instruments client-side navigations for tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
