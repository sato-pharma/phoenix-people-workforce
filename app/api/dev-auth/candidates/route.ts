import { NextResponse } from "next/server";

import { isLocalDevelopmentRequest } from "@/lib/auth/dev-preview";
import { listDevPreviewCandidates } from "@/lib/auth/dev-preview-picker";
import { parseRoleStrict } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Super Admin-only, dev-only: the full line/region/area/name candidate list for
 * one role, so the Dev Preview picker's cascading dropdowns (Line -> Region ->
 * Area -> Name) can be driven entirely client-side after the role changes,
 * without a full page reload. Local development only — see `isLocalDevelopmentRequest`.
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

  const candidates = await listDevPreviewCandidates(role);
  return NextResponse.json({ candidates });
}
