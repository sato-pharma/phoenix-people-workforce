/**
 * THE PAGE CONTENT SECURITY POLICY, WITH A NONCE PER REQUEST (26 Oct 2026 deep audit, point 29).
 *
 * The site-wide policy in next.config.ts allowed `'unsafe-inline'` scripts, so ONE injected
 * `<script>` anywhere in a page ran with the signed-in person's session. A page now carries this
 * policy instead: inline and parser-inserted scripts run only with the nonce `proxy.ts` mints for
 * that one request, and `'strict-dynamic'` lets a script that already runs load the scripts it needs
 * (the Next.js chunks, the Maps loader, OneSignal, the Facebook SDK, gapi, pdf.js).
 *
 * 🔴 NEVER `'unsafe-inline'` IN script-src HERE. A browser that understands nonces ignores it anyway,
 * so adding it back "to be safe" protects nobody who has a modern browser and silently re-opens the
 * hole for everybody else. A page script that is blocked needs the nonce, never the old keyword.
 *
 * EVERY OTHER DIRECTIVE MIRRORS next.config.ts EXACTLY, and tests/csp-headers.test.ts proves it by
 * evaluating both under the same environment: the base policy, the builder-preview frame-ancestors,
 * the Sentry ingest host (site policy only), and the three page overrides (/whatsapp-connect, the
 * managed Google Play console, the Milestones workspace — both spellings of each /hr page). The host
 * lists stay in script-src on purpose: a browser without CSP Level 3 ignores `'strict-dynamic'` and
 * falls back to them.
 *
 * NOT FOR API ROUTES OR FILES. An API route's HTML (the hiring-pack print page, the share card) and a
 * file under public/ keep the next.config.ts policy; `shouldSendPageCsp` decides, and Next.js only
 * puts the nonce on what it renders itself.
 *
 * Pure: no imports, so the proxy, the root layout and the test read the same function.
 */

/** The request header the proxy hands the nonce to the layouts in. */
export const CSP_NONCE_HEADER = "x-nonce";

const BUILDER_PREVIEW_ORIGIN = "https://builder.io";

export type PagePolicyEnvironment = {
  isProduction: boolean;
  /** PHOENIX_ALLOWED_ORIGINS, comma-separated — the builder preview origin opens frame-ancestors. */
  allowedOrigins: string;
  /** NEXT_PUBLIC_SENTRY_DSN — its ingest origin joins connect-src on the site policy. */
  sentryDsn: string;
};

export function pagePolicyEnvironment(): PagePolicyEnvironment {
  return {
    isProduction: process.env.NODE_ENV === "production",
    allowedOrigins: String(process.env.PHOENIX_ALLOWED_ORIGINS ?? ""),
    sentryDsn: String(process.env.NEXT_PUBLIC_SENTRY_DSN ?? ""),
  };
}

/** 16 random bytes, base64 — fresh for every request, never reused. */
export function createCspNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Whether a request path is a PAGE that gets the nonce policy. API routes, Next.js internals and
 * anything that names a file (a dot-extension on the last segment: public/ assets, the OneSignal
 * worker, marketing-guide.html) keep the next.config.ts policy.
 */
