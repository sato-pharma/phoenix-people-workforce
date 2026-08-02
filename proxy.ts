import { NextResponse, type NextRequest } from "next/server";

import { resolveRootRedirectPath } from "@/lib/auth/root-landing";
import { phoenixSessionCookieName } from "@/lib/auth/session-token";
import {
  isSameOriginMutationRequest,
  requiresCsrfProtection,
} from "@/lib/security/csrf";
import {
  isAllowedPhoenixOrigin,
  normalizeOrigin,
} from "@/lib/security/origins";

const builderPreviewOrigin = "https://builder.io";

const previewReadOnlyAllowedMutationPaths = new Set([
  "/api/admin/email-composer/preview",
  "/api/admin/email-composer/resolve-recipients",
  "/api/admin/email-reply/send",
  "/api/admin/email-templates/preview",
  "/api/admin/email-templates/simulate-recipients",
  "/api/admin/email-templates/test",
  "/api/admin/email-templates/validate-draft",
  "/api/auth/heartbeat",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/integrations/telegram/webhook",
]);

function isPreviewSourceOfSalesMutationPath(pathname: string) {
  return pathname === "/api/sales/monthly-import/validate" ||
    /^\/api\/sales\/monthly-import\/batches\/[^/]+$/.test(pathname) ||
    pathname === "/api/sales/source-of-sales/products" ||
    /^\/api\/sales\/source-of-sales\/products\/[^/]+$/.test(pathname);
}

function isPreviewEmailTemplateMutationPath(pathname: string) {
  return /^\/api\/admin\/email-templates\/[^/]+$/.test(pathname) ||
    /^\/api\/admin\/email-templates\/[^/]+\/rollback$/.test(pathname);
}

function isPreviewReadOnlyEnabled() {
  // Platform-neutral preview detection (previously used a Vercel-only env var that is
  // never set on Cloud Run). A preview deployment must set APP_ENV=preview AND opt in
  // with PHOENIX_PREVIEW_READ_ONLY=true.
  return (
    process.env.APP_ENV === "preview" &&
    process.env.PHOENIX_PREVIEW_READ_ONLY === "true"
  );
}

function isPreviewReadOnlyBlockedMutation(request: NextRequest) {
  if (!isPreviewReadOnlyEnabled() || !requiresCsrfProtection(request)) {
    return false;
  }

  return !previewReadOnlyAllowedMutationPaths.has(request.nextUrl.pathname) &&
    !isPreviewSourceOfSalesMutationPath(request.nextUrl.pathname) &&
    !isPreviewEmailTemplateMutationPath(request.nextUrl.pathname);
}

export function isPreviewBuilderLoginRequest(request: NextRequest) {
  if (
    request.method.toUpperCase() !== "POST" ||
    request.nextUrl.pathname !== "/api/auth/login" ||
    !isAllowedPhoenixOrigin(builderPreviewOrigin)
  ) {
    return false;
  }

  const originHeader = normalizeOrigin(request.headers.get("origin"));
  const refererOrigin = normalizeOrigin(request.headers.get("referer"));

  return originHeader === builderPreviewOrigin || refererOrigin === builderPreviewOrigin;
}

/**
 * Answer "/" with a real HTTP redirect instead of a JS-dependent one.
 *
 * Resolving the landing path here — before rendering — is what makes the redirect a true 307.
 * See src/lib/auth/root-landing.ts for why resolving it in app/page.tsx could not be.
 *
 * Fails OPEN by design: any throw (missing PHOENIX_AUTH_SECRET, malformed cookie) falls
 * through to app/page.tsx, which still performs the same redirect the slow way. The entry
 * point of a live HR platform must degrade to "slower" and never to a 500.
 */
function rootRedirectResponse(request: NextRequest) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (request.nextUrl.pathname !== "/") return null;

  try {
    const destination = resolveRootRedirectPath(
      request.cookies.get(phoenixSessionCookieName)?.value,
    );
    const url = request.nextUrl.clone();
    url.pathname = destination;
    url.search = "";

    const response = NextResponse.redirect(url, 307);
    // The destination depends on the session cookie, so this response is per-user. Never let an
    // edge or intermediary hold it: a cached "/" -> /admin would be handed to signed-out visitors.
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  } catch {
    return null;
  }
}

export function proxy(request: NextRequest) {
  const rootRedirect = rootRedirectResponse(request);
  if (rootRedirect) return rootRedirect;

  if (isPreviewReadOnlyBlockedMutation(request)) {
    return NextResponse.json(
      {
        error: "preview_read_only",
        message: "Preview is read-only. Mutations are disabled to protect production data.",
      },
      { status: 403 },
    );
  }

  if (isPreviewBuilderLoginRequest(request)) {
    return NextResponse.next();
  }

  if (
    request.method.toUpperCase() === "POST" &&
    (
      request.nextUrl.pathname === "/api/attendance/raw-punches" ||
      request.nextUrl.pathname === "/api/admin/synthetic-journeys/ingest" ||
      request.nextUrl.pathname === "/api/integrations/telegram/webhook" ||
      request.nextUrl.pathname === "/api/webhooks/resend" ||
      // Brevo transactional webhook: the provider POSTs cross-origin; a shared secret token
      // (?token= / x-brevo-token, verified in the route) authorises it, so it is CSRF-exempt.
      request.nextUrl.pathname === "/api/webhooks/brevo" ||
      // WhatsApp Cloud API webhook: Meta POSTs cross-origin with no Origin/Referer header,
      // so it always fail-closed here (403) even with a correct X-Hub-Signature-256 — the
      // route verifies that signature itself, so this is CSRF-exempt by the same shared-secret
      // pattern as the other provider webhooks above.
      request.nextUrl.pathname === "/api/webhooks/whatsapp" ||
      // RFC 8058 one-click unsubscribe: the mailbox provider POSTs cross-origin; the
      // signed token (not a session) authorises it, so it is CSRF-exempt by design.
      request.nextUrl.pathname.startsWith("/api/email/unsubscribe/")
    )
  ) {
    return NextResponse.next();
  }

  if (!requiresCsrfProtection(request)) {
    return NextResponse.next();
  }

  if (!isSameOriginMutationRequest(request)) {
    return NextResponse.json(
      { error: "csrf_blocked", message: "Cross-site mutation request blocked." },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // "/" is matched so the entry point can be answered with a true 307 before any rendering.
    "/",
    "/api/:path*",
    "/offers/:token/accept",
    "/offers/:token/reject",
  ],
};
