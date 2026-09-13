import Link from "next/link";
import { redirect } from "next/navigation";
import { CalendarDays } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { VacationApprovalsBody } from "@/components/approvals-hub/vacation-approvals-body";
import { buttonVariants } from "@/components/ui/button";
import { getVacationWorkspaceData } from "@/lib/approvals-hub/service";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getVacationDayRequestAvailability } from "@/lib/crm/native-visits/vacation-days";

export const dynamic = "force-dynamic";

export default async function AdminVacationApprovalsPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/approvals/vacation");
  // The vacation-day work link (CRM phase 6, rule 9) appears only once the CRM cutover date is set.
  const [data, vacationDayWork] = await Promise.all([
    getVacationWorkspaceData(access),
    getVacationDayRequestAvailability(access),
  ]);
  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Approvals Hub"
        title="Vacation Approvals"
        description="Leave requests waiting on your response, and your full response history."
        icon={<CalendarDays className="h-3.5 w-3.5" />}
      />
      {vacationDayWork.show ? (
        <div className="flex flex-wrap gap-2">
          <Link className={buttonVariants({ variant: "outline" })} href="/admin/approvals/vacation-day-work">
            {vacationDayWork.waitingForYou > 0
              ? `Work on a vacation day (${vacationDayWork.waitingForYou} waiting)`
              : "Work on a vacation day"}
          </Link>
        </div>
      ) : null}
      <VacationApprovalsBody data={data} />
    </div>
  );
}
