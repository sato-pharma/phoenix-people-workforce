"use client";

import { useState, useTransition } from "react";
import { CalendarCheck, Clock, MessageSquare, RefreshCw, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { EmployeeAttendanceData } from "@/lib/attendance/employee-attendance";

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

function StatCard({ label, value, sub }: { label: string; sub?: string; value: string | number }) {
  return (
    <div className="rounded border border-border bg-background p-4 text-center">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="mt-1 text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">
            Showing last 30 days &middot; {rows.length} day{rows.length !== 1 ? "s" : ""} recorded
          </p>
          {pendingDisputes > 0 && (
            <p className="mt-1 text-xs text-orange-600 font-medium">
              {pendingDisputes} dispute{pendingDisputes !== 1 ? "s" : ""} pending HR review
            </p>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={refresh} disabled={isPending}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      <Card>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="Complete" value={summary.completeDays} />
          <StatCard label="Late / Early" value={summary.lateDays} />
          <StatCard label="Short / Absent" value={summary.absentDays + summary.shortDays} />
          <StatCard label="Exceptions" value={summary.exceptionDays} sub="approved" />
        </div>
      </Card>

      {rows.length === 0 ? (
        <Card>
          <div className="py-10 text-center text-muted-foreground">
            <CalendarCheck className="mx-auto mb-3 h-8 w-8 opacity-30" />
            <p className="text-sm">No attendance records found for this period.</p>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">In</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Out</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Hours</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">Deduction</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => {
                  const dispute = disputes[row.rawDate];
                  const hasDeduction = parseFloat(row.deductionDays) > 0;
                  const disputeAlreadyPending = pendingDisputes > 0 && !dispute;
                  return (
                    <>
                      <tr key={row.rawDate} className="hover:bg-muted/30">
                        <td className="px-4 py-3 font-mono text-xs">{row.date}</td>
                        <td className="px-4 py-3 text-xs">
                          {row.firstPunch ? (
                            <span className="flex items-center gap-1">
                              <Clock className="h-3 w-3 text-muted-foreground" />
                              {row.firstPunch}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="px-4 py-3 text-xs">{row.lastPunch || "—"}</td>
                        <td className="px-4 py-3 font-mono text-xs">{row.timeLong || "—"}</td>
                        <td className="px-4 py-3">{statusBadge(row.status)}</td>
                        <td className="px-4 py-3 text-xs">
                          {hasDeduction ? (
                            <span className="font-medium text-red-600">-{row.deductionDays} day{row.deductionDays !== "1" ? "s" : ""}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {hasDeduction && !row.hasException && !dispute && !disputeAlreadyPending && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => openDispute(row.rawDate, row.date)}
                            >
                              <MessageSquare className="mr-1 h-3 w-3" />
                              Dispute
                            </Button>
                          )}
                          {dispute?.submitted && (
                            <span className="flex items-center gap-1 text-xs text-orange-600 font-medium">
                              <ShieldCheck className="h-3 w-3" />
                              Pending review
                            </span>
                          )}
                        </td>
                      </tr>
                      {dispute && !dispute.submitted && (
                        <tr key={`${row.rawDate}-dispute`}>
                          <td colSpan={7} className="bg-orange-50/50 px-4 py-3">
                            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
                              <textarea
                                className="flex-1 rounded border border-orange-300 bg-white px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-orange-400"
                                placeholder="Describe why this record should be reconsidered (e.g. official visit, technical issue with device)…"
                                rows={2}
                                value={dispute.reason}
                                onChange={(e) => updateDisputeReason(row.rawDate, e.target.value)}
                              />
                              <div className="flex gap-2 sm:flex-col">
                                <Button
                                  size="sm"
                                  className="flex-1 bg-orange-600 text-white hover:bg-orange-700"
                                  disabled={dispute.submitting}
                                  onClick={() => submitDispute(row.rawDate, hrId)}
                                >
                                  {dispute.submitting ? "Sending…" : "Submit"}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="flex-1"
                                  onClick={() => cancelDispute(row.rawDate)}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                            {dispute.error && <p className="mt-1 text-xs text-red-600">{dispute.error}</p>}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
