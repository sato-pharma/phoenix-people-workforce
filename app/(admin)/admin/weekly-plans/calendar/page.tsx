import { redirect } from "next/navigation";
import { CalendarDays, CalendarRange, TriangleAlert } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { PlanningCalendar } from "@/components/employee-portal/planning-calendar";
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
      <AdminPageHero
        badges={
          <>
            <AdminInsightChip tone="orange">Admin Calendar</AdminInsightChip>
            <AdminInsightChip tone="slate">Submitted Activity</AdminInsightChip>
            <AdminInsightChip tone="emerald">Coverage View</AdminInsightChip>
          </>
        }
        description="Review company-wide submitted planning activity, national vacations, and same-line Medical Rep conflicts in one admin calendar."
        eyebrow="Planning Calendar"
        icon={<CalendarRange className="h-3.5 w-3.5" />}
        title="Company Planning Calendar"
        aside={
          <div className="grid min-w-[260px] gap-2 text-xs font-bold text-slate-200 sm:grid-cols-2 lg:grid-cols-1">
            <div className="border border-white/15 bg-white/10 p-3 backdrop-blur">
              <div className="flex items-center gap-2 text-orange-100">
                <CalendarDays className="h-4 w-4" />
                Plan coverage
              </div>
              <p className="mt-1 text-[11px] leading-4 text-slate-300">Weekly and monthly submissions in one calendar.</p>
            </div>
            <div className="border border-white/15 bg-white/10 p-3 backdrop-blur">
              <div className="flex items-center gap-2 text-amber-100">
                <TriangleAlert className="h-4 w-4" />
                Conflict signals
              </div>
              <p className="mt-1 text-[11px] leading-4 text-slate-300">Same-line overlaps stay visible for review.</p>
            </div>
          </div>
        }
      />
      <PlanningCalendar initialWorkspace={workspace} />
    </div>
  );
}
