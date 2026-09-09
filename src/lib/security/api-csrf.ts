import { NextResponse, type NextRequest } from "next/server";

import { logStructured } from "@/lib/observability/log";
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

  // The SECOND refusal site, logged for the same reason as the one in proxy.ts and with the same
  // shape. Both are needed: the proxy only guards the paths in `isSecurityProxyPath`, so a route
  // outside that set is refused HERE and nowhere else — logging one and not the other would leave
  // exactly the silent half that made this undiagnosable in the first place. A DIFFERENT event
  // name, so a search can tell which layer refused, which says whether the path was proxy-covered.
  logStructured("WARNING", "Cross-site mutation refused at the route", {
    labels: { event: "csrf_failed" },
    context: {
      method: request.method,
      // Path only — never the query string, which can carry an id or a token.
      path: (() => { try { return new URL(request.url).pathname; } catch { return null; } })(),
      origin: normalizeOrigin(request.headers.get("origin")) ?? null,
      referer: normalizeOrigin(request.headers.get("referer")) ?? null,
      host: request.headers.get("host"),
    },
  });

  return NextResponse.json(
    {
      error: "csrf_failed",
      message: "This action must be submitted from the Phoenix Workforce application.",
      success: false,
    },
    { status: 403 },
  );
}
