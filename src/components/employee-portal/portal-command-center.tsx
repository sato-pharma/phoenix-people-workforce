import Link from "next/link";
import { ArrowRight, CalendarClock, CalendarDays, CalendarX2, CheckCircle2, ClipboardCheck, Wallet } from "lucide-react";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";

// --- local formatters ---

function egp(n: number) {
  return new Intl.NumberFormat("en-EG", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(n);
}

function monthLabel(ym: string) {
  const [y, m] = ym.split("-");
  return new Date(Number(y), Number(m) - 1).toLocaleString("en-US", { month: "short", year: "numeric" });
}

// --- shared layout shells ---

function SectionShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden border border-slate-200">
      <div className="bg-slate-900 px-5 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-300">{title}</h2>
      </div>
      <div className="bg-white p-5">{children}</div>
    </div>
  );
}

function StatTile({
  icon: Icon,
  headline,
  sub,
}: {
  icon: React.ElementType;
  headline: string;
  sub: string;
}) {
  return (
    <div className="overflow-hidden border border-slate-200">
      <div className="flex items-center gap-2 bg-slate-900 px-4 py-2">
        <Icon className="h-3.5 w-3.5 text-slate-400" />
      </div>
      <div className="bg-white px-4 py-4">
        <p className="text-2xl font-bold tracking-tight text-slate-900">{headline}</p>
        <p className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-slate-400">{sub}</p>
      </div>
    </div>
  );
}

// --- main component ---

export function PortalCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, latestPayslip, leaveEntitlementDays } = snapshot;
  const totalPending = pendingVacationCount + pendingExcuseCount;
  const daysUntilRenewal = shell.hrContract?.daysUntilRenewal;

  return (
    <div className="mx-auto w-full space-y-5" dir="auto">
      {/* Hero */}
      <IdentityCard data={shell} />

      {/* Attention */}
      <SectionShell title="Your pending items">
        {totalPending === 0 ? (
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm font-medium">All clear — nothing needs your attention right now.</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {pendingVacationCount > 0 && (
              <Link
                href="/employee-portals/actions"
                className="flex items-center justify-between border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-800 hover:bg-orange-100"
              >
                <span className="flex items-center gap-2">
                  <CalendarDays className="h-4 w-4" />
                  {pendingVacationCount} vacation request{pendingVacationCount > 1 ? "s" : ""} pending
                </span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            )}
            {pendingExcuseCount > 0 && (
              <Link
                href="/employee-portals/actions"
                className="flex items-center justify-between border border-orange-200 bg-orange-50 px-4 py-3 text-sm font-medium text-orange-800 hover:bg-orange-100"
              >
                <span className="flex items-center gap-2">
                  <CalendarX2 className="h-4 w-4" />
                  {pendingExcuseCount} excuse request{pendingExcuseCount > 1 ? "s" : ""} pending
                </span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            )}
          </div>
        )}
      </SectionShell>

      {/* Quick stats */}
      <SectionShell title="Quick stats">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatTile
            icon={CalendarDays}
            headline={leaveEntitlementDays != null ? `${leaveEntitlementDays} days` : "—"}
            sub="annual leave entitlement"
          />
          <StatTile
            icon={Wallet}
            headline={latestPayslip ? egp(latestPayslip.netSalary) : "Not yet issued"}
            sub={latestPayslip ? `${monthLabel(latestPayslip.month)} net salary` : "last payslip"}
          />
          <StatTile
            icon={daysUntilRenewal != null ? CalendarClock : ClipboardCheck}
            headline={daysUntilRenewal != null ? `${daysUntilRenewal} days` : "No renewal pending"}
            sub="until contract renewal"
          />
        </div>
      </SectionShell>
    </div>
  );
}
