import { NextResponse, type NextRequest } from "next/server";

import {
  isSameOriginMutationRequest,
  requiresCsrfProtection,
} from "@/lib/security/csrf";

const previewReadOnlyAllowedMutationPaths = new Set([
  "/api/auth/heartbeat",
  "/api/auth/login",
  "/api/auth/logout",
]);

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

  return !previewReadOnlyAllowedMutationPaths.has(request.nextUrl.pathname);
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

  if (
    request.method.toUpperCase() === "POST" &&
    (
      request.nextUrl.pathname === "/api/attendance/raw-punches" ||
      request.nextUrl.pathname === "/api/webhooks/resend"
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
