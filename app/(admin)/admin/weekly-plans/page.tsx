import { redirect } from "next/navigation";
import { CalendarDays, ClipboardCheck, ShieldCheck } from "lucide-react";

import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { PlansWorkspace } from "@/components/employee-portal/plans-workspace";
import { canAccess } from "@/lib/auth/permissions";
import { guardSeatPage } from "@/lib/auth/seat-page-guard";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getEmployeePlansWorkspace } from "@/lib/weekly-planning/service";

export const dynamic = "force-dynamic";

export default async function AdminWeeklyPlansPage({
  searchParams,
}: {
  searchParams: Promise<{ plan?: string | string[] }>;
}) {
  const access = await resolveAccessContextFromPage();
  guardSeatPage(access, "/admin/weekly-plans");
  const canReadPlans = await canAccess(access, "weekly_plans", "read");
  if (!canReadPlans && access.role !== "CEO" && access.role !== "Super Admin") {
    redirect("/employee-portals");
  }

  const [workspace, params] = await Promise.all([
    getEmployeePlansWorkspace(access),
    searchParams,
  ]);
  const selectedPlanId = Array.isArray(params.plan) ? params.plan[0] : params.plan;

  return (
    <div className="space-y-6">
      <AdminPageHero
        badges={
          <>
            <AdminInsightChip tone="orange">Admin Shell</AdminInsightChip>
            <AdminInsightChip tone="slate">Manager Reviews</AdminInsightChip>
            <AdminInsightChip tone="emerald">CEO Decisions</AdminInsightChip>
          </>
        }
        description="Review submitted field plans, return corrections with row-level notes, finalize CEO decisions, and track HR acknowledgements from the desktop admin workspace."
        eyebrow="Planning Governance"
        icon={<CalendarDays className="h-3.5 w-3.5" />}
        title="Weekly / Monthly Plans"
        aside={
          <div className="grid min-w-[260px] gap-2 text-xs font-bold text-slate-200 sm:grid-cols-2 lg:grid-cols-1">
            <div className="border border-white/15 bg-white/10 p-3 backdrop-blur">
              <div className="flex items-center gap-2 text-orange-100">
                <ClipboardCheck className="h-4 w-4" />
                Review queue
              </div>
              <p className="mt-1 text-phx-xs leading-4 text-slate-300">Manager approvals, returns, and CEO decisions.</p>
            </div>
            <div className="border border-white/15 bg-white/10 p-3 backdrop-blur">
              <div className="flex items-center gap-2 text-emerald-100">
                <ShieldCheck className="h-4 w-4" />
                HR acknowledgement
              </div>
              <p className="mt-1 text-phx-xs leading-4 text-slate-300">Final approvals remain visible for HR follow-through.</p>
            </div>
          </div>
        }
      />
      <PlansWorkspace
        access={access}
        basePath="/admin/weekly-plans"
        initialWorkspace={workspace}
        selectedPlanId={selectedPlanId ?? null}
      />
    </div>
  );
}
