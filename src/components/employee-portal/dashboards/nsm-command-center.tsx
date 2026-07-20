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
import {
  ActionStrip,
  DashboardsGrid,
  KeycardGrid,
  PendingActions,
  ProfileIntelBar,
  RankingPanel,
  SectionHead,
  egpCompact,
  type ActionStripItem,
  type DashboardLink,
} from "@/components/employee-portal/portal-command-center";
import { DoubleVisitFocusSection } from "@/components/employee-portal/dashboards/double-visit-focus-section";
import type { PortalHomeSnapshot } from "@/lib/employee-portal/home-snapshot";

type NsmBoard = NonNullable<PortalHomeSnapshot["nsmBoard"]>;
type CrmData = NsmBoard["crm"];

function cairoTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "Africa/Cairo",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Early-bird `at` comes from the vendor's crm_save_date — a zone-less Cairo wall-clock stored as
// +00, so its clock reading is ALREADY Cairo-local. Render as-is (timeZone "UTC"); using cairoTime
// here (as lastSyncAt correctly does for the true-UTC synced_at) would double-add the offset and
// show submission times 2–3h late.
function vendorLocalTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });
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
        <KeycardGrid cards={cards} />
      ) : (
        <p className="bg-white px-5 py-6 text-sm text-slate-500">No line sales data synced for the current period yet.</p>
      )}
    </div>
  );
}

/* ── Dashboards grid ───────────────────────────────────────────────── */

const DASHBOARDS: readonly DashboardLink[] = [
  { href: "/employee-portals/source-of-sales", icon: ChartColumnBig, label: "Source of Sales" },
  { href: "/employee-portals/weekly-sales", icon: CalendarRange, label: "Weekly Sales" },
  { href: "/employee-portals/roi", icon: PieChart, label: "ROI" },
  { href: "/employee-portals/expense-dashboard", icon: CircleDollarSign, label: "Expenses" },
  { href: "/employee-portals/coaching", icon: ClipboardCheck, label: "Coaching" },
  { href: "/employee-portals/med-reps-performance", icon: Users, label: "Med Reps" },
  { href: "/employee-portals/dsms-performance", icon: Network, label: "DSMs" },
  { href: "/employee-portals/organogram", icon: Building2, label: "Organogram" },
];

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
  const syncLabel = crm?.lastSyncAt ? `as of ${cairoTime(crm.lastSyncAt)}` : "awaiting sync";

  return (
    <div className="overflow-hidden border border-slate-200 bg-white">
      <SectionHead
        title="CRM First Visit"
        right={<span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-widest text-slate-400">{syncLabel}</span>}
      />
      {crm?.error ? (
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-slate-500">
            CRM data is temporarily unavailable — this is a fetch issue, not a compliance gap. Try again shortly.
          </p>
        </div>
      ) : !crm || !crm.synced ? (
        <div className="flex items-center gap-3 bg-white px-4 py-5 sm:px-5">
          <Clock className="h-4 w-4 shrink-0 text-slate-400" />
          <p className="text-sm text-slate-500">
            Awaiting today&apos;s first CRM sync — visits mirror from iReports360 roughly every 15&nbsp;minutes from 8:30&nbsp;AM
            to noon, then again at 12:07&nbsp;PM and 7:07&nbsp;PM.
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
                {crm.earlyBirds.map((b, i) => {
                  const isGps = b.source === "gps_checkin";
                  return (
                    <span
                      key={b.hrId || b.name}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700"
                    >
                      <span className="font-black text-emerald-600">{i + 1}</span>
                      {b.name}
                      <span className="font-normal text-emerald-600/70">{vendorLocalTime(b.at)}</span>
                      <span
                        className={`rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${
                          isGps ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-500"
                        }`}
                        title={isGps ? "Real GPS check-in time (on site)" : "Logged/save time — not GPS-verified; may be logged later"}
                      >
                        {isGps ? "GPS" : "Logged"}
                      </span>
                    </span>
                  );
                })}
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

const ACTIONS: readonly ActionStripItem[] = [
  { href: "/employee-portals/vacation-request", icon: CalendarDays, label: "Leave" },
  { href: "/employee-portals/excuses", icon: CalendarClock, label: "Excuse" },
  { href: "/employee-portals/marketing-requests", icon: Send, label: "Marketing" },
  { href: "/employee-portals/submit-expense", icon: ReceiptText, label: "Expense" },
];

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

      <NationalKeycards nsmNational={nsmNational} />

      <DashboardsGrid items={DASHBOARDS} />

      <div className="flex items-center gap-1.5 border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Incentives shown below are not yet confirmed by HR.
      </div>

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

      <ActionStrip items={ACTIONS} />

      <DoubleVisitFocusSection focus={dvFocus} />
    </div>
  );
}
