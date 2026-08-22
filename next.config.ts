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
  // api.onesignal.com is required HERE (script-src), not just connect-src: the SDK loads
  // a JSONP-style sync script directly from https://api.onesignal.com/sync/<appId>/web —
  // a <script> tag, not a fetch/XHR. Omitting it from script-src silently blocks that load,
  // which hangs OneSignal.init() until it times out — confirmed in production 2026-07-23
  // (console: "Loading the script '.../sync/.../web' violates ... script-src"), which meant
  // push never worked at all, on any device, despite every other piece being correctly wired.
  //
  // 'wasm-unsafe-eval' is required for the Maps JavaScript API's vector renderer, which
  // compiles a WebAssembly module. Without it production threw
  // "CompileError: call to WebAssembly.instantiate() blocked by CSP" on every page that
  // renders a map — /employee-portals/submit-expense and /admin/outstation/expense-command
  // — which was 1,992 of 2,236 logged client errors (89%) over the 14 days to 2026-08-09.
  // It only ever broke in production because 'unsafe-eval' (appended below outside
  // production) already implies wasm compilation, so dev and preview looked fine.
  // 'wasm-unsafe-eval' permits WebAssembly compilation ONLY — it does not re-enable
  // eval() of JavaScript, so this does not widen the JS execution surface.
  // Google documents it as a CSP requirement for the Maps JS API, same source as the
  // style-src/font-src entries below:
  // https://developers.google.com/maps/documentation/javascript/content-security-policy
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https://maps.googleapis.com https://maps.gstatic.com https://cdn.onesignal.com https://api.onesignal.com${isProduction ? "" : " 'unsafe-eval'"}`,
  // fonts.googleapis.com: the Maps JavaScript API (loaded above for outstation expense
  // heatmaps/location review — see src/lib/google-maps/browser.ts) injects its own
  // <link rel="stylesheet"> for the "Google Sans" font used by its UI controls
  // (InfoWindow, controls). font-src already allowed fonts.gstatic.com (the actual font
  // files) for the same reason; style-src needs the matching stylesheet host too — this
  // is Google's own documented CSP requirement for the Maps JS API, not our own font
  // loading, so next/font can't replace it. See
  // https://developers.google.com/maps/documentation/javascript/content-security-policy
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
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
  // the `pnpm run ci` script and the required `typecheck` CI job. Next.js 16
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
  // tesseract.js is here for the same class of reason: it forks its own worker script and loads a
  // WebAssembly core and a language file from disk at runtime, by path. Bundled, none of those paths
  // resolve. See src/lib/recruitment/cv-ocr.ts, which reads scanned CVs when the vision model is
  // unavailable.
  serverExternalPackages: ["pdfmake", "pdfkit", "puppeteer-core", "pdf-parse", "mammoth", "tesseract.js"],
  // pdf-parse's local PDF text extraction (src/lib/recruitment/cv-extraction.ts) runs on
  // pdfjs-dist's "legacy" build. In Node, pdfjs-dist always disables real Worker threads and
  // instead dynamically `import()`s its own sibling "legacy/build/pdf.worker.mjs" file to run
  // the same parsing code in-process (see PDFWorker#setupFakeWorker in pdfjs-dist). That import
  // is deliberately marked with /*webpackIgnore*/ /*@vite-ignore*/ so bundlers don't touch it —
  // which also makes it invisible to Next's production file-tracer (`.next/standalone`; see
  // pdf-dommatrix-polyfill.ts for the sibling gap the same tracer left in this dependency). The
  // tracer follows the static `import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"` and
  // copies pdf.mjs, but never sees pdf.worker.mjs, so every PDF extraction hard-fails in
  // production with "Setting up fake worker failed: Cannot find module '.../pdf.worker.mjs'"
  // (confirmed fatal: pdfjs-dist has no other Node code path once that promise rejects).
  //
  // The tessdata file and the tesseract.js WASM core are here for exactly the same reason. Both are
  // opened by absolute path at runtime — the language file from assets/tessdata (deliberately
  // vendored so nothing is fetched from a CDN by a production server) and the core from its own
  // package — so the tracer never sees either. Without these entries free OCR would work in dev and
  // fail only in production, which is precisely how the pdf.worker.mjs bug behaved.
  //
  // THIRD gap in the same tracer, found 2026-08-22 from a live production log line. pdf-parse's
  // getImage() — the call that pulls the page images OUT of a scanned PDF to feed that same free
  // OCR path — builds a canvas to decode them, and reaches @napi-rs/canvas through a runtime
  // createRequire the tracer cannot follow. getText() is unaffected (it never rasterizes), which is
  // why CV text extraction kept working and this stayed invisible for months.
  //
  // THE FIRST ATTEMPT AT THIS FIX SHIPPED AND DID NOT WORK (#2299). It traced the package at its
  // .pnpm path, which copies the right bytes to a place nothing can require: tracing copies real
  // FILES (the glob below runs with nodir:true), never pnpm's symlinks, and under pnpm a TRANSITIVE
  // package is reachable ONLY through symlinks — the one pdfjs-dist uses to see the wrapper, and the
  // one the wrapper uses to see its own Skia binary. Neither is recreated in .next/standalone, so
  // production threw the identical MODULE_NOT_FOUND with the files sitting right there.
  //
  // Hence publicHoistPattern in pnpm-workspace.yaml: it puts both packages in the ROOT node_modules,
  // where Node's ordinary walk-up finds them from any depth, and this glob copies them there. Note
  // the shape carefully — `@napi-rs/*/**` and NOT `@napi-rs/**`, because `**` does not traverse a
  // symlinked directory and the shorter pattern matches ZERO files (measured). A glob that silently
  // matches nothing is exactly how the first attempt shipped green, so tests/pdf-canvas-trace.test.ts
  // asserts these globs resolve to real files rather than merely being present.
  outputFileTracingIncludes: {
    "/api/**/*": [
      "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./assets/tessdata/*.traineddata.gz",
      "./node_modules/.pnpm/tesseract.js@*/node_modules/tesseract.js/src/worker-script/**",
      "./node_modules/.pnpm/tesseract.js-core@*/node_modules/tesseract.js-core/**",
      "./node_modules/@napi-rs/*/**",
    ],
  },
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
  // Direct Orders route retirements (2026-08-10 consolidation).
  //
  // TRUE 308s, declared here rather than as page-level permanentRedirect() calls. Those were tried
  // first and DO work for a human, but Next throws the redirect after the root layout has begun
  // streaming, so the status line is already sent: it degrades to a 200 carrying
  // `<meta http-equiv="refresh">`. Confirmed live in dev. That is a 200 to a bookmark, a crawler and
  // any link checker, and it flashes the shell before moving. Declared redirects are matched before
  // any rendering, so they cost nothing and say what they mean.
  async redirects() {
    return [
      // The ten-card hub -> the workspace's Admin Tools tab.
      // ?view=admin-tools still resolves (resolveDirectOrderWorkspaceTab keeps the legacy aliases
      // working), but pointing the redirect at the current name means the URL a user ends up with
      // is the one that will still be correct next year.
      { source: "/sales/direct-orders-tools", destination: "/admin/direct-orders?view=pharmacy-control", permanent: true },
      // Approving is an action on an order, not a separate world. Both shells.
      { source: "/admin/approvals/direct-orders", destination: "/admin/direct-orders?view=needs-action", permanent: true },
      { source: "/employee-portals/approvals/direct-orders", destination: "/employee-portals/direct-orders?view=needs-action", permanent: true },
      // The approval detail routes were a strict SUBSET of the order detail (same component, minus
      // the pharmacy-validation capture and the cancel-held control), so this loses nothing.
      { source: "/admin/approvals/direct-orders/:id", destination: "/admin/direct-orders/:id", permanent: true },
      { source: "/employee-portals/approvals/direct-orders/:id", destination: "/employee-portals/direct-orders/:id", permanent: true },
    ];
  },

  async headers() {
    return [
      {
        headers: securityHeaders,
        source: "/:path*",
      },
      // CvPreviewModal renders a candidate's CV inline via <iframe src={ourOwnDownloadRoute}> —
      // the global X-Frame-Options: DENY / frame-ancestors 'none' above blocks that outright,
      // even same-origin, so the preview silently failed to render (Chrome: net::ERR_BLOCKED_BY_RESPONSE)
      // regardless of Content-Disposition. These two file-serving routes are the only ones this
      // app ever needs to frame, and only from itself — scope the loosening to exactly that
      // (frame-ancestors 'self' + X-Frame-Options: SAMEORIGIN), not weakened for anything else.
      // A CSP consisting of only frame-ancestors is deliberate here too: these routes return raw
      // file bytes (PDF/image), never HTML that executes script, so script-src/connect-src/etc.
      // have nothing to protect on this response — restating the full site-wide CSP would be
      // dead weight, not defense in depth.
      {
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
        source: "/api/recruitment/files/:id/download",
      },
      {
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
        source: "/api/recruitment/hiring-manager/candidates/:candidateId/files/:fileId",
      },
      ...(process.env.NODE_ENV === "production"
        ? [
            { source: "/_next/static/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
            // Next's public/ default (Cache-Control: public, max-age=0) forces Cloud CDN — which
            // sits in front of this origin with cacheMode: USE_ORIGIN_HEADERS — to revalidate
            // with origin on essentially every request. Confirmed via Cloud Run request logs
            // (2026-07-26/28, 5 revisions) that near-simultaneous revalidation GETs from
            // "Cloud-CDN-Google (GFE/2.0)" for /brand/identity-watermark.png intermittently 500
            // at the origin; not user-visible (CDN's serveWhileStale keeps serving the last good
            // copy) but it pollutes error logs/alerts. A bounded max-age (not `immutable`, since
            // these filenames aren't content-hashed) cuts origin revalidation traffic from
            // "every request" to "about once a day," which removes the trigger almost entirely,
            // while capping worst-case staleness if a brand asset is ever replaced in place.
            { source: "/brand/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }] },
          ]
        : []),
    ];
  },
};

export default nextConfig;
