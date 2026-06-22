import { redirect } from "next/navigation";

import { PrivateCalendarsFilterMap } from "@/components/admin/private-calendars-filter-map";
import { PremiumHero } from "@/components/ui/premium-hero";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUsePrivateCalendarAdminSurface } from "@/lib/private-calendar/service";
import { getSharedPlanningCalendarWorkspace } from "@/lib/weekly-planning/calendar-service";

export const dynamic = "force-dynamic";

export default async function AdminPrivateCalendarsPage() {
  const access = await resolveAccessContextFromPage();
  if (!canUsePrivateCalendarAdminSurface(access)) {
    redirect("/employee-portals/private-calendar");
  }

  const now = new Date();
  const workspace = await getSharedPlanningCalendarWorkspace(
    access,
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
  );

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Private Calendars"
        title="Shared Planning Filter Map"
        subtitle="Filter by name, region, line, title, and date period for Head Office + NSM/PM/TM/GPM planning data."
      />
      <PrivateCalendarsFilterMap initialWorkspace={workspace} />
    </div>
  );
}

