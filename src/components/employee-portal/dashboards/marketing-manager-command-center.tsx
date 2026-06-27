import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  CalendarDays,
  ChartColumnBig,
  ClipboardCheck,
  Inbox,
  ShieldCheck,
  Wallet,
} from "lucide-react";

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
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";

function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

export function MarketingManagerCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, latestPayslip, leaveEntitlementDays, mmOverview, plansAwaitingManagerApproval } = snapshot;
  const plansCount = plansAwaitingManagerApproval ?? 0;
  const totalPending = pendingVacationCount + pendingExcuseCount;

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />
      <PortalContextBar role="Marketing Manager" context="Marketing & Commercial" />

      <GlanceStrip
        items={[
          {
            icon: Inbox,
            value: mmOverview ? String(mmOverview.awaitingMyDecision) : "—",
            label: mmOverview?.awaitingMyDecision === 1 ? "awaiting my approval" : "awaiting my approval",
            href: "/employee-portals/marketing-requests/inbox",
            urgent: !!mmOverview && mmOverview.awaitingMyDecision > 0,
          },
          {
            icon: ShieldCheck,
            value: mmOverview ? String(mmOverview.validationPending) : "—",
            label: "validation pending",
            href: "/employee-portals/marketing-requests/roi-tracking",
          },
          {
            icon: ChartColumnBig,
            value: mmOverview ? String(mmOverview.inApprovalTotal) : "—",
            label: "in approval (company)",
            href: "/employee-portals/marketing-requests",
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
          { href: "/employee-portals/marketing-requests/inbox", icon: Inbox, label: "Review Marketing Requests" },
          { href: "/employee-portals/marketing-requests/roi-tracking", icon: ChartColumnBig, label: "ROI Tracking" },
          { href: "/employee-portals/monthly-closing", icon: ClipboardCheck, label: "Monthly Closing" },
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
        ]}
      />

      {(totalPending > 0 || plansCount > 0) && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} plansAwaitingApproval={plansCount} />
      )}

      <div className="overflow-hidden border border-slate-200">
        <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Needs Your Decision</h2>
          <div className="h-1.5 w-12 bg-orange-500" />
        </div>
        {mmOverview && mmOverview.topPendingForMe.length > 0 ? (
          <div className="divide-y divide-slate-100 bg-white">
            {mmOverview.topPendingForMe.map((row) => (
              <Link
                key={row.id}
                href="/employee-portals/marketing-requests/inbox"
                className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-orange-50"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">
                    {row.requestCode} · {row.requesterName}
                  </p>
                  <p className="truncate text-[11px] text-slate-500">{row.requestType}</p>
                </div>
                <span className="shrink-0 text-sm font-bold text-slate-700">{egp(row.estimatedCost)}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-slate-300 transition-colors group-hover:text-orange-500" />
              </Link>
            ))}
          </div>
        ) : (
          <p className="bg-white px-5 py-6 text-sm text-slate-500">No pending marketing approvals. You&apos;re all caught up.</p>
        )}
      </div>

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Upcoming Pay Dates</h2>
        </div>
        {mmOverview && mmOverview.upcoming.length > 0 ? (
          <div className="divide-y divide-slate-100 bg-white">
            {mmOverview.upcoming.map((row) => (
              <Link
                key={row.id}
                href="/employee-portals/marketing-requests/roi-tracking"
                className="group flex items-center gap-4 px-5 py-3 transition-colors hover:bg-orange-50"
              >
                <CalendarClock className="h-4 w-4 shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-slate-900">{row.requestCode}</p>
                  <p className="text-[11px] text-slate-500">
                    {new Date(row.payDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                  </p>
                </div>
                <span className="shrink-0 text-sm font-bold text-slate-700">{egp(row.estimatedCost)}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="bg-white px-5 py-6 text-sm text-slate-500">No approved campaigns paying out soon.</p>
        )}
      </div>

      <InsightPreviewPanel note="Campaign and budget recommendations for your portfolio are coming soon." />

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">My Workspace</h2>
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2">
          <Link href="/employee-portals/coaching-analytics" className="group flex min-h-[64px] items-center gap-4 bg-white px-4 py-4 transition-colors hover:bg-orange-50">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
              <ChartColumnBig className="h-4 w-4" />
            </div>
            <p className="text-sm font-semibold text-slate-800">Coaching Analytics</p>
          </Link>
          <Link href="/employee-portals/payslips" className="group flex min-h-[64px] items-center gap-4 bg-white px-4 py-4 transition-colors hover:bg-orange-50">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
              <Wallet className="h-4 w-4" />
            </div>
            <p className="text-sm font-semibold text-slate-800">My Payslips</p>
          </Link>
        </div>
      </div>

      {leaveEntitlementDays != null && totalPending === 0 && (
        <p className="px-1 text-[11px] text-slate-400">{leaveEntitlementDays} leave days remaining this cycle.</p>
      )}
    </div>
  );
}
