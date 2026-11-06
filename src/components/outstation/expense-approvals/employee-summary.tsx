"use client";

import { AlertTriangle, ChevronRight, Undo2 } from "lucide-react";

import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { isAdjustedAmount } from "@/lib/outstation/approval-state";
import type { ExpenseApprovalEmployeeSummary } from "@/lib/outstation/expense-approval-summary";
import type { totalExpenseApprovalSummary } from "@/lib/outstation/expense-approval-summary";
import { tripSpan } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import { DISTANCE_TONE_CLASS, PANEL_CLASS, distanceFlag, egp } from "./shared";

/**
 * Per-employee roll-up. Desktop lays the numbers out in columns; below `sm` the same row stacks
 * into a card, because the admin shell never shows a table on a phone. Pressing a row expands that
 * person's trips in place — the detail is right under the number it explains, instead of sending
 * the reviewer back to the queue with a filter to re-apply.
 *
 * Moved whole from the workspace in the 2026-11-07 rebuild; only the header band lost the four
 * figures the stat line already shows.
 */
export function EmployeeSummaryPanel({
  summaries,
  totals,
  expanded,
  onToggle,
  onUndo,
  narrowed,
}: {
  expanded: Set<string>;
  narrowed: boolean;
  onToggle: (employeeKey: string) => void;
  onUndo: (tripId: string) => void;
  summaries: ExpenseApprovalEmployeeSummary[];
  totals: ReturnType<typeof totalExpenseApprovalSummary>;
}) {
  if (summaries.length === 0) {
    return (
      <p className={cn(PANEL_CLASS, "px-4 py-10 text-center text-sm text-slate-500")}>
        {narrowed ? "No trips match these filters." : "No outstation trips to summarise yet."}
      </p>
    );
  }

  return (
    <div className={PANEL_CLASS}>
      <div className="flex flex-wrap items-center justify-between gap-3 bg-slate-900 px-5 py-3">
        <div className="flex items-center gap-2">
          <span aria-hidden className="h-4 w-1 bg-orange-500" />
          <span className="text-phx-xs font-black uppercase tracking-wide text-white">
            {formatNumberValue(totals.employeeCount)} employees
          </span>
        </div>
        {/* `claimed` spans every trip on screen — the one figure the stat line does not carry. */}
        <span className="whitespace-nowrap text-phx-xs font-bold text-slate-300">{egp(totals.claimedTotal)} claimed</span>
      </div>

      {/* Desktop: one fitted table (AGENTS.md §4 — `w-full table-fixed` + `<colgroup>`, nothing
          scrolls sideways). */}
      <table className="hidden w-full table-fixed md:table">
        <colgroup>
          <col className="w-10" />
          <col />
          <col className="w-24" />
          <col className="w-24" />
          <col className="w-36" />
          <col className="w-24" />
        </colgroup>
        <thead className="border-b border-slate-200 bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
          <tr>
            <th className="px-3 py-2" scope="col">
              <span className="sr-only">Open</span>
            </th>
            <th className="px-3 py-2 text-left" scope="col">Employee</th>
            <th className="px-3 py-2 text-right" scope="col">Pending</th>
            <th className="px-3 py-2 text-right" scope="col">Approved</th>
            <th className="px-3 py-2 text-right" scope="col">Approved pay</th>
            <th className="px-3 py-2 text-right" scope="col">Rejected</th>
          </tr>
        </thead>
        {summaries.map((summary) => {
          const isOpen = expanded.has(summary.employeeKey);
          const detailId = `employee-trips-${summary.employeeKey.replace(/[^a-z0-9]+/gi, "-")}`;
          return (
            <tbody className="border-b border-slate-200 last:border-b-0" key={summary.employeeKey}>
              <tr className={cn("transition-colors", isOpen ? "bg-orange-50" : "hover:bg-slate-50")}>
                <td className="px-3 py-3 align-top">
                  <ChevronRight
                    aria-hidden
                    className={cn("mt-0.5 h-4 w-4 transition-transform", isOpen ? "rotate-90 text-orange-500" : "text-slate-400")}
                  />
                </td>
                <td className="min-w-0 p-0">
                  <button
                    {...rowDetailToggleProps(detailId, isOpen)}
                    className="block w-full px-3 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange-500"
                    onClick={() => onToggle(summary.employeeKey)}
                    type="button"
                  >
                    <span className="block break-words text-sm font-bold text-slate-900">{summary.employeeLabel}</span>
                    <span className="block text-phx-xs text-slate-500">
                      {formatNumberValue(summary.totalCount)} trip{summary.totalCount === 1 ? "" : "s"} ·{" "}
                      {egp(summary.claimedTotal)} claimed
                    </span>
                  </button>
                </td>
                <td className="px-3 py-3 text-right font-mono text-sm font-bold tabular-nums text-amber-600">
                  {formatNumberValue(summary.pendingCount)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-sm font-bold tabular-nums text-emerald-600">
                  {formatNumberValue(summary.approvedCount)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-sm font-bold tabular-nums text-slate-900">
                  {egp(summary.approvedValue)}
                </td>
                <td className="px-3 py-3 text-right font-mono text-sm font-bold tabular-nums text-rose-600">
                  {formatNumberValue(summary.rejectedCount)}
                </td>
              </tr>
              {isOpen ? (
                <TableRowDetail colSpan={6} id={detailId}>
                  <EmployeeTripsTable onUndo={onUndo} trips={summary.trips} />
                </TableRowDetail>
              ) : null}
            </tbody>
          );
        })}
      </table>

      {/* Phone: the same people as cards, each figure carrying its own label. */}
      <div className="divide-y divide-slate-200 md:hidden">
        {summaries.map((summary) => {
          const isOpen = expanded.has(summary.employeeKey);
          return (
            <div key={summary.employeeKey}>
              <button
                aria-expanded={isOpen}
                className={cn(
                  "flex w-full items-start gap-2 px-4 py-3 text-left transition-colors",
                  isOpen ? "bg-orange-50" : "hover:bg-slate-50",
                )}
                onClick={() => onToggle(summary.employeeKey)}
                type="button"
              >
                <ChevronRight
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0 transition-transform",
                    isOpen ? "rotate-90 text-orange-500" : "text-slate-400",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-bold text-slate-900">{summary.employeeLabel}</span>
                  <span className="block text-phx-xs text-slate-500">
                    {formatNumberValue(summary.totalCount)} trip{summary.totalCount === 1 ? "" : "s"} ·{" "}
                    {egp(summary.claimedTotal)} claimed
                  </span>
                  <span className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-xs font-bold">
                    <span className="text-amber-600">
                      <span className="text-phx-2xs font-black uppercase text-slate-400">Pending </span>
                      {formatNumberValue(summary.pendingCount)}
                    </span>
                    <span className="text-rose-600">
                      <span className="text-phx-2xs font-black uppercase text-slate-400">Rejected </span>
                      {formatNumberValue(summary.rejectedCount)}
                    </span>
                    <span className="col-span-2 text-emerald-700">
                      <span className="text-phx-2xs font-black uppercase text-slate-400">Approved </span>
                      {formatNumberValue(summary.approvedCount)} · {egp(summary.approvedValue)}
                    </span>
                  </span>
                </span>
              </button>
              {isOpen ? (
                <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
                  <EmployeeTripsTable onUndo={onUndo} trips={summary.trips} />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const SUMMARY_STATE_TONE: Record<ExpenseApprovalEmployeeSummary["trips"][number]["state"], { spine: string; text: string }> = {
  approved: { spine: "bg-emerald-500", text: "text-emerald-700" },
  pending: { spine: "bg-amber-400", text: "text-amber-700" },
  rejected: { spine: "bg-rose-500", text: "text-rose-700" },
};

/** "Unapprove" / "Undo rejection" straight from the summary — local only, Save still commits. */
function SummaryUndoButton({ onUndo, row }: { onUndo: (tripId: string) => void; row: ExpenseApprovalEmployeeSummary["trips"][number] }) {
  if (row.state === "pending") return null;
  return (
    <button
      className="inline-flex items-center gap-1.5 whitespace-nowrap border border-slate-300 bg-white px-2 py-1 text-phx-xs font-bold text-slate-700 transition-colors hover:border-orange-400 hover:text-orange-700"
      onClick={() => onUndo(row.tripId)}
      type="button"
    >
      <Undo2 className="h-3 w-3" />
      {row.state === "approved" ? "Unapprove" : "Undo rejection"}
    </button>
  );
}

/** One "km" cell, flagged against the outstation distance floor exactly like the trip page. */
function SummaryDistance({ km }: { km: number }) {
  if (!km) return <span className="text-slate-400">—</span>;
  const flag = distanceFlag(km);
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap px-1.5 py-0.5", DISTANCE_TONE_CLASS[flag.tone])}
      title={flag.label || undefined}
    >
      {flag.tone === "fail" ? <AlertTriangle className="h-3 w-3" /> : null}
      {formatNumberValue(km)} km
    </span>
  );
}

/** "AM 3 · PM 9" with the pharmacies on their own line — declared on the sheet, not CRM evidence. */
function SummaryDeclared({ row }: { row: ExpenseApprovalEmployeeSummary["trips"][number] }) {
  return (
    <>
      AM {formatNumberValue(row.amWorkload)} · PM {formatNumberValue(row.pmWorkload)}
      {/* Absent on a pre-split trip, whose pharmacies sit inside AM/PM. */}
      {row.pharmacyWorkload === null || row.pharmacyWorkload === undefined ? null : (
        <span className="block">Pharmacies {formatNumberValue(row.pharmacyWorkload)}</span>
      )}
    </>
  );
}

/** A trip's dates, with its length when it ran over more than one day. */
function SummaryTripDates({ row }: { row: ExpenseApprovalEmployeeSummary["trips"][number] }) {
  const span = tripSpan(row.date, row.toDate);
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="whitespace-nowrap">
        {formatDateValue(row.date, null, { year: undefined })}
        {span.multiDay ? ` → ${formatDateValue(row.toDate, null, { year: undefined })}` : ""}
      </span>
      {span.multiDay ? (
        <span className="whitespace-nowrap border border-orange-300 bg-white px-1 text-phx-2xs font-black uppercase tracking-wide text-orange-700">
          {formatNumberValue(span.days)} days
        </span>
      ) : null}
    </span>
  );
}

/**
 * One person's trips. Desktop: a fitted table whose columns MERGE (dates with the trip ID, the
 * payable with the claim it came from, the decision with its undo) so it fits the page width.
 * Phone: the same trips as cards.
 */
function EmployeeTripsTable({
  onUndo,
  trips,
}: {
  onUndo: (tripId: string) => void;
  trips: ExpenseApprovalEmployeeSummary["trips"];
}) {
  return (
    <>
      <p className="mb-2 text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">
        Trips · distance and declared workload, AM · PM · Pharmacies
      </p>
      <table className="hidden w-full table-fixed border border-slate-200 bg-white text-xs md:table">
        <colgroup>
          <col className="w-1" />
          <col className="w-[22%]" />
          <col />
          <col className="w-[11%]" />
          <col className="w-[15%]" />
          <col className="w-[14%]" />
          <col className="w-[16%]" />
        </colgroup>
        <thead className="border-b border-slate-200 bg-slate-50 text-phx-2xs font-black uppercase tracking-[0.1em] text-slate-500">
          <tr>
            <th aria-hidden className="p-0" />
            <th className="px-3 py-2 text-left" scope="col">Trip</th>
            <th className="px-3 py-2 text-left" scope="col">Destination</th>
            <th className="px-3 py-2 text-right" scope="col">Distance</th>
            <th className="px-3 py-2 text-right" scope="col">Declared</th>
            <th className="px-3 py-2 text-right" scope="col">Payable</th>
            <th className="px-3 py-2 text-right" scope="col">Decision</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {trips.map((row) => {
            const tone = SUMMARY_STATE_TONE[row.state];
            return (
              <tr key={row.tripId}>
                <td aria-hidden className={cn("p-0", tone.spine)} />
                <td className="px-3 py-2 align-top text-slate-600">
                  <SummaryTripDates row={row} />
                  <span className="block font-mono text-phx-2xs text-slate-400">{row.tripId}</span>
                </td>
                <td className="break-words px-3 py-2 align-top text-slate-800" dir="auto">
                  {row.destination || "—"}
                </td>
                <td className="px-3 py-2 text-right align-top font-mono">
                  <SummaryDistance km={row.km} />
                </td>
                <td className="px-3 py-2 text-right align-top font-mono text-slate-700">
                  <SummaryDeclared row={row} />
                </td>
                <td className="px-3 py-2 text-right align-top font-mono">
                  <span className="block font-bold text-slate-900">{egp(row.approvedAmount)}</span>
                  {isAdjustedAmount(row.approvedAmount, row.claimedTotal) ? (
                    <span className="block text-phx-2xs text-slate-400">of {egp(row.claimedTotal)}</span>
                  ) : null}
                </td>
                <td className="px-3 py-2 text-right align-top">
                  <span className={cn("block text-phx-2xs font-black uppercase tracking-wide", tone.text)}>{row.state}</span>
                  <span className="mt-1 block">
                    <SummaryUndoButton onUndo={onUndo} row={row} />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="space-y-2 md:hidden">
        {trips.map((row) => {
          const tone = SUMMARY_STATE_TONE[row.state];
          return (
            <div className="flex items-stretch border border-slate-200 bg-white" key={row.tripId}>
              <span aria-hidden className={cn("w-1 shrink-0", tone.spine)} />
              <div className="min-w-0 flex-1 space-y-1.5 px-3 py-2 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 text-slate-600">
                    <SummaryTripDates row={row} />
                    <span className="block font-mono text-phx-2xs text-slate-400">{row.tripId}</span>
                  </span>
                  <span className="shrink-0 text-right font-mono">
                    <span className="block font-bold text-slate-900">{egp(row.approvedAmount)}</span>
                    {isAdjustedAmount(row.approvedAmount, row.claimedTotal) ? (
                      <span className="block text-phx-2xs text-slate-400">of {egp(row.claimedTotal)}</span>
                    ) : null}
                  </span>
                </div>
                <p className="break-words text-slate-800" dir="auto">{row.destination || "—"}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono">
                  <SummaryDistance km={row.km} />
                  <span className="text-slate-700">
                    <SummaryDeclared row={row} />
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={cn("text-phx-2xs font-black uppercase tracking-wide", tone.text)}>{row.state}</span>
                  <SummaryUndoButton onUndo={onUndo} row={row} />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
