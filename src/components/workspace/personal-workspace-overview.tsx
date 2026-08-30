import { CalendarClock, CircleAlert, Fingerprint, Plane, UserRound } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { AdminHeroFrame } from "@/components/admin/admin-design-system";
import { MetricTile, SectionShell } from "@/components/admin/ceo-command-center";
import { CeoHeroIdentity } from "@/components/admin/ceo-hero-identity";
import type { EmployeeExcuseRequest, EmployeeExcuseWorkspaceData } from "@/lib/excuses/service";
import type { VacationBalanceSnapshot } from "@/lib/vacation/types";
import type { PersonalWorkspaceTab } from "@/lib/workspace/personal-workspace-nav";

/**
 * The personal workspace overview.
 *
 * Until 2026-08-30 `/workspace` rendered `MedicalRepOverviewPage` — the medical rep's PORTAL
 * dashboard — to whoever opened it. A Super Admin, an HR seat or the Finance Manager therefore
 * landed on a sales rep's home: company sales totals, achievement rate, gap to target, "Rank in
 * team comparison", and territory insight copy about a territory they do not hold. None of it was
 * theirs, none of it was actionable from that seat, and the one thing the page never showed was the
 * person's own state.
 *
 * This is built in the command-centre language the owner named — the same identity banner the CEO,
 * the SFE Manager and the Finance Manager get (`CeoHeroIdentity`), the same square `SectionShell`
 * with its dark header bar, and the same `MetricTile`. Sharing the components rather than copying
 * their markup is deliberate: a restyle of the command centres reaches this page for free, which is
 * the only way four "matching" pages stay matching.
 *
 * Every number here is the viewer's OWN. No payroll figure appears anywhere on it — no amount and
 * no month label — which is the owner's standing rule for any overview or landing page, for every
 * role. Payslips are one click away in the tab strip, where they belong.
 *
 * A source that fails to load renders an em dash and says so, never a zero. A zero here would read
 * as "you have no leave left" or "you were never at work this month".
 */

export type PersonalWorkspaceOverviewData = {
  /** This month's fingerprint rows. Null when the attendance source did not answer. */
  attendance: { exceptions: number; monthLabel: string; recordedDays: number } | null;
  /** The viewer's own excuse workspace — identity, this month's allowance, and their own requests. */
  excuses: EmployeeExcuseWorkspaceData | null;
  /** Annual leave, recomputed live. Null when the vacation source did not answer. */
  leave: VacationBalanceSnapshot | null;
};

/** The hero, handed to WorkspaceFrame so the page still draws exactly one. */
export function PersonalWorkspaceHero({
  fullName,
  imageUrl,
  initials,
  roleLabel,
}: {
  fullName: string;
  imageUrl?: string | null;
  initials?: string;
  roleLabel: string;
}) {
  return (
    <AdminHeroFrame className="z-10 overflow-visible">
      <div className="p-5 sm:p-6 lg:p-8">
        <div className="mb-5 inline-flex items-center gap-2 border border-orange-400/40 bg-orange-500/15 px-3 py-1.5 text-phx-3xs font-black uppercase tracking-[0.22em] text-orange-100">
          <UserRound aria-hidden="true" className="h-3.5 w-3.5" />
          My Workspace
        </div>
        <CeoHeroIdentity
          flushToEdges
          fullName={fullName}
          imageUrl={imageUrl}
          initials={initials}
          personal
          roleLabel={roleLabel}
          // The sales sub-greeting is wrong for every seat that lands here — none of them run a
          // territory. `null` removes the line rather than replacing it, because an empty string
          // falls straight back through `??` to the sales copy.
          subGreeting={null}
        />
      </div>
    </AdminHeroFrame>
  );
}

const STATUS_LABELS: Record<string, { label: string; tone: "amber" | "emerald" | "rose" | "slate" }> = {
  approved: { label: "Approved", tone: "emerald" },
  cancelled: { label: "Cancelled", tone: "slate" },
  pending_manager: { label: "With your manager", tone: "amber" },
  rejected: { label: "Rejected", tone: "rose" },
};

function StatusPill({ status }: { status: string }) {
  const resolved = STATUS_LABELS[status] ?? { label: status.replace(/_/g, " "), tone: "slate" as const };
  const toneClass = {
    amber: "border-amber-200 bg-amber-50 text-amber-800",
    emerald: "border-emerald-200 bg-emerald-50 text-emerald-800",
    rose: "border-rose-200 bg-rose-50 text-rose-800",
    slate: "border-slate-200 bg-slate-50 text-slate-600",
  }[resolved.tone];
  return (
    <span
      className={`inline-flex whitespace-nowrap border px-2 py-1 text-phx-3xs font-black uppercase tracking-[0.12em] ${toneClass}`}
    >
      {resolved.label}
    </span>
  );
}

function cairoDate(iso: string) {
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(
    parsed,
  );
}

function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="px-5 py-6 text-sm text-slate-500">{children}</p>;
}

