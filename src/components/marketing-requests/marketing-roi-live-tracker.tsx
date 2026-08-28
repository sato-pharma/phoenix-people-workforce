"use client";

// ─────────────────────────────────────────────────────────────────────────────
// ROI Tracker (live / Phoenix-submitted) — money in flight, and when you will know.
//
// This is NOT the Archived Marketing Requests view with a different filter. The two surfaces
// answer different questions and are deliberately shaped differently:
//
//   ARCHIVED  a closed set of 217 imported requests. Nothing new ever arrives, there is no
//             approval chain, and no request will ever move. A post-mortem — so it is organised
//             by OUTCOME (delivered / measuring / missed / unmeasurable).
//
//   LIVE      a pipeline. Requests arrive, get approved, get paid, then sit in a measurement
//             window for 3-7 months before anyone can judge them. Money is genuinely in flight,
//             so it is organised by LIFECYCLE STAGE and by TIME.
//
// The organising insight comes from the biggest finding of the ROI audit: the module's alarming
// "67.7% of requests have no attributed sales" was a TIMING artifact, not a data failure — ROI
// windows run into 2027 while validated sales only load through 2026-06. Read as a failure it
// panics people; read as a clock it is simply "too early to tell". So on this surface the clock
// is the spine of the page rather than a footnote on a row.
//
//   ZONE 1  FLIGHT PATH        every EGP sits at exactly one lifecycle stage — awaiting
//                              approval, approved but unpaid, in measurement, or judged. Stages,
//                              not verdicts: this is where money is stuck, not how it performed.
//   ZONE 2  JUDGEMENT CALENDAR anchored to the validated-data frontier, not to today. Shows the
//                              month each committed EGP becomes knowable, so "we cannot know yet"
//                              is a date on a calendar instead of a shrug.
//   ZONE 3  WAITING ON A PERSON the live approval chain — which step holds a request and which
//                              role owns it. Impossible on the archive, which has no chain.
//   ZONE 4  THE REQUESTS       grouped BY the month they become judgeable, so the list inherits
//                              the same spine as the rest of the page.
//
// Every number still originates in getMarketingRoiReport via getMarketingRoiTracker. This module
// adds NO attribution logic, exactly like the archive tracker — see roi-tracker-service.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, ChevronDown, RefreshCcw, Search, SlidersHorizontal, Target } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { ExportXlsxButton } from "@/components/ui/export-xlsx-button";
import type { ExportColumn, ExportRow } from "@/lib/export/table-workbook";
import { ROI_DATA_COVERAGE_LABEL, ROI_RESULT_STATUS_LABEL } from "@/lib/marketing-requests/roi-labels";
import { roiConfidenceOf } from "@/lib/marketing-requests/roi-confidence";
import type { RoiConfidenceBand } from "@/lib/marketing-requests/roi-confidence";
import type { RoiLifecycleStage } from "@/lib/marketing-requests/roi-live-stages";
import { roiJudgementMonth, roiLifecycleStage } from "@/lib/marketing-requests/roi-live-stages";
import type { RoiFilterState } from "@/lib/marketing-requests/roi-report-types";
import { emptyRoiFilterState } from "@/lib/marketing-requests/roi-report-types";
import type { RoiTrackerReport, RoiTrackerRow } from "@/lib/marketing-requests/roi-tracker-service";
import { cn } from "@/lib/utils";

const money = (value: number) => `EGP ${Math.round(value).toLocaleString("en-US")}`;
const compact = (value: number) =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(Math.round(value));
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const units = (value: number) => Math.round(value).toLocaleString("en-US");

// ── Lifecycle ────────────────────────────────────────────────────────────────
// The rules themselves live in src/lib/marketing-requests/roi-live-stages.ts (domain-first, and
// unit-tested there); this file only decides how to draw them.
type Stage = RoiLifecycleStage;
const stageOf = roiLifecycleStage;
const judgementMonth = roiJudgementMonth;

const STAGE_ORDER: Stage[] = ["awaiting_approval", "approved_unpaid", "measuring", "judged", "rejected"];

const STAGE_META: Record<Stage, { label: string; bar: string; chip: string; help: string }> = {
  approved_unpaid: {
    bar: "bg-sky-400",
    chip: "border-sky-200 bg-sky-50 text-sky-700",
    help: "Approved — the ROI clock has not started",
    label: "Not yet paid",
  },
  awaiting_approval: {
    bar: "bg-amber-400",
    chip: "border-amber-200 bg-amber-50 text-amber-800",
    help: "Still needs a decision from someone",
    label: "Awaiting approval",
  },
  judged: {
    bar: "bg-emerald-500",
    chip: "border-emerald-200 bg-emerald-50 text-emerald-700",
    help: "Window fully covered by validated sales — the number is final",
    label: "Judged",
  },
  measuring: {
    bar: "bg-orange-400",
    chip: "border-orange-200 bg-orange-50 text-orange-700",
    help: "Paid, inside its window — too early to judge",
    label: "In measurement",
  },
  rejected: {
    bar: "bg-slate-300",
    chip: "border-slate-200 bg-slate-100 text-slate-600",
    help: "Turned down — never counted as committed money",
    label: "Rejected",
  },
};

