import { NextResponse } from "next/server";

import {
  createDevPreviewSessionToken,
  devPreviewCookieMaxAgeSeconds,
  isLocalDevelopmentRequest,
  phoenixDevPreviewCookieName,
} from "@/lib/auth/dev-preview";
import { findDevPreviewRoleMismatch } from "@/lib/auth/dev-preview-picker";
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

  // A preview under a real person's hrId wears the role that person really signs in with. Without
  // this, `role=Medical Rep&hrId=<a District Manager>` rendered a medical rep's command center under
  // his name with no team on it, which read as his real account being broken (2026-09-21). Leave
  // hrId out for a role-only preview; a synthetic hrId with no login is still accepted.
  if (hrId) {
    const mismatch = await findDevPreviewRoleMismatch(role, hrId);
    if (mismatch) {
      const who = mismatch.fullName ?? "This person";
      return NextResponse.json(
        {
          actualRole: mismatch.actualRole,
          error: "role_mismatch",
          message: `${who} signs in as ${mismatch.actualRole}, not ${role}. Preview them as ${mismatch.actualRole}, or leave hrId out for a role-only preview.`,
        },
        { status: 409 },
      );
    }
  }

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
