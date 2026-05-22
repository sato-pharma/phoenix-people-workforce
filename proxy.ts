import { NextResponse, type NextRequest } from "next/server";

import {
  isSameOriginMutationRequest,
  requiresCsrfProtection,
} from "@/lib/security/csrf";

export function proxy(request: NextRequest) {
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