const VERDICT_STYLE: Record<string, string> = {
  awaiting_data: "border-slate-200 bg-slate-50 text-slate-600",
  behind: "border-rose-200 bg-rose-50 text-rose-700",
  no_data: "border-slate-200 bg-slate-50 text-slate-600",
  on_track: "border-emerald-200 bg-emerald-50 text-emerald-700",
};

const REQUEST_STATUS_LABEL: Record<string, string> = {
  active: "Active",
  approved: "Approved",
  archived: "Archived",
  closed: "Closed",
  draft: "Draft",
  finance_hold: "On finance hold",
  pending_approval: "Waiting for approval",
  pending_validation: "Waiting for validation",
  rejected: "Rejected",
  returned: "Sent back",
  roi_tracking: "In ROI tracking",
};
const readableRequestStatus = (status: string) => REQUEST_STATUS_LABEL[status] ?? "Unknown";

const STEP_STATUS_LABEL: Record<string, string> = {
  approved: "Approved",
  current: "Waiting on this step",
  pending: "Not reached yet",
  rejected: "Rejected",
  returned: "Sent back",
  skipped: "Skipped",
};
const readableStepStatus = (status: string) => STEP_STATUS_LABEL[status] ?? "Unknown";

function monthLabel(period: string): string {
  const [year, month] = period.split("-");
  const index = Number(month) - 1;
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return names[index] ? `${names[index]} ${year}` : period;
}

function Badge({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center rounded-sm border px-2 py-0.5 text-phx-2xs font-black uppercase tracking-wide", className)}>
      {children}
    </span>
  );
}

// ── Filters ──────────────────────────────────────────────────────────────────
/**
 * Filter dimensions for the LIVE surface. Deliberately not the archive's list: the two leading
 * entries only exist because this is a pipeline rather than a post-mortem —
 *
 *   "Judgeable from"  the clock. Lets a reader ask "show me only what I can actually judge today",
 *                     or "what lands in Q1", which is the question the whole page is built around.
 *   "Waiting on"      the live approval chain. Answers "what is MY queue" by role — impossible on
 *                     the archive, whose imported requests carry no chain at all.
 *
 * Lifecycle stage is deliberately absent: zone 1 already filters by stage on click, and offering
 * the same control twice invites the two to disagree.
 *
 * Values are read off the loaded rows, so a dropdown can never offer an option that matches
 * nothing, and a new value appearing in the data needs no code change here.
 */
type Facet = { key: string; label: string; values: (row: RoiTrackerRow) => string[] };

const FACETS: Facet[] = [
  { key: "judgeable", label: "Judgeable from", values: (row) => { const m = roiJudgementMonth(row); return m ? [monthLabel(m)] : []; } },
  {
    key: "waitingOn",
    label: "Waiting on",
    values: (row) => {
      const current = row.approvals.find((approval) => approval.status === "current" && !approval.isCc);
      return current ? [current.assignedRole] : [];
    },
  },
  { key: "region", label: "Region", values: (row) => (row.region ? [row.region] : []) },
  { key: "line", label: "Line", values: (row) => (row.line ? [row.line] : []) },
  { key: "requester", label: "Requester", values: (row) => [row.requesterName ?? row.requesterHrId] },
  { key: "customer", label: "Customer", values: (row) => [row.customerName] },
  { key: "type", label: "Request type", values: (row) => (row.requestTypeName ? [row.requestTypeName] : []) },
  { key: "result", label: "Result", values: (row) => [ROI_RESULT_STATUS_LABEL[row.resultStatus]] },
  { key: "status", label: "Request status", values: (row) => [readableRequestStatus(row.status)] },
  { key: "product", label: "Product", values: (row) => row.products.map((product) => product.productName) },
  { key: "distributor", label: "Distributor", values: (row) => row.distributorCodes },
];

type FacetState = Record<string, string[]>;

function matchesFacets(row: RoiTrackerRow, selected: FacetState): boolean {
  return FACETS.every((facet) => {
    const chosen = selected[facet.key];
    if (!chosen || chosen.length === 0) return true;
    const rowValues = facet.values(row);
    return chosen.some((value) => rowValues.includes(value));
  });
}

