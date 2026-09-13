import { redirect } from "next/navigation";
import { CalendarDays } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { NativeVisitVacationDaysWorkspace } from "@/components/employee-portal/native-visit-vacation-days-workspace";
import { resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertVacationDayAccess } from "@/lib/crm/native-visits/vacation-days";

export const dynamic = "force-dynamic";

// The HR approval of rule 9 (CRM phase 6), which the administrator alone gives, on the admin shell;
// reps and managers use the employee portal twin at /employee-portals/visits/vacation-day-requests.
export default async function AdminVacationDayWorkPage() {
  const access = await resolveAccessContextFromPage();
  if (resolveNavigationMode(access) === "employee-portal") redirect("/employee-portals/visits/vacation-day-requests");
  const allowed = await assertVacationDayAccess(access).then(
    () => true,
    () => false,
  );
  if (!allowed) redirect("/admin/approvals/vacation");

  return (
    <div className="space-y-5">
      <AdminPageHero
        eyebrow="Approvals Hub"
        title="Vacation-Day Work"
        description="Reps asking to enter visits on a day HR approved as their vacation. The day opens only when the manager and HR both approve."
        icon={<CalendarDays className="h-3.5 w-3.5" />}
      />
      <NativeVisitVacationDaysWorkspace />
    </div>
  );
}
