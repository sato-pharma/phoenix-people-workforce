import { NextResponse, type NextRequest } from "next/server";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getEmailControlCenterSnapshot } from "@/lib/notifications/email-control-center";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read = CEO + Super Admin (mirrors /admin/cron-control); mutations on the sibling
// [system]/[key] route are Super Admin only — see the comment in access-registry.ts.
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    const allowed = access.role === "CEO" || canAccessSystemAdministratorWorkspace(access);
    if (!allowed) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }

    const snapshot = await getEmailControlCenterSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load the email control center.") },
      { status: 500 },
    );
  }
}
