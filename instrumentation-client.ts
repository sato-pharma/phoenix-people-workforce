// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn:
    process.env.NEXT_PUBLIC_SENTRY_DSN ??
    "https://0cb6a7f804dcba65701b98bffa914f27@o4511776154583040.ingest.de.sentry.io/4511777616298064",

  // Do not ship anything from local `next dev` — see the longer rationale in
  // sentry.server.config.ts. The opt-in flag needs the NEXT_PUBLIC_ prefix here because the
  // server-only SENTRY_ENABLE_IN_DEV is never inlined into the client bundle.
  enabled:
    process.env.NODE_ENV === "production" ||
    process.env.NEXT_PUBLIC_SENTRY_ENABLE_IN_DEV === "true",

  // Without this, local `next dev` and production share one bucket in Sentry — dev-only
  // noise (e.g. transient Fast Refresh/webpack HMR glitches) shows up as "High priority"
  // production issues (confirmed: PHX-B9-4/5/6 were all local dev-server errors). NODE_ENV
  // is one of the few env vars Next.js always inlines into the client bundle too, so this
  // needs no new build-time ARG/ENV plumbing.
  //
  // The hostname check is the browser-side counterpart to the server config's K_SERVICE
  // check: NODE_ENV is "production" in any built bundle, including the one CI's
  // preview-smoke job serves from http://localhost:3000 on a GitHub runner, so NODE_ENV
  // alone would file CI errors as production. K_SERVICE is server-only and never reaches
  // the client bundle, so here the tell is that a production build is being served from
  // localhost — CI or a local `next start`. See sentry.server.config.ts (PHX-B9-10).
  environment:
    process.env.NODE_ENV === "development"
      ? "development"
      : typeof window !== "undefined" &&
          /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/.test(window.location.hostname)
        ? "ci"
        : "production",

  // NEXT_PUBLIC_COMMIT_SHA is baked in at build time (see Dockerfile) — matches the
  // same $SHA_TAG used for next.config.ts's withSentryConfig release + the server/edge
  // configs' runtime COMMIT_SHA, so all three agree on one release identifier.
  release: process.env.NEXT_PUBLIC_COMMIT_SHA,

  // Add optional integrations for additional features.
  // feedbackIntegration is registered with autoInject: false — it does NOT show a floating
  // widget globally. src/components/admin/sentry-feedback-widget.tsx manually mounts it only
  // within the admin/ops shell (app/(admin)/layout.tsx), never on employee-facing pages.
  integrations: [Sentry.replayIntegration(), Sentry.feedbackIntegration({ autoInject: false })],

  // 100% in dev catches everything locally; 20% in production balances trace coverage
  // against ingest volume/cost. Adjust further with tracesSampler if specific routes
  // need different treatment.
  tracesSampleRate: process.env.NODE_ENV === "development" ? 1 : 0.2,
  // Enable logs to be sent to Sentry
  enableLogs: true,

  // Define how likely Replay events are sampled.
  // This sets the sample rate to be 10%. You may want this to be 100% while
  // in development and sample at a lower rate in production
  replaysSessionSampleRate: 0.1,

  // Define how likely Replay events are sampled when an error occurs.
  replaysOnErrorSampleRate: 1.0,

  // Deliberately omitting `dataCollection` entirely: passing it at all — even `{}` — flips
  // every unset PII/body-collection category to its permissive default (full user info +
  // HTTP bodies), overriding the SDK's safer `sendDefaultPii: false` default that applies
  // only when this key is absent. This is an HR platform (salaries, personal data) — do not
  // re-add this key without explicit per-field opt-in.
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
