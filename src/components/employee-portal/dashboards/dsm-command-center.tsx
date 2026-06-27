import Link from "next/link";
import {
  CalendarDays,
  CalendarX2,
  ChartColumnBig,
  ClipboardCheck,
  ReceiptText,
  Target,
  Users,
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

export function DsmCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, latestPayslip, dsmTeam } = snapshot;
  const totalPending = pendingVacationCount + pendingExcuseCount;
  const pct = dsmTeam ? Math.max(0, Math.round(dsmTeam.achievementPercent)) : null;

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />
      <PortalContextBar role="District Sales Manager" context={dsmTeam ? `${dsmTeam.memberCount} reps` : "—"} />

      <GlanceStrip
        items={[
          {
            icon: Users,
            value: pct !== null ? `${pct}%` : "—",
            label: "team achievement",
            href: "/employee-portals/team-performance",
            urgent: pct !== null && pct < 70,
          },
          {
            icon: ClipboardCheck,
            value: dsmTeam ? String(dsmTeam.pendingApprovals) : "—",
            label: dsmTeam?.pendingApprovals === 1 ? "approval pending" : "approvals pending",
            href: "/employee-portals/actions",
            urgent: !!dsmTeam && dsmTeam.pendingApprovals > 0,
          },
          {
            icon: CalendarX2,
            value: String(totalPending),
            label: totalPending === 1 ? "my pending request" : "my pending requests",
            href: "/employee-portals/actions",
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
          { href: "/employee-portals/team-performance", icon: Users, label: "Review Team Plan" },
          { href: "/employee-portals/coaching-analytics", icon: ChartColumnBig, label: "Coaching Analytics" },
          { href: "/employee-portals/actions", icon: ClipboardCheck, label: "Approve Requests" },
          { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Request Leave" },
        ]}
      />

      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      )}

      <div className="overflow-hidden border border-slate-200 bg-white">
        <div className="flex items-center justify-between bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Team Snapshot</h2>
          <div className="h-1.5 w-12 bg-orange-500" />
        </div>
        {dsmTeam ? (
          <div className="grid grid-cols-2 gap-px bg-slate-200 sm:grid-cols-4">
            {[
              { label: "Team size", value: String(dsmTeam.memberCount) },
              { label: "Sales", value: egp(dsmTeam.totalSales) },
              { label: "Target", value: egp(dsmTeam.totalTarget) },
              { label: "Achievement", value: pct !== null ? `${pct}%` : "—" },
            ].map((tile) => (
              <div key={tile.label} className="bg-white px-4 py-4">
                <p className="text-lg font-black text-slate-900">{tile.value}</p>
                <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">{tile.label}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-5 py-6 text-sm text-slate-500">
            No team sales data synced for the current period yet.
          </p>
        )}
      </div>

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">Upcoming</h2>
        </div>
        <p className="bg-white px-5 py-6 text-sm text-slate-500">
          No coaching sessions or territory reviews scheduled.
        </p>
      </div>

      <InsightPreviewPanel note="Coverage and coaching recommendations for your team are coming soon." />

      <div className="overflow-hidden border border-slate-200">
        <div className="bg-slate-900 px-5 py-3">
          <h2 className="text-[10px] font-bold uppercase tracking-widest text-slate-300">My Tools</h2>
        </div>
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2">
          <Link href="/employee-portals/med-reps-performance" className="group flex min-h-[64px] items-center gap-4 bg-white px-4 py-4 transition-colors hover:bg-orange-50">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
              <Target className="h-4 w-4" />
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
