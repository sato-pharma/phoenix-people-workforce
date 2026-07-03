import Link from "next/link";
import { CalendarDays, CalendarX2, ChartColumnBig, ClipboardCheck, ReceiptText, TrendingUp, Wallet } from "lucide-react";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import {
  GlanceStrip,
  PendingActions,
  PortalContextBar,
  ProfileIntelBar,
  QuickActions,
  egp,
} from "@/components/employee-portal/portal-command-center";
import { InsightPreviewPanel } from "@/components/employee-portal/dashboards/insight-preview-panel";
import { DoubleVisitFocusSection } from "@/components/employee-portal/dashboards/double-visit-focus-section";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";

function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

export function RmCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, latestPayslip, leaveEntitlementDays, plansAwaitingManagerApproval, dvFocus } = snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount + plansCount;

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />
      <PortalContextBar role="Regional Manager" context={shell.employee.territory || "—"} />

      <GlanceStrip
        items={[
          {
            icon: ClipboardCheck,
            value: String(plansCount),
            label: plansCount === 1 ? "plan awaiting approval" : "plans awaiting approval",
            href: "/employee-portals/approvals-hub",
            urgent: plansCount > 0,
          },
          {
            icon: CalendarX2,
            value: String(pendingVacationCount + pendingExcuseCount),
            label: pendingVacationCount + pendingExcuseCount === 1 ? "my pending request" : "my pending requests",
            href: "/employee-portals/approvals-hub",
          },
          {
            icon: CalendarDays,
            value: leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "—",
            label: "leave balance",
            href: "/employee-portals/vacation-request",
          },
          {
            icon: Wallet,
            value: latestPayslip ? egp(latestPayslip.netSalary) : "—",
            label: latestPayslip ? `${monthLabel(latestPayslip.month)} payslip` : "last payslip",
            href: "/employee-portals/payslips",
          },
        ]}
      />

      <QuickActions
        actions={[
          { href: "/employee-portals/source-of-sales", icon: TrendingUp, label: "Source of Sales" },
          { href: "/employee-portals/plans", icon: CalendarDays, label: "Region Plans" },
          { href: "/employee-portals/approvals-hub", icon: ClipboardCheck, label: "Approve Requests" },
          { href: "/employee-portals/vacation-request", icon: CalendarX2, label: "Request Leave" },
        ]}
      />

      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      )}

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Upcoming</h2>
        </div>
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No coaching sessions or territory reviews scheduled.</p>
      </div>

      <InsightPreviewPanel note="Regional coverage and coaching recommendations are coming soon." />

      <DoubleVisitFocusSection focus={dvFocus} />

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">My Tools</h2>
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2">
          <Link href="/employee-portals/med-reps-performance" className="group flex min-h-[64px] items-center gap-4 bg-white px-4 py-4 transition-colors hover:bg-orange-50">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
              <ChartColumnBig className="h-4 w-4" />
            </div>
            <p className="text-sm font-semibold text-slate-800">Med Rep Performance</p>
          </Link>
          <Link href="/employee-portals/expenses" className="group flex min-h-[64px] items-center gap-4 bg-white px-4 py-4 transition-colors hover:bg-orange-50">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
              <ReceiptText className="h-4 w-4" />
            </div>
            <p className="text-sm font-semibold text-slate-800">My Expenses</p>
          </Link>
        </div>
      </div>
    </div>
  );
}
