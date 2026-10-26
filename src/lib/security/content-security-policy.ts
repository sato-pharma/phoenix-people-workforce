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
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://maps.googleapis.com https://maps.gstatic.com https://routes.googleapis.com https://cdn.onesignal.com https://api.onesignal.com https://onesignal.com",
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
