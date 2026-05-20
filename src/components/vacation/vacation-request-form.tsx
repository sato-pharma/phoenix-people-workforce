"use client";

import { AlertCircle, CalendarDays, SendHorizonal } from "lucide-react";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { AdminCallout, AdminPageHero, AdminStatCard, adminPanelClassName } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/layout/page-container";
import {
  calculateVacationDurationDays,
  getAnnualVacationMinimumStartDate,
  getVacationPolicyToday,
  vacationUnpaidReasonLabel,
} from "@/lib/vacation/calculations";
import { formatHrIdForDisplay } from "@/lib/hr-id";
import type {
  VacationBalanceSnapshot,
  VacationDayPart,
  VacationEmployeeSummary,
  VacationType,
} from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_TYPES } from "@/lib/vacation/types";
import { cn } from "@/lib/utils";

type VacationRequestFormProps = {
  initialData: {
    balance: VacationBalanceSnapshot | null;
    balances?: Partial<Record<VacationType, VacationBalanceSnapshot | null>>;
    dayPartOptions: ReadonlyArray<{ label: string; value: VacationDayPart }>;
    employee: VacationEmployeeSummary;
    manager: VacationEmployeeSummary | null;
    managerOfManager: VacationEmployeeSummary | null;
    vacationTypeOptions: ReadonlyArray<{ label: string; value: VacationType }>;
  } | null;
  initialError: string | null;
};

function formatDays(days: number) {
  return `${Number(days.toFixed(2))} day${days === 1 ? "" : "s"}`;
}

function todayDateOnly() {
  return getVacationPolicyToday();
}

function annualMinimumDateOnly() {
  return getAnnualVacationMinimumStartDate();
}

