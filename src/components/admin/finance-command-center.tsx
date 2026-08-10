import Link from "next/link";
import { type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Landmark,
  ReceiptText,
  Megaphone,
  ScrollText,
  Wallet,
} from "lucide-react";

import { AdminHeroFrame } from "@/components/admin/admin-design-system";
import { AreaSparkline, SectionShell, TwoSeriesBars } from "@/components/admin/ceo-command-center";
import { CeoHeroIdentity } from "@/components/admin/ceo-hero-identity";
import type { FinanceCommandCenterView, FinancePayrollRun } from "@/lib/finance/command-center";

export type FinanceWelcomeProfile = {
  fullName: string;
  roleLabel: string;
  hrId: string | null;
  imageUrl?: string | null;
};

// ── Formatters ───────────────────────────────────────────────────────────────
// Same shape as the CEO centre's local helpers (they are not exported). Compact for tiles so a
// 2.6M figure never wraps — the owner's standing rule is that admin text never wraps and is never
// truncated with an ellipsis, and a tile is the tightest space on the page.

function egp(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(2)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return `EGP ${Math.round(safe).toLocaleString("en-US")}`;
}

/** Exact figure, for the places where finance needs the piastres and there is room to show them. */
function egpExact(value: number) {
  const safe = Number.isFinite(value) ? value : 0;
  return `EGP ${safe.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

function n(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "-";
}

function monthLabel(period: string) {
  const [year, month] = period.split("-");
  const index = Number(month) - 1;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[index] ?? period} ${String(year ?? "").slice(2)}`;
}

/**
 * Every time this platform shows is Africa/Cairo, never raw UTC — a standing owner rule. Rendered
 * on the server from the payload's own stamp, so it is the age of the DATA, not of the page view.
 */
function cairoTimestamp(iso: string) {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return "just now";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
  }).format(at);
}

/** Whole days since `iso`, in Cairo terms. Ageing is the signal finance acts on, not the raw date. */
function daysSince(iso: string | null) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}

function ageLabel(iso: string | null, emptyText: string) {
  const days = daysSince(iso);
  if (days === null) return emptyText;
  if (days === 0) return "Oldest: today";
  return `Oldest: ${days} ${days === 1 ? "day" : "days"} old`;
}

// ── Tiles ────────────────────────────────────────────────────────────────────

