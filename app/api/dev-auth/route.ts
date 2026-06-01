import { NextResponse } from "next/server";

import {
  createDevPreviewSessionToken,
  devPreviewCookieMaxAgeSeconds,
  phoenixDevPreviewCookieName,
} from "@/lib/auth/dev-preview";
import { parseRoleStrict } from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isLoopbackHostname(hostname: string | null | undefined) {
  const normalized = hostname?.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function hostnameFromHeader(value: string | null) {
  const first = value?.split(",")[0]?.trim();
  if (!first) return null;
  const withoutPort = first.startsWith("[")
    ? first.slice(1, first.indexOf("]"))
    : first.split(":")[0];
  return withoutPort || null;
}

function isLocalDevelopmentRequest(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return false;
  }

  const hostname = new URL(request.url).hostname.toLowerCase();
  const hostHeader = hostnameFromHeader(request.headers.get("host"));
  const forwardedHost = hostnameFromHeader(request.headers.get("x-forwarded-host"));

  return [hostname, hostHeader, forwardedHost].some(isLoopbackHostname);
}

function normalizeNextPath(value: string | null, fallback: string) {
  const next = value?.trim();
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return fallback;
  }

  return next;
}

export async function GET(request: Request) {
  if (!isLocalDevelopmentRequest(request)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const url = new URL(request.url);
  const role = parseRoleStrict(url.searchParams.get("role") ?? "Super Admin");
  const loginId = url.searchParams.get("loginId")?.trim() || "dev.preview";
  const hrId = url.searchParams.get("hrId")?.trim() || null;
  const nextPath = normalizeNextPath(
    url.searchParams.get("next"),
    resolveLandingPathForRole(role),
  );

  const response = NextResponse.redirect(new URL(nextPath, url));
  response.cookies.set({
    httpOnly: true,
    maxAge: devPreviewCookieMaxAgeSeconds(),
    name: phoenixDevPreviewCookieName,
    path: "/",
    sameSite: "lax",
    secure: false,
    value: createDevPreviewSessionToken({ hrId, loginId, role }),
  });

  return response;
}
