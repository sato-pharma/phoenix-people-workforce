import { NextResponse, type NextRequest } from "next/server";

import { isSameOriginMutationRequest } from "@/lib/security/csrf";
import {
  isAllowedPhoenixOrigin,
  normalizeOrigin,
  requestOriginCandidates,
} from "@/lib/security/origins";

function plainRequestIsSameOrigin(request: Request) {
  const candidates = requestOriginCandidates(request);
  const expectedOrigins = new Set(
    [candidates.forwardedOrigin, candidates.hostOrigin, candidates.requestUrlOrigin]
      .filter((origin): origin is string => Boolean(origin && isAllowedPhoenixOrigin(origin))),
  );

  const originHeader = normalizeOrigin(request.headers.get("origin"));
  if (originHeader) return expectedOrigins.has(originHeader);

  const refererOrigin = normalizeOrigin(request.headers.get("referer"));
  if (refererOrigin) return expectedOrigins.has(refererOrigin);

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
