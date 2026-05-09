import type { NextRequest } from "next/server";

const csrfProtectedMethods = new Set(["DELETE", "PATCH", "POST", "PUT"]);

function normalizeLocalHostname(hostname: string) {
  const normalized = hostname
    .trim()
    .replace(/^\[(.*)\]$/, "$1")
    .toLowerCase();

  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  ) {
    return "localhost";
  }

  return normalized;
}

function originFromUrl(value: string | null) {
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function normalizeOrigin(value: string | null) {
  const origin = originFromUrl(value);
  if (!origin) return null;

  try {
    const url = new URL(origin);
    url.hostname = normalizeLocalHostname(url.hostname);
    return url.origin;
  } catch {
    return null;
  }
}

function originFromHostParts(host: string | null, proto: string | null) {
  const normalizedHost = host?.trim();
  if (!normalizedHost) return null;

  const normalizedProto = proto?.trim() || "https";
  return normalizeOrigin(`${normalizedProto}://${normalizedHost}`);
}

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
    if (origin) {
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
