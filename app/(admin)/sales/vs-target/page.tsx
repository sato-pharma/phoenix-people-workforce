import { redirect } from "next/navigation";

import { VsTargetDashboard } from "@/components/sales/vs-target/vs-target-dashboard";
import { assertPermission, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAuthenticatedPageAccess } from "@/lib/auth/page-access";
import { buildVsTargetDashboard } from "@/lib/sales/vs-target-page";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Sales vs Target — admin-shell surface. The employee-portal twin lives at
// /employee-portals/sales-vs-target and shares buildVsTargetDashboard, so the two URLs
// cannot drift apart on the numbers.
//
// Portal-shell roles are redirected to their own URL rather than being denied: field roles
// reach their scoped analytics through the portal, never through an /admin path.
export default async function AdminSalesVsTargetPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>;
}) {
  const access = await resolveAuthenticatedPageAccess();
  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals/sales-vs-target");
  }
  await assertPermission(access, "sales", "read");

  const sp = await searchParams;
  const data = await buildVsTargetDashboard(access, sp.period ?? null);

  return (
    <div className="p-4 sm:p-6">
      <VsTargetDashboard data={data} basePath="/sales/vs-target" kicker="Commercial Performance" />
    </div>
  );
}
