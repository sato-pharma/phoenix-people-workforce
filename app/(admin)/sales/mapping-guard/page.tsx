import { redirect } from "next/navigation";

import {
  pageHeaderDescriptionClassName,
  pageHeaderKickerClassName,
  pageHeaderRailClassName,
  pageHeaderRuleClassName,
  pageHeaderTitleClassName,
} from "@/components/admin/admin-design-tokens";
import { MappingGuardReview } from "@/components/sales/mapping-guard-review";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { listHeldMappingChanges, type HeldMappingChange } from "@/lib/sales/mapping-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The review screen for held mapping changes. Owner asked for the guard on 2026-09-10 and chose
// quarantine over report-only, which makes this screen load-bearing rather than a report: a hold
// stays a hold until somebody decides here, so the map stops accepting that change until then.
//
// SUPER ADMIN ONLY, matching the other Source-of-Sales mapping-authority pages. Releasing a hold is
// an owner decision by construction — the guard exists precisely because somebody else's change was
// about to replace one of his — so widening this gate would hand that decision away.
//
// The gate is enforced HERE, server-side, before anything loads. system-navigation.ts hiding the
// link is UX only.

export default async function MappingGuardPage() {
  const accessContext = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(accessContext) === "employee-portal") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }
  if (accessContext.role !== "Super Admin" && accessContext.scope !== "system") {
    redirect(resolveLandingPathForRole(accessContext.role));
  }

  let holds: HeldMappingChange[] = [];
  let unavailable = false;
  try {
    await assertPermission(accessContext, "sales", "import");
    holds = await listHeldMappingChanges();
  } catch {
    // The table is absent until the migration is applied, and a missing table answers PGRST205
    // rather than 42P01. Say so plainly instead of rendering an empty state that reads as "nothing
    // is held" — those two look identical and only one of them is good news.
    unavailable = true;
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <header className={pageHeaderRailClassName}>
        <p className={pageHeaderKickerClassName}>Source of Sales</p>
        <h1 className={pageHeaderTitleClassName}>Mapping changes held for you</h1>
        <p className={pageHeaderDescriptionClassName}>
          A customer, brick or area re-mapping stops here when it would overwrite a mapping decision
          of yours, or move a customer to another region. Nothing on this page has been applied.
        </p>
        <div className={pageHeaderRuleClassName} />
      </header>

      {unavailable ? (
        <div className="border border-amber-200 bg-amber-50 px-4 py-6">
          <p className="text-sm font-semibold text-amber-900">The guard is not switched on yet.</p>
          <p className="mt-1 text-sm text-amber-800">
            Its migration has not been applied to this environment, so nothing is being held and this
            screen has nothing to show. That is different from everything having gone through.
          </p>
        </div>
      ) : (
        <MappingGuardReview initialHolds={holds} />
      )}
    </div>
  );
}
