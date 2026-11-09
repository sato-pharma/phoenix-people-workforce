"use client";

import { ChevronRight, Eye, Undo2 } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import {
  CrmButton,
  CrmCard,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmFacts,
  CrmPill,
  CrmTable,
  crmTdClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { isAdjustedAmount } from "@/lib/outstation/approval-state";
import type { ExpenseApprovalEmployeeSummary, totalExpenseApprovalSummary } from "@/lib/outstation/expense-approval-summary";
import { displayPlace } from "@/lib/outstation/place-label";
import { tripSpan } from "@/lib/outstation/trip-span";
import { cn } from "@/lib/utils";

import { DistanceChip, egp } from "./review-parts";

type SummaryTrip = ExpenseApprovalEmployeeSummary["trips"][number];

const STATE_PILL: Record<SummaryTrip["state"], { label: string; tone: "bad" | "good" | "orange" }> = {
  approved: { label: "Approved", tone: "good" },
  pending: { label: "Waiting", tone: "orange" },
  rejected: { label: "Rejected", tone: "bad" },
};

const STATE_ACCENT: Record<SummaryTrip["state"], string> = {
  approved: "border-l-emerald-500",
  pending: "border-l-orange-400",
  rejected: "border-l-rose-500",
};

/**
 * By employee — every person with a trip in the filtered queue, in the Phoenix CRM list identity: a
 * fixed table on a desktop, cards on a phone. A row opens that person's trips in place, right under
 * the figure they explain; each trip opens in the one-by-one reviewer, which then walks that person's
 * trips only. Built from the CURRENT decisions, so a trip approved a moment ago counts here already.
 */
export function EmployeeRollUp({
  canDecide,
  expanded,
  narrowed,
  onOpenTrips,
  onToggle,
  onUndo,
  summaries,
  totals,
}: {
  canDecide: boolean;
  expanded: Set<string>;
  narrowed: boolean;
  /** Opens the reviewer on these trips, at the given one. */
  onOpenTrips: (tripIds: string[], tripId: string) => void;
  onToggle: (employeeKey: string) => void;
  onUndo: (tripId: string) => void;
  summaries: ExpenseApprovalEmployeeSummary[];
  totals: ReturnType<typeof totalExpenseApprovalSummary>;
}) {
  return (
    <div aria-labelledby="expense-tab-employees" id="expense-panel-employees" role="tabpanel">
      <AdminTableShell
        description={`${formatNumberValue(totals.employeeCount)} employees · ${egp(totals.claimedTotal)} claimed in all. Open a person to see each trip, its distance and the workload declared on it.`}
        title={`By employee (${formatNumberValue(summaries.length)})`}
      >
        {summaries.length === 0 ? (
          <CrmEmpty
            message={narrowed ? "Clear the filters to see everybody." : "No outstation trips to sum up yet."}
            title={narrowed ? "Nobody matches these filters" : "No trips yet"}
          />
        ) : (
          <>
            <CrmCardsOnPhone>
              {summaries.map((summary) => {
                const open = expanded.has(summary.employeeKey);
                return (
                  <CrmCard
                    accent={summary.pendingCount > 0 ? "border-l-orange-400" : "border-l-slate-300"}
                    key={summary.employeeKey}
                    meta={`${formatNumberValue(summary.totalCount)} trip${summary.totalCount === 1 ? "" : "s"} · ${egp(summary.claimedTotal)} claimed`}
                    title={summary.employeeLabel}
                  >
                    <CrmFacts
                      facts={[
                        { label: "Waiting", value: <span className="tabular-nums">{formatNumberValue(summary.pendingCount)}</span> },
                        { label: "Rejected", value: <span className="tabular-nums">{formatNumberValue(summary.rejectedCount)}</span> },
                        {
                          label: "Approved",
                          value: (
                            <span className="tabular-nums">
                              {formatNumberValue(summary.approvedCount)} · {egp(summary.approvedValue)}
                            </span>
                          ),
                        },
                      ]}
                    />
                    <CrmButton
                      aria-expanded={open}
                      className="mt-2 w-full"
                      onClick={() => onToggle(summary.employeeKey)}
                      size="sm"
                      variant="secondary"
                    >
                      <ChevronRight aria-hidden className={cn("h-4 w-4 transition-transform", open ? "rotate-90" : null)} />
                      {open ? "Hide the trips" : "Show the trips"}
                    </CrmButton>
                    {open ? (
                      <div className="mt-2">
                        <EmployeeTrips canDecide={canDecide} onOpenTrips={onOpenTrips} onUndo={onUndo} trips={summary.trips} />
                      </div>
                    ) : null}
                  </CrmCard>
                );
              })}
            </CrmCardsOnPhone>
            <CrmTable columns={["3rem", null, "11%", "11%", "17%", "11%"]}>
              <thead>
                <tr>
                  <th className={crmThClassName} scope="col">
                    <span className="sr-only">Open</span>
                  </th>
                  <th className={crmThClassName} scope="col">Employee</th>
                  <th className={cn(crmThClassName, "text-right")} scope="col">Waiting</th>
                  <th className={cn(crmThClassName, "text-right")} scope="col">Approved</th>
                  <th className={cn(crmThClassName, "text-right")} scope="col">Approved pay</th>
                  <th className={cn(crmThClassName, "text-right")} scope="col">Rejected</th>
                </tr>
              </thead>
              {summaries.map((summary) => {
                const open = expanded.has(summary.employeeKey);
                const detailId = `employee-trips-${summary.employeeKey.replace(/[^a-z0-9]+/gi, "-")}`;
                return (
                  <tbody key={summary.employeeKey}>
                    <tr className={cn("transition-colors", open ? "bg-orange-50" : "hover:bg-slate-50")}>
                      <td className={crmTdClassName}>
                        <ChevronRight
                          aria-hidden
                          className={cn("mt-0.5 h-4 w-4 transition-transform", open ? "rotate-90 text-orange-600" : "text-slate-400")}
                        />
                      </td>
                      <td className="border-b border-slate-100 p-0 align-top">
                        <button
                          {...rowDetailToggleProps(detailId, open)}
                          className="block w-full px-3 py-2.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-orange-500"
                          onClick={() => onToggle(summary.employeeKey)}
                          type="button"
                        >
                          <span className="block break-words text-sm font-black text-slate-950">{summary.employeeLabel}</span>
                          <span className="block text-xs font-semibold text-slate-500">
                            {formatNumberValue(summary.totalCount)} trip{summary.totalCount === 1 ? "" : "s"} · {egp(summary.claimedTotal)} claimed
                          </span>
                        </button>
                      </td>
                      <td className={cn(crmTdClassName, "text-right font-black tabular-nums text-orange-700")}>{formatNumberValue(summary.pendingCount)}</td>
                      <td className={cn(crmTdClassName, "text-right font-black tabular-nums text-emerald-700")}>{formatNumberValue(summary.approvedCount)}</td>
                      <td className={cn(crmTdClassName, "text-right font-black tabular-nums text-slate-950")}>{egp(summary.approvedValue)}</td>
                      <td className={cn(crmTdClassName, "text-right font-black tabular-nums text-rose-700")}>{formatNumberValue(summary.rejectedCount)}</td>
                    </tr>
                    {open ? (
                      <TableRowDetail colSpan={6} id={detailId}>
                        <EmployeeTrips canDecide={canDecide} onOpenTrips={onOpenTrips} onUndo={onUndo} trips={summary.trips} />
                      </TableRowDetail>
                    ) : null}
                  </tbody>
                );
              })}
            </CrmTable>
          </>
        )}
      </AdminTableShell>
    </div>
  );
}

/** A trip's dates, with its length when it ran over more than one day. */
function TripDates({ row }: { row: SummaryTrip }) {
  const span = tripSpan(row.date, row.toDate);
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="whitespace-nowrap">
        {formatDateValue(row.date, null, { year: undefined })}
        {span.multiDay ? ` → ${formatDateValue(row.toDate, null, { year: undefined })}` : ""}
      </span>
      {span.multiDay ? <CrmPill tone="orange">{formatNumberValue(span.days)} days</CrmPill> : null}
    </span>
  );
}

