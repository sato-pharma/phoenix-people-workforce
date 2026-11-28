import { redirect } from "next/navigation";
import { CalendarCheck } from "lucide-react";

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { PrivateCalendarDayRecordsWorkspace } from "@/components/admin/private-calendar-day-records-workspace";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { DAY_RECORD_ACTIVITIES, DAY_RECORD_ACTIVITY_LABELS } from "@/lib/private-calendar/day-records";

// PRIVATE CALENDAR DAY RECORDS (owner, 2026-11-28): "make an option for the system administrator to pick
// the people … select all district managers and exclude one … I can submit it for them all by one step",
// and "never automatic — he asks the super admin … gave me the days as MCQ". Super Admin only, the same
// gate every read and write of the route asks for itself.
export const dynamic = "force-dynamic";

export default async function AdminPrivateCalendarDayRecordsPage() {
  const access = await resolveAccessContextFromPage();
  if (access.role !== "Super Admin") redirect("/admin/private-calendars");

  const today = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone: "Africa/Cairo", year: "numeric" }).format(new Date());
  return (
    <div className="space-y-5">
      <AdminPageHero
        description="A day someone worked that their Private Calendar cannot see — a meeting, a training, a conference. Phoenix asks you about a line's training days and about the people a rep names on a conference; you tick the days. You can also record one day for a whole group in one step. Only what you save covers a day."
        eyebrow="Private Calendar"
        icon={<CalendarCheck className="h-3.5 w-3.5" />}
        title="Day Records"
      />
      <PrivateCalendarDayRecordsWorkspace
        activities={DAY_RECORD_ACTIVITIES.map((value) => ({ label: DAY_RECORD_ACTIVITY_LABELS[value], value }))}
        initialMonth={today.slice(0, 7)}
        today={today}
      />
    </div>
  );
}
