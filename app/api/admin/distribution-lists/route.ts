import { NextResponse, type NextRequest } from "next/server";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import {
  getCompanyEmailAliasesWithDrift,
  getDistributionListSpecs,
  resolveAllDistributionLists,
} from "@/lib/distribution-lists/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Super Admin only, matching /api/admin/notification-recipients next door. A distribution list
// decides who receives company mail, so reading one is reading an audience — the same class of
// fact as which roles get pinged about a resignation-SLA breach.
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!canAccessSystemAdministratorWorkspace(access)) {
      return NextResponse.json({ message: "Forbidden: Super Admin only." }, { status: 403 });
    }

    const [specs, lists, aliases] = await Promise.all([
      getDistributionListSpecs(),
      resolveAllDistributionLists(),
      getCompanyEmailAliasesWithDrift(),
    ]);

    return NextResponse.json({
      aliases: aliases.aliases,
      lists,
      specs,
      warnings: Array.from(new Set([...lists.flatMap((list) => list.warnings), ...aliases.warnings])),
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { message: clientSafeErrorMessage(error, "Failed to load distribution lists.") },
      { status: 500 },
    );
  }
}
