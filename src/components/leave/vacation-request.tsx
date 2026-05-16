"use client";

import { CalendarPlus, Info, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  calculateVacationDuration,
  calculateVacationRequestPreview,
  formatVacationDate,
  formatVacationTimestamp,
  getEmployeeBalanceSummary,
  isHalfDayRangeInvalid,
  loadVacationRequests,
  type VacationDayType,
  type VacationRequestRecord,
  type VacationRequestType,
  vacationDayTypeOptions,
  vacationRequestTypeForSubmission,
} from "@/lib/leave/requests";
import { getWorkflowStatusLabel } from "@/lib/leave/workflow";

type FormState = {
  dayType: VacationDayType;
  employeeEmail: string;
  employeeHireDate: string;
  employeeId: string;
  employeeName: string;
  reason: string;
  requestType: VacationRequestType;
  startDate: string;
  endDate: string;
};

const initialForm: FormState = {
  dayType: "Full Day",
  employeeEmail: "",
  employeeHireDate: "",
  employeeId: "",
  employeeName: "",
  reason: "",
  requestType: "Annual Leave",
  startDate: "",
  endDate: "",
};

function statusClass(status: string) {
  if (status === "Approved") return "bg-emerald-50 text-emerald-700";
  if (status === "Rejected") return "bg-rose-50 text-rose-700";
  return "bg-amber-50 text-amber-700";
}

function statusLabel(status: string) {
  if (status === "Approved") return "Approved";
  if (status === "Rejected") return "Rejected";
  return "Pending";
}

function paymentClass(status: string) {
  if (status === "Paid") return "border-emerald-300 bg-emerald-50 text-emerald-700";
  return "border-rose-300 bg-rose-50 text-rose-700";
}

