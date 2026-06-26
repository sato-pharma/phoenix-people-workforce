import { NextResponse, type NextRequest } from "next/server";

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
  return (
    process.env.VERCEL_ENV === "preview" &&
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

export function proxy(request: NextRequest) {
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
      request.nextUrl.pathname === "/api/integrations/telegram/webhook" ||
      request.nextUrl.pathname === "/api/webhooks/resend" ||
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
    "/api/:path*",
    "/offers/:token/accept",
    "/offers/:token/reject",
  ],
};
