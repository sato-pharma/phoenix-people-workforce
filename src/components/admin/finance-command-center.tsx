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
  // Abbreviate only where the exact figure cannot fit and the rounding is immaterial. Below 100K
  // the full number is shown: on a finance dashboard "EGP 6K" for a 5,500 EGP payable is a worse
  // answer than the number itself, and 43,925.50 rounding to "44K" hides which order it is.
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(2)}M`;
  if (Math.abs(safe) >= 100_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
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

/**
 * A single figure in a pipeline strip.
 *
 * Renders its zero rather than hiding it — owner's rule for this page: "relevant even if empty, no
 * data now, tomorrow will be populated." Both modules here are mid-lifecycle (the receivables
 * columns are populated on 0 of 24 direct orders today), and a stage that disappears when empty
 * teaches the reader it does not exist. `muted` greys an untouched stage so an empty pipeline still
 * reads as a pipeline, not as a row of failures.
 */
function PipelineStat({
  label,
  value,
  sub,
  muted = false,
  tone = "slate",
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
  tone?: "slate" | "emerald" | "amber" | "rose";
}) {
  const toneClass = muted
    ? "text-slate-300"
    : { amber: "text-amber-700", emerald: "text-emerald-700", rose: "text-rose-700", slate: "text-slate-900" }[tone];

  return (
    <div className="min-w-0 border border-slate-200 bg-white px-4 py-3.5">
      <p className="text-[9px] font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className={`mt-2 text-xl font-black leading-none tabular-nums ${toneClass}`}>{value}</p>
      {sub ? <p className="mt-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p> : null}
    </div>
  );
}

/**
 * The one header on this page allowed to be a statement rather than a label.
 *
 * Deliberately the same construction as SfeDepartmentBanner in ceo-command-center.tsx — same
 * vertical footprint as a normal header (px-5 py-4, so it cannot push the figures down the page),
 * same orange hairline, same gradient-clipped title, and the Sato mark in the same right-hand
 * position the CEO's carries. The name is read from the viewer rather than hardcoded, so the
 * banner stays true if the seat ever changes hands.
 */
function FinanceOwnerBanner({ fullName }: { fullName: string }) {
  return (
    <div className="relative overflow-hidden border-b border-slate-200 bg-slate-900 px-5 py-4 text-center">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent_0%,rgba(249,115,22,0.7)_50%,transparent_100%)]"
      />
      <div className="relative flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
        <h2 className="bg-[linear-gradient(180deg,#FFFFFF_0%,#FFE7CF_60%,#F8B56B_100%)] bg-clip-text text-sm font-black uppercase tracking-[0.14em] text-transparent">
          {fullName}
        </h2>
        <span aria-hidden="true" className="h-1 w-1 rotate-45 bg-[#F97316]" />
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[#F8B56B]">
          Leading Since Your First Day
        </p>
      </div>
      {/* Right corner, absolutely placed so it cannot shift the centred statement off-centre. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt="SATO Pharma"
        className="absolute right-5 top-1/2 hidden h-7 w-auto -translate-y-1/2 opacity-95 sm:block"
        src="/brand/sato-pharma-logo.png"
      />
    </div>
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

  // Which period's sheets to offer, and the authorization to offer them at all, are two different
  // questions and must not be conflated.
  //
  // `sheets` resolving non-null IS the authorization: getFinanceAvailability runs
  // assertAutomatedPayrollFinanceActor, so a viewer who may not download never gets a payload and
  // never gets a button. But it reports on the CURRENT month, and the sheets finance actually
  // needs belong to whichever run is confirmed-but-unpublished — in August that is still JULY.
  // Keying the buttons to the current month hid them exactly when they mattered.
  const sheetRun = readyToPay ?? runs.find((run) => run.part1_confirmed && !run.published) ?? null;
  const canDownloadSheets = sheets !== null && sheetRun !== null;
  const scope = sheetRun?.part2_confirmed ? "full" : "part1";
  const [sheetYear, sheetMonth] = (sheetRun?.month_key ?? "").split("-");
  const sheetQuery = sheetRun ? `?month=${Number(sheetMonth)}&year=${Number(sheetYear)}&scope=${scope}` : "";

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
        {canDownloadSheets && sheetRun ? (
          <div className="flex flex-wrap items-center gap-2 bg-slate-50 px-5 py-4">
            <span className="mr-1 text-[10px] font-black uppercase tracking-[0.14em] text-slate-500">
              {sheetRun.part2_confirmed
                ? `Ready to pay — ${monthLabel(sheetRun.month_key)}`
                : `Part 1 available — ${monthLabel(sheetRun.month_key)}`}
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

  const actionTotal =
    data.directOrders.awaitingCount +
    data.marketing.awaitingMyStep +
    data.marketing.dueUnexecutedCount +
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
          <CeoHeroIdentity
            flushToEdges
            fullName={welcome.fullName}
            imageUrl={welcome.imageUrl}
            roleLabel={welcome.roleLabel}
            subGreeting="Here is what the company owes, what it has charged, and what is waiting on your decision."
          />
        </div>
      </AdminHeroFrame>

      <UnavailableNotice sources={view.unavailable} />

      {/* ── Band 1 ──
          `header` replaces the default title row entirely (and with it any `action`), which is how
          SfeDepartmentBanner earns its centred banner too. The Sato mark lives inside the banner
          as a result — same bar, same right-hand position as the CEO's. */}
      <SectionShell
        header={<FinanceOwnerBanner fullName={welcome.fullName} />}
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
            icon={<Megaphone aria-hidden="true" className="h-3.5 w-3.5" />}
            label="Marketing spend to pay"
            sub={
              data.marketing.dueUnexecutedCount > 0
                ? `${n(data.marketing.dueUnexecutedCount)} approved, not executed`
                : "Nothing due"
            }
            tone={data.marketing.dueUnexecutedCount > 0 ? "amber" : "emerald"}
            value={egp(data.marketing.dueUnexecutedValue)}
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
            {data.marketing.dueUnexecutedCount > 0 ? (
              <QueueRow
                count={data.marketing.dueUnexecutedCount}
                href="/admin/marketing-requests/inbox"
                icon={<Megaphone aria-hidden="true" className="h-4 w-4" />}
                label="Approved marketing spend not yet paid"
                meta="Carries a pay date and has never been executed"
                tone="rose"
                value={egpExact(data.marketing.dueUnexecutedValue)}
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

      {/* ── Band 4: direct orders, end to end ──
          The booking hop is his alone; the rest is the receivable that hop creates. Every stage
          renders its zero — the collection columns are empty on all 24 orders today, and a stage
          that vanishes when empty teaches the reader it does not exist. */}
      <SectionShell
        action={
          <Link
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
            href="/admin/direct-orders/report"
          >
            <ReceiptText aria-hidden="true" className="h-3.5 w-3.5" />
            Direct order report
          </Link>
        }
        description="Approved · booked into a month · into Source of Sales · collected · paid. Only you can book the month."
        title="Direct orders"
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <PipelineStat
            label="Approved"
            sub={`${n(data.directOrders.approvedCount)} orders`}
            tone="emerald"
            value={egp(data.directOrders.approvedValue)}
          />
          <PipelineStat
            label="Awaiting a month"
            muted={data.directOrders.awaitingCount === 0}
            sub={`${n(data.directOrders.awaitingCount)} yours to book`}
            tone={data.directOrders.awaitingCount > 0 ? "rose" : "slate"}
            value={egp(data.directOrders.awaitingValue)}
          />
          <PipelineStat
            label="Booked"
            muted={data.directOrders.bookedCount === 0}
            sub={`${n(data.directOrders.bookedCount)} into a month`}
            value={egp(data.directOrders.bookedValue)}
          />
          <PipelineStat
            label="In Source of Sales"
            muted={data.directOrders.injectedCount === 0}
            sub="orders injected"
            value={n(data.directOrders.injectedCount)}
          />
          <PipelineStat
            label="Collected"
            muted={data.directOrders.paidTotal === 0}
            sub={`${n(data.directOrders.collectedCount)} payments in`}
            tone="emerald"
            value={egp(data.directOrders.paidTotal)}
          />
          <PipelineStat
            label="Still outstanding"
            muted={data.directOrders.remainingTotal === 0}
            sub="unpaid balance"
            tone={data.directOrders.remainingTotal > 0 ? "amber" : "slate"}
            value={egp(data.directOrders.remainingTotal)}
          />
        </div>
        <div className="grid gap-2 border-t border-slate-100 px-5 pb-5 sm:grid-cols-2 lg:grid-cols-3">
          <PipelineStat
            label="In approval"
            muted={data.directOrders.pendingCount === 0}
            sub={`${n(data.directOrders.pendingCount)} awaiting a decision`}
            value={egp(data.directOrders.pendingValue)}
          />
          <PipelineStat
            label="Held or expired"
            muted={data.directOrders.heldCount === 0}
            sub={`${n(data.directOrders.heldCount)} parked`}
            tone={data.directOrders.heldCount > 0 ? "amber" : "slate"}
            value={egp(data.directOrders.heldValue)}
          />
          <PipelineStat
            label="Oldest unbooked"
            muted={data.directOrders.awaitingCount === 0}
            sub={data.directOrders.awaitingCount > 0 ? "since approval" : "nothing waiting"}
            tone={data.directOrders.awaitingCount > 0 ? "rose" : "slate"}
            value={
              daysSince(data.directOrders.awaitingOldest) === null
                ? "—"
                : `${daysSince(data.directOrders.awaitingOldest)} d`
            }
          />
        </div>
      </SectionShell>

      {/* ── Band 5: marketing requests ──
          `dueUnexecuted` deliberately does NOT require a finance step to exist: a request approved
          before that rung was switched on is still spend the company owes, and hiding it on a
          workflow technicality would hide a real payable. */}
      <SectionShell
        action={
          <Link
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-white/20"
            href="/admin/marketing-requests/inbox"
          >
            <Megaphone aria-hidden="true" className="h-3.5 w-3.5" />
            Approval inbox
          </Link>
        }
        description="You execute the transaction after CEO approval, then attach the invoice and the transfer proof."
        title="Marketing requests"
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <PipelineStat
            label="Committed spend"
            muted={data.marketing.committedSpend === 0}
            sub={`${n(data.marketing.approvedCount)} approved`}
            value={egp(data.marketing.committedSpend)}
          />
          <PipelineStat
            label="Due to pay"
            muted={data.marketing.dueUnexecutedCount === 0}
            sub={`${n(data.marketing.dueUnexecutedCount)} not executed`}
            tone={data.marketing.dueUnexecutedCount > 0 ? "rose" : "slate"}
            value={egp(data.marketing.dueUnexecutedValue)}
          />
          <PipelineStat
            label="Executed by you"
            muted={data.marketing.executedCount === 0}
            sub="transactions done"
            tone="emerald"
            value={n(data.marketing.executedCount)}
          />
          <PipelineStat
            label="Invoice missing"
            muted={data.marketing.missingInvoice === 0}
            sub="on executed spend"
            tone={data.marketing.missingInvoice > 0 ? "amber" : "slate"}
            value={n(data.marketing.missingInvoice)}
          />
          <PipelineStat
            label="Transfer proof missing"
            muted={data.marketing.missingPaymentProof === 0}
            sub="yours to attach"
            tone={data.marketing.missingPaymentProof > 0 ? "amber" : "slate"}
            value={n(data.marketing.missingPaymentProof)}
          />
          <PipelineStat
            label="ROI committed"
            muted={data.marketing.requiredRoi === 0}
            sub="sales this must return"
            value={egp(data.marketing.requiredRoi)}
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