/**
 * One card per tab the viewer can actually open. The labels come from the same array the tab strip
 * reads, so this grid can never offer a page the strip does not — and never a page the guard would
 * bounce them from.
 *
 * Deliberately label-only. A per-tab summary line under "Payslips" is precisely the payslip-on-an-
 * overview the owner's rule forbids, and the moment one card carries a figure the rest look empty.
 */
function WorkspaceLinkGrid({ tabs }: { tabs: readonly PersonalWorkspaceTab[] }) {
  return (
    <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tabs.map((tab) => (
        <Link
          className="group flex items-center justify-between gap-3 border border-slate-200 bg-white px-4 py-3.5 transition-colors hover:border-orange-300"
          href={tab.href}
          key={tab.href}
        >
          <span className="whitespace-nowrap text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-600 group-hover:text-slate-900">
            {tab.label}
          </span>
          <span className="text-sm font-black text-slate-300 group-hover:text-orange-500" aria-hidden="true">
            →
          </span>
        </Link>
      ))}
    </div>
  );
}

export function PersonalWorkspaceOverview({
  data,
  tabs,
}: {
  data: PersonalWorkspaceOverviewData;
  tabs: readonly PersonalWorkspaceTab[];
}) {
  const { attendance, excuses, leave } = data;
  const employee = excuses?.employee ?? null;
  const monthly = excuses?.monthly ?? null;

  // Their own requests, newest first. `requests` is already scoped to this employee by the loader.
  const myRequests: EmployeeExcuseRequest[] = [...(excuses?.requests ?? [])]
    .sort((a, b) => b.excuseDate.localeCompare(a.excuseDate))
    .slice(0, 6);

  const identityLine = [employee?.roleLabel, employee?.departmentName, employee?.lineName]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" · ");

  // Links exclude the page you are already on.
  const linkTabs = tabs.filter((tab) => tab.href !== "/workspace");

  return (
    <div className="space-y-0 divide-y divide-slate-200">
      <SectionShell
        description={identityLine || "Your own record in Phoenix"}
        title={employee?.fullName ?? "My record"}
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            icon={<Plane className="h-3.5 w-3.5" />}
            label="Annual leave left"
            sub={
              leave
                ? `${leave.usedPaidDays} of ${leave.entitlementDays} days taken`
                : "Vacation balance did not load"
            }
            tone={leave ? (leave.balanceAfterDays > 0 ? "emerald" : "amber") : "amber"}
            value={leave ? `${leave.balanceAfterDays}` : "—"}
          />
          <MetricTile
            icon={<CalendarClock className="h-3.5 w-3.5" />}
            label="Excuses left this month"
            sub={
              monthly
                ? `${monthly.used} of ${monthly.allowance} used${monthly.pending ? ` · ${monthly.pending} awaiting a decision` : ""}`
                : "Excuse allowance did not load"
            }
            tone={monthly ? (monthly.remaining > 0 ? "emerald" : "amber") : "amber"}
            value={monthly ? `${monthly.remaining}` : "—"}
          />
          <MetricTile
            icon={<Fingerprint className="h-3.5 w-3.5" />}
            label="Days recorded"
            sub={attendance ? `Fingerprint · ${attendance.monthLabel}` : "Attendance did not load"}
            value={attendance ? `${attendance.recordedDays}` : "—"}
          />
          <MetricTile
            icon={<CircleAlert className="h-3.5 w-3.5" />}
            label="Attendance flags"
            sub={attendance ? "Days needing a look this month" : "Attendance did not load"}
            tone={attendance ? (attendance.exceptions > 0 ? "amber" : "emerald") : "amber"}
            value={attendance ? `${attendance.exceptions}` : "—"}
          />
        </div>
      </SectionShell>

      <SectionShell description="Excuse requests you have filed, newest first" title="My requests">
        {excuses === null ? (
          <EmptyRow>Your requests could not be loaded. Open Excuses from the strip above to see them.</EmptyRow>
        ) : myRequests.length === 0 ? (
          <EmptyRow>You have not filed an excuse request yet.</EmptyRow>
        ) : (
          <div className="divide-y divide-slate-100">
            {myRequests.map((request) => (
              <div className="flex items-center justify-between gap-4 px-5 py-3.5" key={request.id}>
                <div className="min-w-0">
                  <p className="whitespace-nowrap text-sm font-bold text-slate-900">{cairoDate(request.excuseDate)}</p>
                  <p className="mt-0.5 whitespace-nowrap text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">
                    {request.excuseType.replace(/_/g, " ")} · {request.durationHours}h
                    {request.managerName ? ` · ${request.managerName}` : ""}
                  </p>
                </div>
                <StatusPill status={request.status} />
              </div>
            ))}
          </div>
        )}
      </SectionShell>

      {linkTabs.length ? (
        <SectionShell
          description="Everything this seat can open, and nothing it cannot"
          title="All my pages"
        >
          <WorkspaceLinkGrid tabs={linkTabs} />
        </SectionShell>
      ) : null}
    </div>
  );
}
