import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { readWorldFor, resolvePhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadDoctorDirectory } from "@/lib/phoenix-crm/server/doctors";
import { phoenixCrmFailure, searchOf } from "@/lib/phoenix-crm/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET = the Doctors directory: every validated customer in the viewer's reach, across territories,
// with the territory that holds each one. Scope is settled server-side (loadDoctorDirectory): a
// directory role reads the company, everyone else reads downward only.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    await assertPermission(access, "phoenix_crm", "read");
    const viewer = await resolvePhoenixCrmViewer(access);
    const isTest = readWorldFor(viewer, searchOf(request).get("test"));
    const directory = await loadDoctorDirectory(viewer, isTest);
    return NextResponse.json({ directory, success: true });
  } catch (error) {
    return phoenixCrmFailure(error, "Could not load the doctors list.");
  }
}
