import { NextResponse, type NextRequest } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { canManageDistributionLists, distributionListScopeFor } from "@/lib/distribution-lists/access";
import {
  getCompanyEmailAliasesWithDrift,
  getDistributionListSpecs,
  resolveAllDistributionLists,
} from "@/lib/distribution-lists/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Super Admin, plus the HR Business Partner narrowed to the HR-owned lists — the boundary is
// @/lib/distribution-lists/access. A distribution list decides who receives company mail, so
// reading one is reading an audience.
export async function GET(request: NextRequest) {
  try {
    const access = await resolveAccessContext(request);
    if (!canManageDistributionLists(access)) {
      return NextResponse.json({ message: "Forbidden." }, { status: 403 });
    }
    const scope = distributionListScopeFor(access);
    const inScope = (listKey: string | null) => scope === "all" || (listKey != null && scope.has(listKey));

    const [specs, lists, aliases] = await Promise.all([
      getDistributionListSpecs(),
      resolveAllDistributionLists(),
      getCompanyEmailAliasesWithDrift(),
    ]);

    const scopedLists = lists.filter((list) => inScope(list.listKey));
    return NextResponse.json({
      // An alias with no list stays Super-Admin-only — nothing marks it as HR's, and fail-closed is
      // the direction that cannot put a sales or finance alias on an HR screen.
      aliases: aliases.aliases.filter((alias) => inScope(alias.distributionListKey)),
      lists: scopedLists,
      specs: specs.filter((spec) => inScope(spec.listKey)),
      warnings: Array.from(new Set([...scopedLists.flatMap((list) => list.warnings), ...aliases.warnings])),
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