/** "AM 3 · PM 9", pharmacies on their own line — what the sheet declared, not CRM evidence. */
function Declared({ row }: { row: SummaryTrip }) {
  return (
    <>
      AM {formatNumberValue(row.amWorkload)} · PM {formatNumberValue(row.pmWorkload)}
      {row.pharmacyWorkload === null || row.pharmacyWorkload === undefined ? null : (
        <span className="block">Pharmacies {formatNumberValue(row.pharmacyWorkload)}</span>
      )}
    </>
  );
}

/** "Unapprove" / "Undo rejection" straight from the roll-up — on screen only, Save still commits. */
function UndoButton({ canDecide, onUndo, row }: { canDecide: boolean; onUndo: (tripId: string) => void; row: SummaryTrip }) {
  if (!canDecide || row.state === "pending") return null;
  return (
    <CrmButton onClick={() => onUndo(row.tripId)} size="sm" variant="secondary">
      <Undo2 aria-hidden className="h-3.5 w-3.5" />
      {row.state === "approved" ? "Unapprove" : "Undo rejection"}
    </CrmButton>
  );
}

/**
 * One person's trips. Desktop: a fitted table whose columns MERGE (the dates with the trip, the pay
 * with the claim it came from, the decision with its controls) so it fits the page. Phone: cards.
 */
