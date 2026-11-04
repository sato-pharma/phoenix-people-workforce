import { redirect } from "next/navigation";

import { SpotlightWorkspace } from "@/components/spotlight/spotlight-workspace";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, canAccess, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { facetsFrom, loadSpotlightOrg } from "@/lib/spotlight/org";
import { isSalesPeriodReleasedCompanyWide, loadSalesReleaseKeys } from "@/lib/sales/unpublished-sales-access";
import { selectableWindows } from "@/lib/spotlight/period";

export const dynamic = "force-dynamic";

/**
 * Spotlight — the recognition workspace.
 *
 * SUPER ADMIN AND CEO ONLY, by the owner's instruction. The gate below redirects rather than
 * rendering a locked shell, and it is NOT the security boundary: `/api/spotlight/*` asserts the
 * same permission on every call, because a hidden page is UX and a route is the boundary.
 *
 * The picker's options are resolved on the server rather than fetched, so the first paint already
 * knows which months have finished and which people exist. The window list comes from the SAME
 * gate the export uses — deriving it separately is how a picker starts offering something the
 * server then refuses.
 */
export default async function SpotlightPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") {
    // A portal-mode viewer (a medical rep) belongs on his own self-only spotlight, not the
    // company-wide admin surface — the portal twin, backed by tests/portal-twin-forwarding.test.ts.
    // A rep without spotlight_self is turned back to his landing by the twin page's own gate.
    redirect("/employee-portals/spotlight");
  }
  try {
    await assertPermission(access, "spotlight", "read");
  } catch {
    redirect(resolveLandingPathForRole(access.role));
  }
  const canExport = await canAccess(access, "spotlight", "export");

  const [index, publishedKeys] = await Promise.all([loadSpotlightOrg(), loadSalesReleaseKeys()]);
  const isPublished = (period: string) => isSalesPeriodReleasedCompanyWide(period, publishedKeys);

  return (
    <SpotlightWorkspace
      canExport={canExport}
      facets={facetsFrom(index)}
      windows={{
        month: selectableWindows("month", undefined, 18, isPublished),
        quarter: selectableWindows("quarter", undefined, 8, isPublished),
        semester: selectableWindows("semester", undefined, 4, isPublished),
        year: selectableWindows("year", undefined, 4, isPublished),
      }}
    />
  );
}
