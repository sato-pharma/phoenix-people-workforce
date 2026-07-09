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
  `script-src 'self' 'unsafe-inline' https://maps.googleapis.com https://maps.gstatic.com${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://maps.googleapis.com https://maps.gstatic.com https://routes.googleapis.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io",
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
  // npm run check:harden / ci and the required `lint-typecheck` CI job. Next.js 16
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
  serverExternalPackages: ["pdfmake", "pdfkit"],
  experimental: {
    serverActions: {
      allowedOrigins: [
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

export default nextConfig;
