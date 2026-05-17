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
  vacationUnpaidReasonLabel,
} from "@/lib/vacation/calculations";
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
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

export function VacationRequestForm({ initialData, initialError }: VacationRequestFormProps) {
  const router = useRouter();
  const [vacationType, setVacationType] = useState<VacationType>("annual");
  const [dayPart, setDayPart] = useState<VacationDayPart>("full_day");
  const [startDate, setStartDate] = useState(todayDateOnly());
  const [endDate, setEndDate] = useState(todayDateOnly());
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
      const response = await fetch("/api/vacations/requests", {
        body: JSON.stringify({ dayPart, endDate, startDate, vacationType }),
        headers: { "Content-Type": "application/json" },
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

  const balance = initialData?.balance;

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
                onChange={(event) => setVacationType(event.target.value as VacationType)}
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
                onChange={(event) => setDayPart(event.target.value as VacationDayPart)}
              >
                {(initialData?.dayPartOptions ?? VACATION_DAY_PARTS).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="space-y-2">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Vacation start from</span>
              <Input value={startDate} type="date" onChange={(event) => setStartDate(event.target.value)} />
            </label>

            <label className="space-y-2">
              <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Vacation to</span>
              <Input value={endDate} type="date" onChange={(event) => setEndDate(event.target.value)} />
            </label>
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
              disabled={!initialData || !initialData.balance || submitting || Boolean(durationPreview.error)}
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
                <p className="text-xs font-semibold text-slate-500">{initialData?.employee.hrId ?? ""}</p>
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Direct manager</p>
                <p className="mt-1 text-sm font-black text-slate-950">{initialData?.manager?.fullName ?? "Not assigned"}</p>
                <p className="text-xs font-semibold text-slate-500">{initialData?.manager?.hrId ?? ""}</p>
              </div>
              <div>
                <p className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Manager of manager</p>
                <p className="mt-1 text-sm font-black text-slate-950">{initialData?.managerOfManager?.fullName ?? "Not assigned"}</p>
                <p className="text-xs font-semibold text-slate-500">{initialData?.managerOfManager?.hrId ?? ""}</p>
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
