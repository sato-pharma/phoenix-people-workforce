// Sentry initialization for the Node.js server runtime (API routes, server components).
// Loaded from instrumentation.ts when NEXT_RUNTIME === "nodejs".
// Stays completely inert until a DSN is provided, so local/dev and un-configured
// environments behave exactly as before.
import * as Sentry from "@sentry/nextjs";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV,
  // Capture errors always; sample a small slice of performance traces to stay
  // comfortably inside the free tier. Override with SENTRY_TRACES_SAMPLE_RATE.
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0.1"),
  // HR data is sensitive — do not attach request bodies / user PII to events.
  sendDefaultPii: false,
});