function EmployeeTrips({
  canDecide,
  onOpenTrips,
  onUndo,
  trips,
}: {
  canDecide: boolean;
  onOpenTrips: (tripIds: string[], tripId: string) => void;
  onUndo: (tripId: string) => void;
  trips: SummaryTrip[];
}) {
  const ids = trips.map((row) => row.tripId);
  return (
    <div className="min-w-0" data-employee-trips>
      <p className="mb-2 text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">Trips · distance and declared workload</p>
      <div className="space-y-2 md:hidden">
        {trips.map((row) => (
          <article className={cn("min-w-0 border border-slate-200 border-l-[3px] bg-white px-3 py-2.5 text-xs", STATE_ACCENT[row.state])} key={row.tripId}>
            <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
              <span className="min-w-0 text-slate-600">
                <TripDates row={row} />
                <span className="block text-phx-sm font-bold text-slate-400">{row.tripId}</span>
              </span>
              <span className="text-right tabular-nums">
                <span className="block font-black text-slate-950">{egp(row.approvedAmount)}</span>
                {isAdjustedAmount(row.approvedAmount, row.claimedTotal) ? (
                  <span className="block text-phx-sm text-slate-400">of {egp(row.claimedTotal)}</span>
                ) : null}
              </span>
            </div>
            <p className="mt-1 break-words text-slate-800" dir="auto" title={row.destination || undefined}>
              {displayPlace(row.destination)}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">
              <DistanceChip km={row.km} />
              <span className="text-slate-700">
                <Declared row={row} />
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <CrmPill tone={STATE_PILL[row.state].tone}>{STATE_PILL[row.state].label}</CrmPill>
              <UndoButton canDecide={canDecide} onUndo={onUndo} row={row} />
              <CrmButton onClick={() => onOpenTrips(ids, row.tripId)} size="sm" variant="secondary">
                <Eye aria-hidden className="h-3.5 w-3.5" /> Review
              </CrmButton>
            </div>
          </article>
        ))}
      </div>
      <CrmTable className="border border-slate-200 bg-white" columns={["24%", null, "11%", "14%", "14%", "20%"]}>
        <thead>
          <tr>
            <th className={crmThClassName} scope="col">Trip</th>
            <th className={crmThClassName} scope="col">Destination</th>
            <th className={cn(crmThClassName, "text-right")} scope="col">Distance</th>
            <th className={cn(crmThClassName, "text-right")} scope="col">Declared</th>
            <th className={cn(crmThClassName, "text-right")} scope="col">Payable</th>
            <th className={crmThClassName} scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          {trips.map((row) => (
            <tr key={row.tripId}>
              <td className={cn(crmTdClassName, "border-l-[3px] text-xs", STATE_ACCENT[row.state])}>
                <TripDates row={row} />
                <span className="block text-phx-sm font-bold text-slate-400">{row.tripId}</span>
              </td>
              <td className={cn(crmTdClassName, "text-xs")} dir="auto" title={row.destination || undefined}>
                {displayPlace(row.destination)}
              </td>
              <td className={cn(crmTdClassName, "text-right text-xs")}>
                <DistanceChip km={row.km} />
              </td>
              <td className={cn(crmTdClassName, "text-right text-xs tabular-nums")}>
                <Declared row={row} />
              </td>
              <td className={cn(crmTdClassName, "text-right tabular-nums")}>
                <span className="block font-black text-slate-950">{egp(row.approvedAmount)}</span>
                {isAdjustedAmount(row.approvedAmount, row.claimedTotal) ? (
                  <span className="block text-phx-sm text-slate-400">of {egp(row.claimedTotal)}</span>
                ) : null}
              </td>
              <td className={crmTdClassName}>
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <CrmPill tone={STATE_PILL[row.state].tone}>{STATE_PILL[row.state].label}</CrmPill>
                  <UndoButton canDecide={canDecide} onUndo={onUndo} row={row} />
                  <CrmButton onClick={() => onOpenTrips(ids, row.tripId)} size="sm" variant="ghost">
                    <Eye aria-hidden className="h-3.5 w-3.5" /> Review
                  </CrmButton>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </div>
  );
}
