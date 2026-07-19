import { NextResponse, type NextRequest } from "next/server";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { listCronJobs } from "@/lib/cron-control/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only: CEO + Super Admin (same gate as /admin/system-issues). Mutations on the sibling
// routes are Super Admin only — see the comment in access-registry.ts.
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    const result = await listCronJobs();
    return NextResponse.json(result);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to load cron jobs." },
      { status: 500 },
    );
  }
}