function MetricTile({
  icon,
  label,
  value,
  sub,
  tone = "slate",
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  tone?: "slate" | "emerald" | "amber" | "rose";
}) {
  const toneClass = {
    amber: "text-amber-700",
    emerald: "text-emerald-700",
    rose: "text-rose-700",
    slate: "text-slate-900",
  }[tone];

  return (
    <div className="min-h-32 border border-slate-200 bg-white px-4 py-4">
      <div className="flex items-center gap-2 text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">
        <span className="text-orange-600">{icon}</span>
        {label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none ${toneClass}`}>{value}</p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p>
    </div>
  );
}

/**
 * One row of the action queue. Renders as a full-width link on every breakpoint — a queue is a
 * list of things to go and do, so it is a card on mobile and a card on desktop. Only genuine
 * TABLES get the md: split, which is why nothing on this page renders a <table> at all.
 */
function QueueRow({
  count,
  href,
  icon,
  label,
  meta,
  tone = "slate",
  value,
}: {
  count: number;
  href: string;
  icon: ReactNode;
  label: string;
  meta: string;
  tone?: "slate" | "amber" | "rose";
  value?: string;
}) {
  const accent = { amber: "border-l-amber-400", rose: "border-l-rose-500", slate: "border-l-slate-300" }[tone];
  const countTone = { amber: "text-amber-700", rose: "text-rose-700", slate: "text-slate-900" }[tone];

  return (
    <Link
      className={`flex items-center gap-4 border-l-[3px] ${accent} border-b border-slate-100 px-5 py-4 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500`}
      href={href}
    >
      <span className="shrink-0 text-orange-600">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-black text-slate-950">{label}</span>
        <span className="mt-0.5 block text-[11px] font-semibold text-slate-500">{meta}</span>
      </span>
      {value ? (
        <span className="hidden shrink-0 text-right text-sm font-black tabular-nums text-slate-700 sm:block">{value}</span>
      ) : null}
      <span className={`shrink-0 text-2xl font-black tabular-nums ${countTone}`}>{n(count)}</span>
      <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0 text-slate-300" />
    </Link>
  );
}

function AllClear({ message }: { message: string }) {
  return (
    <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 px-5 py-4">
      <CheckCircle2 aria-hidden="true" className="h-5 w-5 shrink-0 text-emerald-600" />
      <span className="text-sm font-semibold text-emerald-800">{message}</span>
    </div>
  );
}

function UnavailableNotice({ sources }: { sources: string[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="border border-amber-200 bg-amber-50 px-5 py-4">
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
        <div>
          <p className="text-sm font-black text-amber-900">Some finance data sources are unavailable.</p>
          <p className="mt-1 text-xs font-medium text-amber-800">
            These figures are paused rather than shown as zero: {sources.join(", ")}.
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Payroll cycle ────────────────────────────────────────────────────────────

const SHEET_LINKS = [
  { key: "finance", label: "Finance sheet", href: "/api/automated-payroll/finance/download" },
  { key: "cib", label: "CIB bank file", href: "/api/automated-payroll/finance/cib-download" },
  { key: "fab", label: "FAB bank file", href: "/api/automated-payroll/finance/fab-download" },
] as const;

function PayrollCycle({ view }: { view: FinanceCommandCenterView }) {
  const { data, sheets } = view;
  const runs = data.payroll.runs;
  const readyToPay = runs.find((run) => run.part2_confirmed && !run.published) ?? null;

  const phaseLabel = (run: FinancePayrollRun | null) => {
    if (!run) return "No run open";
    if (run.published) return "Published to payslips";
    if (run.part2_confirmed) return "Both parts confirmed — awaiting publish";
    if (run.part1_confirmed) return "Part 1 confirmed";
    return "Part 1 in progress";
  };

  const scope = sheets?.full ? "full" : "part1";
  const period = sheets?.period;
  const sheetQuery = period ? `?month=${period.month}&year=${period.year}&scope=${scope}` : "";

  return (
    <div className="grid gap-0 lg:grid-cols-[1.1fr_0.9fr] lg:divide-x lg:divide-slate-200">
      <div className="divide-y divide-slate-100">
        {runs.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-slate-400">No automated payroll run yet.</div>
        ) : (
          runs.slice(0, 3).map((run) => (
            <div className="flex items-center gap-4 px-5 py-4" key={run.month_key}>
              <span className="shrink-0 text-orange-600">
                <CalendarClock aria-hidden="true" className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-black text-slate-950">{monthLabel(run.month_key)}</p>
                <p className="mt-0.5 text-[11px] font-semibold text-slate-500">{phaseLabel(run)}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-black tabular-nums text-slate-900">{n(run.rows_in_run)}</p>
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">in run</p>
              </div>
              <div className="hidden shrink-0 text-right sm:block">
                <p className="text-sm font-black tabular-nums text-rose-700">{egpExact(run.decided_deductions)}</p>
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">deducted</p>
              </div>
            </div>
          ))
        )}

        {/* The point of the whole band: when a period is confirmed but unpublished, the locked
            sheet and both bank files are sitting ready and pulling them is his job. These are
            shortcuts to /admin/automated-payroll/finance, which he already reaches through
            isAutomatedPayrollFinanceActor — no new authority, one less navigation. */}
        {sheets?.hasRun && (sheets.part1 || sheets.full) ? (
          <div className="flex flex-wrap items-center gap-2 bg-slate-50 px-5 py-4">
            <span className="mr-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
              {readyToPay ? `Ready to pay — ${monthLabel(readyToPay.month_key)}` : "Available to download"}
            </span>
            {SHEET_LINKS.map((sheet) => (
              <a
                className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-800 transition-colors hover:border-orange-300 hover:bg-orange-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                href={`${sheet.href}${sheetQuery}`}
                key={sheet.key}
              >
                <Download aria-hidden="true" className="h-3.5 w-3.5 text-orange-600" />
                {sheet.label}
              </a>
            ))}
          </div>
        ) : (
          <div className="bg-slate-50 px-5 py-4 text-[11px] font-semibold text-slate-500">
            No finance sheet is available for this period yet — HR confirms Part 1 first.
          </div>
        )}
      </div>

      <div className="space-y-4 p-5">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">Net payroll paid</p>
          <div className="mt-2">
            <AreaSparkline
              gradId="finance-net-payroll"
              points={data.payroll.committed.map((month) => ({ label: monthLabel(month.period), value: month.net }))}
            />
          </div>
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
            Deductions actually committed
          </p>
          <p className="mt-0.5 text-[10px] font-medium text-slate-400">
            What payroll charged — not what the detection engines proposed.
          </p>
          <div className="mt-2">
            <TwoSeriesBars
              colorA="#F97316"
              colorB="#8B5CF6"
              data={data.payroll.committed.map((month) => ({
                a: month.deductions,
                b: month.governmental,
                label: monthLabel(month.period),
              }))}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-3 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-2" style={{ backgroundColor: "#F97316" }} />
              HR deductions
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="h-2 w-2" style={{ backgroundColor: "#8B5CF6" }} />
              Tax &amp; insurance
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export function FinanceCommandCenter({
  view,
  welcome,
}: {
  view: FinanceCommandCenterView;
  welcome: FinanceWelcomeProfile;
}) {
  const { data } = view;
  const latest = data.payroll.committed[data.payroll.committed.length - 1] ?? null;
  const openRun = data.payroll.runs[0] ?? null;

  const actionTotal =
    data.directOrders.awaitingCount +
    data.marketing.awaitingMyStep +
    data.marketing.missingPaymentProof +
    data.leave.awaitingMyDecision;

  return (
    <div className="space-y-0 divide-y divide-slate-200">
      <AdminHeroFrame className="z-10 overflow-visible">
        <div className="p-5 sm:p-6 lg:p-8">
          <div className="mb-5 inline-flex items-center gap-2 border border-orange-400/40 bg-orange-500/15 px-3 py-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-orange-100">
            <Landmark aria-hidden="true" className="h-3.5 w-3.5" />
            Finance Command Center
          </div>
          <CeoHeroIdentity fullName={welcome.fullName} imageUrl={welcome.imageUrl} roleLabel={welcome.roleLabel} />
        </div>
      </AdminHeroFrame>

      <UnavailableNotice sources={view.unavailable} />

      {/* ── Band 1: money in motion ── */}
      <SectionShell
        description="The standing cost of the company, and what is waiting on you right now."
        title="Money in motion"
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            icon={<Wallet aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Net payroll"
            sub={`${n(data.headcount.payrollEligible)} payroll-eligible`}
            value={egp(latest?.net ?? data.headcount.standingNet)}
          />
          <MetricTile
            icon={<ScrollText aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Awaiting you"
            sub={actionTotal === 0 ? "Nothing queued" : "Across every module"}
            tone={actionTotal > 0 ? "amber" : "emerald"}
            value={n(actionTotal)}
          />
          <MetricTile
            icon={<ReceiptText aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Direct orders unbooked"
            sub={ageLabel(data.directOrders.awaitingOldest, "All booked")}
            tone={data.directOrders.awaitingCount > 0 ? "rose" : "emerald"}
            value={egp(data.directOrders.awaitingValue)}
          />
          <MetricTile
            icon={<CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Expense claims pending"
            sub={ageLabel(data.outstation.pendingOldest, "Queue is clear")}
            tone={data.outstation.pendingCount > 0 ? "amber" : "emerald"}
            value={egp(data.outstation.pendingClaimed)}
          />
        </div>
      </SectionShell>

      {/* ── Band 2: the payroll cycle ── */}
      <SectionShell
        action={
          <Link
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
            href="/admin/automated-payroll/finance"
          >
            <FileSpreadsheet aria-hidden="true" className="h-3.5 w-3.5" />
            Payroll — Finance
          </Link>
        }
        description="Run status, the sheets you can pull, and what payroll has actually charged."
        title="Payroll cycle"
      >
        <PayrollCycle view={view} />
      </SectionShell>

      {/* ── Band 3: his queues ── */}
      <SectionShell
        description="Everything below is assigned to you personally — not a company backlog."
        title="Waiting on you"
      >
        {actionTotal === 0 ? (
          <AllClear message="Nothing is waiting on you. Every queue you own is clear." />
        ) : (
          <div>
            {data.directOrders.awaitingCount > 0 ? (
              <QueueRow
                count={data.directOrders.awaitingCount}
                href="/admin/direct-orders/report"
                icon={<ReceiptText aria-hidden="true" className="h-4 w-4" />}
                label="Direct orders awaiting a sales month"
                meta={`You are the only person who can book these · ${ageLabel(data.directOrders.awaitingOldest, "")}`}
                tone="rose"
                value={egpExact(data.directOrders.awaitingValue)}
              />
            ) : null}
            {data.marketing.awaitingMyStep > 0 ? (
              <QueueRow
                count={data.marketing.awaitingMyStep}
                href="/admin/marketing-requests/inbox"
                icon={<Megaphone aria-hidden="true" className="h-4 w-4" />}
                label="Marketing requests to execute"
                meta="Your Finance Execution step, after CEO approval"
                tone="amber"
              />
            ) : null}
            {data.marketing.missingPaymentProof > 0 ? (
              <QueueRow
                count={data.marketing.missingPaymentProof}
                href="/workspace/marketing-requests"
                icon={<FileSpreadsheet aria-hidden="true" className="h-4 w-4" />}
                label="Marketing spend missing payment proof"
                meta="Executed requests with no money-transfer proof attached"
                tone="amber"
              />
            ) : null}
            {data.leave.awaitingMyDecision > 0 ? (
              <QueueRow
                count={data.leave.awaitingMyDecision}
                href="/admin/approvals/vacation"
                icon={<CalendarClock aria-hidden="true" className="h-4 w-4" />}
                label="Leave requests from your team"
                meta="Your direct reports are waiting on a decision"
                tone="amber"
              />
            ) : null}
          </div>
        )}
      </SectionShell>

      {/* ── Band 4: cost control ── */}
      <SectionShell
        description="Committed figures from payroll itself. Candidate estimates are never shown here."
        title="Cost control"
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            icon={<ScrollText aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Deductions charged"
            sub={latest ? `${monthLabel(latest.period)} payroll` : "No closed month yet"}
            value={egp(latest?.deductions ?? 0)}
          />
          <MetricTile
            icon={<Landmark aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Tax & insurance"
            sub={latest ? `${monthLabel(latest.period)} payroll` : "No closed month yet"}
            value={egp(latest?.governmental ?? 0)}
          />
          <MetricTile
            icon={<ReceiptText aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Expenses in open run"
            sub={openRun ? `${monthLabel(openRun.month_key)} · reimbursed` : "No run open"}
            value={egp(openRun?.expenses_paid ?? 0)}
          />
          <MetricTile
            icon={<CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Expense claims approved"
            sub={`${n(data.outstation.approvedCount)} trips cleared`}
            tone="emerald"
            value={egp(data.outstation.approvedValue)}
          />
        </div>
      </SectionShell>

      <div className="flex items-center justify-between gap-4 bg-slate-900 px-5 py-3 text-[10px] text-slate-400">
        <span>Deduction figures are taken from committed payroll, never from candidate estimates.</span>
        <span className="shrink-0 tabular-nums">Updated {cairoTimestamp(data.generatedAt)}</span>
      </div>
    </div>
  );
}
