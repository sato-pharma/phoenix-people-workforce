import { type NextRequest, NextResponse } from "next/server";

import {
  isSameOriginMutationRequest,
  requiresCsrfProtection,
} from "@/lib/security/csrf";

export function middleware(request: NextRequest) {
  if (
    requiresCsrfProtection(request) &&
    !isSameOriginMutationRequest(request)
  ) {
    return NextResponse.json(
      {
        error: "csrf_violation",
        message: "Cross-origin state-mutating requests are not allowed.",
      },
      { status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
