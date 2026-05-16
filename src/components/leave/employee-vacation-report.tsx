"use client";

import { useEffect, useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  formatVacationDate,
  formatVacationTimestamp,
  loadEmployeePortalVacationData,
  type LeaveWorkflowStatus,
  type VacationPaymentStatus,
  type VacationRequestRecord,
  type VacationRequestType,
  vacationRequestTypeOptions,
} from "@/lib/leave/requests";
import { getWorkflowStatusLabel, leaveWorkflowStatusOptions } from "@/lib/leave/workflow";

type StatusFilter = LeaveWorkflowStatus | "all";
type TypeFilter = VacationRequestType | "all";
type PaymentFilter = VacationPaymentStatus | "all";

function statusClass(status: LeaveWorkflowStatus) {
  if (status === "approved" || status === "awaiting_payout") return "bg-emerald-50 text-emerald-700";
  if (status === "manager_rejected" || status === "hr_rejected" || status === "cancelled") return "bg-rose-50 text-rose-700";
  if (status === "needs_routing") return "bg-orange-50 text-orange-700";
  return "bg-amber-50 text-amber-700";
}

function paymentClass(status: VacationPaymentStatus) {
  return status === "Paid"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-rose-200 bg-rose-50 text-rose-700";
}

function isWithinDateWindow(request: VacationRequestRecord, fromDate: string, toDate: string) {
  if (!fromDate && !toDate) return true;

  const requestDate = new Date(request.createdAt);
  if (Number.isNaN(requestDate.getTime())) return true;

  const from = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const to = toDate ? new Date(`${toDate}T23:59:59`).getTime() : Number.POSITIVE_INFINITY;
  return requestDate.getTime() >= from && requestDate.getTime() <= to;
}

