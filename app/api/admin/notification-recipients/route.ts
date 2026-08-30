import { NextResponse, type NextRequest } from "next/server";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getNotificationRolePolicies } from "@/lib/notifications/role-recipients";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Super Admin only, both view and edit — see the comment in access-registry.ts. Which roles
// get pinged about a resignation-SLA breach is internal plumbing, with no CEO oversight story.
// Its page is /admin/notification-recipients.
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!canAccessSystemAdministratorWorkspace(access)) {
      return NextResponse.json({ message: "Forbidden: Super Admin only." }, { status: 403 });
    }

    const policies = await getNotificationRolePolicies();
    return NextResponse.json({ policies });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load notification recipients.") },
      { status: 500 },
    );
  }
}