export function shouldSendPageCsp(pathname: string): boolean {
  if (pathname === "/api" || pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/_next/")) return false;
  const lastSegment = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !/\.[a-z0-9]{1,12}$/i.test(lastSegment);
}

function configuredOrigins(allowedOrigins: string): Set<string> {
  return new Set(
    allowedOrigins
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

function sentryIngestOrigin(sentryDsn: string): string | null {
  try {
    const dsn = new URL(sentryDsn.trim());
    return dsn.protocol === "https:" && dsn.username ? dsn.origin : null;
  } catch {
    return null;
  }
}

function basePagePolicy(nonce: string, env: PagePolicyEnvironment): string {
  const frameAncestorsPolicy = configuredOrigins(env.allowedOrigins).has(BUILDER_PREVIEW_ORIGIN)
    ? `frame-ancestors 'self' ${BUILDER_PREVIEW_ORIGIN}`
    : "frame-ancestors 'none'";
  return [
    "default-src 'self'",
    // next.config.ts explains every host and 'wasm-unsafe-eval' (the Maps vector renderer).
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' blob: https://maps.googleapis.com https://maps.gstatic.com https://cdn.onesignal.com https://api.onesignal.com${env.isProduction ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https://*.supabase.co https://maps.googleapis.com https://maps.gstatic.com https://routes.googleapis.com https://cdn.onesignal.com https://api.onesignal.com https://onesignal.com",
    "media-src 'self' blob: https://*.supabase.co",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    frameAncestorsPolicy,
    ...(env.isProduction ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/**
 * The policy for one page request. The three page overrides are derived from the base exactly as
 * next.config.ts derives them, and matched on the address the BROWSER asked for (before the /hr
 * rewrite), which is the path the next.config.ts header rules match too.
 */
export function pageContentSecurityPolicy(
  pathname: string,
  nonce: string,
  env: PagePolicyEnvironment = pagePolicyEnvironment(),
): string {
  const base = basePagePolicy(nonce, env);
  switch (pathname) {
    case "/whatsapp-connect":
      return base
        .replace("script-src 'self'", "script-src 'self' https://connect.facebook.net")
        .replace(
          "connect-src 'self'",
          "connect-src 'self' https://connect.facebook.net https://graph.facebook.com https://*.facebook.com",
        )
        .concat("; frame-src 'self' https://connect.facebook.net https://*.facebook.com");
    case "/devices/managed-play":
    case "/hr/devices/managed-play":
      return base
        .replace("script-src 'self'", "script-src 'self' https://apis.google.com")
        .replace("connect-src 'self'", "connect-src 'self' https://apis.google.com https://play.google.com")
        .concat("; frame-src 'self' https://play.google.com https://apis.google.com");
    case "/milestones":
    case "/hr/milestones":
      return base.concat("; frame-src 'self' blob:");
    default: {
      const sentry = sentryIngestOrigin(env.sentryDsn);
      return sentry ? base.replace("connect-src 'self'", `connect-src 'self' ${sentry}`) : base;
    }
  }
}

/**
 * WHERE A BROWSER SENDS A REPORT-ONLY VIOLATION — app/api/security/csp-report/route.ts. The same path
 * is the `report-uri` (Firefox, Safari) and the `csp-report` endpoint of `report-to` (Chromium).
 */
export const CSP_REPORT_PATH = "/api/security/csp-report";
export const CSP_REPORT_GROUP = "csp-report";

/**
 * The `Reporting-Endpoints` header a page carries with the report-only policy. Same-origin, so the
 * relative path is valid.
 */
export const CSP_REPORTING_ENDPOINTS = `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"`;

/**
 * Where a page may load a picture from under the report-only policy (S01, F-PLT-011), measured
 * 13 Nov 2026:
 *
 *   'self' data: blob:     employee photos (/api/employees/<hrId>/photo), bundled files, previews made
 *                          in the browser (a camera capture, a stored signature)
 *   *.supabase.co          every evidence, invoice and attachment picture (a signed storage address)
 *   tile.openstreetmap.org the integrity-board and refused-reading map tiles
 *   *.googleapis.com, *.gstatic.com, *.google.com, *.googleusercontent.com
 *                          the Maps JavaScript API's tiles and markers (Google's own CSP guide)
 *   *.onesignal.com        the push-permission prompt's pictures
 */
export const REPORT_ONLY_IMAGE_SOURCES = [
  "'self'",
  "data:",
  "blob:",
  "https://*.supabase.co",
  "https://tile.openstreetmap.org",
  "https://*.googleapis.com",
  "https://*.gstatic.com",
  "https://*.google.com",
  "https://*.googleusercontent.com",
  "https://*.onesignal.com",
] as const;

/**
 * THE REPORT-ONLY POLICY A PAGE CARRIES BESIDE ITS ENFORCED ONE (S01, F-PLT-011, 13 Nov 2026).
 *
 * It blocks nothing. It tells the browser to REPORT, to CSP_REPORT_PATH, every `<style>` element
 * without this request's nonce and every picture from outside REPORT_ONLY_IMAGE_SOURCES, so the
 * enforced policy can drop `'unsafe-inline'` from style-src and narrow img-src once the reports are
 * measured. It is not enforced yet because what was measured would break today:
 *
 *   - the toast library mounted on every page injects a `<style>` with no nonce, as do the .docx CV
 *     preview, the hiring-pack paper editor and 21 `<style>` elements in our own components;
 *   - a received email shown in the mailbox frames loads pictures from any host.
 *
 * `style-src-attr 'unsafe-inline'` keeps the 1,104 `style={…}` attributes out of the reports, which
 * cover `<style>` elements only.
 *
 * Only the two measured directives are listed, so nothing else is reported. frame-ancestors and
 * upgrade-insecure-requests are left out because a browser ignores them in a report-only policy.
 */
export function pageReportOnlyContentSecurityPolicy(nonce: string): string {
  return [
    `style-src 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
    "style-src-attr 'unsafe-inline'",
    `img-src ${REPORT_ONLY_IMAGE_SOURCES.join(" ")}`,
    `report-uri ${CSP_REPORT_PATH}`,
    `report-to ${CSP_REPORT_GROUP}`,
  ].join("; ");
}
