import { redirect } from "next/navigation";

import { PlanningCalendar } from "@/components/employee-portal/planning-calendar";
import { PremiumHero } from "@/components/ui/premium-hero";
import { canAccess } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getSharedPlanningCalendarWorkspace } from "@/lib/weekly-planning/calendar-service";

export const dynamic = "force-dynamic";

export default async function AdminPlanningCalendarPage() {
  const access = await resolveAccessContextFromPage();
  const canReadPlans = await canAccess(access, "weekly_plans", "read");
  if (!canReadPlans && access.role !== "CEO" && access.role !== "Super Admin") {
    redirect("/employee-portals");
  }

  const now = new Date();
  const workspace = await getSharedPlanningCalendarWorkspace(access, now.getUTCFullYear(), now.getUTCMonth() + 1);

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Shared Planning Calendar"
        title="Weekly / Monthly Plans Calendar"
        subtitle="Submitted plan activity, national vacations, and same-line Medical Rep warnings across the organization."
      />
      <PlanningCalendar initialWorkspace={workspace} />
    </div>
  );
}
