"use client";

import { CalendarClock, CircleAlert, Send, WalletCards } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  calculateVacationRequestPreview,
  formatVacationDate,
  loadEmployeePortalVacationData,
  type EmployeePortalVacationEmployee,
  type VacationBalanceSummary,
  type VacationDayType,
  type VacationPaymentStatus,
  type VacationRequestRecord,
  type VacationRequestType,
  vacationDayTypeOptions,
  vacationRequestTypeForSubmission,
} from "@/lib/leave/requests";
import { getWorkflowStatusLabel } from "@/lib/leave/workflow";

type FormState = {
  dayType: VacationDayType;
  endDate: string;
  reason: string;
  requestType: VacationRequestType;
  startDate: string;
};

const initialForm: FormState = {
  dayType: "Full Day",
  endDate: "",
  reason: "",
  requestType: "Annual Leave",
  startDate: "",
};

function paymentBadgeClass(status: VacationPaymentStatus) {
  return status === "Paid"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
    : "border-rose-200 bg-rose-50 text-rose-700";
}

function profileValue(value: string) {
  return value.trim() || "Not available";
}

export function EmployeeVacationRequest() {
  const [employee, setEmployee] = useState<EmployeePortalVacationEmployee | null>(null);
  const [balance, setBalance] = useState<VacationBalanceSummary | null>(null);
  const [requests, setRequests] = useState<VacationRequestRecord[]>([]);
  const [form, setForm] = useState<FormState>(initialForm);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const result = await loadEmployeePortalVacationData();
      if (!active) return;
      setEmployee(result.employee);
      setBalance(result.balance);
      setRequests(result.requests);
      setError(result.error);
      setIsLoading(false);
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const preview = useMemo(() => {
    if (!employee) {
      return null;
    }

    return calculateVacationRequestPreview({
      currentDateISO: new Date().toISOString().slice(0, 10),
      dayType: form.dayType,
      employeeEmail: employee.email,
      employeeHireDate: employee.hireDate,
      employeeId: employee.hrId,
      employeeName: employee.name,
      endDate: form.endDate,
      existingRecords: requests,
      startDate: form.startDate,
    });
  }, [employee, form.dayType, form.endDate, form.startDate, requests]);

  const submitDisabled =
    !employee ||
    !preview ||
    !form.startDate ||
    !form.endDate ||
    preview.isHalfDayInvalid ||
    preview.totalDays <= 0 ||
    isSubmitting;

  const currentBalance = balance?.remainingBalance ?? preview?.remainingBalance ?? 0;
  const unpaidWarning =
    preview && preview.totalDays > 0 && preview.paymentStatus === "Unpaid"
      ? balance?.isInProbation
        ? "You are still within your first 6 months from hire date, so this request will be unpaid automatically."
        : "This request exceeds your available paid balance or falls outside paid leave eligibility, so it will be unpaid automatically."
      : null;
  const profileLoadMessage =
    error ??
    "Your employee profile could not be resolved from the current session. Please contact HR or sign in again.";
  const isSessionError = (error ?? "").toLowerCase().includes("session");
  const isSessionExpiredMessage = isSessionError;

  const onFieldChange = (field: keyof FormState, value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setError(null);
    setMessage(null);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!preview) {
      setError("Your leave preview is not available.");
      return;
    }

    if (preview.isHalfDayInvalid) {
      setError("AM Only and PM Only requests must use the same start and end date.");
      return;
    }

    if (preview.totalDays <= 0) {
      setError("Choose a valid leave date range.");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch("/api/employee-portals/vacation-requests", {
        body: JSON.stringify({
          action: "submit",
          dayType: form.dayType,
          endDate: form.endDate,
          reason: form.reason,
          requestType: form.requestType,
          startDate: form.startDate,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        balance?: {
          currentAvailable?: number;
        };
        error?: string;
        request?: VacationRequestRecord;
        success?: boolean;
        warnings?: string[];
      };

      if (!response.ok || !payload.success || !payload.request) {
        setError(payload.error ?? "Unable to submit vacation request.");
        return;
      }

      const nextRequests = [payload.request, ...requests];
      setRequests(nextRequests);
      if (employee) {
        setBalance({
          availableBalance: payload.balance?.currentAvailable ?? currentBalance,
          currentAnnualEntitlement: preview.currentAnnualEntitlement,
          firstYearEntitlement: preview.firstYearEntitlement,
          isInProbation: preview.isInProbation,
          pendingLeaveImpact: balance?.pendingLeaveImpact ?? 0,
          remainingBalance: payload.balance?.currentAvailable ?? currentBalance,
          unpaidLeaveDays: balance?.unpaidLeaveDays ?? 0,
          usedPaidLeave: balance?.usedPaidLeave ?? 0,
        });
      }
      setForm(initialForm);
      setMessage(
        payload.warnings && payload.warnings.length > 0
          ? `Request submitted. ${payload.warnings.join(" ")}`
          : `Vacation request submitted successfully. Current stage: ${getWorkflowStatusLabel(payload.request.workflowStatus)}.`,
      );
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to submit vacation request.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-[28px] border border-orange-100 bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.14),transparent_36%),linear-gradient(135deg,#fff7ed_0%,#ffffff_54%,#f8fafc_100%)] p-6 shadow-[0_18px_45px_rgba(15,23,42,0.06)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-black uppercase tracking-[0.22em] text-orange-600">Employee Portal</p>
            <h1 className="mt-2 text-2xl font-black text-slate-900">Vacation Request</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-600">
              Submit your own leave request only. Paid or unpaid status is calculated automatically from your hire date and available balance.
            </p>
          </div>
          <div className="rounded-2xl border border-orange-200 bg-white/90 px-4 py-3 text-right shadow-sm">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-500">Available Balance</p>
            <p className="mt-1 text-2xl font-black text-orange-700">{currentBalance.toFixed(2)}</p>
            <p className="text-xs font-medium text-slate-500">paid days</p>
          </div>
        </div>
      </div>

      {error ? <p className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">{error}</p> : null}
      {message ? <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{message}</p> : null}

      <div className="grid gap-6 xl:grid-cols-[1.3fr_0.9fr]">
        <Card className="rounded-[24px] border-white/90 bg-white/95 shadow-[0_20px_50px_rgba(15,23,42,0.08)]">
          <div className="mb-5 flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-orange-50 text-orange-700">
              <CalendarClock className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-lg font-black text-slate-900">New Request</h2>
              <p className="text-sm text-slate-500">Only your own leave request can be submitted from this portal.</p>
            </div>
          </div>

          {isLoading ? (
            <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-600">Loading your leave profile...</p>
          ) : !employee ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
              <p>{profileLoadMessage}</p>
              {isSessionExpiredMessage ? (
                <div className="mt-3">
                  <Button
                    className="rounded-xl"
                    onClick={() => {
                      window.location.assign("/login?reason=session_expired");
                    }}
                    type="button"
                  >
                    Sign in again
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <form className="space-y-5" onSubmit={onSubmit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="space-y-1.5">
                  <span className="text-sm font-semibold text-slate-700">Vacation Type</span>
                  <select
                    className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-orange-300"
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
                  <span className="text-sm font-semibold text-slate-700">Day Type</span>
                  <select
                    className="h-11 w-full rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-orange-300"
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
                  <span className="text-sm font-semibold text-slate-700">Vacation Start From</span>
                  <Input
                    onChange={(event) => onFieldChange("startDate", event.target.value)}
                    type="date"
                    value={form.startDate}
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-sm font-semibold text-slate-700">Vacation To</span>
                  <Input
                    onChange={(event) => onFieldChange("endDate", event.target.value)}
                    type="date"
                    value={form.endDate}
                  />
                </label>
              </div>

              <label className="space-y-1.5">
                <span className="text-sm font-semibold text-slate-700">Request Details</span>
                <textarea
                  className="min-h-[104px] w-full resize-y rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none transition focus:border-orange-300"
                  onChange={(event) => onFieldChange("reason", event.target.value)}
                  placeholder="Optional note for your manager and HR."
                  value={form.reason}
                />
              </label>

              <div className="grid gap-3 rounded-[20px] border border-slate-200 bg-slate-50/80 p-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl bg-white p-3 shadow-sm">
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Calculated Duration</p>
                  <p className="mt-2 text-lg font-black text-slate-900">{preview ? `${preview.totalDays.toFixed(2)} day(s)` : "-"}</p>
                </div>
                <div className="rounded-2xl bg-white p-3 shadow-sm">
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Current Balance</p>
                  <p className="mt-2 text-lg font-black text-slate-900">{currentBalance.toFixed(2)} day(s)</p>
                </div>
                <div className="rounded-2xl bg-white p-3 shadow-sm">
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Paid / Unpaid</p>
                  <p className={`mt-2 inline-flex rounded-full border px-3 py-1 text-sm font-bold ${paymentBadgeClass(preview?.paymentStatus ?? "Paid")}`}>
                    {preview?.paymentStatus ?? "-"}
                  </p>
                </div>
                <div className="rounded-2xl bg-white p-3 shadow-sm">
                  <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Balance After Request</p>
                  <p className="mt-2 text-lg font-black text-slate-900">
                    {preview ? `${preview.remainingAfterSubmit.toFixed(2)} day(s)` : "-"}
                  </p>
                </div>
              </div>

              {preview?.isHalfDayInvalid ? (
                <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-800">
                  AM Only and PM Only requests must start and end on the same date.
                </div>
              ) : null}

              {unpaidWarning ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700">
                  {unpaidWarning}
                </div>
              ) : null}

              <div className="flex justify-end">
                <Button className="gap-2 rounded-xl px-5 py-2.5" disabled={submitDisabled} type="submit">
                  <Send className="h-4 w-4" />
                  {isSubmitting ? "Submitting..." : "Submit Request"}
                </Button>
              </div>
            </form>
          )}
        </Card>

        <div className="space-y-6">
          <Card className="rounded-[24px] border-white/90 bg-white/95 shadow-[0_20px_50px_rgba(15,23,42,0.08)]">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-700">
                <WalletCards className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-black text-slate-900">Your Profile Context</h2>
                <p className="text-sm text-slate-500">Read-only information used by the leave workflow.</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl bg-slate-50 p-3">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Employee</p>
                <p className="mt-1 text-sm font-bold text-slate-900">{profileValue(employee?.name ?? "")}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">HR ID</p>
                <p className="mt-1 text-sm font-bold text-slate-900">{profileValue(employee?.hrId ?? "")}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Hire Date</p>
                <p className="mt-1 text-sm font-bold text-slate-900">{employee?.hireDate ? formatVacationDate(employee.hireDate) : "Not available"}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Team</p>
                <p className="mt-1 text-sm font-bold text-slate-900">{profileValue(employee?.teamName ?? "")}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Line</p>
                <p className="mt-1 text-sm font-bold text-slate-900">{profileValue(employee?.lineName ?? "")}</p>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-500">Area</p>
                <p className="mt-1 text-sm font-bold text-slate-900">{profileValue(employee?.areaName ?? "")}</p>
              </div>
            </div>
          </Card>

          <Card className="rounded-[24px] border-white/90 bg-white/95 shadow-[0_20px_50px_rgba(15,23,42,0.08)]">
            <div className="mb-4 flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-50 text-rose-700">
                <CircleAlert className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-black text-slate-900">Leave Rules</h2>
                <p className="text-sm text-slate-500">The system applies these rules automatically.</p>
              </div>
            </div>
            <div className="space-y-3 text-sm text-slate-700">
              <p className="rounded-2xl bg-slate-50 p-3">First 6 months from hire date: all requests are automatically unpaid.</p>
              <p className="rounded-2xl bg-slate-50 p-3">After 6 months and before 1 full year: up to 15 paid annual leave days can be used.</p>
              <p className="rounded-2xl bg-slate-50 p-3">After completing 1 full year: annual paid entitlement becomes 21 days.</p>
              <p className="rounded-2xl bg-slate-50 p-3">If requested days exceed your available paid balance, the request becomes unpaid automatically.</p>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
