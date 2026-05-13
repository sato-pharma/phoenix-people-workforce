"use client";

import { useState } from "react";
import { CalendarDays, Clock3, Gauge, Plus, RefreshCw, ShieldCheck } from "lucide-react";

import type { LeaveAccrualPreview } from "@/lib/leave/types";
import { cn } from "@/lib/utils";

import {
  buttonClassName,
  compactNumber,
  formatDate,
  MetricCard,
  Panel,
  PanelHeader,
} from "./leave-ui-primitives";

export function LeaveAccrualPanel({
  onToast,
  preview,
}: {
  onToast: (message: string) => void;
  preview?: LeaveAccrualPreview | null;
}) {
  const [currentPreview, setCurrentPreview] = useState<LeaveAccrualPreview | null>(preview ?? null);
  const [isLoading, setIsLoading] = useState(false);

  async function refresh(dryRun: boolean) {
    setIsLoading(true);
    try {
      const response = dryRun
        ? await fetch("/api/leave/accrual/run", { body: JSON.stringify({ dryRun: true }), headers: { "Content-Type": "application/json" }, method: "POST" })
        : await fetch("/api/leave/accrual/run");
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to preview accrual.");
      setCurrentPreview(payload);
      onToast(dryRun ? `Dry run ready: ${payload.wouldAccrue} employee${payload.wouldAccrue === 1 ? "" : "s"} would accrue.` : "Accrual preview refreshed.");
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Unable to preview accrual.");
    } finally {
      setIsLoading(false);
    }
  }

  async function runAccrual() {
    if (!window.confirm("Run monthly leave accrual now? The engine will skip employees already accrued for this period.")) return;
    setIsLoading(true);
    try {
      const response = await fetch("/api/leave/accrual/run", { body: "{}", headers: { "Content-Type": "application/json" }, method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to run accrual.");
      onToast(`Accrual processed for ${payload.processed} employee${payload.processed === 1 ? "" : "s"}.`);
      await refresh(false);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Unable to run accrual.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Panel>
      <PanelHeader
        action={
          <div className="flex flex-wrap gap-2">
            <button className={cn(buttonClassName, "border border-slate-200 bg-white text-slate-800 hover:bg-slate-50")} data-testid="leave-accrual-dry-run-button" disabled={isLoading} onClick={() => refresh(true)} type="button">
              <RefreshCw className="h-4 w-4" />
              Dry Run
            </button>
            <button className={cn(buttonClassName, "bg-orange-600 text-white hover:bg-orange-700")} data-testid="leave-accrual-safe-run-button" disabled={isLoading} onClick={runAccrual} type="button">
              <Plus className="h-4 w-4" />
              Safe Run
            </button>
          </div>
        }
        description="Preview monthly accrual, confirm idempotency status, and run the safe HR/Admin trigger."
        icon={<RefreshCw className="h-5 w-5" />}
        title="Monthly Accrual Control"
      />
      <div className="grid gap-3 p-4 sm:p-5 md:grid-cols-5">
        <MetricCard icon={<CalendarDays className="h-5 w-5" />} label="Current Period" value={currentPreview?.period ?? "-"} />
        <MetricCard icon={<Clock3 className="h-5 w-5" />} label="Last Run" value={currentPreview?.lastRunAt ? formatDate(currentPreview.lastRunAt) : "Not found"} />
        <MetricCard icon={<Plus className="h-5 w-5" />} label="Would Accrue" value={currentPreview?.wouldAccrue ?? 0} />
        <MetricCard icon={<ShieldCheck className="h-5 w-5" />} label="Already Accrued" value={currentPreview?.alreadyAccrued ?? 0} />
        <MetricCard icon={<Gauge className="h-5 w-5" />} label="Preview Days" value={compactNumber(currentPreview?.totalAccrualDays ?? 0)} />
      </div>
    </Panel>
  );
}
