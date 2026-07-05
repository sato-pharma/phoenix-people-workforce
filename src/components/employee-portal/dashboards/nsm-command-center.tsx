import Link from "next/link";
import {
  AlarmClock,
  AlertTriangle,
  Building2,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ChartColumnBig,
  CheckCircle2,
  CircleDollarSign,
  ClipboardCheck,
  Clock,
  Flag,
  Network,
  PieChart,
  ReceiptText,
  Send,
  Sunrise,
  Target,
  TrendingUp,
  Trophy,
  Users,
  Wallet,
} from "lucide-react";

import { IdentityCard } from "@/components/employee-portal/identity-card";
import { PendingActions, ProfileIntelBar } from "@/components/employee-portal/portal-command-center";
import { DoubleVisitFocusSection } from "@/components/employee-portal/dashboards/double-visit-focus-section";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";

type NsmBoard = NonNullable<PortalHomeSnapshot["nsmBoard"]>;
type CrmData = NsmBoard["crm"];
type RankRow = {
  hrId: string;
  name: string;
  achievementPercent: number;
  totalSales: number;
  totalTarget: number;
  managerName?: string | null;
};

// Compact EGP for the KPI keycards, e.g. 128,450,000 -> "128.45 M EGP".
function egpCompact(value: number): string {
  const abs = Math.abs(value);
  const unit =
    abs >= 1_000_000_000
      ? { div: 1_000_000_000, suffix: "B" }
      : abs >= 1_000_000
        ? { div: 1_000_000, suffix: "M" }
        : abs >= 1_000
          ? { div: 1_000, suffix: "K" }
          : null;
  if (!unit) return `${Math.round(value).toLocaleString("en-US")} EGP`;
  const scaled = (value / unit.div).toFixed(2).replace(/\.?0+$/, "");
  return `${scaled} ${unit.suffix} EGP`;
}

function cairoTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function pctTextClass(pct: number): string {
  return pct >= 100 ? "text-emerald-600" : pct >= 90 ? "text-amber-600" : pct >= 70 ? "text-orange-600" : "text-rose-600";
}
function pctBarClass(pct: number): string {
  return pct >= 100 ? "bg-emerald-500" : pct >= 90 ? "bg-amber-400" : pct >= 70 ? "bg-orange-500" : "bg-rose-500";
}
function rankChipClass(index: number): string {
  return index === 0
    ? "bg-amber-400 text-slate-900"
    : index === 1
      ? "bg-slate-300 text-slate-900"
      : index === 2
        ? "bg-orange-300 text-slate-900"
        : "bg-slate-900 text-white";
}

function SectionHead({ title, right }: { title: string; right?: React.ReactNode }) {
  // Matches the ProfileIntelBar treatment: navy #0b1f3a, subtle grid, orange top hairline + accent.
  return (
    <div className="relative overflow-hidden bg-[#0b1f3a] shadow-[0_8px_32px_rgba(11,31,58,0.35)]">
      <div className="pointer-events-none absolute inset-0 opacity-[0.04] [background-image:linear-gradient(rgba(255,255,255,1)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,1)_1px,transparent_1px)] [background-size:32px_32px]" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#f47b20] to-transparent" />
      <div className="relative flex items-center justify-between px-4 py-2.5 sm:px-5 sm:py-3">
        <div className="flex items-center gap-2.5">
          <span className="h-4 w-[3px] bg-[#f47b20]" />
          <h2 className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-300">{title}</h2>
        </div>
        {right}
      </div>
    </div>
  );
}

/* ── National performance keycards ─────────────────────────────────── */