/** Native <details> disclosure — no outside-click listener, no focus trap, nothing to desync. */
function FacetSelect({
  facet,
  options,
  selected,
  onChange,
}: {
  facet: Facet;
  options: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  if (options.length === 0) return null;

  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((entry) => entry !== value) : [...selected, value]);

  return (
    <details className="relative">
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-semibold transition",
          selected.length > 0
            ? "border-slate-900 bg-slate-900 text-white"
            : "border-slate-200 text-slate-700 hover:border-slate-300",
        )}
      >
        {facet.label}
        {selected.length > 0 ? <span className="tabular-nums">({selected.length})</span> : null}
        <ChevronDown className="h-3 w-3" />
      </summary>
      <div className="absolute left-0 z-30 mt-1 flex max-h-72 w-64 flex-col gap-0.5 overflow-auto rounded-sm border border-slate-200 bg-white p-2 shadow-lg">
        {selected.length > 0 ? (
          <button
            className="mb-1 self-start text-phx-xs font-semibold text-slate-500 underline"
            onClick={() => onChange([])}
            type="button"
          >
            Clear {facet.label.toLowerCase()}
          </button>
        ) : null}
        {options.map((option) => (
          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-xs hover:bg-slate-50" key={option}>
            <input checked={selected.includes(option)} onChange={() => toggle(option)} type="checkbox" />
            <span className="min-w-0 flex-1 text-slate-700">{option}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

// ── ZONE 1 ───────────────────────────────────────────────────────────────────
function FlightPath({
  rows,
  dataFrontier,
  focus,
  onFocus,
}: {
  rows: RoiTrackerRow[];
  dataFrontier: string | null;
  focus: Stage | null;
  onFocus: (next: Stage | null) => void;
}) {
  const totals = useMemo(() => {
    const acc: Record<Stage, { cost: number; count: number }> = {
      approved_unpaid: { cost: 0, count: 0 },
      awaiting_approval: { cost: 0, count: 0 },
      judged: { cost: 0, count: 0 },
      measuring: { cost: 0, count: 0 },
      rejected: { cost: 0, count: 0 },
    };
    for (const row of rows) {
      const stage = stageOf(row, dataFrontier);
      acc[stage].cost += row.estimatedCost;
      acc[stage].count += 1;
    }
    return acc;
  }, [rows, dataFrontier]);

  // Rejected money was never committed, so it is deliberately excluded from the committed
  // total — otherwise the bar would imply the company spent money it turned down.
  const committed = STAGE_ORDER.filter((stage) => stage !== "rejected").reduce((sum, stage) => sum + totals[stage].cost, 0);

  return (
    <section className="flex flex-col gap-3 rounded-sm border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-black uppercase tracking-wide text-slate-500">Where the money is right now</h2>
        <span className="text-xs text-slate-500">
          {money(committed)} committed
          {totals.rejected.count > 0 ? ` · ${money(totals.rejected.cost)} rejected and not counted` : ""}
        </span>
      </div>

      {committed > 0 ? (
        <div className="flex h-7 w-full overflow-hidden rounded-sm bg-slate-100">
          {STAGE_ORDER.filter((stage) => stage !== "rejected").map((stage) => {
            const share = totals[stage].cost / committed;
            if (share <= 0) return null;
            return (
              <button
                aria-label={`${STAGE_META[stage].label}: ${money(totals[stage].cost)}`}
                className={cn(
                  "h-full transition-opacity hover:opacity-80",
                  STAGE_META[stage].bar,
                  focus && focus !== stage ? "opacity-35" : "",
                )}
                key={stage}
                onClick={() => onFocus(focus === stage ? null : stage)}
                style={{ width: `${share * 100}%` }}
                title={`${STAGE_META[stage].label} — ${money(totals[stage].cost)}`}
                type="button"
              />
            );
          })}
        </div>
      ) : (
        <div className="h-7 w-full rounded-sm bg-slate-100" />
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {STAGE_ORDER.map((stage) => (
          <button
            className={cn(
              "flex flex-col items-start gap-0.5 rounded-sm border p-2 text-left transition",
              focus === stage ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200 hover:border-slate-300",
            )}
            key={stage}
            onClick={() => onFocus(focus === stage ? null : stage)}
            type="button"
          >
            <span className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 rounded-sm", STAGE_META[stage].bar)} />
              <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">{STAGE_META[stage].label}</span>
            </span>
            <span className="text-sm font-bold tabular-nums text-slate-900">{money(totals[stage].cost)}</span>
            <span className="text-phx-xs text-slate-500">
              {totals[stage].count} request(s) · {STAGE_META[stage].help}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ── ZONE 2 ───────────────────────────────────────────────────────────────────
/**
 * The judgement calendar, anchored to the VALIDATED-DATA FRONTIER rather than to today.
 *
 * That anchor is the point. "Today" is irrelevant to whether a campaign can be judged — what
 * matters is how far validated Source-of-Sales data has actually loaded. Anchoring here means the
 * page draws a literal line between what is knowable and what is not, and a request sitting past
 * the line is visibly "waiting for data" rather than "failing".
 */
function JudgementCalendar({ rows, dataFrontier }: { rows: RoiTrackerRow[]; dataFrontier: string | null }) {
  const months = useMemo(() => {
    const map = new Map<string, { committed: number; count: number; judged: number; judgedCount: number }>();
    for (const row of rows) {
      if (row.status === "rejected") continue;
      const month = judgementMonth(row);
      if (!month) continue;
      const entry = map.get(month) ?? { committed: 0, count: 0, judged: 0, judgedCount: 0 };
      entry.committed += row.estimatedCost;
      entry.count += 1;
      if (row.dataCoverage === "complete") {
        entry.judged += row.estimatedCost;
        entry.judgedCount += 1;
      }
      map.set(month, entry);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  if (months.length === 0) return null;

  const peak = months.reduce((max, [, entry]) => Math.max(max, entry.committed), 0);
  const notYetKnowable = months
    .filter(([month]) => !dataFrontier || month > dataFrontier)
    .reduce((sum, [, entry]) => sum + entry.committed, 0);

  return (
    <section className="flex flex-col gap-2 rounded-sm border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wide text-slate-500">
          <CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />
          When you will know
        </h2>
        <span className="text-xs text-slate-500">
          {dataFrontier ? `Validated sales load through ${monthLabel(dataFrontier)}` : "No validated sales data loaded yet"}
        </span>
      </div>
      <p className="text-xs text-slate-500">
        Each bar is the month a campaign&apos;s measurement window closes — the first moment its result can honestly
        be called. Anything to the right of the line simply has not happened yet.
      </p>

      <ul className="flex flex-col gap-1.5">
        {months.map(([month, entry]) => {
          const knowable = Boolean(dataFrontier) && month <= (dataFrontier ?? "");
          const share = peak > 0 ? entry.committed / peak : 0;
          return (
            <li className="flex items-center gap-3" key={month}>
              <span className={cn("w-20 shrink-0 text-xs tabular-nums", knowable ? "text-slate-700" : "text-slate-400")}>
                {monthLabel(month)}
              </span>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-500">{compact(entry.committed)}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-sm bg-slate-100">
                <div
                  className={cn("h-full rounded-sm", knowable ? "bg-emerald-500" : "bg-slate-300")}
                  style={{ width: `${Math.max(Math.round(share * 100), 2)}%` }}
                />
              </div>
              <span className="w-24 shrink-0 text-right text-phx-xs text-slate-500">
                {entry.judgedCount > 0 ? `${entry.judgedCount}/${entry.count} judged` : `${entry.count} pending`}
              </span>
            </li>
          );
        })}
      </ul>

      {notYetKnowable > 0 ? (
        <p className="mt-1 text-xs font-semibold text-slate-600">
          {money(notYetKnowable)} cannot be judged yet — its windows close after the validated sales data ends. That is a
          calendar fact, not an underperformance.
        </p>
      ) : null}
    </section>
  );
}

// ── ZONE 3 ───────────────────────────────────────────────────────────────────
/**
 * Who is holding the queue. Reads the live approval chain, which the archived module does not
 * have at all — its imported requests carry no chain, so this zone could not exist there.
 */
function WaitingOnAPerson({ rows, onPick }: { rows: RoiTrackerRow[]; onPick: (requestId: string) => void }) {
  const waiting = useMemo(() => {
    const list: Array<{ row: RoiTrackerRow; stepName: string; assignedRole: string; since: string | null }> = [];
    for (const row of rows) {
      const current = row.approvals.find((approval) => approval.status === "current" && !approval.isCc);
      if (!current) continue;
      // "Since" = the most recent decision already taken on this request. There is no createdAt on
      // the row, so a request with no decisions yet honestly reports nothing rather than a guess.
      const decided = row.approvals
        .map((approval) => approval.decisionAt)
        .filter((value): value is string => Boolean(value))
        .sort();
      list.push({
        assignedRole: current.assignedRole,
        row,
        since: decided.length > 0 ? decided[decided.length - 1].slice(0, 10) : null,
        stepName: current.stepName,
      });
    }
    return list.sort((a, b) => (a.since ?? "9999").localeCompare(b.since ?? "9999"));
  }, [rows]);

  if (waiting.length === 0) return null;

  const held = waiting.reduce((sum, entry) => sum + entry.row.estimatedCost, 0);

  return (
    <section className="flex flex-col gap-2 rounded-sm border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-xs font-black uppercase tracking-wide text-slate-500">Waiting on a person</h2>
        <span className="text-xs text-slate-500">
          {money(held)} across {waiting.length} request(s)
        </span>
      </div>
      <ul className="flex flex-col divide-y divide-slate-100">
        {waiting.slice(0, 8).map((entry) => (
          <li className="flex flex-wrap items-center gap-2 py-1.5" key={entry.row.requestId}>
            <button
              className="text-xs font-semibold text-slate-900 underline decoration-slate-300 underline-offset-2"
              onClick={() => onPick(entry.row.requestId)}
              type="button"
            >
              {entry.row.requestCode}
            </button>
            <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{entry.row.customerName}</span>
            <Badge className="border-amber-200 bg-amber-50 text-amber-800">{entry.stepName}</Badge>
            <span className="text-xs text-slate-500">{entry.assignedRole}</span>
            <span className="w-28 text-right text-xs tabular-nums text-slate-500">
              {entry.since ? `since ${entry.since}` : "not started"}
            </span>
            <span className="w-24 text-right text-xs font-semibold tabular-nums text-slate-700">
              {money(entry.row.estimatedCost)}
            </span>
          </li>
        ))}
      </ul>
      {waiting.length > 8 ? (
        <p className="text-phx-xs text-slate-500">Showing the 8 longest-waiting of {waiting.length}.</p>
      ) : null}
    </section>
  );
}

// ── ZONE 4 detail ────────────────────────────────────────────────────────────
const CONFIDENCE_STYLE: Record<RoiConfidenceBand, string> = {
  high: "border-emerald-200 bg-emerald-50 text-emerald-700",
  low: "border-rose-200 bg-rose-50 text-rose-700",
  medium: "border-amber-200 bg-amber-50 text-amber-800",
};

const STEP_TONE: Record<string, { bar: string; dot: string }> = {
  approved: { bar: "bg-emerald-500", dot: "bg-emerald-500" },
  current: { bar: "bg-amber-400", dot: "bg-amber-500 ring-2 ring-amber-200" },
  pending: { bar: "bg-slate-200", dot: "bg-slate-300" },
  rejected: { bar: "bg-rose-500", dot: "bg-rose-500" },
  returned: { bar: "bg-orange-400", dot: "bg-orange-400" },
  skipped: { bar: "bg-slate-200", dot: "bg-slate-200" },
};

/**
 * The approval tracker: where this request actually sits in its chain, on the card itself rather
 * than hidden behind an expand. One segment per step, coloured by that step's real status, with
 * the live step called out by name — so "who is this waiting on" is answerable at a glance for
 * every request instead of one at a time.
 *
 * CC steps are excluded: they are notifications, not gates, and counting them would misstate how
 * many decisions a request is actually waiting on.
 */
function ApprovalTracker({ row }: { row: RoiTrackerRow }) {
  const steps = row.approvals.filter((approval) => !approval.isCc);
  if (steps.length === 0) {
    return <p className="text-phx-xs text-slate-400">No approval chain on this request.</p>;
  }

  const currentIndex = steps.findIndex((step) => step.status === "current");
  const decidedCount = steps.filter((step) => step.status === "approved").length;
  const current = currentIndex >= 0 ? steps[currentIndex] : null;
  const rejected = steps.find((step) => step.status === "rejected");
  const returned = steps.find((step) => step.status === "returned");

  const caption = rejected
    ? `Rejected at step ${steps.indexOf(rejected) + 1} of ${steps.length} — ${rejected.stepName}`
    : returned
      ? `Sent back at step ${steps.indexOf(returned) + 1} of ${steps.length} — ${returned.stepName}`
      : current
        ? `Step ${currentIndex + 1} of ${steps.length} — waiting on ${current.assignedRole}`
        : decidedCount === steps.length
          ? `Fully approved — all ${steps.length} step(s) signed off`
          : `${decidedCount} of ${steps.length} step(s) approved`;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        {steps.map((step, index) => {
          const tone = STEP_TONE[step.status] ?? STEP_TONE.pending;
          return (
            <div className="flex min-w-0 flex-1 items-center gap-1" key={`${step.sequence}-${step.stepName}`}>
              <span
                aria-hidden="true"
                className={cn("h-1.5 min-w-0 flex-1 rounded-sm", tone.bar)}
                title={`${step.stepName} — ${readableStepStatus(step.status)}`}
              />
              <span className={cn("h-2 w-2 shrink-0 rounded-full", tone.dot)} title={step.assignedRole} />
              {index === steps.length - 1 ? null : null}
            </div>
          );
        })}
      </div>
      <span
        className={cn(
          "text-phx-xs font-semibold",
          rejected ? "text-rose-600" : current ? "text-amber-700" : returned ? "text-orange-700" : "text-emerald-700",
        )}
      >
        {caption}
      </span>
    </div>
  );
}

function RequestCard({
  row,
  dataFrontier,
  open,
  onToggle,
}: {
  row: RoiTrackerRow;
  dataFrontier: string | null;
  open: boolean;
  onToggle: () => void;
}) {
  const stage = stageOf(row, dataFrontier);
  const confidence = roiConfidenceOf(row);
  const forecastUnits = row.products.reduce((sum, product) => sum + product.forecastQty, 0);
  const measured = row.dataCoverage !== "no_validated_data";
  const month = judgementMonth(row);

  return (
    <article className={cn("overflow-hidden rounded-sm border bg-white", open ? "border-slate-900" : "border-slate-200")}>
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-3 py-2">
        <span className="font-semibold text-slate-900">{row.requestCode}</span>
        <Badge className={STAGE_META[stage].chip}>{STAGE_META[stage].label}</Badge>
        <Badge className={VERDICT_STYLE[row.resultStatus] ?? VERDICT_STYLE.no_data}>
          {ROI_RESULT_STATUS_LABEL[row.resultStatus]}
        </Badge>
        {row.suspectPharmacyCount > 0 ? (
          <Badge className="border-rose-200 bg-rose-50 text-rose-700">
            {row.suspectPharmacyCount} unverified pharmacy code(s)
          </Badge>
        ) : null}
        {/*
          Trust in the MEASUREMENT, not the campaign. A genuine failure can score 100 — the number
          is reliable, the result is simply bad. `title` carries the reason so the score is never
          an unexplained verdict.
        */}
        <Badge className={CONFIDENCE_STYLE[confidence.band]}>
          <span title={confidence.weakest ? confidence.weakest.detail : "Every input needed to measure this is present."}>
            {confidence.score}% confidence
          </span>
        </Badge>
        <button
          aria-expanded={open}
          className="ml-auto inline-flex items-center gap-1 rounded-sm border border-slate-200 bg-white px-2 py-1 text-xs font-semibold text-slate-700 transition hover:border-slate-300"
          onClick={onToggle}
          type="button"
        >
          {open ? "Hide approval chain" : "Approval chain"}
          <ChevronDown className={cn("h-3 w-3 transition", open && "rotate-180")} />
        </button>
      </div>

      <div className="grid gap-4 px-3 py-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-800">{row.customerName}</span>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-xs">
            <dt className="text-slate-400">Region</dt>
            <dd className={row.region ? "text-slate-700" : "text-slate-400 italic"}>{row.region ?? "Not recorded yet"}</dd>
            <dt className="text-slate-400">Line</dt>
            <dd className="text-slate-700">{row.line ?? "—"}</dd>
            <dt className="text-slate-400">Requester</dt>
            <dd className="text-slate-700">{row.requesterName ?? row.requesterHrId}</dd>
            <dt className="text-slate-400">Status</dt>
            <dd className="text-slate-700">{readableRequestStatus(row.status)}</dd>
            <dt className="text-slate-400">Paid</dt>
            <dd className="tabular-nums text-slate-700">{row.payDate ?? "Not yet"}</dd>
          </dl>
          <div className="mt-1 border-t border-slate-100 pt-2">
            <ApprovalTracker row={row} />
          </div>
        </div>

        {/* The clock — this surface's signature, in place of the archive's static coverage label. */}
        <div className="flex flex-col gap-1 rounded-sm border border-slate-100 bg-slate-50/50 p-2">
          <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">Judgeable</span>
          <span className="text-lg font-bold text-slate-900">{month ? monthLabel(month) : "—"}</span>
          <span className="text-phx-xs text-slate-500">
            {row.roiWindow ? `Window ${row.roiWindow}` : "No window — not paid yet"}
          </span>
          <span className="text-phx-xs text-slate-500">{ROI_DATA_COVERAGE_LABEL[row.dataCoverage]}</span>
        </div>

        <div className="flex flex-col gap-1 rounded-sm border border-slate-100 bg-slate-50/50 p-2">
          <span className="text-phx-2xs font-black uppercase tracking-wide text-slate-500">Committed vs returned</span>
          <div className="flex items-baseline gap-1.5">
            <span className="text-lg font-bold tabular-nums text-slate-900">
              {measured ? money(row.actualSalesValue) : "—"}
            </span>
            <span className="text-xs text-slate-500">of {money(row.requiredRoiValue)} required</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-sm bg-slate-200">
            {measured ? (
              <div
                className={cn("h-full rounded-sm", row.actualCoverageRatio >= 1 ? "bg-emerald-500" : "bg-orange-400")}
                style={{ width: `${Math.min(Math.round(row.actualCoverageRatio * 100), 100)}%` }}
              />
            ) : null}
          </div>
          <span className="text-phx-xs tabular-nums text-slate-500">
            spent {money(row.estimatedCost)} ·{" "}
            {measured ? `${units(row.actualSalesUnits)} of ${units(forecastUnits)} units` : `${units(forecastUnits)} units forecast`}
          </span>
        </div>
      </div>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-slate-200 bg-slate-50/70 p-4">
          <h4 className="text-xs font-black uppercase tracking-wide text-slate-500">Approval chain</h4>
          {row.approvals.length === 0 ? (
            <p className="text-sm text-slate-500">This request carries no approval chain.</p>
          ) : (
            <ol className="flex flex-col gap-1">
              {row.approvals.map((approval) => (
                <li className="flex flex-wrap items-center gap-2 text-xs" key={`${approval.sequence}-${approval.stepName}`}>
                  <span className="w-6 shrink-0 tabular-nums text-slate-400">{approval.sequence}</span>
                  <span className="font-semibold text-slate-800">{approval.stepName}</span>
                  <span className="text-slate-500">{approval.assignedRole}</span>
                  <Badge
                    className={
                      approval.status === "current"
                        ? "border-amber-200 bg-amber-50 text-amber-800"
                        : approval.status === "approved"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                          : "border-slate-200 bg-slate-100 text-slate-600"
                    }
                  >
                    {readableStepStatus(approval.status)}
                  </Badge>
                  {approval.decisionAt ? (
                    <span className="tabular-nums text-slate-500">{approval.decisionAt.slice(0, 10)}</span>
                  ) : null}
                  {approval.isCc ? <span className="text-slate-400">(cc)</span> : null}
                </li>
              ))}
            </ol>
          )}
        </div>
      ) : null}
    </article>
  );
}

// ── Export ───────────────────────────────────────────────────────────────────
const EXPORT_COLUMNS: ExportColumn[] = [
  { key: "requestCode", label: "Request", width: 14 },
  { key: "stage", label: "Stage", width: 20 },
  { key: "judgeable", label: "Judgeable from", width: 16 },
  { key: "customerName", label: "Customer", width: 30 },
  { key: "region", label: "Region", width: 18 },
  { key: "line", label: "Line", width: 16 },
  { key: "requester", label: "Requester", width: 22 },
  { key: "status", label: "Request status", width: 20 },
  { key: "waitingStep", label: "Waiting on step", width: 22 },
  { key: "waitingRole", label: "Waiting on role", width: 20 },
  { key: "payDate", label: "Pay date", width: 13 },
  { key: "roiWindow", label: "ROI window", width: 22 },
  { key: "estimatedCost", label: "Committed (EGP)", numeric: true, width: 17 },
  { key: "requiredRoiValue", label: "Required return (EGP)", numeric: true, width: 20 },
  { key: "actualSalesValue", label: "Returned (EGP)", numeric: true, width: 16 },
  { key: "coverage", label: "Covered", width: 12 },
  { key: "result", label: "Result", width: 16 },
];

function toExportRow(row: RoiTrackerRow, dataFrontier: string | null): ExportRow {
  const measured = row.dataCoverage !== "no_validated_data";
  const current = row.approvals.find((approval) => approval.status === "current" && !approval.isCc);
  const month = judgementMonth(row);
  return {
    actualSalesValue: measured ? Math.round(row.actualSalesValue) : null,
    coverage: measured ? percent(row.actualCoverageRatio) : "Not measured yet",
    customerName: row.customerName,
    estimatedCost: Math.round(row.estimatedCost),
    judgeable: month ? monthLabel(month) : "",
    line: row.line ?? "",
    payDate: row.payDate ?? "",
    region: row.region ?? "",
    requestCode: row.requestCode,
    requiredRoiValue: Math.round(row.requiredRoiValue),
    requester: row.requesterName ?? row.requesterHrId,
    result: ROI_RESULT_STATUS_LABEL[row.resultStatus],
    roiWindow: row.roiWindow ?? "",
    stage: STAGE_META[stageOf(row, dataFrontier)].label,
    status: readableRequestStatus(row.status),
    waitingRole: current?.assignedRole ?? "",
    waitingStep: current?.stepName ?? "",
  };
}

// ── Page ─────────────────────────────────────────────────────────────────────
export function MarketingRoiLiveTracker() {
  const [report, setReport] = useState<RoiTrackerReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [stageFocus, setStageFocus] = useState<Stage | null>(null);
  const [facets, setFacets] = useState<FacetState>({});

  const fetchReport = useCallback(async (): Promise<RoiTrackerReport> => {
    const filters: RoiFilterState = emptyRoiFilterState();
    let response: Response;
    try {
      response = await fetch("/api/marketing-requests/roi-tracker", {
        body: JSON.stringify({ filters, origin: "phoenix" }),
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    } catch {
      // fetch() rejects only on a TRANSPORT failure — server unreachable, offline, DNS. Its native
      // message is the raw string "Failed to fetch", which is browser jargon, not an explanation.
      // Everything the API itself reports comes back as a normal response with a written message.
      throw new Error("Could not reach Phoenix. Check your connection, then press Refresh.");
    }
    let payload: RoiTrackerReport & { message?: string };
    try {
      payload = (await response.json()) as RoiTrackerReport & { message?: string };
    } catch {
      // A non-JSON body means something upstream returned an error page rather than the API.
      throw new Error("Phoenix returned an unexpected response. Press Refresh, and report this if it repeats.");
    }
    if (!response.ok) throw new Error(payload.message ?? "Could not load the ROI tracker.");
    return payload;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await fetchReport();
        if (!cancelled) setReport(payload);
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Could not load the ROI tracker.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchReport]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchReport());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load the ROI tracker.");
    } finally {
      setLoading(false);
    }
  }, [fetchReport]);

  const allRows = useMemo(() => report?.rows ?? [], [report]);
  const dataFrontier = report?.salesDataAsOf ?? null;

  // Options come from the rows the OTHER active filters already allow, so a choice that would
  // return nothing is never offered. Anything already selected stays listed even if the other
  // filters now exclude it — otherwise a chosen value could vanish from its own dropdown and
  // become impossible to clear.
  const facetOptions = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const facet of FACETS) {
      const others: FacetState = { ...facets, [facet.key]: [] };
      const pool = allRows.filter((row) => matchesFacets(row, others));
      const seen = new Set<string>();
      for (const row of pool) for (const value of facet.values(row)) if (value) seen.add(value);
      for (const value of facets[facet.key] ?? []) seen.add(value);
      result[facet.key] = [...seen].sort((a, b) => a.localeCompare(b));
    }
    return result;
  }, [allRows, facets]);

  const activeFilterCount = useMemo(
    () => FACETS.reduce((sum, facet) => sum + (facets[facet.key]?.length ?? 0), 0),
    [facets],
  );

  const rows = useMemo(() => {
    let list = allRows;
    if (stageFocus) list = list.filter((row) => stageOf(row, dataFrontier) === stageFocus);
    if (activeFilterCount > 0) list = list.filter((row) => matchesFacets(row, facets));
    const term = search.trim().toLowerCase();
    if (term) {
      list = list.filter((row) =>
        [row.requestCode, row.customerName, row.requesterName ?? "", row.requesterHrId, row.line ?? "", row.region ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(term),
      );
    }
    return list;
  }, [allRows, stageFocus, search, dataFrontier, facets, activeFilterCount]);

  // Grouped by the month each request becomes judgeable, so the list carries the same spine as
  // zone 2 instead of being a flat table bolted underneath it.
  const grouped = useMemo(() => {
    const map = new Map<string, RoiTrackerRow[]>();
    for (const row of rows) {
      const key = judgementMonth(row) ?? "unscheduled";
      const list = map.get(key);
      if (list) list.push(row);
      else map.set(key, [row]);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  return (
    <div className="flex flex-col gap-5">
      <AdminPageHero
        actions={
          <Button onClick={() => void refresh()} variant="secondary">
            <RefreshCcw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
        }
        description="Money in flight: what stage each campaign is at, who is holding it, and the month you can finally judge it."
        eyebrow="Marketing"
        icon={<Target className="h-6 w-6" />}
        title="ROI Tracker"
      />

      <div className="flex flex-wrap gap-2">
        {dataFrontier ? (
          <AdminInsightChip tone="slate">Validated sales through {dataFrontier}</AdminInsightChip>
        ) : (
          <AdminInsightChip tone="orange">No validated sales data loaded</AdminInsightChip>
        )}
        {report?.includedRestricted ? <AdminInsightChip tone="orange">Includes confidential products</AdminInsightChip> : null}
      </div>

      {error ? (
        <AdminCallout tone="danger">
          <p className="font-semibold">{error}</p>
        </AdminCallout>
      ) : null}

      {loading ? <p className="text-sm text-slate-500">Loading the ROI tracker…</p> : null}

      {/*
        One line, deliberately — the owner removed the earlier explanatory block. But a page that
        renders nothing at all reads as broken rather than empty (it was reported as exactly that),
        so the surface still has to say why it is blank.
      */}
      {!loading && !error && allRows.length === 0 ? (
        <p className="text-sm text-slate-500">
          No Phoenix-submitted requests yet — imported history is in Archived Marketing Requests.
        </p>
      ) : null}

      {allRows.length > 0 ? (
        <>
          <FlightPath dataFrontier={dataFrontier} focus={stageFocus} onFocus={setStageFocus} rows={allRows} />
          <JudgementCalendar dataFrontier={dataFrontier} rows={allRows} />
          <WaitingOnAPerson onPick={(requestId) => setExpanded(requestId)} rows={allRows} />

          <AdminTableShell
            action={
              <div className="flex flex-wrap items-center gap-2">
                {stageFocus ? (
                  <button
                    className="inline-flex items-center gap-1 rounded-sm border border-slate-900 bg-slate-900 px-2 py-1 text-xs font-semibold text-white"
                    onClick={() => setStageFocus(null)}
                    type="button"
                  >
                    {STAGE_META[stageFocus].label} · clear
                  </button>
                ) : null}
                <label className="relative flex items-center">
                  <Search aria-hidden="true" className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-slate-400" />
                  <input
                    aria-label="Search requests"
                    className="w-full rounded-sm border border-slate-200 py-1 pl-7 pr-2 text-xs lg:w-56"
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="Request, customer, requester…"
                    type="search"
                    value={search}
                  />
                </label>
                <ExportXlsxButton
                  columns={EXPORT_COLUMNS}
                  label="Export XLSX"
                  rows={rows.map((row) => toExportRow(row, dataFrontier))}
                  sheetName="ROI Tracker"
                  subtitle={`${rows.length} of ${allRows.length} request(s) · ${
                    dataFrontier ? `validated sales through ${dataFrontier}` : "no validated sales data loaded"
                  }`}
                  title="Marketing ROI Tracker — live"
                />
              </div>
            }
            description="Grouped by the month each campaign becomes judgeable — the soonest its result can honestly be called."
            title={`Requests (${rows.length}${rows.length !== allRows.length ? ` of ${allRows.length}` : ""})`}
          >
            <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 bg-slate-50/50 px-3 py-2">
              <SlidersHorizontal aria-hidden="true" className="h-3.5 w-3.5 text-slate-400" />
              {FACETS.map((facet) => (
                <FacetSelect
                  facet={facet}
                  key={facet.key}
                  onChange={(next) => setFacets((current) => ({ ...current, [facet.key]: next }))}
                  options={facetOptions[facet.key] ?? []}
                  selected={facets[facet.key] ?? []}
                />
              ))}
              {activeFilterCount > 0 ? (
                <button
                  className="ml-auto text-xs font-semibold text-slate-600 underline"
                  onClick={() => setFacets({})}
                  type="button"
                >
                  Clear {activeFilterCount} filter(s)
                </button>
              ) : null}
            </div>

            {rows.length === 0 ? (
              <p className="p-6 text-sm text-slate-500">Nothing matches this view.</p>
            ) : (
              <div className="flex flex-col gap-4 p-3">
                {grouped.map(([month, groupRows]) => {
                  const knowable = Boolean(dataFrontier) && month !== "unscheduled" && month <= (dataFrontier ?? "");
                  const groupCost = groupRows.reduce((sum, row) => sum + row.estimatedCost, 0);
                  return (
                    <section className="flex flex-col gap-2" key={month}>
                      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-1">
                        <span className="text-xs font-black uppercase tracking-wide text-slate-600">
                          {month === "unscheduled" ? "No measurement window yet" : `Judgeable from ${monthLabel(month)}`}
                        </span>
                        <Badge
                          className={
                            knowable
                              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                              : "border-slate-200 bg-slate-100 text-slate-600"
                          }
                        >
                          {knowable ? "Data has arrived" : "Waiting for data"}
                        </Badge>
                        <span className="ml-auto text-xs tabular-nums text-slate-500">
                          {groupRows.length} request(s) · {money(groupCost)}
                        </span>
                      </div>
                      <div className="flex flex-col gap-3">
                        {groupRows.map((row) => (
                          <RequestCard
                            dataFrontier={dataFrontier}
                            key={row.requestId}
                            onToggle={() => setExpanded(expanded === row.requestId ? null : row.requestId)}
                            open={expanded === row.requestId}
                            row={row}
                          />
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </AdminTableShell>
        </>
      ) : null}
    </div>
  );
}