export function EmployeeVacationReport() {
  const [records, setRecords] = useState<VacationRequestRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [paymentFilter, setPaymentFilter] = useState<PaymentFilter>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  useEffect(() => {
    let active = true;

    const load = async () => {
      const result = await loadEmployeePortalVacationData();
      if (!active) return;
      setRecords(result.requests);
      setError(result.error);
      setIsLoading(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const filteredRecords = useMemo(() => {
    return records.filter((request) => {
      const matchesType = typeFilter === "all" || request.requestType === typeFilter;
      const matchesStatus = statusFilter === "all" || request.workflowStatus === statusFilter;
      const matchesPayment = paymentFilter === "all" || request.paymentStatus === paymentFilter;
      const matchesDate = isWithinDateWindow(request, fromDate, toDate);

      return matchesType && matchesStatus && matchesPayment && matchesDate;
    });
  }, [fromDate, paymentFilter, records, statusFilter, toDate, typeFilter]);

  const summary = useMemo(() => {
    return {
      approved: filteredRecords.filter((request) => request.workflowStatus === "approved" || request.workflowStatus === "awaiting_payout").length,
      pending: filteredRecords.filter((request) => request.workflowStatus === "awaiting_manager" || request.workflowStatus === "awaiting_hr" || request.workflowStatus === "needs_routing").length,
      rejected: filteredRecords.filter((request) => request.status === "Rejected").length,
      total: filteredRecords.length,
    };
  }, [filteredRecords]);

  return (
    <div className="space-y-6">
      <div className="rounded-[28px] border border-sky-100 bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.12),transparent_32%),linear-gradient(135deg,#f8fafc_0%,#ffffff_52%,#eff6ff_100%)] p-6 shadow-[0_18px_45px_rgba(15,23,42,0.06)]">
        <p className="text-[11px] font-black uppercase tracking-[0.22em] text-sky-700">Employee Portal</p>
        <h1 className="mt-2 text-2xl font-black text-slate-900">Vacation Report</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          View only your own vacation requests, payment status, and approval history.
        </p>
      </div>

      {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p> : null}
      {isLoading ? <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">Loading your vacation report...</p> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card className="rounded-[22px] bg-white/95">
          <p className="text-sm font-semibold text-slate-500">Total Requests</p>
          <p className="mt-2 text-2xl font-black text-slate-900">{summary.total}</p>
        </Card>
        <Card className="rounded-[22px] bg-white/95">
          <p className="text-sm font-semibold text-slate-500">Pending</p>
          <p className="mt-2 text-2xl font-black text-amber-700">{summary.pending}</p>
        </Card>
        <Card className="rounded-[22px] bg-white/95">
          <p className="text-sm font-semibold text-slate-500">Approved</p>
          <p className="mt-2 text-2xl font-black text-emerald-700">{summary.approved}</p>
        </Card>
        <Card className="rounded-[22px] bg-white/95">
          <p className="text-sm font-semibold text-slate-500">Rejected</p>
          <p className="mt-2 text-2xl font-black text-rose-700">{summary.rejected}</p>
        </Card>
      </div>

      <Card className="rounded-[24px] border-white/90 bg-white/95 shadow-[0_20px_50px_rgba(15,23,42,0.08)]">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Vacation Type</span>
            <select
              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-300"
              onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
              value={typeFilter}
            >
              <option value="all">All</option>
              {vacationRequestTypeOptions.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Status</span>
            <select
              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-300"
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              value={statusFilter}
            >
              <option value="all">All</option>
              {leaveWorkflowStatusOptions.map((status) => (
                <option key={status} value={status}>
                  {getWorkflowStatusLabel(status)}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-1.5">
            <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Paid / Unpaid</span>
            <select
              className="h-10 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-sky-300"
              onChange={(event) => setPaymentFilter(event.target.value as PaymentFilter)}
              value={paymentFilter}
            >
              <option value="all">All</option>
              <option value="Paid">Paid</option>
              <option value="Unpaid">Unpaid</option>
            </select>
          </label>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-2">
            <label className="space-y-1.5">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Date From</span>
              <Input onChange={(event) => setFromDate(event.target.value)} type="date" value={fromDate} />
            </label>
            <label className="space-y-1.5">
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">Date To</span>
              <Input onChange={(event) => setToDate(event.target.value)} type="date" value={toDate} />
            </label>
          </div>
        </div>
      </Card>

      <Card className="rounded-[24px] border-white/90 bg-white/95 shadow-[0_20px_50px_rgba(15,23,42,0.08)]">
        {filteredRecords.length === 0 ? (
          <p className="rounded-2xl bg-slate-50 px-4 py-6 text-sm text-slate-600">
            No vacation requests match the selected filters.
          </p>
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="min-w-[1220px] w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs font-bold uppercase tracking-[0.14em] text-slate-500">
                    <th className="px-3 py-3">Vacation Type</th>
                    <th className="px-3 py-3">Day Type</th>
                    <th className="px-3 py-3">Start Date</th>
                    <th className="px-3 py-3">End Date</th>
                    <th className="px-3 py-3">Duration</th>
                    <th className="px-3 py-3">Paid / Unpaid</th>
                    <th className="px-3 py-3">Available Balance</th>
                    <th className="px-3 py-3">Status</th>
                    <th className="px-3 py-3">Request Date</th>
                    <th className="px-3 py-3">Approval / Rejection Date</th>
                    <th className="px-3 py-3">Rejection Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRecords.map((request) => (
                    <tr className="border-b border-slate-100 align-top last:border-none" key={request.id}>
                      <td className="px-3 py-3 font-semibold text-slate-900">{request.requestType}</td>
                      <td className="px-3 py-3 text-slate-700">{request.dayType}</td>
                      <td className="px-3 py-3 text-slate-700">{formatVacationDate(request.startDate)}</td>
                      <td className="px-3 py-3 text-slate-700">{formatVacationDate(request.endDate)}</td>
                      <td className="px-3 py-3 text-slate-700">{request.totalDays.toFixed(2)} day(s)</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${paymentClass(request.paymentStatus)}`}>
                          {request.paymentStatus}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-slate-700">{request.availableBalanceAtSubmission.toFixed(2)} day(s)</td>
                      <td className="px-3 py-3">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${statusClass(request.workflowStatus)}`}>
                          {getWorkflowStatusLabel(request.workflowStatus)}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-slate-500">{formatVacationTimestamp(request.createdAt)}</td>
                      <td className="px-3 py-3 text-slate-500">
                        {request.approvalStatusDate ? formatVacationTimestamp(request.approvalStatusDate) : "-"}
                      </td>
                      <td className="px-3 py-3 text-slate-700">{request.rejectionReason || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="space-y-4 lg:hidden">
              {filteredRecords.map((request) => (
                <div className="rounded-[22px] border border-slate-200 bg-slate-50/80 p-4" key={request.id}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black text-slate-900">{request.requestType}</p>
                      <p className="mt-1 text-xs font-medium text-slate-500">{request.dayType}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold ${paymentClass(request.paymentStatus)}`}>
                        {request.paymentStatus}
                      </span>
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-bold ${statusClass(request.workflowStatus)}`}>
                        {getWorkflowStatusLabel(request.workflowStatus)}
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-2 text-sm text-slate-700">
                    <p><span className="font-semibold text-slate-500">Start Date:</span> {formatVacationDate(request.startDate)}</p>
                    <p><span className="font-semibold text-slate-500">End Date:</span> {formatVacationDate(request.endDate)}</p>
                    <p><span className="font-semibold text-slate-500">Duration:</span> {request.totalDays.toFixed(2)} day(s)</p>
                    <p><span className="font-semibold text-slate-500">Available Balance:</span> {request.availableBalanceAtSubmission.toFixed(2)} day(s)</p>
                    <p><span className="font-semibold text-slate-500">Request Date:</span> {formatVacationTimestamp(request.createdAt)}</p>
                    <p><span className="font-semibold text-slate-500">Approval / Rejection Date:</span> {request.approvalStatusDate ? formatVacationTimestamp(request.approvalStatusDate) : "-"}</p>
                    <p><span className="font-semibold text-slate-500">Rejection Reason:</span> {request.rejectionReason || "-"}</p>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
