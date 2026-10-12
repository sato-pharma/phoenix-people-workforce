import { NextResponse } from "next/server";

import {
  createDevPreviewSessionToken,
  devPreviewCookieMaxAgeSeconds,
  isLocalDevelopmentRequest,
  phoenixDevPreviewCookieName,
} from "@/lib/auth/dev-preview";
import { devRelativeRedirect } from "@/lib/auth/dev-redirect";
import { findDevPreviewRoleMismatch } from "@/lib/auth/dev-preview-picker";
import { parseRoleStrict } from "@/lib/auth/permissions";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { resolveTestPersonaLink, type SessionUserRow } from "@/lib/auth/server";
import { getSupabaseAdmin } from "@/lib/supabase/server";

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
  const testLogin = url.searchParams.get("testLogin")?.trim();
  if (testLogin) {
    return openTestAccount(url, testLogin);
  }

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

  return setPreviewCookie(devRelativeRedirect(new URL(nextPath, url)), createDevPreviewSessionToken({ hrId, loginId, role }));
}

function setPreviewCookie(response: NextResponse, value: string) {
  response.cookies.set({
    httpOnly: true,
    maxAge: devPreviewCookieMaxAgeSeconds(),
    name: phoenixDevPreviewCookieName,
    path: "/",
    sameSite: "lax",
    secure: false,
    value,
  });
  return response;
}

/**
 * `?testLogin=TEST-…` opens a TEST ACCOUNT the way its own sign-in would, without its password: the
 * person it mirrors, in the test world, with every test-account guard on (owner, 2026-09-30 — a dev
 * preview under the real hr id acted as the REAL person, so her saves would have been real). Only a
 * row that IS an active test account qualifies, and its link comes from the same rule the real
 * sign-in applies (`resolveTestPersonaLink`), so a dev session can never be a test account the real
 * one would refuse.
 */
async function openTestAccount(url: URL, testLogin: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("app_auth_users")
    .select("login_id, hr_id, role, is_active, is_test_persona, test_persona_of_hr_id")
    .eq("login_id", testLogin.toUpperCase())
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "lookup_failed", message: error.message }, { status: 500 });
  }
  const row = data as SessionUserRow | null;
  if (!row || row.is_test_persona !== true) {
    return NextResponse.json(
      { error: "not_a_test_account", message: `${testLogin} is not a test account. Use hrId for a real person's preview.` },
      { status: 404 },
    );
  }
  if (!row.is_active) {
    return NextResponse.json({ error: "test_account_off", message: `${row.login_id} is switched off.` }, { status: 409 });
  }
  const role = parseRoleStrict(row.role);
  const link = resolveTestPersonaLink(row, role);
  if (!link.ok) {
    return NextResponse.json({ error: link.reason, message: `${row.login_id} cannot be opened: ${link.reason}.` }, { status: 409 });
  }

  const nextPath = normalizeNextPath(url.searchParams.get("next"), resolveLandingPathForRole(role));
  return setPreviewCookie(
    devRelativeRedirect(new URL(nextPath, url)),
    createDevPreviewSessionToken({ hrId: link.link.mirrorsHrId, loginId: link.link.loginId, role, testPersona: true }),
  );
}
