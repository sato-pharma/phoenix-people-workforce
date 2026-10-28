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
  // https://*.supabase.co: a saved CRM visit voice note plays from a signed Supabase Storage URL set
  // directly as an <audio src> (src/components/phoenix-crm/voice-playback.tsx). connect-src already
  // allows Supabase, but an <audio> element's source is governed by media-src, not connect-src, so
  // without this the note is blocked from playing back. blob: stays for locally captured previews.
  "media-src 'self' blob: https://*.supabase.co",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  frameAncestorsPolicy,
  ...(isProduction ? ["upgrade-insecure-requests"] : []),
].join("; ");

// A CSP for /whatsapp-connect ONLY — the WhatsApp coexistence onboarding page (app/whatsapp-connect),
// which loads Facebook's JS SDK and opens a Facebook login popup that talks back via postMessage.
// The site-wide CSP above intentionally allows no Facebook host, so left as-is the SDK <script> is
// blocked and the flow is dead on arrival. This derives from the site-wide policy and widens exactly
// three directives for exactly the Facebook hosts the SDK needs — nothing else on the site is touched,
// so payroll/HR pages keep the strict policy. Built by string-replacing the shared const rather than
// re-typing it, so any future hardening of the base policy carries through here automatically (and so
// tests/csp-headers.test.ts, which fingerprints the base template literal, is unaffected).
const whatsappConnectCsp = contentSecurityPolicy
  .replace("script-src 'self'", "script-src 'self' https://connect.facebook.net")
  .replace(
    "connect-src 'self'",
    "connect-src 'self' https://connect.facebook.net https://graph.facebook.com https://*.facebook.com",
  )
  .concat("; frame-src 'self' https://connect.facebook.net https://*.facebook.com");

// A CSP for the hiring-pack print route ONLY — the nine HR documents, which the fill screen shows in
// an <iframe> so an operator can read the real page and correct values on it before it goes to paper.
// The site-wide `frame-ancestors 'none'` / `X-Frame-Options: DENY` blocks that outright, even from
// this app to itself: the frame loads as an error page carrying an opaque origin, so the parent
// cannot reach its document and the panel renders empty with no message anywhere. (Measured in the
// browser 2026-08-31 — "Blocked a frame with origin http://localhost:3000 from accessing a
// cross-origin frame", which is what a SAME-origin iframe reports once the response refuses framing.
// Nothing in the repository can see this: it is a response header meeting a browser, so every test
// and every typecheck passes while the feature is completely dead.)
//
// DERIVED from the site-wide policy by swapping exactly ONE directive, like whatsappConnectCsp above
// and for the same reason: later hardening of the base policy carries through here automatically.
// This route is NOT one of the raw-file routes below and must NOT get their frame-ancestors-only CSP
// — it returns HTML that runs an inline script (FIT_TO_BOX_SCRIPT, which measures Arabic text and is
// the only thing keeping a long value inside its printed box), so script-src and the rest still have
// something real to protect here.
//
// Where the builder preview origin is configured the base policy already permits 'self' and the
// replaced directive is absent, so this leaves that policy alone rather than narrowing it.
const hiringPackPrintCsp = contentSecurityPolicy.replace(
  "frame-ancestors 'none'",
  "frame-ancestors 'self'",
);

// A CSP for the managed Google Play console ONLY — /devices/managed-play and its /hr spelling,
// where the fleet's private apps are published. Google serves that surface as an iframe opened
// through gapi.iframes, so the page needs THREE things the site-wide policy refuses outright:
//   - script-src https://apis.google.com — the gapi loader. Blocked, the page reports "Google's API
//     script failed to load" and nothing else ever happens.
//   - frame-src play.google.com AND apis.google.com — there is NO frame-src directive in the base
//     policy, so framing falls back to `default-src 'self'` and the child frame is refused outright.
//     gapi opens its own relay frame on apis.google.com as well, so naming only play.google.com is
//     not enough and fails in a way that looks like an empty store rather than a blocked frame.
//   - connect-src for both hosts — the iframe's RPC channel and the upload it performs.
// frame-ancestors is deliberately NOT touched: this widens what THIS page may embed, never who may
// embed Phoenix. Nothing else on the site is affected, so payroll and HR keep the strict policy.
//
// DERIVED from the site-wide policy by string-replacing the shared const, like whatsappConnectCsp
// and hiringPackPrintCsp above and for the same reason: later hardening of the base policy carries
// through here automatically, and tests/csp-headers.test.ts (which fingerprints the base template
// literal) is unaffected.
const managedPlayCsp = contentSecurityPolicy
  .replace("script-src 'self'", "script-src 'self' https://apis.google.com")
  .replace(
    "connect-src 'self'",
    "connect-src 'self' https://apis.google.com https://play.google.com",
  )
  .concat("; frame-src 'self' https://play.google.com https://apis.google.com");

