import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { loadSettingsView, saveSettingsChange } from "@/lib/phoenix-crm/server/admin-settings";
import { resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { phoenixCrmFailure } from "@/lib/phoenix-crm/server/http";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  = the module's settings: the plan caps, grade targets, distances, each line's opening date and
//        the coming Ramadan dates.
// POST = change one of them. Both are the Super Admin's only (`update`, narrowed again in the service).
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const settings = loadSettingsView(viewer);
    return NextResponse.json({ settings, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the settings.");
  }
}

export async function POST(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "update");
    const viewer = await resolvePhoenixCrmViewer(access);
    const body = (await request.json()) as unknown;
    await saveSettingsChange(viewer, body);
    const settings = loadSettingsView(await resolvePhoenixCrmViewer(access));
    return NextResponse.json({ settings, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not save the settings.");
  }
}
