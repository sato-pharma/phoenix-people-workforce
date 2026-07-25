import { NextResponse } from "next/server";

import {
  createDevPreviewSessionToken,
  devPreviewCookieMaxAgeSeconds,
  isLocalDevelopmentRequest,
  phoenixDevPreviewCookieName,
} from "@/lib/auth/dev-preview";
import { parseRoleStrict } from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
