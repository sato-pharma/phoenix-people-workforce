"use client";

import { Fragment, useState, useTransition } from "react";
import { AlarmClock, CheckCircle2, Clock, MessageSquare, RefreshCw, ShieldCheck, UserX } from "lucide-react";

import {
  PortalEmptyState,
  PortalMetricCard,
  PortalSection,
} from "@/components/employee-portal/portal-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableRowDetail, rowDetailToggleProps } from "@/components/ui/table-row-detail";
import type { EmployeeAttendanceData } from "@/lib/attendance/employee-attendance";
import { phxTextareaClassName } from "@/components/ui/form-tokens";

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

function statusBadge(status: string) {
  if (status === "Complete") return <Badge variant="success">Complete</Badge>;
  if (status === "Exception") return <Badge variant="neutral">Exception</Badge>;
  if (status === "Late" || status === "Early leave") return <Badge variant="warning">{status}</Badge>;
  if (status === "Short day") return <Badge variant="warning">Short day</Badge>;
  return <Badge variant="danger">{status}</Badge>;
}

const disputeTextareaClass  = phxTextareaClassName;

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
            <p className="mt-0.5 text-phx-sm font-bold text-orange-700">
              {pendingDisputes} dispute{pendingDisputes !== 1 ? "s" : ""} waiting for HR review
            </p>
          )}
        </div>
        <Button className="min-h-10 gap-1.5" disabled={isPending} onClick={refresh} size="sm" variant="outline">
          <RefreshCw className={`h-3.5 w-3.5 ${isPending ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <PortalMetricCard accent="emerald" icon={CheckCircle2} label="Complete" value={summary.completeDays} />
        <PortalMetricCard accent="amber" icon={AlarmClock} label="Late / early" value={summary.lateOrEarlyDays ?? summary.lateDays} />
        <PortalMetricCard accent="rose" icon={UserX} label="Short / absent" value={summary.absentDays + summary.shortDays} />
        <PortalMetricCard accent="sky" icon={ShieldCheck} label="Exceptions" note="Approved by HR" value={summary.exceptionDays} />
      </div>

      <PortalSection eyebrow="Daily record" title="Punches by day">
        {rows.length === 0 ? (
          <PortalEmptyState
            message="Nothing was recorded for you in the last 30 days."
            title="No attendance records"
          />
        ) : (
          <>
            {/* Phone: one card per day. */}
            <div className="divide-y divide-slate-100 md:hidden">
              {rows.map((row) => {
                const dispute = disputes[row.rawDate];
                const disputeAlreadyPending = pendingDisputes > 0 && !dispute;
                return (
                  <div className="px-4 py-3" key={row.rawDate}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-phx-md font-bold tabular-nums text-slate-900">{row.date}</span>
                      {statusBadge(row.status)}
                    </div>
                    <dl className="mt-2.5 grid grid-cols-3 gap-2">
                      <div className="min-w-0 border border-slate-100 bg-slate-50 px-2.5 py-2">
                        <dt className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">In</dt>
                        <dd className="mt-0.5 text-phx-md font-bold tabular-nums text-slate-800">{row.firstPunch || "—"}</dd>
                      </div>
                      <div className="min-w-0 border border-slate-100 bg-slate-50 px-2.5 py-2">
                        <dt className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">Out</dt>
                        <dd className="mt-0.5 text-phx-md font-bold tabular-nums text-slate-800">{row.lastPunch || "—"}</dd>
                      </div>
                      <div className="min-w-0 border border-slate-100 bg-slate-50 px-2.5 py-2">
                        <dt className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-400">Hours</dt>
                        <dd className="mt-0.5 text-phx-md font-bold tabular-nums text-slate-800">{row.timeLong || "—"}</dd>
                      </div>
                    </dl>
                    {row.deductionConfirmed && (
                      <p className="mt-2 text-phx-sm font-bold text-rose-700">
                        Deduction: {row.deductionDays} day{row.deductionDays !== "1" ? "s" : ""}
                      </p>
                    )}
                    {row.deductionConfirmed && !row.hasException && !dispute && !disputeAlreadyPending && (
                      <Button
                        className="mt-2 min-h-10 w-full gap-1.5"
                        onClick={() => openDispute(row.rawDate, row.date)}
                        size="sm"
                        variant="outline"
                      >
                        <MessageSquare className="h-3.5 w-3.5" />
                        Dispute this day
                      </Button>
                    )}
                    {dispute?.submitted && (
                      <span className="mt-2 flex items-center gap-1 text-phx-sm font-bold text-orange-700">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        Waiting for HR review
                      </span>
                    )}
                    {dispute && !dispute.submitted && (
                      <div className="mt-2">
                        <textarea
                          className={disputeTextareaClass}
                          onChange={(e) => updateDisputeReason(row.rawDate, e.target.value)}
                          placeholder={disputePlaceholder}
                          rows={3}
                          value={dispute.reason}
                        />
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          <Button
                            className="min-h-10 bg-orange-600 text-white hover:bg-orange-700"
                            disabled={dispute.submitting}
                            onClick={() => submitDispute(row.rawDate, hrId)}
                            size="sm"
                          >
                            {dispute.submitting ? "Sending…" : "Send dispute"}
                          </Button>
                          <Button
                            className="min-h-10"
                            onClick={() => cancelDispute(row.rawDate)}
                            size="sm"
                            variant="outline"
                          >
                            Cancel
                          </Button>
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
                <thead>
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
                <tbody className="divide-y divide-slate-100">
                  {rows.map((row) => {
                    const dispute = disputes[row.rawDate];
                    const disputeAlreadyPending = pendingDisputes > 0 && !dispute;
                    return (
                      <Fragment key={row.rawDate}>
                        <tr
                          className="bg-white transition hover:bg-orange-50/30"
                          {...rowDetailToggleProps(`dispute-${row.rawDate}`, Boolean(dispute && !dispute.submitted))}
                        >
                          <td className="px-3 py-2.5 font-bold tabular-nums text-slate-900">{row.date}</td>
                          <td className="px-3 py-2.5 tabular-nums text-slate-700">
                            {row.firstPunch ? (
                              <span className="flex flex-wrap items-center gap-x-1">
                                <Clock className="h-3 w-3 shrink-0 text-slate-400" />
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
                              <Button
                                className="h-8 gap-1"
                                onClick={() => openDispute(row.rawDate, row.date)}
                                size="sm"
                                variant="outline"
                              >
                                <MessageSquare className="h-3 w-3" />
                                Dispute
                              </Button>
                            )}
                            {dispute?.submitted && (
                              <span className="flex items-center gap-1 text-phx-sm font-bold text-orange-700">
                                <ShieldCheck className="h-3 w-3 shrink-0" />
                                Waiting for HR
                              </span>
                            )}
                          </td>
                        </tr>
                        {dispute && !dispute.submitted && (
                          <TableRowDetail className="py-3" colSpan={colSpanTotal} id={`dispute-${row.rawDate}`}>
                              <div className="flex flex-col gap-2 lg:flex-row lg:items-start">
                                <textarea
                                  className={`${disputeTextareaClass} lg:flex-1`}
                                  onChange={(e) => updateDisputeReason(row.rawDate, e.target.value)}
                                  placeholder={disputePlaceholder}
                                  rows={2}
                                  value={dispute.reason}
                                />
                                <div className="flex gap-2 lg:flex-col">
                                  <Button
                                    className="flex-1 bg-orange-600 text-white hover:bg-orange-700"
                                    disabled={dispute.submitting}
                                    onClick={() => submitDispute(row.rawDate, hrId)}
                                    size="sm"
                                  >
                                    {dispute.submitting ? "Sending…" : "Send dispute"}
                                  </Button>
                                  <Button
                                    className="flex-1"
                                    onClick={() => cancelDispute(row.rawDate)}
                                    size="sm"
                                    variant="outline"
                                  >
                                    Cancel
                                  </Button>
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
      </PortalSection>
    </div>
  );
}
