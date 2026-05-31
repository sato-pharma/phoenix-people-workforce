import { NextResponse, type NextRequest } from "next/server";

import { isSameOriginMutationRequest } from "@/lib/security/csrf";

function normalizeLocalhost(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (hostname === "127.0.0.1" || hostname === "::1") {
    url.hostname = "localhost";
  }
  return url.origin;
}

function plainRequestIsSameOrigin(request: Request) {
  const expectedOrigin = normalizeLocalhost(request.url);
  const originHeader = request.headers.get("origin");
  if (originHeader) {
    try {
      return normalizeLocalhost(originHeader) === expectedOrigin;
    } catch {
      return false;
    }
  }

  const refererHeader = request.headers.get("referer");
  if (refererHeader) {
    try {
      return normalizeLocalhost(refererHeader) === expectedOrigin;
    } catch {
      return false;
    }
  }

  return false;
}

export function assertSameOriginMutation(request: Request) {
  if ("nextUrl" in request && isSameOriginMutationRequest(request as NextRequest)) return null;
  if (plainRequestIsSameOrigin(request)) return null;

  return NextResponse.json(
    {
      error: "csrf_failed",
      message: "This action must be submitted from the Phoenix Workforce application.",
      success: false,
    },
    { status: 403 },
  );
}