function NationalKeycards({ nsmNational }: { nsmNational: PortalHomeSnapshot["nsmNational"] }) {
  const pct = nsmNational ? Math.max(0, Math.round(nsmNational.achievementPercent)) : null;
  const sales = nsmNational?.totalSales ?? 0;
  const target = nsmNational?.totalTarget ?? 0;
  const threshold90 = target * 0.9;
  const eligible = target > 0 && sales >= threshold90;
  const gapTo90 = Math.max(0, threshold90 - sales);
  const pctNum = pct ?? 0;

  const achAccent =
    pctNum >= 100 ? "bg-emerald-500" : pctNum >= 90 ? "bg-amber-400" : pctNum >= 70 ? "bg-orange-500" : "bg-rose-500";
  const achValueClass =
    pctNum >= 100 ? "text-emerald-600" : pctNum >= 90 ? "text-amber-600" : pctNum >= 70 ? "text-orange-600" : "text-rose-600";

  const cards = [
    {
      icon: TrendingUp,
      label: "Achievement",
      value: pct !== null ? `${pct}%` : "—",
      sub: "vs national target",
      accent: achAccent,
      valueClass: achValueClass,
    },
    { icon: Wallet, label: "Line Sales", value: egpCompact(sales), sub: "achieved this period", accent: "bg-slate-900", valueClass: "text-slate-900" },
    { icon: Target, label: "Target", value: egpCompact(target), sub: "national target", accent: "bg-slate-900", valueClass: "text-slate-900" },
    {
      icon: eligible ? CheckCircle2 : Flag,
      label: "Gap to 90%",
      value: target <= 0 ? "—" : eligible ? "Eligible" : egpCompact(gapTo90),
      sub: eligible ? "incentive threshold cleared" : "sales to reach incentive",
      accent: eligible ? "bg-emerald-500" : "bg-orange-500",
      valueClass: eligible ? "text-emerald-600" : "text-orange-600",
    },
  ];

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead
        title="National Performance"
        right={
          nsmNational ? (
            <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">
              {nsmNational.dsmCount} {nsmNational.dsmCount === 1 ? "district" : "districts"}
            </span>
          ) : undefined
        }
      />
      {nsmNational ? (
        <div className="grid grid-cols-2 gap-px bg-slate-200 xl:grid-cols-4">
          {cards.map((card) => (
            <div key={card.label} className="relative bg-white px-4 py-4 sm:px-5 sm:py-5">
              <span className={`absolute inset-x-0 top-0 h-[3px] ${card.accent}`} />
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center bg-slate-900 text-white">
                  <card.icon className="h-3.5 w-3.5" />
                </span>
                <p className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{card.label}</p>
              </div>
              <p className={`mt-3 whitespace-nowrap text-xl font-black leading-tight tabular-nums sm:text-2xl ${card.valueClass}`}>
                {card.value}
              </p>
              <p className="mt-1 whitespace-nowrap text-[11px] font-medium text-slate-500">{card.sub}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No line sales data synced for the current period yet.</p>
      )}
    </div>
  );
}

/* ── Dashboards grid ───────────────────────────────────────────────── */

const DASHBOARDS = [
  { href: "/employee-portals/source-of-sales", icon: ChartColumnBig, label: "Source of Sales" },
  { href: "/employee-portals/weekly-sales", icon: CalendarRange, label: "Weekly Sales" },
  { href: "/employee-portals/roi", icon: PieChart, label: "ROI" },
  { href: "/employee-portals/expense-dashboard", icon: CircleDollarSign, label: "Expenses" },
  { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Coaching" },
  { href: "/employee-portals/med-reps-performance", icon: Users, label: "Med Reps" },
  { href: "/employee-portals/dsms-performance", icon: Network, label: "DSMs" },
  { href: "/employee-portals/organogram", icon: Building2, label: "Organogram" },
] as const;

function DashboardsGrid() {
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead title="Dashboards" />
      <div className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-4 sm:gap-2.5 sm:p-2.5">
        {DASHBOARDS.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            className="group flex flex-col items-center justify-center gap-2 border border-slate-200 bg-white px-2 py-4 text-center transition-colors hover:border-orange-300 hover:bg-orange-50"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-white transition-colors group-hover:bg-orange-600">
              <d.icon className="h-[18px] w-[18px]" />
            </span>
            <span className="whitespace-nowrap text-xs font-bold uppercase tracking-wide text-slate-700 transition-colors group-hover:text-orange-700">
              {d.label}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

/* ── Ranking panel ─────────────────────────────────────────────────── */

function RankingPanel({
  title,
  subtitle,
  icon: Icon,
  rows,
  showManager,
}: {
  title: string;
  subtitle: string;
  icon: React.ElementType;
  rows: RankRow[];
  showManager?: boolean;
}) {
  const ranked = rows.slice().sort((a, b) => b.achievementPercent - a.achievementPercent || b.totalSales - a.totalSales);
  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead
        title={title}
        right={<span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">{subtitle}</span>}
      />
      {ranked.length === 0 ? (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No sales data synced for the current period yet.</p>
      ) : (
        <div className="bg-white">
          {ranked.map((row, i) => {
            const pct = Math.max(0, Math.round(row.achievementPercent));
            return (
              <div
                key={row.hrId || `${row.name}-${i}`}
                className="flex items-center gap-3 border-b border-slate-100 px-3 py-2.5 last:border-b-0 sm:px-4"
              >
                <span className={`flex h-6 w-6 shrink-0 items-center justify-center text-[11px] font-black ${rankChipClass(i)}`}>
                  {i + 1}
                </span>
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Icon className="hidden h-3.5 w-3.5 shrink-0 text-slate-300 sm:block" />
                  <div className="min-w-0">
                    <p className="whitespace-nowrap text-sm font-semibold text-slate-800">{row.name}</p>
                    {showManager && row.managerName ? (
                      <p className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wide text-slate-400">
                        {row.managerName}
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="w-16 shrink-0">
                  <p className={`text-right text-sm font-black tabular-nums ${pctTextClass(pct)}`}>{pct}%</p>
                  <div className="mt-1 h-1 w-full bg-slate-100">
                    <div className={`h-full ${pctBarClass(pct)}`} style={{ width: `${Math.min(100, Math.max(3, pct))}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── CRM first-visit compliance ────────────────────────────────────── */

function PersonChips({ people, tone }: { people: Array<{ hrId: string; name: string }>; tone: "danger" | "muted" }) {
  const cls =
    tone === "danger"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-slate-200 bg-slate-50 text-slate-600";
  return (
    <div className="flex flex-wrap gap-1.5">
      {people.map((p) => (
        <span key={p.hrId || p.name} className={`whitespace-nowrap border px-2 py-1 text-[11px] font-semibold ${cls}`}>
          {p.name}
        </span>
      ))}
    </div>
  );
}

function CrmBoard({ crm }: { crm: CrmData }) {
  const syncLabel = crm?.lastSyncAt ? `as of ${cairoTime(crm.lastSyncAt)}` : "12 PM sync";

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead
        title="CRM First Visit"
        right={<span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">{syncLabel}</span>}
      />
      {!crm || !crm.synced ? (
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <Clock className="h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-sm text-slate-500">
            Awaiting today&apos;s 12&nbsp;PM CRM sync — first-visit compliance appears once visits are mirrored from iReports360.
          </p>
        </div>
      ) : (
        <div className="space-y-px bg-slate-200">
          {/* Submitted counts */}
          <div className="grid grid-cols-2 gap-px bg-slate-200">
            {[
              { label: "Reps submitted", submitted: crm.reps.submitted, total: crm.reps.total },
              { label: "DSMs submitted", submitted: crm.dsms.submitted, total: crm.dsms.total },
            ].map((s) => {
              const complete = s.total > 0 && s.submitted >= s.total;
              return (
                <div key={s.label} className="bg-white px-4 py-3">
                  <p className={`text-xl font-black tabular-nums ${complete ? "text-emerald-600" : "text-slate-900"}`}>
                    {s.submitted}
                    <span className="text-sm font-bold text-slate-400">/{s.total}</span>
                  </p>
                  <p className="mt-0.5 whitespace-nowrap text-[10px] font-semibold uppercase tracking-widest text-slate-400">{s.label}</p>
                </div>
              );
            })}
          </div>

          {/* Early birds */}
          <div className="bg-white px-4 py-3 sm:px-5">
            <div className="mb-2 flex items-center gap-2">
              <Sunrise className="h-4 w-4 text-emerald-600" />
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Early birds</p>
            </div>
            {crm.earlyBirds.length === 0 ? (
              <p className="text-sm text-slate-500">No visits submitted yet today.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {crm.earlyBirds.map((b, i) => (
                  <span
                    key={b.hrId || b.name}
                    className="inline-flex items-center gap-1.5 whitespace-nowrap border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700"
                  >
                    <span className="font-black text-emerald-600">{i + 1}</span>
                    {b.name}
                    <span className="font-normal text-emerald-600/70">{cairoTime(b.at)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Not-yet-submitted alarm */}
          <div className="bg-white px-4 py-3 sm:px-5">
            {crm.reps.missing.length === 0 && crm.dsms.missing.length === 0 ? (
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                <p className="text-sm font-medium text-emerald-700">Everyone on your line has submitted their first visit.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <AlarmClock className="h-4 w-4 shrink-0 text-rose-600" />
                  <p className="text-[10px] font-bold uppercase tracking-widest text-rose-600">
                    {crm.reps.missing.length + crm.dsms.missing.length} not yet submitted
                  </p>
                </div>
                {crm.dsms.missing.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      <AlertTriangle className="h-3 w-3 text-rose-500" /> DSMs ({crm.dsms.missing.length})
                    </p>
                    <PersonChips people={crm.dsms.missing} tone="danger" />
                  </div>
                )}
                {crm.reps.missing.length > 0 && (
                  <div>
                    <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                      <AlertTriangle className="h-3 w-3 text-rose-500" /> Med reps ({crm.reps.missing.length})
                    </p>
                    <PersonChips people={crm.reps.missing} tone="danger" />
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Quick-submit action strip ─────────────────────────────────────── */

const ACTIONS = [
  { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Leave" },
  { href: "/employee-portals/excuses", icon: CalendarClock, label: "Excuse" },
  { href: "/employee-portals/marketing-requests", icon: Send, label: "Marketing" },
  { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Expense" },
] as const;

function ActionStrip() {
  return (
    <div className="grid grid-cols-4 gap-px overflow-hidden border border-slate-200 bg-slate-200">
      {ACTIONS.map((a) => (
        <Link
          key={a.href}
          href={a.href}
          className="group flex flex-col items-center justify-center gap-1 bg-white px-2 py-3 transition-colors hover:bg-orange-50 sm:flex-row sm:gap-2"
        >
          <a.icon className="h-4 w-4 shrink-0 text-orange-600" />
          <span className="whitespace-nowrap text-[11px] font-bold uppercase tracking-wide text-slate-700 transition-colors group-hover:text-orange-700 sm:text-xs">
            {a.label}
          </span>
        </Link>
      ))}
    </div>
  );
}

/* ── NSM command center ────────────────────────────────────────────── */

export function NsmCommandCenter({ snapshot }: { snapshot: PortalHomeSnapshot }) {
  const { shell, pendingVacationCount, pendingExcuseCount, nsmNational, nsmBoard, dvFocus } = snapshot;
  const totalPending = pendingVacationCount + pendingExcuseCount;

  return (
    <div className="mx-auto w-full space-y-3" dir="auto">
      <IdentityCard data={shell} />
      <ProfileIntelBar shell={shell} />

      {totalPending > 0 && (
        <PendingActions pendingVacationCount={pendingVacationCount} pendingExcuseCount={pendingExcuseCount} />
      )}

      <div className="overflow-hidden border border-slate-200">
        <SectionHead title="My Tools" />
        <div className="grid grid-cols-1 gap-px bg-slate-200 sm:grid-cols-2">
          <Link href="/employee-portals/med-reps-performance" className="group flex min-h-[64px] items-center gap-4 bg-white px-4 py-4 transition-colors hover:bg-orange-50">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
              <TrendingUp className="h-4 w-4" />
            </div>
            <p className="text-sm font-semibold text-slate-800">Med Rep Performance</p>
          </Link>
          <Link href="/employee-portals/expenses" className="group flex min-h-[64px] items-center gap-4 bg-white px-4 py-4 transition-colors hover:bg-orange-50">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center bg-slate-900 text-slate-300 transition-colors group-hover:bg-orange-600 group-hover:text-white">
              <ReceiptText className="h-4 w-4" />
            </div>
            <p className="text-sm font-semibold text-slate-800">Team Expenses</p>
          </Link>
        </div>
      </div>

      {/* ── New command-center sections (added below, nothing replaced) ── */}
      <NationalKeycards nsmNational={nsmNational} />

      <DashboardsGrid />

      <div className="grid gap-3 lg:grid-cols-2">
        <RankingPanel
          title="Top Medical Reps"
          subtitle="by achievement %"
          icon={Trophy}
          rows={nsmBoard?.topReps ?? []}
          showManager
        />
        <RankingPanel title="Districts (DSMs)" subtitle="by achievement %" icon={Network} rows={nsmBoard?.dsms ?? []} />
      </div>

      <CrmBoard crm={nsmBoard?.crm ?? null} />

      <ActionStrip />

      <DoubleVisitFocusSection focus={dvFocus} />
    </div>
  );
}
