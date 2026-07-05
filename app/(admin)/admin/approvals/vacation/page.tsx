import { redirect } from "next/navigation";
import { CalendarDays } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { VacationApprovalsBody } from "@/components/approvals-hub/vacation-approvals-body";
import { getVacationWorkspaceData } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function AdminVacationApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/approvals/vacation");
  const data = await getVacationWorkspaceData(access);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Approvals Hub"
        title="Vacation Approvals"
        description="Leave requests waiting on your response, and your full response history."
        icon={<CalendarDays className="h-3.5 w-3.5" />}
      />
      <VacationApprovalsBody data={data} />
    </div>
  );
}
