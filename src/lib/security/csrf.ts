import type { NextRequest } from "next/server";

import {
  isAllowedPhoenixOrigin,
  normalizeOrigin,
  originFromHostParts,
} from "@/lib/security/origins";

const csrfProtectedMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

function expectedOrigins(request: NextRequest) {
  const origins = new Set<string>();
  const requestUrlOrigin = normalizeOrigin(request.url);
  const nextUrlOrigin = normalizeOrigin(request.nextUrl.origin);
  const forwardedOrigin = originFromHostParts(
    request.headers.get("x-forwarded-host"),
    request.headers.get("x-forwarded-proto"),
  );
  const hostOrigin = originFromHostParts(
    request.headers.get("host"),
    request.nextUrl.protocol.replace(/:$/, ""),
  );

  for (const origin of [requestUrlOrigin, nextUrlOrigin, forwardedOrigin, hostOrigin]) {
    if (origin && isAllowedPhoenixOrigin(origin)) {
      origins.add(origin);
    }
  }

  return origins;
}

export function requiresCsrfProtection(request: NextRequest) {
  return csrfProtectedMethods.has(request.method.toUpperCase());
}

export function isSameOriginMutationRequest(request: NextRequest) {
  const allowedOrigins = expectedOrigins(request);
  const originHeader = normalizeOrigin(request.headers.get("origin"));

  if (originHeader) {
    return allowedOrigins.has(originHeader);
  }

  const refererOrigin = normalizeOrigin(request.headers.get("referer"));
  if (refererOrigin) {
    return allowedOrigins.has(refererOrigin);
  }

  return false;
}