// A CSP for the Milestones workspace ONLY — /milestones and its /hr spelling. The card preview is
// built by POSTing to /api/milestones/card and framing the HTML that comes back as a `blob:` URL,
// which is the one thing the base policy refuses here: there is NO `frame-src` directive in it, so
// framing falls back to `default-src 'self'` and `blob:` is not 'self'. Chrome does not report that
// as a CSP error in the page; it paints its generic refusal inside the frame — "This content is
// blocked. Contact the site owner to fix the issue." — which reads like a proxy or an ad blocker and
// sends you looking anywhere but at a header. (The owner hit exactly that, 2026-09-23.)
//
// `img-src`, `media-src`, `worker-src` and `script-src` already allow `blob:` site-wide; this adds
// the one place it was missing, for one page. `frame-ancestors` is deliberately NOT touched: this
// widens what THIS page may embed, never who may embed Phoenix. And the blob document is same-origin
// with its creator, so it inherits this very policy — the card's inline styles and its layout script
// stay bound by it rather than escaping into a frame with no rules at all.
//
// DERIVED from the site-wide policy by concatenation, like the three above and for the same reason:
// later hardening of the base carries through automatically, and tests/csp-headers.test.ts (which
// fingerprints the base template literal) is unaffected.
const milestonePreviewCsp = contentSecurityPolicy.concat("; frame-src 'self' blob:");