export function VacationRequestModule() {
  const [records, setRecords] = useState<VacationRequestRecord[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [form, setForm] = useState<FormState>(initialForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [formMessage, setFormMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const result = await loadVacationRequests();
      if (!active) return;
      setRecords(result.requests);
      setLoadError(result.error);
      setIsLoading(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const recentRequests = records.slice(0, 8);

  const preview = useMemo(
    () =>
      calculateVacationRequestPreview({
        currentDateISO: new Date().toISOString().slice(0, 10),
        dayType: form.dayType,
        employeeEmail: form.employeeEmail,
        employeeHireDate: form.employeeHireDate,
        employeeId: form.employeeId,
        employeeName: form.employeeName,
        endDate: form.endDate,
        startDate: form.startDate,
        existingRecords: records,
      }),
    [form.dayType, form.employeeEmail, form.employeeHireDate, form.employeeId, form.employeeName, form.endDate, form.startDate, records],
  );

  const employeeBalance = useMemo(() => {
    const balance = getEmployeeBalanceSummary({
      currentDate: new Date(),
      employee: {
        employeeEmail: form.employeeEmail,
        employeeHireDate: form.employeeHireDate,
        employeeId: form.employeeId,
        employeeName: form.employeeName,
      },
      records,
    });
    return balance;
  }, [form.employeeEmail, form.employeeHireDate, form.employeeId, form.employeeName, records]);

  const submitDisabled =
    !preview.hasRange ||
    isHalfDayRangeInvalid({
      dayType: form.dayType,
      endDate: form.endDate,
      startDate: form.startDate,
    }) ||
    calculateVacationDuration(form.startDate, form.endDate) <= 0 ||
    preview.durationDays <= 0;

  const onFieldChange = (name: keyof FormState, value: string) => {
    setForm((current) => ({ ...current, [name]: value }));
    setFormMessage(null);
    setFormError(null);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormMessage(null);
    setFormError(null);

    if (!form.startDate || !form.endDate) {
      setFormError("Vacation start and end dates are required.");
      return;
    }
    if (preview.isHalfDayInvalid) {
      setFormError("AM/PM only is only valid when start and end date are the same day.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/vacation-requests/workflow", {
        body: JSON.stringify({
          action: "submit",
          request: {
            vacation_type: form.requestType,
            day_type: form.dayType,
            end_date: form.endDate,
            reason: form.reason.trim(),
            start_date: form.startDate,
          },
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        data?: {
          requestSnapshot?: Partial<VacationRequestRecord>;
          directManagerEmail?: {
            error?: string;
            recipients?: string[];
            sent?: boolean;
          };
          inApp?: Array<{ recipient: string; error?: string; sent: boolean }>;
        };
        error?: string;
        success?: boolean;
        warnings?: string[];
      };

      if (!response.ok || !payload.success) {
        setFormError(payload.error || "Workflow submission failed.");
        return;
      }

      const warnings = [
        ...(payload.data?.directManagerEmail?.sent ? ["Direct manager email sent."] : []),
        ...(payload.warnings ?? []),
      ];
      const notificationStatus =
        payload.data?.directManagerEmail?.sent || payload.warnings?.length
          ? `Workflow sent: ${warnings.length > 0 ? warnings.join(" ") : "Direct manager notified."}`
          : "Workflow submitted with no delivery confirmation.";
      const requestSnapshot = payload.data?.requestSnapshot;
      const requestRecord = requestSnapshot ? (requestSnapshot as VacationRequestRecord) : null;
      if (requestRecord) {
        setRecords((current) => [requestRecord, ...current]);
      } else {
        const refreshed = await loadVacationRequests();
        setRecords(refreshed.requests);
      }
      setForm(initialForm);
      setFormMessage(
        requestRecord
          ? `Vacation request submitted as ${requestRecord.paymentStatus}. Stage: ${getWorkflowStatusLabel(requestRecord.workflowStatus)}. ${notificationStatus}`
          : `Vacation request submitted. ${notificationStatus}`,
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to send vacation request for workflow review.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-r from-white to-[#FFF7ED] p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xl font-black text-slate-900">Vacation Request</p>
            <p className="mt-1 text-sm text-slate-600">
              Submit leave requests. Paid or unpaid is calculated automatically from employment rules.
            </p>
          </div>
          <div className="rounded-xl border border-[#F97316]/30 bg-[#FFF7ED] px-4 py-3 text-sm font-semibold text-[#C2410C]">
            Total Requests: {records.length}
          </div>
        </div>
      </div>

      {loadError ? <p className="rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{loadError}</p> : null}
      {isLoading ? <p className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">Loading existing vacation requests...</p> : null}

      <div className="grid gap-6 xl:grid-cols-[1.25fr_1fr]">
        <Card>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <CalendarPlus className="h-5 w-5 text-[#991B1B]" />
              <h2 className="text-base font-black text-slate-900">New Request</h2>
            </div>
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-600">
              <WalletCards className="h-4 w-4" />
              Current Available Balance: {employeeBalance.remainingBalance.toFixed(2)} days
            </div>
          </div>

          <form className="grid gap-4" onSubmit={onSubmit}>
            <label className="space-y-1.5">
              <span className="text-sm font-semibold text-slate-700">Employee Name*</span>
              <Input
                value={form.employeeName}
                onChange={(event) => onFieldChange("employeeName", event.target.value)}
                placeholder="e.g., Omar Mohamed"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-sm font-semibold text-slate-700">Employee ID</span>
                <Input
                  value={form.employeeId}
                  onChange={(event) => onFieldChange("employeeId", event.target.value)}
                  placeholder="Internal employee identifier"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-semibold text-slate-700">Employee Email</span>
                <Input
                  value={form.employeeEmail}
                  onChange={(event) => onFieldChange("employeeEmail", event.target.value)}
                  placeholder="employee@company.com"
                  type="email"
                />
              </label>
            </div>

            <label className="space-y-1.5">
              <span className="text-sm font-semibold text-slate-700">Employee Hiring Date*</span>
              <Input
                value={form.employeeHireDate}
                onChange={(event) => onFieldChange("employeeHireDate", event.target.value)}
                type="date"
              />
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-sm font-semibold text-slate-700">Vacation Type*</span>
                <select
                  className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  onChange={(event) => onFieldChange("requestType", event.target.value as VacationRequestType)}
                  value={form.requestType}
                >
                  {vacationRequestTypeForSubmission.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-semibold text-slate-700">Day Type*</span>
                <select
                  className="h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900"
                  onChange={(event) => onFieldChange("dayType", event.target.value as VacationDayType)}
                  value={form.dayType}
                >
                  {vacationDayTypeOptions.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-1.5">
                <span className="text-sm font-semibold text-slate-700">Vacation Start From*</span>
                <Input
                  value={form.startDate}
                  onChange={(event) => onFieldChange("startDate", event.target.value)}
                  type="date"
                />
              </label>
              <label className="space-y-1.5">
                <span className="text-sm font-semibold text-slate-700">Vacation To*</span>
                <Input
                  value={form.endDate}
                  onChange={(event) => onFieldChange("endDate", event.target.value)}
                  type="date"
                />
              </label>
            </div>

            <label className="space-y-1.5">
              <span className="text-sm font-semibold text-slate-700">Reason</span>
              <textarea
                className="min-h-[96px] w-full resize-y rounded-lg border border-border bg-white px-3 py-2 text-sm text-slate-900"
                onChange={(event) => onFieldChange("reason", event.target.value)}
                placeholder="Optional reason for request"
                value={form.reason}
              />
            </label>

            <div className="grid gap-3 rounded-xl bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Duration</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {preview.hasRange ? `${preview.durationDays} day(s)` : "-"}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Total Days</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {preview.hasRange ? `${preview.totalDays} day(s)` : "-"}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Half-Day Impact</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {preview.hasRange ? `${preview.halfDayImpact} day(s)` : "-"}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Current Annual Entitlement</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {preview.hasRange ? `${preview.currentAnnualEntitlement.toFixed(2)} day(s)` : "-"}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">First-Year Entitlement</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {preview.hasRange ? `${preview.firstYearEntitlement.toFixed(2)} day(s)` : "-"}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Used Paid Leave</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {employeeBalance.usedPaidLeave.toFixed(2)} day(s)
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Unpaid Leave Days</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {employeeBalance.unpaidLeaveDays.toFixed(2)} day(s)
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Remaining Paid Balance</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {employeeBalance.remainingBalance.toFixed(2)} day(s)
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Balance After Submit</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {preview.willBePaid ? `${preview.remainingAfterSubmit.toFixed(2)} day(s)` : `${employeeBalance.remainingBalance.toFixed(2)} day(s)`}
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Pending Leave Impact</p>
                <p className="mt-1 text-sm font-bold text-slate-900">
                  {employeeBalance.pendingLeaveImpact.toFixed(2)} day(s)
                </p>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">System Payment Decision</p>
                <p className={`mt-1 inline-flex rounded-lg border px-3 py-1 text-sm font-bold ${paymentClass(preview.paymentStatus)}`}>
                  {preview.paymentStatus}
                </p>
              </div>
            </div>

            {form.employeeHireDate && employeeBalance.isInProbation ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                This employee is within first 6 months from hiring date. All requests are automatically unpaid.
              </p>
            ) : null}

            {preview.isHalfDayInvalid ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
                AM/PM only is valid only when start and end date are the same day.
              </p>
            ) : null}

            {formError ? (
              <p className="text-sm font-semibold text-rose-700">{formError}</p>
            ) : formMessage ? (
              <p className="text-sm font-semibold text-emerald-700">{formMessage}</p>
            ) : null}

            <div className="rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">
              <p className="flex items-start gap-2 text-xs font-semibold text-slate-500">
                <Info className="mt-0.5 h-4 w-4 text-slate-400" />
                {preview.totalDays > 0
                  ? "Duration, entitlement, balance, and paid/unpaid status are calculated instantly."
                  : "Set employee details and a valid date range to view live calculations."}
              </p>
            </div>

            <div className="flex justify-end">
              <Button disabled={submitDisabled || isSubmitting} type="submit">
                {isSubmitting ? "Submitting..." : "Submit Request"}
              </Button>
            </div>
          </form>
        </Card>

        <Card>
          <h2 className="mb-4 text-base font-black text-slate-900">Latest Requests</h2>
          {recentRequests.length === 0 ? (
            <p className="rounded-md bg-slate-50 px-3 py-4 text-sm text-slate-600">
              No vacation requests yet.
            </p>
          ) : (
            <div className="space-y-3">
              {recentRequests.map((request) => (
                <div className="rounded-lg border border-border bg-white p-3" key={request.id}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-900">{request.employeeName}</p>
                    <span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusClass(request.status)}`}>
                      {getWorkflowStatusLabel(request.workflowStatus)}
                    </span>
                  </div>
                  <p className="text-sm text-slate-700">
                    {`${request.employeeId || "No ID"} · ${request.requestType} · ${request.dayType}`}
                  </p>
                  <p className="text-sm text-slate-700">
                    {`${formatVacationDate(request.startDate)} -> ${formatVacationDate(request.endDate)} (${request.totalDays} day(s))`}
                  </p>
                  <p className="text-xs text-slate-500">
                    {`${request.paymentStatus} · Balance at submit: ${request.availableBalanceAtSubmission.toFixed(2)} day(s)`}
                  </p>
                  <p className="text-xs text-slate-500">
                    {`First-year entitlement: ${request.firstYearEntitlementAtSubmission.toFixed(2)} | Current annual entitlement: ${request.currentAnnualEntitlementAtSubmission.toFixed(2)} | Used paid: ${request.usedPaidLeaveAtSubmission.toFixed(2)} | Remaining: ${request.remainingPaidBalanceAtSubmission.toFixed(2)} | Unpaid: ${request.unpaidLeaveDaysAtSubmission.toFixed(2)} | Pending: ${request.pendingLeaveImpactAtSubmission.toFixed(2)}`}
                  </p>
                  <p className="text-xs text-slate-400">
                    Hiring date: {formatVacationDate(request.employeeHireDate)} · Submitted: {formatVacationTimestamp(request.createdAt)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

