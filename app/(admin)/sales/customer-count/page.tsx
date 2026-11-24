import { UsersRound } from "lucide-react";
import { redirect } from "next/navigation";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { CustomerCountDashboard } from "@/components/sales/customer-count-dashboard";
import { resolveLandingPathForRole } from "@/lib/auth/landing";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";

export const dynamic = "force-dynamic";

// THE CUSTOMER COUNT DASHBOARD (owner, 24 Nov 2026: "I want a separate dashboard for number of
// customers", "keep a monthly closing sheets, but I want a dashboard specialized for now customer
// count"). How many pharmacies bought each month, from the published closings, cut by line, product,
// region, area, brick and medical rep.
//
// The same readers as the admin Monthly Closing (app/(admin)/sales/monthly-closing/page.tsx): the
// Super Admin, the SFE Manager and the CEO. Managers reach their own team's count from the portal
// (/employee-portals/customer-count). The data route enforces the same gate on its own.
export default async function CustomerCountPage() {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/customer-count");
  const isSystemAdministratorViewer = access.role === "Super Admin" || access.scope === "system";
  if (!isSystemAdministratorViewer && access.role !== "SFE Manager" && access.role !== "CEO") {
    redirect(resolveLandingPathForRole(access.role));
  }
  await assertPermission(access, "sales", access.role === "CEO" ? "read" : "import");

  return (
    <div className="min-w-0 space-y-4">
      <AdminPageHero
        eyebrow="Source of Sales"
        icon={<UsersRound className="h-5 w-5" />}
        title="Customer Count"
        description="How many pharmacies bought each month, from the published closings. A pharmacy counts once per month whatever it bought; direct orders, Office, Main Stores and wholesalers are not pharmacies."
      />
      <CustomerCountDashboard endpoint="/api/sales/customer-count" />
    </div>
  );
}