export function VacationRequestForm({ initialData, initialError }: VacationRequestFormProps) {
  const router = useRouter();
  const [vacationType, setVacationType] = useState<VacationType>("annual");
  const [dayPart, setDayPart] = useState<VacationDayPart>("full_day");
  const [startDate, setStartDate] = useState(annualMinimumDateOnly());
  const [endDate, setEndDate] = useState(annualMinimumDateOnly());
  const [sickDocument, setSickDocument] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError);

  const durationPreview = useMemo(() => {
    try {
      return {
        days: calculateVacationDurationDays({ dayPart, endDate, startDate }),
        error: null,
      };
    } catch (previewError) {
      return {
        days: 0,
        error: previewError instanceof Error ? previewError.message : "Invalid vacation dates.",
      };
    }
  }, [dayPart, endDate, startDate]);

  async function submitRequest() {
    setSubmitting(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("dayPart", dayPart);
      formData.append("endDate", endDate);
      formData.append("startDate", startDate);
      formData.append("vacationType", vacationType);
      if (sickDocument) {
        formData.append("sickDocument", sickDocument);
      }

      const response = await fetch("/api/vacations/requests", {
        body: formData,
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Vacation request failed.");
      }

      router.push("/leave-management/vacation-report?status=pending_manager");
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Vacation request failed.");
    } finally {
      setSubmitting(false);
    }
  }

  const balance = initialData?.balances?.[vacationType] ?? initialData?.balance;
  const isEmergency = vacationType === "emergency";
  const isSick = vacationType === "sick";
  const annualMinimumDate = annualMinimumDateOnly();
  const dateInputMinimum = vacationType === "annual" ? annualMinimumDate : undefined;
  const dateInputMaximum = isEmergency ? todayDateOnly() : undefined;
  const submitDisabled =
    !initialData ||
    !initialData.balance ||
    submitting ||
    Boolean(durationPreview.error) ||
    (isSick && !sickDocument);

  function updateVacationType(value: VacationType) {
    setVacationType(value);
    setSickDocument(null);
    if (value === "emergency") {
      const today = todayDateOnly();
      setStartDate(today);
      setEndDate(today);
      return;
    }
    if (value === "annual" && startDate < annualMinimumDate) {
      setStartDate(annualMinimumDate);
      setEndDate(endDate < annualMinimumDate ? annualMinimumDate : endDate);
    }
  }

  function updateDayPart(value: VacationDayPart) {
    setDayPart(value);
    if (value !== "full_day") {
      setEndDate(startDate);
    }
  }

  function updateStartDate(value: string) {
    const nextValue = isEmergency ? todayDateOnly() : value;
    setStartDate(nextValue);
    if (dayPart !== "full_day" || endDate < nextValue) {
      setEndDate(nextValue);
    }
  }

  return (
    <PageContainer>
      <AdminPageHero
        description="Submit a vacation request for direct manager approval."
        eyebrow="Leave Management"
        icon={<CalendarDays className="h-3.5 w-3.5" />}
        title="Vacation Request"
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </AdminCallout>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className={cn(adminPanelClassName, "p-5")}>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-2">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Vacation type</span>
              <select
                className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold text-text outline-none transition focus:border-orange-300"
                value={vacationType}
                onChange={(event) => updateVacationType(event.target.value as VacationType)}
              >
                {(initialData?.vacationTypeOptions ?? VACATION_TYPES).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="space-y-2">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Day part</span>
              <select
                className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold text-text outline-none transition focus:border-orange-300"
                value={dayPart}
                onChange={(event) => updateDayPart(event.target.value as VacationDayPart)}
              >
                {(initialData?.dayPartOptions ?? VACATION_DAY_PARTS).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="space-y-2">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Vacation start from</span>
              <Input
                disabled={isEmergency}
                max={dateInputMaximum}
                min={dateInputMinimum}
                value={startDate}
                type="date"
                onChange={(event) => updateStartDate(event.target.value)}
              />
            </label>

            <label className="space-y-2">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Vacation to</span>
              <Input
                disabled={isEmergency || dayPart !== "full_day"}
                max={dateInputMaximum}
                min={startDate}
                value={endDate}
                type="date"
                onChange={(event) => setEndDate(isEmergency ? todayDateOnly() : event.target.value)}
              />
            </label>

            {isSick ? (
              <label className="space-y-2 sm:col-span-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Medical document</span>
                <Input
                  accept=".pdf,.doc,.docx,image/jpeg,image/png,image/webp"
                  required
                  type="file"
                  onChange={(event) => setSickDocument(event.target.files?.[0] ?? null)}
                />
                <p className="text-xs font-semibold text-slate-500">
                  {sickDocument ? sickDocument.name : "Required for sick vacation requests."}
                </p>
              </label>
            ) : null}
          </div>

          <div className="mt-5 flex flex-col gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Calculated duration</p>
              <p className="mt-1 text-2xl font-black text-slate-950">
                {durationPreview.error ? "Invalid" : formatDays(durationPreview.days)}
              </p>
              {durationPreview.error ? <p className="mt-1 text-sm font-semibold text-rose-700">{durationPreview.error}</p> : null}
            </div>
            <Button
              className="gap-2 rounded-xl bg-orange-600 px-5 py-3 font-black hover:bg-orange-700"
              disabled={submitDisabled}
              onClick={submitRequest}
              type="button"
            >
              <SendHorizonal className="h-4 w-4" />
              {submitting ? "Submitting..." : "Submit Request"}
            </Button>
          </div>
        </Card>

        <div className="space-y-4">
          <AdminStatCard
            description={balance?.unpaidReason ? vacationUnpaidReasonLabel(balance.unpaidReason) : "Available based on current approved paid vacations."}
            icon={<CalendarDays className="h-5 w-5" />}
            label="Available balance"
            value={balance ? formatDays(balance.balanceBeforeDays) : "-"}
            tone={balance?.paymentStatus === "paid" ? "emerald" : "orange"}
          />

          <Card className={cn(adminPanelClassName, "p-5")}>
            <div className="space-y-4">
              <div>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Employee</p>
                <p className="mt-1 text-sm font-black text-slate-950">{initialData?.employee.fullName ?? "-"}</p>
                <p className="text-xs font-semibold text-slate-500">{formatHrIdForDisplay(initialData?.employee.hrId) ?? ""}</p>
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Direct manager</p>
                <p className="mt-1 text-sm font-black text-slate-950">{initialData?.manager?.fullName ?? "Not assigned"}</p>
                <p className="text-xs font-semibold text-slate-500">{formatHrIdForDisplay(initialData?.manager?.hrId) ?? ""}</p>
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Manager of manager</p>
                <p className="mt-1 text-sm font-black text-slate-950">{initialData?.managerOfManager?.fullName ?? "Not assigned"}</p>
                <p className="text-xs font-semibold text-slate-500">{formatHrIdForDisplay(initialData?.managerOfManager?.hrId) ?? ""}</p>
              </div>
              <Badge variant={balance?.paymentStatus === "paid" ? "success" : "warning"}>
                {balance?.paymentStatus === "paid" ? "Paid eligible" : "Unpaid if requested today"}
              </Badge>
            </div>
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
