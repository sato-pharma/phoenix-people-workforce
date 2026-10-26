import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { revokeAppSession } from "@/lib/auth/app-sessions";
import { writeAuthAudit } from "@/lib/auth/audit";
import { isDevPreviewReplay, isLocalDevelopmentRequest } from "@/lib/auth/dev-preview";
import { devRelativeRedirect } from "@/lib/auth/dev-redirect";
import { findDevPreviewCandidate, findDevPreviewCandidateByHrId } from "@/lib/auth/dev-preview-picker";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { parseRoleStrict, type AccessContext, type PhoenixRole } from "@/lib/auth/permissions";
import { isPreviewSession } from "@/lib/auth/preview-session-guard";
import { resolveAccessContext } from "@/lib/auth/server";
import { phoenixSessionCookieName, verifySessionToken } from "@/lib/auth/session";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LaunchParams = { area: string | null; hrId: string | null; line: string | null; region: string | null };

const LAUNCH_FIELDS = ["role", "hrId", "line", "region", "area"] as const;

/**
 * The picker's form fields. The switch is a POST from `<form method="post">` (audit point 17,
 * 2026-10-26): it revokes the caller's real session and writes an audit row, and as a GET any link
 * or `<img src>` on a page the Super Admin opened could fire it. Only the five named text fields
 * are read; a body that is not a form reads as empty, which fails the role check below.
 */
async function readLaunchForm(request: Request): Promise<URLSearchParams> {
  const fields = new URLSearchParams();
  const form = await request.formData().catch(() => null);
  if (!form) return fields;
  for (const name of LAUNCH_FIELDS) {
    const value = form.get(name);
    if (typeof value === "string") fields.set(name, value);
  }
  return fields;
}

function readLaunchParams(fields: URLSearchParams): LaunchParams {
  return {
    area: fields.get("area")?.trim() || null,
    hrId: fields.get("hrId")?.trim() || null,
    line: fields.get("line")?.trim() || null,
    region: fields.get("region")?.trim() || null,
  };
}

function resolveLaunchCandidate(role: PhoenixRole, params: LaunchParams) {
  return params.hrId
    ? findDevPreviewCandidateByHrId(role, params.hrId)
    : findDevPreviewCandidate(role, { areaName: params.area, lineName: params.line, regionName: params.region });
}

/**
 * Where a REPEATED launch goes, or null when this is not one. A second click on the picker's button,
 * or a reload of the still-pending address, arrives wearing the preview the first click already
 * switched to, and so fails the Super Admin gate — see `isDevPreviewReplay` for the incident. It is
 * sent where the first click was going: the landing page `/api/dev-auth` redirects to.
 *
 * It grants nothing. It answers only a preview session asking for the very preview it is already in,
 * and all it returns is that session's own landing page — no session is minted, no cookie is set,
 * the real session is not touched and no audit row is written. Everything else stays a 403.
 */
async function replayLandingUrl(access: AccessContext, fields: URLSearchParams, base: URL): Promise<URL | null> {
  if (!isPreviewSession(access)) return null;

  let role: PhoenixRole;
  try {
    role = parseRoleStrict(fields.get("role"));
  } catch {
    return null;
  }
  if (role !== access.role) return null;

  const candidate = await resolveLaunchCandidate(role, readLaunchParams(fields));
  if (!candidate || !isDevPreviewReplay(access, { hrId: candidate.hrId, role })) return null;

  return new URL(resolveLandingPathForRole(role), base);
}

/**
 * Super Admin-only front door onto the existing `/api/dev-auth` bootstrap route:
 * given a role and either an explicit `hrId` (chosen by name in the picker) or
 * line/region/area filters (auto-pick), resolves a real active employee and
 * hands off to it so the preview shows genuine data instead of a synthetic
 * fixture. Local development only — see `isLocalDevelopmentRequest`.
 *
 * A same-origin POST only, and every answer is a 303 so the browser's next hop is a plain GET.
 */
export async function POST(request: Request) {
  if (!isLocalDevelopmentRequest(request)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const csrf = assertSameOriginMutation(request);
  if (csrf) return csrf;

  const url = new URL(request.url);
  const fields = await readLaunchForm(request);

  const access = await resolveAccessContext(request);
  if (access.role !== "Super Admin") {
    const replay = await replayLandingUrl(access, fields, url);
    if (replay) return devRelativeRedirect(replay, 303);
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let role: ReturnType<typeof parseRoleStrict>;
  try {
    role = parseRoleStrict(fields.get("role"));
  } catch {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }
  const launch = readLaunchParams(fields);
  const { area, hrId, line, region } = launch;
  const candidate = await resolveLaunchCandidate(role, launch);

  if (!candidate) {
    const backUrl = new URL("/admin/dev-preview", url);
    backUrl.searchParams.set("error", "no_candidate");
    backUrl.searchParams.set("role", role);
    if (line) backUrl.searchParams.set("line", line);
    if (region) backUrl.searchParams.set("region", region);
    if (area) backUrl.searchParams.set("area", area);
    return devRelativeRedirect(backUrl, 303);
  }

  const targetUrl = new URL("/api/dev-auth", url);
  targetUrl.searchParams.set("role", role);
  targetUrl.searchParams.set("hrId", candidate.hrId);
  targetUrl.searchParams.set("loginId", candidate.fullName);

  const response = devRelativeRedirect(targetUrl, 303);

  // The real session cookie is checked before the dev-preview cookie
  // (see resolveAccessContextInner in src/lib/auth/server.ts), so it must be
  // cleared here or the upcoming dev-preview cookie would be silently ignored.
  const cookieStore = await cookies();
  const realSession = verifySessionToken(cookieStore.get(phoenixSessionCookieName)?.value ?? null);
  if (realSession) {
    await revokeAppSession(realSession.sid, "dev_preview_switch").catch(() => undefined);
  }
  response.cookies.delete(phoenixSessionCookieName);

  await writeAuthAudit({
    actorLoginId: access.loginId,
    entityId: candidate.hrId,
    newValues: {
      pickedByName: Boolean(hrId),
      previewArea: candidate.areaName,
      previewLine: candidate.lineName,
      previewRegion: candidate.regionName,
      previewRole: role,
      targetHrId: candidate.hrId,
      targetName: candidate.fullName,
    },
    summary: `Super Admin dev-preview: switched into ${role} (${candidate.fullName}, ${candidate.hrId})`,
  }).catch(() => undefined);

  return response;
}
