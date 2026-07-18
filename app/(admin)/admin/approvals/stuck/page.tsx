import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { StuckApprovalsPanel } from "@/components/approvals-hub/stuck-approvals-panel";
import { getStuckApprovalsForReassignment } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { isAllVacationVisibility } from "@/lib/vacation/service";

export const dynamic = "force-dynamic";

export default async function AdminStuckApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/approvals-hub");
  // HR / Super Admin only — mirror the server gate inside getStuckApprovalsForReassignment so a
  // non-authorized viewer never reaches the data fetch. Sidebar visibility is UX, not the boundary.
  if (!isAllVacationVisibility(access)) redirect("/admin/approvals-hub");

  const data = await getStuckApprovalsForReassignment(access);

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Approvals Hub"
        title="Stuck Approvals — Needs Reassignment"
        description="Weekly/monthly plans and excuses pinned to a resigned or missing approver. Reassign each to an active manager to unstick the workflow — this changes who owns the pending step, it never decides the request."
        icon={<AlertTriangle className="h-3.5 w-3.5" />}
      />
      <StuckApprovalsPanel
        weeklyPlans={data.weeklyPlans}
        excuses={data.excuses}
        managerOptions={data.managerOptions}
      />
    </div>
  );
}
