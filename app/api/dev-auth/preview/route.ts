import { NextResponse } from "next/server";
import { cookies } from "next/headers";

import { revokeAppSession } from "@/lib/auth/app-sessions";
import { writeAuthAudit } from "@/lib/auth/audit";
import { isLocalDevelopmentRequest } from "@/lib/auth/dev-preview";
import { findDevPreviewCandidate, findDevPreviewCandidateByHrId } from "@/lib/auth/dev-preview-picker";
import { parseRoleStrict } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { phoenixSessionCookieName, verifySessionToken } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Super Admin-only front door onto the existing `/api/dev-auth` bootstrap route:
 * given a role and either an explicit `hrId` (chosen by name in the picker) or
 * line/region/area filters (auto-pick), resolves a real active employee and
 * hands off to it so the preview shows genuine data instead of a synthetic
 * fixture. Local development only — see `isLocalDevelopmentRequest`.
 */
export async function GET(request: Request) {
  if (!isLocalDevelopmentRequest(request)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const access = await resolveAccessContext(request);
  if (access.role !== "Super Admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  let role: ReturnType<typeof parseRoleStrict>;
  try {
    role = parseRoleStrict(url.searchParams.get("role"));
  } catch {
    return NextResponse.json({ error: "invalid_role" }, { status: 400 });
  }
  const hrId = url.searchParams.get("hrId")?.trim() || null;
  const line = url.searchParams.get("line")?.trim() || null;
  const region = url.searchParams.get("region")?.trim() || null;
  const area = url.searchParams.get("area")?.trim() || null;

  const candidate = hrId
    ? await findDevPreviewCandidateByHrId(role, hrId)
    : await findDevPreviewCandidate(role, { areaName: area, lineName: line, regionName: region });

  if (!candidate) {
    const backUrl = new URL("/admin/dev-preview", url);
    backUrl.searchParams.set("error", "no_candidate");
    backUrl.searchParams.set("role", role);
    if (line) backUrl.searchParams.set("line", line);
    if (region) backUrl.searchParams.set("region", region);
    if (area) backUrl.searchParams.set("area", area);
    return NextResponse.redirect(backUrl);
  }

  const targetUrl = new URL("/api/dev-auth", url);
  targetUrl.searchParams.set("role", role);
  targetUrl.searchParams.set("hrId", candidate.hrId);
  targetUrl.searchParams.set("loginId", candidate.fullName);

  const response = NextResponse.redirect(targetUrl);

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
