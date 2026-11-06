import Link from "next/link";
import { type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Download,
  FileSpreadsheet,
  Landmark,
  ReceiptText,
  Megaphone,
  ScrollText,
  Wallet,
} from "lucide-react";

import { AdminHeroFrame } from "@/components/admin/admin-design-system";
import { AreaSparkline, SectionShell } from "@/components/admin/ceo-command-center";
import { CeoHeroIdentity } from "@/components/admin/ceo-hero-identity";
import { APPROVALS_SLA_THRESHOLDS, slaTone } from "@/components/approvals-hub/sla-thresholds";
import { PushOptInNudge } from "@/components/notifications/push-opt-in-nudge";
import { financeDownloadScope } from "@/lib/automated-payroll/finance-links";
import type {
  FinanceCommandCenterData,
  FinanceCommandCenterView,
  FinanceCommittedMonth,
  FinancePayrollRun,
} from "@/lib/finance/command-center";

/**
 * The identity band's subject. Back, and it is the ORIGINAL band, not the thin strip.
 *
 * Removed 2026-09-03 ("remove from all pages this dump block") and restored 2026-09-06 on the
 * owner's instruction: "I WANT THE SFE AND THE FINANCE AND CEO TO HAVE THEIR PREVIOUS IDENTITY
 * BANNER, THE NEW ONE IS ONLY FOR HRs." The thin `PhoenixIdentityStrip` briefly went on this page
 * that same day and was wrong — it belongs to the HR overview and /admin. Full account on
 * `CeoWelcomeProfile` in ceo-command-center.tsx, which this mirrors.
 */
