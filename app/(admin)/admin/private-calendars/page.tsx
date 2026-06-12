import { redirect } from "next/navigation";

import { PrivateCalendar } from "@/components/employee-portal/private-calendar";
import { PremiumHero } from "@/components/ui/premium-hero";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { canUsePrivateCalendarAdminSurface, getPrivateCalendarWorkspace } from "@/lib/private-calendar/service";

export const dynamic = "force-dynamic";

export default async function AdminPrivateCalendarsPage() {
  const access = await resolveAccessContextFromPage();
  if (!canUsePrivateCalendarAdminSurface(access)) {
    redirect("/employee-portals/private-calendar");
  }

  const now = new Date();
  const workspace = await getPrivateCalendarWorkspace({
    access,
    month: now.getUTCMonth() + 1,
    year: now.getUTCFullYear(),
  });

  return (
    <div className="space-y-6">
      <PremiumHero
        kicker="Private Calendars"
        title="Employee Private Calendars"
        subtitle="Read-only monthly attendance, vacation, excuse, and plan view for authorized HR and executive users."
      />
      <PrivateCalendar initialWorkspace={workspace} />
    </div>
  );
}
