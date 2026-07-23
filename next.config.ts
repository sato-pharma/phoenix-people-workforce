import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";


const isProduction = process.env.NODE_ENV === "production";
const builderPreviewOrigin = "https://builder.io";
function configuredPhoenixOrigins() {
  return new Set(
    String(process.env.PHOENIX_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => {
        try {
          return new URL(origin.trim()).origin;
        } catch {
          return null;
        }
      })
      .filter((origin): origin is string => Boolean(origin)),
  );
}

const isBuilderPreviewEnabled = configuredPhoenixOrigins().has(builderPreviewOrigin);
const frameAncestorsPolicy = isBuilderPreviewEnabled
  ? `frame-ancestors 'self' ${builderPreviewOrigin}`
  : "frame-ancestors 'none'";

const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' blob: https://maps.googleapis.com https://maps.gstatic.com https://cdn.onesignal.com${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  // cdn.onesignal.com / api.onesignal.com / onesignal.com: the Web Push SDK (script,
  // its own REST calls, and its permission-prompt UI). If the browser console ever shows
  // a CSP violation for a different OneSignal subdomain, add it here too.
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://maps.googleapis.com https://maps.gstatic.com https://routes.googleapis.com https://cdn.onesignal.com https://api.onesignal.com https://onesignal.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  frameAncestorsPolicy,
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  ...(isBuilderPreviewEnabled
    ? []
    : [
        {
          key: "X-Frame-Options",
          value: "DENY",
        },
      ]),
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self), payment=()",
  },
  {
    key: "Cross-Origin-Opener-Policy",
    value: "same-origin",
  },
  ...(isProduction
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=63072000; includeSubDomains; preload",
        },
      ]
    : []),
];

// Vercel serverless functions enforce a 4.5 MB request body cap that cannot be
// overridden via Next.js config. Client-side upload limits must stay below this.
// For uploads > 4 MB, use the signed-URL pattern (see src/lib/uploads/ and the
// sales-imports Supabase bucket).
const nextConfig: NextConfig = {
  // `typecheck` already runs as a required, separate step ahead of `build` in both
  // pnpm run check:harden / ci and the required `lint-typecheck` CI job. Next.js 16
  // has no built-in ESLint-during-build integration anymore (no `eslint` NextConfig
  // key), so only the redundant type-check needs disabling here. Do NOT remove this
  // without also confirming typecheck still gates merges/deploys some other way.
  typescript: { ignoreBuildErrors: true },
  // Pin the workspace root to wherever this config file actually lives. Without
  // this, Next.js's lockfile-based root inference gets confused by the many
  // sibling worktree/package-lock.json copies nested under the repo root (see
  // AGENTS.md § Parallel Session and Git Worktree Safety) and can end up
  // watching/tracing a far larger — sometimes pathologically slow — file tree
  // than the actual app needs.
  outputFileTracingRoot: __dirname,
  output: "standalone",
  // pdfmake/pdfkit load their standard-14 font metrics (.afm files) from disk at runtime
  // relative to their own package directory. Left to normal webpack bundling, those relative
  // paths break (Next tries to resolve them as bundled "vendor-chunks" that don't exist).
  // Marking them external makes API routes `require()` them natively from node_modules
  // instead, so the on-disk .afm lookups keep working.
  serverExternalPackages: ["pdfmake", "pdfkit", "puppeteer-core"],
  experimental: {
    serverActions: {
      allowedOrigins: [
        "phoenix-hr-897559113412.europe-west3.run.app",
        // Old Iowa host — kept only for the post-cutover rollback window (DNS can be
        // flipped back to it until the us-central1 service is decommissioned).
        "phoenix-hr-897559113412.us-central1.run.app",
        "phoenix-hr.satopharma.com",
      ],
    },
    // Tree-shake large barrel imports so only the icons/charts a component
    // actually uses land in its client chunk (lucide-react alone is imported
    // across 240+ files). "radix-ui" was removed: audited 2026-07-03, zero
    // import sites in app/ or src/ — this project's UI primitives are
    // hand-rolled, not radix wrappers, so it was dead config.
    optimizePackageImports: ["lucide-react", "recharts"],
  },
  allowedDevOrigins: [
    "192.168.1.45",
    "imagines-sixfold-corny.ngrok-free.dev",
    "*.ngrok-free.dev",
    "*.trycloudflare.com",
  ],
  async headers() {
    return [
      {
        headers: securityHeaders,
        source: "/:path*",
      },
      ...(process.env.NODE_ENV === "production"
        ? [{ source: "/_next/static/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] }]
        : []),
    ];
  },
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "phoenix-workforce",

  project: "phx-b9",

  // Ties uploaded source maps to the same release identifier the running app reports
  // (see instrumentation-client.ts/sentry.server.config.ts/sentry.edge.config.ts) so
  // Sentry can resolve stack traces and diff issues across releases. NEXT_PUBLIC_COMMIT_SHA
  // is a build-time value (see Dockerfile) since this webpack-plugin config itself runs
  // at build time, same lifecycle as the client bundle.
  release: { name: process.env.NEXT_PUBLIC_COMMIT_SHA },

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