export type FinanceWelcomeProfile = {
  fullName: string;
  roleLabel: string;
  hrId: string | null;
  imageUrl?: string | null;
  initials?: string;
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

/**
 * "Oldest deadline was 18 days ago" — spelled out, because this row is read on a phone at a glance
 * and the owner's rule is that nothing in the UI truncates or wraps. Falls back to a plain sentence
 * rather than an empty string: a queue row that renders with no explanation reads as a bug.
 */
function overdueInvoiceMeta(oldestDeadline: string | null) {
  const days = daysSince(oldestDeadline);
  if (days === null) return "The invoice was promised by a date that has passed";
  if (days === 0) return "The deadline was today";
  return `Oldest deadline was ${days} ${days === 1 ? "day" : "days"} ago`;
}

function ageLabel(iso: string | null, emptyText: string) {
  const days = daysSince(iso);
  if (days === null) return emptyText;
  if (days === 0) return "Oldest: today";
  return `Oldest: ${days} ${days === 1 ? "day" : "days"} old`;
}

/**
 * How loud the unbooked-direct-orders figure should be, given how long the oldest one has waited.
 *
 * ONE definition, three consumers — the "Direct orders unbooked" tile, the "Direct orders awaiting a
 * sales month" queue row, and the "Awaiting a month" pipeline stat. Before this, all three simply
 * went rose the moment the count passed zero, which meant a queue cleared the same afternoon looked
 * exactly as alarming as one seven days old, and nothing on the page could tell him which he had.
 *
 * This is what replaces an escalation email. The owner declined extra email (2026-08-10), so the
 * pressure has to live on the screen: normal turnaround is quiet, day 4 turns amber, and the
 * threshold turns it red — the same none/due/overdue vocabulary and the same slaTone() the approval
 * badges use, so "late" means one thing across the product.
 */
function unbookedTone(count: number, oldestIso: string | null): "emerald" | "slate" | "amber" | "rose" {
  if (count === 0) return "emerald";
  const tone = slaTone(daysSince(oldestIso) ?? 0, APPROVALS_SLA_THRESHOLDS.directOrderMonth);
  return tone === "overdue" ? "rose" : tone === "due" ? "amber" : "slate";
}

/**
 * The queue-row variant: same decision, minus `emerald`, which QueueRow has no accent for. Safe
 * because the row only renders when the count is above zero — but expressed as a fallback rather
 * than a cast, so a future caller that renders it at zero degrades to `slate` instead of failing
 * a lookup and rendering an unstyled border.
 */
function unbookedQueueTone(count: number, oldestIso: string | null): "slate" | "amber" | "rose" {
  const tone = unbookedTone(count, oldestIso);
  return tone === "rose" ? "rose" : tone === "amber" ? "amber" : "slate";
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

  // Centred, unlike the CEO centre's left-aligned MetricTile this is modelled on. This page is a
  // grid of many small figures rather than a few wide ones, and centring gives every card a single
  // shared axis — the eye scans down one line instead of re-finding a ragged left edge per row.
  return (
    <div className="min-h-32 border border-slate-200 bg-white px-4 py-4 text-center">
      <div className="flex items-center justify-center gap-2 text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">
        <span className="text-orange-600">{icon}</span>
        {label}
      </div>
      <p className={`mt-4 text-3xl font-black leading-none tabular-nums ${toneClass}`}>{value}</p>
      <p className="mt-2 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p>
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
        <span className="mt-0.5 block text-phx-xs font-semibold text-slate-500">{meta}</span>
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
 * data now, tomorrow will be populated." A stage that disappears when empty teaches the reader it
 * does not exist. `muted` greys an untouched stage so an empty pipeline still reads as a pipeline,
 * not as a row of failures. Booked and In-Source-of-Sales are the live example: both sit at 0 of 24
 * direct orders today, and both are one action away from filling.
 *
 * The rule has a limit, and the receivables columns were where it was found. "Collected" and "Still
 * outstanding" used to sit at the end of the direct-orders pipeline under exactly this reasoning —
 * but nothing in the product can write paid_amount or remaining_amount, so their tomorrow never
 * existed. The owner removed them on 2026-08-10. Show an empty stage that CAN fill; delete one that
 * cannot, or the zero is not a stage, it is a false promise.
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
    <div className="min-w-0 border border-slate-200 bg-white px-4 py-3.5 text-center">
      <p className="text-phx-3xs font-black uppercase tracking-[0.14em] text-slate-500">{label}</p>
      <p className={`mt-2 text-xl font-black leading-none tabular-nums ${toneClass}`}>{value}</p>
      {sub ? <p className="mt-1.5 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">{sub}</p> : null}
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
function FinanceOwnerBanner() {
  return (
    // py-4 on purpose, matching SfeDepartmentBanner: a banner that pushes the figures down the
    // page costs more than it adds. Everything below earns its presence through ornament and
    // depth, never through height.
    <div className="relative overflow-hidden border-b border-slate-200 bg-slate-900 px-5 py-4 text-center">
      {/* Depth, back to front: a warm ember centred behind the wordmark so the bar is lit rather
          than flat, then a hairline top and bottom to frame it. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_58%_130%_at_50%_50%,rgba(249,115,22,0.17)_0%,rgba(249,115,22,0.05)_45%,transparent_76%)]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-[linear-gradient(90deg,transparent_0%,rgba(249,115,22,0.75)_50%,transparent_100%)]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-[linear-gradient(90deg,transparent_0%,rgba(248,181,107,0.3)_50%,transparent_100%)]"
      />

      {/* Deliberately the phrase alone. His name and portrait are already the hero directly above,
          so repeating them here was saying the same thing twice in 40 vertical pixels.
          Flanked by tapered rules and lit diamonds — the ornament is what makes three short words
          hold the full width of the bar without setting them enormous. */}
      <div className="relative flex items-center justify-center gap-3 sm:gap-4">
        <span
          aria-hidden="true"
          className="hidden h-px w-10 bg-[linear-gradient(90deg,transparent_0%,rgba(248,181,107,0.75)_100%)] sm:block lg:w-16"
        />
        <span
          aria-hidden="true"
          className="hidden h-1 w-1 rotate-45 bg-phx-accent shadow-[0_0_10px_rgba(249,115,22,0.9)] sm:block"
        />

        {/* `fcc-nameplate` (app/globals.css) is the gold foil + travelling highlight; it already
            sets background-clip:text and a transparent colour, so no bg-clip utility here.
            text-indent cancels the trailing space that letter-spacing adds after the final "E",
            which would otherwise sit the phrase visibly left of true centre. */}
        <h2 className="fcc-nameplate text-sm font-black uppercase tracking-[0.44em] [text-indent:0.44em] [text-shadow:0_0_26px_rgba(249,115,22,0.34)] sm:text-phx-lg">
          Since Day One
        </h2>

        <span
          aria-hidden="true"
          className="hidden h-1 w-1 rotate-45 bg-phx-accent shadow-[0_0_10px_rgba(249,115,22,0.9)] sm:block"
        />
        <span
          aria-hidden="true"
          className="hidden h-px w-10 bg-[linear-gradient(90deg,rgba(248,181,107,0.75)_0%,transparent_100%)] sm:block lg:w-16"
        />
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

/**
 * Net payroll, month over month.
 *
 * The sparkline above it carries the LEVEL; this carries the MOVEMENT — how much each month's net
 * rose or fell against the one before, which is the question a finance manager actually asks of a
 * payroll series. Rendered as plain divs with inline heights, the same way TwoSeriesBars does it,
 * so it stays in the executive family and pulls in no charting library.
 *
 * Bars are scaled from zero, not from the series minimum: a 2.6M and a 2.8M month are genuinely
 * similar, and a min-anchored scale would exaggerate that into a cliff.
 */
function NetMonthOverMonth({ months }: { months: FinanceCommittedMonth[] }) {
  if (months.length === 0) {
    return <p className="text-xs text-slate-400">No closed month yet.</p>;
  }

  const max = Math.max(...months.map((month) => month.net), 1);
  const lastIndex = months.length - 1;

  return (
    // `overflow-visible` so a tooltip can escape the chart box; the parent panel does not clip.
    <div className="relative overflow-visible pt-6">
      <div className="flex h-24 items-end gap-2">
        {months.map((month, index) => {
          const previous = index > 0 ? months[index - 1]!.net : null;
          const delta = previous && previous > 0 ? (month.net - previous) / previous : null;
          const flat = delta !== null && Math.abs(delta) < 0.005;
          const up = delta !== null && !flat && delta > 0;
          const down = delta !== null && !flat && delta < 0;
          const isLatest = index === lastIndex;
          const deltaText = delta === null ? "—" : flat ? "0%" : `${up ? "+" : "−"}${Math.abs(delta * 100).toFixed(0)}%`;

          return (
            <div
              className="group relative flex min-w-0 flex-1 flex-col items-center gap-1.5"
              key={month.period}
            >
              {/* Hover card. Pure CSS — this is a server component, and a native `title` alone
                  cannot show the exact figure and the change together. `title` stays as the
                  touch/screen-reader fallback, since hover does not exist on a phone. */}
              <div
                className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden -translate-x-1/2 whitespace-nowrap border border-slate-700 bg-slate-900 px-3 py-2 text-left shadow-[0_12px_28px_rgba(15,23,42,0.35)] group-hover:block"
                role="tooltip"
              >
                <p className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">
                  {monthLabel(month.period)}
                </p>
                <p className="mt-1 text-sm font-black tabular-nums text-white">{egpExact(month.net)}</p>
                <p className="mt-0.5 text-phx-2xs font-bold tabular-nums text-slate-300">
                  {n(month.employees)} paid
                  {delta === null ? "" : ` · ${deltaText} vs ${monthLabel(months[index - 1]!.period)}`}
                </p>
              </div>

              <span
                className={`text-phx-3xs font-black tabular-nums ${
                  delta === null || flat ? "text-slate-400" : up ? "text-emerald-700" : "text-rose-700"
                }`}
              >
                {deltaText}
              </span>

              {/* Solid brand orange with a vertical gradient — no opacity wash, which is what made
                  the earlier bars look faded and unfinished on white. The latest month is the
                  deepest and carries a ring so "now" is unmistakable at a glance. */}
              <div
                className={`w-full transition-[filter] duration-150 group-hover:brightness-110 ${
                  isLatest ? "ring-1 ring-orange-700/40" : ""
                }`}
                style={{
                  backgroundImage: isLatest
                    ? "linear-gradient(180deg,#FB923C 0%,#EA580C 100%)"
                    : "linear-gradient(180deg,#FDBA74 0%,#F97316 100%)",
                  height: `${Math.max(6, (month.net / max) * 68)}px`,
                }}
                title={`${monthLabel(month.period)} — ${egpExact(month.net)}${delta === null ? "" : ` (${deltaText})`}`}
              />

              <span
                className={`truncate text-phx-4xs ${isLatest ? "font-black text-slate-700" : "text-slate-400"}`}
              >
                {monthLabel(month.period)}
              </span>

              {/* Screen readers get the same three facts the hover card shows. */}
              <span className="sr-only">
                {monthLabel(month.period)}: {egpExact(month.net)}, {n(month.employees)} paid
                {delta === null ? "" : `, ${deltaText} versus the previous month`}
              </span>

              {down ? <span className="sr-only">decrease</span> : null}
            </div>
          );
        })}
      </div>
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

/** "FAB bank file · Part 2" — the part a bank file pays is said on the button, not only in its name. */
function financeSheetLabel(sheet: (typeof SHEET_LINKS)[number], part2Confirmed: boolean): string {
  if (sheet.key === "finance") return part2Confirmed ? "Finance sheet · full month" : "Finance sheet · Part 1";
  return `${sheet.label} · ${part2Confirmed ? "Part 2" : "Part 1"}`;
}

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
  const part2Confirmed = sheetRun?.part2_confirmed === true;
  const [sheetYear, sheetMonth] = (sheetRun?.month_key ?? "").split("-");
  const sheetHref = (sheet: (typeof SHEET_LINKS)[number]) =>
    `${sheet.href}?month=${Number(sheetMonth)}&year=${Number(sheetYear)}&scope=${financeDownloadScope(sheet.key, part2Confirmed)}`;

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
                <p className="mt-0.5 text-phx-xs font-semibold text-slate-500">{phaseLabel(run)}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm font-black tabular-nums text-slate-900">{n(run.rows_in_run)}</p>
                <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">in run</p>
              </div>
              <div className="hidden shrink-0 text-right sm:block">
                <p
                  className={`text-sm font-black tabular-nums ${run.on_hold_count > 0 ? "text-amber-700" : "text-slate-300"}`}
                >
                  {n(run.on_hold_count)}
                </p>
                <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-400">on hold</p>
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
            <span className="mr-1 text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
              {sheetRun.part2_confirmed
                ? `Ready to pay — ${monthLabel(sheetRun.month_key)}`
                : `Part 1 available — ${monthLabel(sheetRun.month_key)}`}
            </span>
            {SHEET_LINKS.map((sheet) => (
              <a
                className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-3 py-1.5 text-phx-xs font-bold text-slate-800 transition-colors hover:border-orange-300 hover:bg-orange-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
                href={sheetHref(sheet)}
                key={sheet.key}
              >
                <Download aria-hidden="true" className="h-3.5 w-3.5 text-orange-600" />
                {financeSheetLabel(sheet, part2Confirmed)}
              </a>
            ))}
          </div>
        ) : (
          <div className="bg-slate-50 px-5 py-4 text-phx-xs font-semibold text-slate-500">
            No finance sheet is available for this period yet — HR confirms Part 1 first.
          </div>
        )}
      </div>

      <div className="space-y-4 p-5">
        <div>
          <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">Net payroll paid</p>
          <div className="mt-2">
            <AreaSparkline
              gradId="finance-net-payroll"
              points={data.payroll.committed.map((month) => ({ label: monthLabel(month.period), value: month.net }))}
            />
          </div>
        </div>
        <div>
          <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-500">
            Net payroll — month over month
          </p>
          <p className="mt-0.5 text-phx-2xs font-medium text-slate-400">
            How each month moved against the one before it.
          </p>
          <div className="mt-2">
            <NetMonthOverMonth months={data.payroll.committed} />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

/**
 * Everything sitting in the Finance Manager's own queues. Extracted so the System Administrator
 * Overview counts the identical set - two surfaces quoting a different "waiting" number for the
 * same backlog is how a queue gets argued about instead of worked.
 */
function financeActionTotal(data: FinanceCommandCenterData) {
  return (
    data.directOrders.awaitingCount +
    data.marketing.awaitingMyStep +
    data.marketing.dueUnexecutedCount +
    data.marketing.invoiceOverdueCount +
    data.marketing.missingPaymentProof +
    data.leave.awaitingMyDecision
  );
}

/**
 * Band 1's tiles, shared with the admin overview.
 *
 * `audience` only changes who the queue tile says the work belongs to. On the Finance Manager's
 * own page it is "Awaiting you"; on the Super Admin's it is the Finance Manager's backlog, which
 * he is reading rather than owning - labelling it "Awaiting you" there would put four queues on
 * his desk that are not his.
 */
function MoneyInMotionTiles({
  audience,
  data,
}: {
  audience: "admin" | "finance";
  data: FinanceCommandCenterData;
}) {
  const latest = data.payroll.committed[data.payroll.committed.length - 1] ?? null;
  const actionTotal = financeActionTotal(data);
  return (
    <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
      <MetricTile
        icon={<Wallet aria-hidden="true" className="h-3.5 w-3.5" />}
        label="Net payroll"
        sub={`${n(data.headcount.payrollEligible)} payroll-eligible`}
        value={egp(latest?.net ?? data.headcount.standingNet)}
      />
      <MetricTile
        icon={<ScrollText aria-hidden="true" className="h-3.5 w-3.5" />}
        label={audience === "admin" ? "In the finance queue" : "Awaiting you"}
        sub={
          actionTotal === 0
            ? "Nothing queued"
            : audience === "admin"
              ? "Waiting on the Finance Manager"
              : "Across every module"
        }
        tone={actionTotal > 0 ? "amber" : "emerald"}
        value={n(actionTotal)}
      />
      <MetricTile
        icon={<ReceiptText aria-hidden="true" className="h-3.5 w-3.5" />}
        label="Direct orders unbooked"
        sub={ageLabel(data.directOrders.awaitingOldest, "All booked")}
        tone={unbookedTone(data.directOrders.awaitingCount, data.directOrders.awaitingOldest)}
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
  );
}

/** The Workforce band's stats, shared with the admin overview. Cairo month boundaries, never UTC. */
function WorkforceTiles({ data }: { data: FinanceCommandCenterData }) {
  return (
    <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
      <PipelineStat
        label="Payroll-eligible"
        sub={`${n(data.headcount.activeEmployees)} active on the roster`}
        value={n(data.headcount.payrollEligible)}
      />
      <PipelineStat label="Cost to company" sub="gross, this month" value={egp(data.headcount.standingGross)} />
      <PipelineStat
        label="Resigned this month"
        muted={data.headcount.resignedThisMonth === 0}
        sub="settlements to prepare"
        tone={data.headcount.resignedThisMonth > 0 ? "amber" : "slate"}
        value={n(data.headcount.resignedThisMonth)}
      />
      <PipelineStat
        label="Last working day this month"
        muted={data.headcount.leavingThisMonth === 0}
        sub="final pay lands in this run"
        tone={data.headcount.leavingThisMonth > 0 ? "amber" : "slate"}
        value={n(data.headcount.leavingThisMonth)}
      />
    </div>
  );
}

/**
 * The three Finance bands the System Administrator Overview borrows.
 *
 * Money, the payroll cycle, and the workforce behind both - the part of the Finance Manager's page
 * that answers "is the company's money moving", which is a system-administration question as much
 * as a finance one. His four PERSONAL queues (direct orders, marketing, invoices, leave) stay on
 * his page: they are assigned to him by name, and duplicating them here would make it ambiguous
 * who is expected to clear them.
 *
 * Rendered through the SAME components his page uses, so the two can never drift into quoting
 * different figures for the same month.
 */
export function FinanceAdminBands({ view }: { view: FinanceCommandCenterView }) {
  const { data } = view;
  return (
    <>
      {/* The Super Admin overview used to drop this notice on the floor: `view.unavailable` was
        * destructured away and never rendered, so when the finance RPC failed `emptyData()`'s
        * zeros reached the page as fact — EGP 0 net payroll, EGP 0 direct orders, EGP 0 marketing
        * spend, all presented with no hint that nothing had been read. The Finance Manager's own
        * page has always rendered it (see the bottom of FinanceCommandCenterView). Same notice,
        * same data, so the two seats can never disagree about whether a figure is real. */}
      <UnavailableNotice sources={view.unavailable} />
      <SectionShell
        action={
          <Link
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
            href="/admin/finance-command-center"
          >
            <Landmark aria-hidden="true" className="h-3.5 w-3.5" />
            Finance
          </Link>
        }
        description="The Finance Manager's headline figures, read-only from here."
        title="Money in motion"
      >
        <MoneyInMotionTiles audience="admin" data={data} />
      </SectionShell>

      <SectionShell
        action={
          <Link
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
            href="/admin/automated-payroll/finance"
          >
            <FileSpreadsheet aria-hidden="true" className="h-3.5 w-3.5" />
            Payroll
          </Link>
        }
        description="Run status, the sheets that can be pulled, and who is still held out of the payout."
        title="Payroll cycle"
      >
        <PayrollCycle view={view} />
      </SectionShell>

      <SectionShell description="Who payroll pays this month, and who is leaving it." title="Workforce">
        <WorkforceTiles data={data} />
      </SectionShell>
    </>
  );
}

export function FinanceCommandCenter({
  view,
  welcome,
}: {
  view: FinanceCommandCenterView;
  /** The Finance Manager, for the identity band. See `FinanceWelcomeProfile`. */
  welcome: FinanceWelcomeProfile;
}) {
  const { data } = view;

  const actionTotal = financeActionTotal(data);
  /**
   * An all-clear is a CLAIM, and it may only be made about queues that were actually read.
   *
   * When the aggregates RPC fails, `getFinanceCommandCenterData` substitutes `emptyData()` — every
   * counter zero — and names the source in `view.unavailable`. `actionTotal` is then 0 for the one
   * reason that must never produce "Every queue you own is clear": nothing was counted. The amber
   * notice above says so, but the green panel below it said the opposite, and the green one is the
   * one a tired reader believes.
   */
  const queuesWereRead = view.unavailable.length === 0;

  return (
    <div className="space-y-0 divide-y divide-slate-200">
      {/* THE ORIGINAL IDENTITY BAND, restored 2026-09-06: "I WANT THE SFE AND THE FINANCE AND CEO
          TO HAVE THEIR PREVIOUS IDENTITY BANNER, THE NEW ONE IS ONLY FOR HRs." Byte-for-byte the
          block removed on 2026-09-03.

          `subGreeting={null}` — not undefined — and that is load-bearing. The shared default is
          "Here is where sales and the field stand today", and the Finance Manager holds no `sales`
          grant at all, so the default would promise him a page he cannot open. `??` inside
          CeoHeroIdentity falls straight through an empty string, which is why the removal has to
          be an explicit null.

          SAFE IN THIS COMPONENT, unlike the strip. `FinanceCommandCenter` has exactly one call
          site — app/(admin)/admin/finance-command-center/page.tsx. The Super Admin's overview
          reuses `FinanceAdminBands`, a DIFFERENT export further down this file, which draws no
          identity: /admin carries the thin strip and would otherwise show two. */}
      <AdminHeroFrame className="z-10 overflow-visible">
        <div className="p-5 sm:p-6 lg:p-8">
          <div className="mb-5 inline-flex items-center gap-2 border border-orange-400/40 bg-orange-500/15 px-3 py-1.5 text-phx-3xs font-black uppercase tracking-[0.22em] text-orange-100">
            <Landmark aria-hidden="true" className="h-3.5 w-3.5" />
            Finance Command Center
          </div>
          <CeoHeroIdentity
            flushToEdges
            fullName={welcome.fullName}
            imageUrl={welcome.imageUrl}
            initials={welcome.initials}
            roleLabel={welcome.roleLabel}
            subGreeting={null}
          />
        </div>
      </AdminHeroFrame>

      <PushOptInNudge />

      <UnavailableNotice sources={view.unavailable} />

      {/* ── Band 1 ──
          `header` replaces the default title row entirely (and with it any `action`), which is how
          SfeDepartmentBanner earns its centred banner too. The Sato mark lives inside the banner
          as a result — same bar, same right-hand position as the CEO's. */}
      <SectionShell
        header={<FinanceOwnerBanner />}
        title="Money in motion"
      >
        <MoneyInMotionTiles audience="finance" data={data} />
      </SectionShell>

      {/* ── Band 2: the payroll cycle ── */}
      <SectionShell
        action={
          <Link
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
            href="/admin/automated-payroll/finance"
          >
            <FileSpreadsheet aria-hidden="true" className="h-3.5 w-3.5" />
            Payroll
          </Link>
        }
        description="Run status, the sheets you can pull, and who is still held out of the payout."
        title="Payroll cycle"
      >
        <PayrollCycle view={view} />
      </SectionShell>

      {/* ── Band 3: his queues ── */}
      <SectionShell
        description="Everything below is assigned to you personally — not a company backlog."
        title="Waiting on you"
      >
        {actionTotal === 0 && !queuesWereRead ? (
          <div className="px-5 py-6 text-sm font-medium text-slate-500">
            Your queues could not be read just now, so nothing here is a count. The amber notice
            above names the source that did not answer.
          </div>
        ) : actionTotal === 0 ? (
          <AllClear message="Nothing is waiting on you. Every queue you own is clear." />
        ) : (
          <div>
            {data.directOrders.awaitingCount > 0 ? (
              <QueueRow
                count={data.directOrders.awaitingCount}
                // ?unbooked=1 opens the report already narrowed to exactly these orders. Landing on
                // all 24 rows and asking him to find the three that need him is how the queue on
                // this very card went unworked for seven days.
                href="/admin/direct-orders/report?unbooked=1"
                icon={<ReceiptText aria-hidden="true" className="h-4 w-4" />}
                label="Direct orders awaiting a sales month"
                meta={`You are the only person who can book these · ${ageLabel(data.directOrders.awaitingOldest, "")}`}
                tone={unbookedQueueTone(data.directOrders.awaitingCount, data.directOrders.awaitingOldest)}
                value={egpExact(data.directOrders.awaitingValue)}
              />
            ) : null}
            {data.marketing.awaitingMyStep > 0 ? (
              <QueueRow
                count={data.marketing.awaitingMyStep}
                href="/admin/marketing-requests/finance-ageing"
                icon={<Megaphone aria-hidden="true" className="h-4 w-4" />}
                label="Marketing requests to execute"
                meta="Your Finance Execution step, oldest first with the days waiting"
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
            {/* The invoice is LATE, which is not the same as the invoice being absent: the row below
                counts a missing file whether or not anything was promised by a date. This is the
                figure the nightly nudge (#2695) messages him about, so the two now agree — before
                this, the alert named a number his own dashboard could not show him anywhere.
                A held invoice never reaches here: the pause was somebody's decision. */}
            {data.marketing.invoiceOverdueCount > 0 ? (
              <QueueRow
                count={data.marketing.invoiceOverdueCount}
                href="/workspace/marketing-requests"
                icon={<Megaphone aria-hidden="true" className="h-4 w-4" />}
                label="Marketing invoices past their deadline"
                meta={overdueInvoiceMeta(data.marketing.invoiceOverdueOldest)}
                tone="rose"
                value={egpExact(data.marketing.invoiceOverdueValue)}
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

      {/* ── Payout split ──
          How the month physically leaves the company. FAB and CIB each generate their own bank
          file; Treasury is everyone with no usable bank account, paid in cash — the one bucket
          with no export of its own, which is exactly why it belongs on his page. The three are
          exhaustive and non-overlapping, so they always reconcile to the net beside them. */}
      <SectionShell
        action={
          <Link
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
            href="/admin/automated-payroll/finance"
          >
            <Landmark aria-hidden="true" className="h-3.5 w-3.5" />
            Bank files
          </Link>
        }
        description="Where the money goes, and whether it settles in the first payment or carries to the second."
        title="Payout split"
      >
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <PipelineStat
            label="FAB"
            muted={data.payroll.channels.fabCount === 0}
            sub={`${n(data.payroll.channels.fabCount)} employees · bank file`}
            value={egp(data.payroll.channels.fabNet)}
          />
          <PipelineStat
            label="CIB"
            muted={data.payroll.channels.cibCount === 0}
            sub={`${n(data.payroll.channels.cibCount)} employees · bank file`}
            value={egp(data.payroll.channels.cibNet)}
          />
          <PipelineStat
            label="Treasury"
            muted={data.payroll.channels.treasuryCount === 0}
            sub={`${n(data.payroll.channels.treasuryCount)} employees · paid in cash`}
            tone={data.payroll.channels.treasuryCount > 0 ? "amber" : "slate"}
            value={egp(data.payroll.channels.treasuryNet)}
          />
        </div>
        <div className="grid gap-2 border-t border-slate-100 px-5 pb-5 sm:grid-cols-2">
          <PipelineStat
            label="Settled in the first payment"
            muted={data.payroll.parts.firstOnlyCount === 0}
            sub={`${n(data.payroll.parts.firstOnlyCount)} employees · nothing carries over`}
            value={egp(data.payroll.parts.firstOnlyNet)}
          />
          <PipelineStat
            label="Carries to the second"
            muted={data.payroll.parts.bothPartsCount === 0}
            sub={`${n(data.payroll.parts.bothPartsCount)} employees · split across both parts`}
            value={egp(data.payroll.parts.bothPartsNet)}
          />
        </div>
      </SectionShell>

      {/* ── Workforce ──
          Headcount, and the two leaver figures finance needs before a month can close. Month
          boundaries are Africa/Cairo, never UTC. */}
      <SectionShell
        description="Who payroll pays this month, and who is leaving it."
        title="Workforce"
      >
        <WorkforceTiles data={data} />
      </SectionShell>

      {/* ── Band 4: direct orders, end to end ──
          The booking hop is his alone; the rest is the receivable that hop creates. Every stage
          renders its zero — the collection columns are empty on all 24 orders today, and a stage
          that vanishes when empty teaches the reader it does not exist. */}
      <SectionShell
        action={
          <Link
            className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
            href="/admin/direct-orders/report"
          >
            <ReceiptText aria-hidden="true" className="h-3.5 w-3.5" />
            Direct order report
          </Link>
        }
        description="Approved · booked into a month · into Source of Sales. Only you can book the month."
        title="Direct orders"
      >
        {/* Two changes here, both from the owner on 2026-08-10 ("no collection tracking, remove the
            tiles"). The Collected and Still-outstanding tiles are gone, so the grid is xl:grid-cols-4
            rather than 6, and the description above no longer promises "collected · paid" — the
            pipeline now ends where Phoenix's knowledge ends.

            Those two tiles read paid_amount / remaining_amount, which at the time NOTHING in the
            codebase wrote: there was no screen, route or service that recorded a pharmacy paying, so
            both were permanently EGP 0. That is NOT the empty-stage case PipelineStat documents
            below — that rule keeps a stage visible because tomorrow it fills. These two had no
            tomorrow.

            They have one now: DirectOrderCollectionControl and /api/direct-orders/:id/collection
            were added later the same day, so recordDirectOrderCollection does write all three
            columns. The tiles are still deliberately absent — the owner asked for the recording, not
            the dashboard, and restoring them is his call, not a consequence of the write existing.
            If he does want them back, the RPC already returns collectedCount / paidTotal /
            remainingTotal, so it is a display change only. */}
        <div className="grid gap-2 p-5 sm:grid-cols-2 lg:grid-cols-4">
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
            tone={unbookedTone(data.directOrders.awaitingCount, data.directOrders.awaitingOldest)}
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
            tone={unbookedTone(data.directOrders.awaitingCount, data.directOrders.awaitingOldest)}
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
          <div className="flex flex-wrap items-center gap-2">
            <Link
              className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
              href="/admin/marketing-requests/inbox"
            >
              <Megaphone aria-hidden="true" className="h-3.5 w-3.5" />
              Approval inbox
            </Link>
            {/* UNCONDITIONAL, and that is the point.
                The inbox beside it holds only what is waiting on HIS decision, so a request leaves
                it the moment he executes the finance rung — and the invoice he then has to chase
                lives on the Approved tab of this workspace, which shows him every approved request
                in the company (getMarketingRequestDraftWorkspace widens that one list for his role
                alone). Until now his only route there was the "missing payment proof" queue row
                above, which renders solely while that count is non-zero: the screen disappeared
                exactly when the paperwork was tidy, and the overdue queue row has the same shape.
                NOT a sidebar entry — /workspace/marketing-requests was removed from the admin
                sidebar by an explicit, repeated product decision (d5fd863e4), pinned by
                tests/marketing-review-routing.test.ts. This is a link on his own landing page,
                which that decision leaves untouched and which the page already carried elsewhere. */}
            <Link
              className="inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-3 py-1.5 text-phx-2xs font-bold text-white hover:bg-white/20"
              href="/workspace/marketing-requests"
            >
              <ClipboardList aria-hidden="true" className="h-3.5 w-3.5" />
              Approved requests
            </Link>
          </div>
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
          {/* Deliberately its own tile rather than a refinement of the one above: "missing" asks
              whether the file is here, "overdue" whether a date was broken. A request can be either
              without being the other, and merging them would hide the one that has a promise behind
              it. Left outside the six-tile row on purpose — the grid already wraps at every smaller
              breakpoint, so a seventh tile changes no layout that was signed off. */}
          <PipelineStat
            label="Invoice overdue"
            muted={data.marketing.invoiceOverdueCount === 0}
            sub="past the promised date"
            tone={data.marketing.invoiceOverdueCount > 0 ? "rose" : "slate"}
            value={n(data.marketing.invoiceOverdueCount)}
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

      <div className="flex items-center justify-between gap-4 bg-slate-900 px-5 py-3 text-phx-2xs text-slate-400">
        <span>Every figure is taken from committed payroll and live requests — never from an estimate.</span>
        <span className="shrink-0 tabular-nums">Updated {cairoTimestamp(data.generatedAt)}</span>
      </div>
    </div>
  );
}