// Sentry (sentry.io) browser reports need their ingest host in connect-src, and ONLY when this build
// carries a DSN — the origin is read from NEXT_PUBLIC_SENTRY_DSN itself rather than written here, so the
// region (us / de) is whatever the account's DSN says and a build without one gains no new host. Applied
// to the site-wide header only; the derived whatsapp/hiring/play/milestone policies above stay as they are.
const sentryIngestOrigin = (() => {
  try {
    const dsn = new URL(String(process.env.NEXT_PUBLIC_SENTRY_DSN ?? "").trim());
    return dsn.protocol === "https:" && dsn.username ? dsn.origin : null;
  } catch {
    return null;
  }
})();
const siteContentSecurityPolicy = sentryIngestOrigin
  ? contentSecurityPolicy.replace("connect-src 'self'", `connect-src 'self' ${sentryIngestOrigin}`)
  : contentSecurityPolicy;

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: siteContentSecurityPolicy,
  },
  // The browser profiler only runs on a document served with this policy. Sent only by a build that carries a
  // Sentry DSN, so staging, previews and local runs keep the headers they have today.
  ...(sentryIngestOrigin ? [{ key: "Document-Policy", value: "js-profiling" }] : []),
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
  // camera=(self), NOT camera=(). The empty allowlist made Chromium refuse getUserMedia before any
  // prompt, so every live-photo capture — the outstation arrival and departure photos, the direct-order
  // storefront photo, the marketing venue photo — failed on Android Chrome, Samsung Internet and
  // desktop Chrome/Edge with a "permission blocked" message no site setting could clear. Safari and
  // Firefox ignore this header, which is why photos kept arriving and the outage stayed invisible.
  //
  // Site-wide on purpose, not scoped to those routes: a permissions policy is fixed when the DOCUMENT
  // loads, and App Router navigation never loads a new one, so a rep who opens the portal and taps
  // through to Submit Expense would still carry the landing page's camera=(). `self` keeps
  // third-party frames locked out.
  //
  // microphone=(self), NOT microphone=(): the Phoenix CRM visit form records a voice note and runs
  // ar-EG dictation (src/components/phoenix-crm/speak.tsx, shipped 2026-09-25), so the app DOES record
  // audio now. The empty allowlist made every browser refuse getUserMedia before any prompt — the exact
  // camera=() failure above, replayed for the mic: the owner saw "microphone blocked for Phoenix" in
  // Chrome even with the site permission granted, because a document-level policy of () overrides the
  // site/OS permission entirely. `self` (not `*`) keeps third-party frames out, same as camera.
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(self), geolocation=(self), payment=()",
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
  // `next dev` (16+) auto-writes a generic "This is NOT the Next.js you know..." block into
  // AGENTS.md every time it starts (node_modules/next/dist/server/lib/generate-agent-files.js),
  // gated on this flag defaulting to true. This repo's AGENTS.md is the hand-maintained,
  // byte-budgeted operating-rules doc referenced by CLAUDE.md (see docs/memory-index-budget.md)
  // — not a throwaway file — so every local dev session was getting a silent uncommitted diff
  // there. Disable Next's own AGENTS.md/CLAUDE.md generation instead of relying on everyone to
  // notice and revert it.
  agentRules: false,
  // No `X-Powered-By: Next.js` on any response. It tells nobody anything they need, and it tells a
  // scanner which framework (and so which advisories) to try first. Pinned by
  // tests/public-surface-hardening.test.ts.
  poweredByHeader: false,
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
  serverExternalPackages: ["pdfmake", "pdfkit", "puppeteer-core", "pdf-parse", "mammoth", "word-extractor", "tesseract.js", ...(isProduction ? [] : ["exceljs", "imapflow", "mailparser", "nodemailer", "pdf-lib", "jszip"])],
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
      // The authorised signatory's signature, drawn onto every offer PDF. Deliberately NOT in
      // `public/`: the email never carries it (it points at the attached PDF instead), so nothing
      // needs to fetch it over HTTP, and a real signature on a guessable public URL is worth
      // avoiding. Server-read only, which means it ships only if it is traced — hence this line.
      "./assets/brand/*.png",
      // The business-card design and its two Montserrat faces (src/lib/business-cards/render-pdf.ts).
      // Same reasoning as the signature: the owner's card artwork is read by the server, never served.
      "./assets/business-cards/*.pdf",
      "./assets/business-cards/*.ttf",
      "./node_modules/.pnpm/tesseract.js@*/node_modules/tesseract.js/src/worker-script/**",
      "./node_modules/.pnpm/tesseract.js-core@*/node_modules/tesseract.js-core/**",
      "./node_modules/@napi-rs/*/**",
      // The isolated CV reader (src/lib/recruitment/cv-text-isolation.ts) runs in a worker thread that
      // require()s its library BY BARE NAME from /app/node_modules. Next links a package there only when
      // something traced requires it by that name: mammoth and word-extractor happened to be, pdf-parse
      // was not (the app reaches it through a hashed alias in .next/node_modules), so every PDF fell back
      // to the unlimited in-process reader on production. Listing all three here makes the link certain,
      // the same way @napi-rs above gets one. Pinned by tests/cv-text-isolation.test.ts.
      "./node_modules/pdf-parse/**",
      "./node_modules/mammoth/**",
      "./node_modules/word-extractor/**",
    ],
  },
  experimental: {
    // 🔴 THE PAGE-DATA WORKER POOL, CAPPED ONLY WHERE THE HOST LIES ABOUT ITS CPUs.
    //
    // `next build` sizes this pool from the CPUs it can SEE. In a container that is the HOST's count,
    // not the container's allowance, so on the self-hosted Railway runner it read 47, spawned 47
    // tokio workers against a far lower pid/thread limit, and aborted the build AFTER compiling
    // successfully:
    //
    //     ✓ Compiled successfully in 40s
    //     Collecting page data using 47 workers ...
    //     OS can't spawn worker thread: Resource temporarily unavailable (os error 11)
    //     fatal runtime error: failed to initiate panic, error 5, aborting
    //
    // 🔴 `NEXT_CPUS` CANNOT FIX THIS — no env var can. Read from the installed next@16.3.3:
    // `dist/build/index.js:371` decides the count from `config.experimental.cpus` alone, so a
    // container variable is ignored however it is spelled, which is why setting one changed nothing
    // and the log still said 47. The option is the only knob.
    //
    // Unset — every GitHub-hosted run, every local build, production — this key is ABSENT and the
    // default is untouched: `0` and a non-numeric value both resolve to absent, never to a cap of
    // zero. Pinned by tests/next-build-cpu-cap.test.ts.
    ...(Number(process.env.PHX_BUILD_CPUS) > 0
      ? { cpus: Number(process.env.PHX_BUILD_CPUS) }
      : {}),
    // THE ONE HOST A SERVER ACTION MAY ARRIVE ON. Next matches the request's Origin/Host against
    // this list and rejects the action if it is not here, so every entry is a host allowed to POST
    // a mutation into a live payroll app.
    //
    // 🔴 The two Cloud Run hosts that used to sit here were REMOVED on 2026-09-30, and must never
    // come back. GCP billing is closed (AGENTS.md §3: "GCP and Vercel are DEAD" — every API answers
    // BILLING_DISABLED), the services are gone, and that project-number hostname is a name the
    // company no longer controls: whoever claims the number next inherits a host this app was still
    // trusting to POST server actions. The second of the two carried a comment about a "post-cutover
    // rollback window" to a platform that had already been deleted for weeks — that window is
    // closed, and there is nothing left to roll back to.
    //
    // This was the LAST place they were trusted anywhere in the repo. Everything else had already
    // been hardened: `isAllowedPhoenixOrigin` rejects them (pinned by
    // tests/gcloud-migration-hardening.test.ts), and scripts/validate-env.mjs refuses such a value
    // outright. scripts/check-no-stale-domains.mjs now carries the matching host pattern so this
    // file cannot quietly regrow one — it read next.config.ts all along and passed it, because it
    // only knew the four Vercel patterns.
    //
    // 🔴 The hostname is deliberately not spelled out above: that gate scans this file, and prose
    // quoting the host would trip the very check that keeps it gone.
    serverActions: {
      allowedOrigins: ["phoenix-hr.satopharma.com"],
    },
    // Tree-shake large barrel imports so only the icons/charts a component
    // actually uses land in its client chunk (lucide-react alone is imported
    // across 240+ files). "radix-ui" was removed: audited 2026-07-03, zero
    // import sites in app/ or src/ — this project's UI primitives are
    // hand-rolled, not radix wrappers, so it was dead config.
    optimizePackageImports: ["lucide-react", "recharts"],
    // 🔴 NEVER BUILD A WHOLE PAGE NOBODY TAPPED (owner, 2026-10-01: "the system is slow to transfer
    // between page and page … make the medical rep role very fast").
    //
    // The portal sidebar used `<Link prefetch>` — `prefetch={true}`, a FULL prefetch — on every row
    // and every rail icon. For a dynamic page a full prefetch is the whole page rendered on the
    // server: its auth, its loaders, its RPCs. So opening ANY portal page rendered ~15 others in the
    // background at the same moment, on the one replica, against the one database. Production HTTP
    // logs, 2026-10-01 00:57 Cairo, one portal load: business-review 7.5 s, weekly-stock 6.4 s,
    // /employee-portals 5.2 s, employee-360 4.8 s, weekly-sales 4.5 s — all at once, none clicked.
    // A tap on a link while that burst ran queued behind it, which is the slowness he saw.
    //
    // Links now prefetch only down to the page's loading.tsx while on screen — every rep route has
    // one, so the skeleton appears the instant he taps.
    //
    // 🔴 AND NO `dynamicOnHover` EITHER (owner, 2026-10-23: "the process of shifting from page to page
    // never take more than 1 second"). It upgraded a link to the FULL page on mouseenter /
    // touchstart, meant as a head start of 100–400 ms. In practice a mouse crossing the sidebar, or a
    // finger scrolling it, touched row after row: production logs, 2026-10-23 14:18–14:52 Cairo, show
    // 8 full page builds — 46 s of server work — queued in front of ONE rep's tap on Visits, and a
    // sweep in Chrome the same afternoon set off 7 builds, about 60 s, by moving the mouse down the
    // menu. The page that was tapped waited behind every page that was not. Leave the key out (Next's
    // default is off) and give a slow page a faster loader instead; tests/portal-link-prefetch.test.ts
    // refuses the key and the prop.
    //
    // THE CLIENT ROUTER CACHE. `dynamic`: a page he navigated to is reused for 30 s, so going back
    // and forth between two pages is instant instead of a fresh server render each time (default 0).
    // `static`: how old a prefetched entry may be and still answer a tap — lowered from the default
    // 300 s to 60 s, because the old full prefetch served EVERY sidebar page up to five minutes
    // stale; this bounds it at one minute. Every save that calls
    // `router.refresh()` (the Phoenix CRM visit form among ~85 others) invalidates the whole cache
    // at once, so a save is never followed by its own stale page. 30 is the schema's floor for
    // `static`.
    staleTimes: {
      dynamic: 30,
      static: 60,
    },
    // NO TURBOPACK FILESYSTEM CACHE FOR `next build`, added 2026-09-17. Next 16.3 turned it
    // ON by default, and nothing here ever reads it back: CI starts every run on a fresh
    // runner with no .next restore (ci.yml deleted that cache on 2026-08-29), and the
    // Dockerfile's `RUN pnpm run build` has no cache mount, so Railway discards it too.
    // Writing it is pure cost, and the build waits for the write to finish before it exits.
    //
    // MEASURED on CI's Build step, successful runs either side of the 16.2.11 -> 16.3.3 bump
    // (#3559, 2026-09-09): 19 runs before, median 3.2 min, max 4.3; 20 runs after, median
    // 4.0 min, max 7.1. Compilation itself did not move (~2.7-3.0 min both sides). The whole
    // difference is the new "Finished writing to filesystem cache" line, which logged 49s to
    // 4.4 min depending on the runner's disk, and a slow write also stretches "Collecting
    // page data" (21s -> 80s) because the two contend for the same disk.
    //
    // A build cache only speeds up the NEXT build that reads it; it is not part of what this
    // build ships. If a restore is ever added (a CI cache step or a Docker cache mount),
    // measure before turning this back on. `next dev` has its own flag and is unaffected.
    turbopackFileSystemCacheForBuild: false,
    // DEV-ONLY MEMORY SETTINGS, added 2026-09-09. Production config is byte-identical to
    // what it was before this block: `next build` and `next start` both run with
    // NODE_ENV=production, so neither flag is ever set for them.
    //
    // WHY THIS EXISTS. The owner's machine hard-froze twice on 2026-09-09 (17:34 and 20:36
    // Cairo). No minidump either time, a GPU watchdog dump instead — the signature of the
    // desktop compositor being paged out, not a driver fault. The cause was physical RAM:
    // 16 GB total, and a single `next dev` server on this repo was measured that night at
    //     peak commit 10,221 MB, peak working set 7,497 MB
    // after serving TEN admin routes from cold. Free RAM bottomed at 1,025 MB during that
    // one run, with nothing else heavy open. Two servers at once cannot fit, and that is
    // exactly the state both freezes were in.
    //
    // preloadEntriesOnStart defaults to TRUE, which loads every route entry into memory when
    // the server starts. This app has 401 pages and 747 API routes — 1,148 entries — so that
    // default is the single most expensive thing the dev server does here. It is a latency
    // optimisation for a small app and a memory disaster for a large one.
    //
    // webpackMemoryOptimizations is Next's own knob for this; its documented trade is a
    // smaller max heap for slightly slower compiles, which is the right way round on a box
    // whose bottleneck is RAM and not CPU (CPU never passed 9% during either freeze).
    //
    // Do NOT extend either flag to production without measuring there: preloading entries is
    // what keeps the first request to each route fast after a deploy, and Railway runs one
    // replica serving real users.
    ...(isProduction
      ? {}
      : {
          preloadEntriesOnStart: false,
          webpackMemoryOptimizations: true,
        }),
  },
  // DEV-ONLY, OFF UNLESS PHOENIX_DEV_LEAN_SERVER_MAPS=1 (2026-10-29). `next dev` gives every compiler,
  // the server ones included, full `eval-source-map`, and reverts a changed `devtool`, so the only
  // lever is Next's own source-map plugin. With the switch on, the SERVER and EDGE compilers drop it:
  // their loaders stop producing a map per module and webpack stops holding them. The browser bundle
  // keeps its full maps, so client debugging is unchanged. The cost: a server error's stack names the
  // compiled `.next/server` file, not the line in `src/`. `next build` never runs this branch.
  //
  // DEV-ONLY, OFF UNLESS PHOENIX_DEV_NO_DISK_CACHE=1 (2026-10-29). In dev Next keeps webpack's cache
  // in memory (its MemoryWithGcCachePlugin) AND gzips it to `.next/dev/cache/webpack` a second
  // after each compile. That write held 1.1 GB of buffers outside the heap on 2026-10-29 (memory
  // probe, /admin from cold: outside-heap 515 -> 1,627 MB while `*.pack.gz_` files were written).
  // With the switch on, the cache stays in memory only (Next adds MemoryWithGcCachePlugin in dev
  // whatever `cache` says), so rebuilds inside one server still reuse it; the cost is that every
  // new server start compiles cold (/admin: first byte in 40 s on this machine, 2026-10-29).
  webpack: (config, { dev, isServer }) => {
    if (dev && isServer && process.env.PHOENIX_DEV_LEAN_SERVER_MAPS === "1") {
      config.plugins = (config.plugins ?? []).filter(
        (plugin: { constructor?: { name?: string } } | null) =>
          plugin?.constructor?.name !== "EvalSourceMapDevToolPlugin",
      );
    }
    if (dev && process.env.PHOENIX_DEV_NO_DISK_CACHE === "1") {
      config.cache = false;
    }
    return config;
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
      // Notification links already sent to real people, pointing at pages that never existed at
      // those addresses. Fixing the generator only helps the NEXT send; these repair the ones
      // already in inboxes and on phones — 82 contract-renewal and 3 holiday-confirmation links
      // measured in production 2026-08-28, every one of which 404'd when tapped.
      { source: "/contracts/renewals", destination: "/contracts", permanent: true },
      { source: "/admin/attendance/holiday-calendar", destination: "/attendance/holiday-calendar", permanent: true },
      // Sales Analytics retirement (owner, 2026-09-17: "drop and retire the sales analytics module").
      // An old address lands on the nearest page that stays: the weekly dashboards on Weekly Sales,
      // everything else on Monthly Closing, in each shell. ONE page survives inside the admin module,
      // /admin/analytics/monthly-closing/details (the Finance Manager's export), so the admin entries
      // name each retired page instead of catching the whole folder. A `:path*` source also matches
      // its bare folder, and the first match wins, so the portal's weekly entry must stay above its
      // catch-all. Pinned by tests/sales-analytics-retired.test.ts.
      { source: "/admin/analytics", destination: "/sales/monthly-closing", permanent: true },
      { source: "/admin/analytics/weekly-sales/:path*", destination: "/sales/weekly/dashboard", permanent: true },
      { source: "/admin/analytics/source-sales/:path*", destination: "/sales/monthly-closing", permanent: true },
      { source: "/admin/analytics/monthly-closing", destination: "/sales/monthly-closing", permanent: true },
      { source: "/admin/analytics/monthly-closing/by-line", destination: "/sales/monthly-closing", permanent: true },
      { source: "/admin/analytics/monthly-closing/by-employee", destination: "/sales/monthly-closing", permanent: true },
      { source: "/admin/analytics/executive-comparison", destination: "/sales/monthly-closing", permanent: true },
      { source: "/admin/analytics/reconciliation", destination: "/sales/monthly-closing", permanent: true },
      { source: "/employee-portals/sales-analytics/weekly-sales/:path*", destination: "/employee-portals/weekly-sales", permanent: true },
      { source: "/employee-portals/sales-analytics/:path*", destination: "/employee-portals/monthly-closing", permanent: true },
    ];
  },

  async headers() {
    return [
      {
        headers: securityHeaders,
        source: "/:path*",
      },
      // /whatsapp-connect — the WhatsApp coexistence onboarding page. Two per-key overrides of the
      // site-wide security headers, and ONLY for this one path:
      //   - Content-Security-Policy -> whatsappConnectCsp, which permits Facebook's JS SDK + graph
      //     calls (the site-wide policy allows no Facebook host, which would block the SDK outright).
      //   - Cross-Origin-Opener-Policy -> same-origin-allow-popups. The site-wide value is
      //     `same-origin`, which severs window.opener for the Facebook login popup and so kills the
      //     postMessage that returns the auth code. `-allow-popups` keeps the opener link for popups
      //     this page opens while still isolating it from the pages that open IT.
      // Per-key, later-array-entry-wins override — verified live against the CV-download entries below;
      // every other header (X-Frame-Options: DENY, HSTS, etc.) is inherited unchanged from /:path*.
      {
        headers: [
          { key: "Content-Security-Policy", value: whatsappConnectCsp },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
        source: "/whatsapp-connect",
      },
      // The managed Google Play console — see managedPlayCsp above for what each widened directive
      // buys and what breaks without it. BOTH spellings are listed because proxy.ts rewrites the
      // `/hr` namespace onto the admin pages AFTER these headers are matched, so a rule written only
      // against the admin path would never fire for the HR seats that actually browse there — and it
      // would fail as a blank frame, which is the failure mode hardest to trace back to a header.
      {
        headers: [{ key: "Content-Security-Policy", value: managedPlayCsp }],
        source: "/devices/managed-play",
      },
      {
        headers: [{ key: "Content-Security-Policy", value: managedPlayCsp }],
        source: "/hr/devices/managed-play",
      },
      // The Milestones workspace — see milestonePreviewCsp above for why the card preview is a blank
      // refusal without it. BOTH spellings, for the same reason the managed Play console lists both.
      {
        headers: [{ key: "Content-Security-Policy", value: milestonePreviewCsp }],
        source: "/milestones",
      },
      {
        headers: [{ key: "Content-Security-Policy", value: milestonePreviewCsp }],
        source: "/hr/milestones",
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
      // The hiring-pack documents, framed by their own fill screen — see hiringPackPrintCsp above for
      // why this keeps the full site-wide policy rather than the frame-ancestors-only one used by the
      // two file routes directly above it.
      {
        headers: [
          { key: "Content-Security-Policy", value: hiringPackPrintCsp },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
        source: "/api/hiring-pack/:hrId/print",
      },
      // Business cards: the screen saves a ZIP of separate PDFs by posting into a hidden same-origin
      // frame, so the browser writes the stream to disk instead of holding it in the page. The
      // site-wide DENY blocks that response like the CV preview above, and the download never starts.
      // Same scoped loosening as the two file routes: the route returns PDF/ZIP bytes or a JSON
      // error, never HTML that runs script, so a frame-ancestors-only CSP loses nothing.
      {
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
        source: "/api/business-cards",
      },
      ...(process.env.NODE_ENV === "production"
        ? [
            { source: "/_next/static/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }] },
            // Brand files under public/brand keep their names when a picture is replaced, so a
            // browser's copy is the only thing that can show an old logo. Next's public/ default
            // (public, max-age=0) makes every page load ask again; a day plus a week of
            // stale-while-revalidate (the old value, set for a Cloud CDN that no longer exists —
            // GCP is gone and Railway has no shared cache) let a replaced logo linger for up to
            // eight days. With one hour plus a day of stale serving, repeat loads stay cheap and a
            // replaced file shows from the second load after the hour is up. Not `immutable`: the
            // names are not content-hashed.
            { source: "/brand/:path*", headers: [{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }] },
          ]
        : []),
    ];
  },
};

// Source maps and releases: the Sentry build plugin runs ONLY when this build carries an auth token, so every
// build without one (local, preview, CI, staging) exports the plain config exactly as before. The token is a
// build-time secret and is never printed; the maps are deleted after upload so none is served to a browser.
// The four auto-instrument switches stay off — they would wrap every route handler and middleware, and the
// app already reports through its own paths. No tunnelRoute: the browser reports straight to the ingest host
// the CSP allows.
function withOptionalSentry(config: NextConfig): NextConfig {
  const authToken = String(process.env.SENTRY_AUTH_TOKEN ?? "").trim();
  if (!authToken) return config;
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded only on a build that has a token; withSentryConfig lives at the /config entry, not the package root
  const { withSentryConfig } = require("@sentry/nextjs/config") as {
    withSentryConfig: (config: NextConfig, options: Record<string, unknown>) => NextConfig;
  };
  const release = String(process.env.COMMIT_SHA ?? process.env.RAILWAY_GIT_COMMIT_SHA ?? "").trim();
  return withSentryConfig(config, {
    // The account's organisation, project and EU host are not secrets, so they are written here, not synced.
    org: "phoenix-crm",
    project: "phoenix-workforce",
    sentryUrl: "https://de.sentry.io",
    authToken,
    silent: true,
    // A rejected or expired token must never stop a production deploy: the upload fails, the build goes on.
    errorHandler: (error: Error) => console.warn(`[sentry] source-map upload skipped: ${error.message}`),
    telemetry: false,
    widenClientFileUpload: true,
    sourcemaps: { deleteSourcemapsAfterUpload: true },
    // The release is the commit sha. It is also marked as a production deploy, so Sentry shows when each release went
    // out and which errors first appeared in it. setCommits names the repository explicitly (the Docker build has no
    // .git to read) and ignores a missing integration, so it only starts working once the GitHub integration is
    // installed in Sentry and is silent until then.
    ...(release
      ? {
          release: {
            name: release,
            deploy: { env: "production" },
            setCommits: { repo: "it-gawish-hr/phoenix-people-workforce", commit: release, ignoreMissing: true },
          },
        }
      : {}),
    autoInstrumentServerFunctions: false,
    autoInstrumentMiddleware: false,
    autoInstrumentAppDirectory: false,
    automaticVercelMonitors: false,
  });
}

export default withOptionalSentry(nextConfig);
