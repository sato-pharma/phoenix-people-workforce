import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, CalendarDays } from "lucide-react";

import { AdminPageHero, AdminSectionHeader } from "@/components/admin/admin-design-system";
import { Card } from "@/components/ui/card";
import {
  financeLeaveManagementExcuseItems,
  financeLeaveManagementVacationItems,
  type AdminToolsPageItem,
} from "@/config/system-navigation";
import { getExcuseWorkspaceData, getVacationWorkspaceData } from "@/lib/approvals-hub/service";
import { canAccessSystemAdministratorWorkspace, resolveNavigationMode } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";

export const dynamic = "force-dynamic";

export default async function FinanceLeaveManagementPage() {
  const access = await resolveAccessContextFromPage();

  if (resolveNavigationMode(access) === "employee-portal") {
    redirect("/employee-portals");
  }

  // Gated on the ROLE, exactly like the Finance Command Center: this page has exactly one
  // audience, so a permission-based gate would be the wrong tool (leave:approve is not unique to
  // him). Super Admin keeps access so the page can be supported without borrowing his account —
  // the sidebar row itself stays hidden from Super Admin (see system-navigation.ts), this is only
  // about a direct URL still working.
  const allowed = access.role === "Finance Manager" || canAccessSystemAdministratorWorkspace(access);
  if (!allowed) {
    redirect("/admin");
  }

  // Pending counts degrade to "unknown" (no badge) rather than a misleading 0 if either read
  // fails — every card is still a working link either way.
  const [vacationPending, excusePending] = await Promise.all([
    getVacationWorkspaceData(access)
      .then((data) => data.pendingCount)
      .catch(() => null),
    getExcuseWorkspaceData(access)
      .then((data) => data.pendingCount)
      .catch(() => null),
  ]);

  const pendingCountByHref: Record<string, number | null> = {
    "/admin/approvals/vacation": vacationPending,
    "/admin/approvals/excuse": excusePending,
  };

  return (
    <div className="space-y-6">
      <AdminPageHero
        description="Vacation and excuse workflows in one place — request your own leave, decide what's waiting on you, and review the record."
        eyebrow="Leave"
        icon={<CalendarDays className="h-3.5 w-3.5" />}
        title="Leave Management"
      />

      <Card className="overflow-hidden p-0">
        <AdminSectionHeader
          description="Request your own leave, decide vacation requests waiting on you, and review balances and history."
          title="Vacations"
        />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 sm:p-6 lg:grid-cols-3">
          {financeLeaveManagementVacationItems.map((tool) => (
            <LeaveHubCard key={tool.href} pendingCount={pendingCountByHref[tool.href] ?? null} tool={tool} />
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden p-0">
        <AdminSectionHeader description="Submit your own excuse, and decide excuse requests waiting on you." title="Excuses" />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2 sm:p-6">
          {financeLeaveManagementExcuseItems.map((tool) => (
            <LeaveHubCard key={tool.href} pendingCount={pendingCountByHref[tool.href] ?? null} tool={tool} />
          ))}
        </div>
      </Card>
    </div>
  );
}

function LeaveHubCard({ tool, pendingCount }: { pendingCount: number | null; tool: AdminToolsPageItem }) {
  const Icon = tool.icon;
  return (
    <Link
      className="group relative flex flex-col overflow-hidden border border-slate-200 bg-white p-5 shadow-[0_4px_16px_rgba(15,23,42,0.07)] transition duration-200 hover:-translate-y-1 hover:border-orange-300/70 hover:shadow-[0_16px_38px_rgba(15,23,42,0.13)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
      href={tool.href}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-orange-500 via-orange-400 to-amber-300 opacity-70 transition-opacity duration-200 group-hover:opacity-100"
      />
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center bg-gradient-to-br from-orange-100 to-orange-50 text-orange-700 ring-1 ring-orange-200/70">
          <Icon aria-hidden="true" className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold tracking-[-0.01em] text-slate-950">{tool.label}</h3>
            {pendingCount !== null ? (
              <span className="inline-flex shrink-0 items-center justify-center bg-orange-100 px-1.5 py-0.5 text-[10px] font-black text-orange-700">
                {pendingCount} pending
              </span>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs leading-5 text-slate-500">{tool.description}</p>
        </div>
      </div>
      <div className="mt-4 inline-flex items-center gap-1 text-xs font-bold text-orange-700">
        Open
        <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
