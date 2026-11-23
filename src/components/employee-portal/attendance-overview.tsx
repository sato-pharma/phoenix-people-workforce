"use client";

import { Fragment, useState, useTransition } from "react";
import { Clock, MessageSquare, RefreshCw, ShieldCheck } from "lucide-react";

import { PortalEmptyState } from "@/components/employee-portal/portal-primitives";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LANDING_NAVY_TILE,
  LandingFigure,
  LandingMeta,
  LandingNavyBoard,
  LandingPanel,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import type { EmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { cn } from "@/lib/utils";
import {
  phxButtonAccentClassName,
  phxButtonGhostClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";

type Props = {
  hrId: string;
  initialData: EmployeeAttendanceData;
};

type DisputeState = {
  date: string;
  reason: string;
  submitting: boolean;
  submitted: boolean;
  error: string | null;
};

// The landing kit's status rule: a day's status is a coloured word, never a filled pill.
function statusInk(status: string) {
  if (status === "Complete") return "text-emerald-700";
  if (status === "Exception") return "text-slate-600";
  if (status === "Late" || status === "Early leave" || status === "Short day") return "text-amber-700";
  return "text-rose-700";
}

function statusBadge(status: string) {
  return (
    <span className={`break-words text-phx-xs font-bold uppercase tracking-[0.08em] ${statusInk(status)}`}>{status}</span>
  );
}

/** One figure on the page's navy board: a colour swatch beside the label, the count white and tabular. */
function AttendanceFigure({ label, note, swatch, value }: { label: string; note?: string; swatch: string; value: number }) {
  return (
    <div className={`min-w-0 px-3 py-2.5 ${LANDING_NAVY_TILE}`}>
      <p className="flex items-center gap-1.5">
        <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 ${swatch}`} />
        <span className="min-w-0 break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-white/60">{label}</span>
      </p>
      <div className="mt-1.5">
        <LandingFigure onNavy>{value}</LandingFigure>
      </div>
      {note ? <p className="mt-1 break-words text-phx-xs font-semibold text-white/45">{note}</p> : null}
    </div>
  );
}

const disputeTextareaClass  = phxTextareaClassName;
// The form kit's terminal commit and its ghost, with the landing focus ring and a full-height tap target.
const sendDisputeClass = cn(phxButtonAccentClassName, "min-h-10 justify-center motion-reduce:transition-none", LANDING_FOCUS);
const cancelDisputeClass = cn(phxButtonGhostClassName, "min-h-10 justify-center motion-reduce:transition-none", LANDING_FOCUS);

export function AttendanceOverview({ hrId, initialData }: Props) {
  const [data, setData] = useState<EmployeeAttendanceData>(initialData);
  const [disputes, setDisputes] = useState<Record<string, DisputeState>>({});
  const [isPending, startTransition] = useTransition();

  const { summary, rows, pendingDisputes } = data;

  function refresh() {
    const url = `/api/attendance/employee-attendance?hrId=${encodeURIComponent(hrId)}&dateFrom=${data.dateFrom}&dateTo=${data.dateTo}`;
    startTransition(async () => {
      try {
        const res = await fetch(url);
        if (res.ok) setData(await res.json());
      } catch {
        // silent refresh failure
      }
    });
  }

  function openDispute(rawDate: string, date: string) {
    setDisputes((prev) => ({
      ...prev,
      [rawDate]: { date, error: null, reason: "", submitting: false, submitted: false },
    }));
  }

  function updateDisputeReason(rawDate: string, reason: string) {
    setDisputes((prev) => ({
      ...prev,
      [rawDate]: { ...prev[rawDate], reason },
    }));
  }

  function cancelDispute(rawDate: string) {
    setDisputes((prev) => {
      const next = { ...prev };
      delete next[rawDate];
      return next;
    });
  }

  function submitDispute(rawDate: string, employeeHrId: string) {
    const dispute = disputes[rawDate];
    if (!dispute || !dispute.reason.trim()) {
      setDisputes((prev) => ({ ...prev, [rawDate]: { ...prev[rawDate], error: "Please enter a reason." } }));
      return;
    }
    setDisputes((prev) => ({ ...prev, [rawDate]: { ...prev[rawDate], submitting: true, error: null } }));

    fetch("/api/attendance/exceptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        employeeHrId,
        exceptionDate: rawDate,
        reason: dispute.reason,
        status: "pending",
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message ?? "Submission failed.");
        }
        setDisputes((prev) => ({ ...prev, [rawDate]: { ...prev[rawDate], submitting: false, submitted: true } }));
      })
      .catch((err) => {
        setDisputes((prev) => ({
          ...prev,
          [rawDate]: { ...prev[rawDate], submitting: false, error: err instanceof Error ? err.message : "Failed." },
        }));
      });
  }

  const showDeductionCol = rows.some((r) => r.deductionConfirmed);
  const colSpanTotal = showDeductionCol ? 6 : 5;
  const disputePlaceholder =
    "Why should this record be reconsidered? For example an official visit, or a problem with the device.";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-phx-md font-semibold text-slate-600">
            Last 30 days &middot; {rows.length} day{rows.length !== 1 ? "s" : ""} recorded
          </p>
          {pendingDisputes > 0 && (
            <p className="mt-0.5 text-phx-sm font-bold text-sky-700">
              {pendingDisputes} dispute{pendingDisputes !== 1 ? "s" : ""} waiting for HR review
            </p>
          )}
        </div>
        <button className={landingActionClassName("outline")} disabled={isPending} onClick={refresh} type="button">
          <RefreshCw aria-hidden="true" className={`h-3.5 w-3.5 ${isPending ? "animate-spin motion-reduce:animate-none" : ""}`} />
          Refresh
        </button>
      </div>

      <LandingNavyBoard label="Key figures">
        <div className="grid grid-cols-2 gap-px lg:grid-cols-4">
          <AttendanceFigure label="Complete" swatch="bg-emerald-400" value={summary.completeDays} />
          <AttendanceFigure swatch="bg-amber-400" label="Late / early" value={summary.lateOrEarlyDays ?? summary.lateDays} />
          <AttendanceFigure label="Short / absent" swatch="bg-rose-400" value={summary.absentDays + summary.shortDays} />
          <AttendanceFigure label="Exceptions" note="Approved by HR" swatch="bg-sky-400" value={summary.exceptionDays} />
        </div>
      </LandingNavyBoard>

      <LandingPanel right={<LandingMeta items={["Daily record"]} />} title="Punches by day">
        {rows.length === 0 ? (
          <PortalEmptyState
            message="Nothing was recorded for you in the last 30 days."
            title="No attendance records"
          />
        ) : (
          <>
            {/* Phone: one card per day. */}
            <div className="divide-y divide-slate-200 md:hidden">
              {rows.map((row) => {
                const dispute = disputes[row.rawDate];
                const disputeAlreadyPending = pendingDisputes > 0 && !dispute;
                return (
                  <div className="px-3 py-3 sm:px-4" key={row.rawDate}>
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{row.date}</span>
                      {statusBadge(row.status)}
                    </div>
                    <dl className="mt-2.5 grid grid-cols-3 divide-x divide-slate-200 border-y border-slate-200">
                      <div className="min-w-0 px-2 py-1.5">
                        <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">In</dt>
                        <dd className={`mt-0.5 break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{row.firstPunch || "—"}</dd>
                      </div>
                      <div className="min-w-0 px-2 py-1.5">
                        <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">Out</dt>
                        <dd className={`mt-0.5 break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{row.lastPunch || "—"}</dd>
                      </div>
                      <div className="min-w-0 px-2 py-1.5">
                        <dt className="text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">Hours</dt>
                        <dd className={`mt-0.5 break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{row.timeLong || "—"}</dd>
                      </div>
                    </dl>
                    {row.deductionConfirmed && (
                      <p className="mt-2 text-phx-sm font-bold text-rose-700">
                        Deduction: {row.deductionDays} day{row.deductionDays !== "1" ? "s" : ""}
                      </p>
                    )}
                    {row.deductionConfirmed && !row.hasException && !dispute && !disputeAlreadyPending && (
                      <button
                        className={landingActionClassName("outline", "mt-2 w-full")}
                        onClick={() => openDispute(row.rawDate, row.date)}
                        type="button"
                      >
                        <MessageSquare aria-hidden="true" className="h-3.5 w-3.5" />
                        Dispute this day
                      </button>
                    )}
                    {dispute?.submitted && (
                      <span className="mt-2 flex items-center gap-1 text-phx-sm font-bold text-sky-700">
                        <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
                        Waiting for HR review
                      </span>
                    )}
                    {dispute && !dispute.submitted && (
                      <div className="mt-2">
                        <textarea
                          aria-label="Dispute reason"
                          className={disputeTextareaClass}
                          dir="auto"
                          onChange={(e) => updateDisputeReason(row.rawDate, e.target.value)}
                          placeholder={disputePlaceholder}
                          rows={3}
                          value={dispute.reason}
                        />
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <button
                            className={sendDisputeClass}
                            disabled={dispute.submitting}
                            onClick={() => submitDispute(row.rawDate, hrId)}
                            type="button"
                          >
                            {dispute.submitting ? "Sending…" : "Send dispute"}
                          </button>
                          <button
                            className={cancelDisputeClass}
                            onClick={() => cancelDispute(row.rawDate)}
                            type="button"
                          >
                            Cancel
                          </button>
                        </div>
                        {dispute.error && <p className="mt-1 text-phx-sm font-semibold text-rose-700">{dispute.error}</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Tablet and desktop: one table that fits its column at every width — fixed layout
                and a colgroup, no min-width and no sideways scroll (the fits-the-screen rule). */}
            <div className="hidden md:block">
              <table className="w-full table-fixed text-left text-phx-md">
                <colgroup>
                  <col className="w-[22%]" />
                  <col className="w-[18%]" />
                  <col className="w-[13%]" />
                  <col className="w-[17%]" />
                  {showDeductionCol ? <col className="w-[12%]" /> : null}
                  <col className={showDeductionCol ? "w-[18%]" : "w-[30%]"} />
                </colgroup>
                <thead className="border-b border-slate-200 text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
                  <tr>
                    <th className="px-3 py-2.5">Date</th>
                    <th className="px-3 py-2.5">In · Out</th>
                    <th className="px-3 py-2.5">Hours</th>
                    <th className="px-3 py-2.5">Status</th>
                    {showDeductionCol && <th className="px-3 py-2.5">Deduction</th>}
                    <th className="px-3 py-2.5">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {rows.map((row) => {
                    const dispute = disputes[row.rawDate];
                    const disputeAlreadyPending = pendingDisputes > 0 && !dispute;
                    return (
                      <Fragment key={row.rawDate}>
                        <tr
                          className="bg-white transition-colors hover:bg-slate-50 motion-reduce:transition-none"
                          {...rowDetailToggleProps(`dispute-${row.rawDate}`, Boolean(dispute && !dispute.submitted))}
                        >
                          <td className={`px-3 py-2.5 font-bold tabular-nums ${LANDING_INK}`}>{row.date}</td>
                          <td className="px-3 py-2.5 tabular-nums text-slate-700">
                            {row.firstPunch ? (
                              <span className="flex flex-wrap items-center gap-x-1">
                                <Clock aria-hidden="true" className="h-3 w-3 shrink-0 text-slate-400" />
                                {row.firstPunch}
                                <span className="text-slate-400">·</span>
                                {row.lastPunch || "—"}
                              </span>
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-3 py-2.5 tabular-nums text-slate-700">{row.timeLong || "—"}</td>
                          <td className="px-3 py-2.5">{statusBadge(row.status)}</td>
                          {showDeductionCol && (
                            <td className="px-3 py-2.5">
                              {row.deductionConfirmed ? (
                                <span className="font-bold text-rose-700">
                                  {row.deductionDays} day{row.deductionDays !== "1" ? "s" : ""}
                                </span>
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                          )}
                          <td className="px-3 py-2.5">
                            {row.deductionConfirmed && !row.hasException && !dispute && !disputeAlreadyPending && (
                              <button
                                className={landingActionClassName("outline", "gap-1 px-2.5")}
                                onClick={() => openDispute(row.rawDate, row.date)}
                                type="button"
                              >
                                <MessageSquare aria-hidden="true" className="h-3 w-3" />
                                Dispute
                              </button>
                            )}
                            {dispute?.submitted && (
                              <span className="flex items-center gap-1 text-phx-sm font-bold text-sky-700">
                                <ShieldCheck aria-hidden="true" className="h-3 w-3 shrink-0" />
                                Waiting for HR
                              </span>
                            )}
                          </td>
                        </tr>
                        {dispute && !dispute.submitted && (
                          <TableRowDetail className="py-3" colSpan={colSpanTotal} id={`dispute-${row.rawDate}`}>
                              <div className="flex flex-col gap-2 lg:flex-row lg:items-start">
                                <textarea
                                  aria-label="Dispute reason"
                                  className={`${disputeTextareaClass} lg:flex-1`}
                                  dir="auto"
                                  onChange={(e) => updateDisputeReason(row.rawDate, e.target.value)}
                                  placeholder={disputePlaceholder}
                                  rows={2}
                                  value={dispute.reason}
                                />
                                <div className="flex gap-2 lg:flex-col">
                                  <button
                                    className={cn(sendDisputeClass, "flex-1")}
                                    disabled={dispute.submitting}
                                    onClick={() => submitDispute(row.rawDate, hrId)}
                                    type="button"
                                  >
                                    {dispute.submitting ? "Sending…" : "Send dispute"}
                                  </button>
                                  <button
                                    className={cn(cancelDisputeClass, "flex-1")}
                                    onClick={() => cancelDispute(row.rawDate)}
                                    type="button"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                              {dispute.error && <p className="mt-1 text-phx-sm font-semibold text-rose-700">{dispute.error}</p>}
                          </TableRowDetail>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </LandingPanel>
    </div>
  );
}
