import { redirect } from "next/navigation";
import { CalendarRange } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { PlanApprovalsBody } from "@/components/approvals-hub/plan-approvals-body";
import { getPlanWorkspaceData } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminPlanApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/approvals/plan");
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/approvals/plan");
  const data = await getPlanWorkspaceData(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Approvals Hub"
        title="Weekly / Monthly Plan Approvals"
        description="Plans waiting on your response, and your full response history."
        icon={<CalendarRange className="h-3.5 w-3.5" />}
      />
      <PlanApprovalsBody data={data} />
    </div>
  );
}
