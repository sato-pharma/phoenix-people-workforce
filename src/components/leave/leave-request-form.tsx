"use client";

import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { AlertTriangle, CalendarCheck, Upload } from "lucide-react";

import type { LeaveConflictResult, LeavePolicy, LeaveType, PublicHoliday } from "@/lib/leave/types";
import { cn } from "@/lib/utils";

import {
  buttonClassName,
  calculateWorkingDaysPreview,
  fieldClassName,
  Panel,
  PanelHeader,
  textAreaClassName,
} from "./leave-ui-primitives";

function ConflictWarning({
  conflicts,
  isLoading,
}: {
  conflicts: LeaveConflictResult | null;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-bold text-slate-600 lg:col-span-12">
        Checking team availability conflicts...
      </div>
    );
  }
  if (!conflicts || (!conflicts.warnings.length && !conflicts.overlappingRequests.length)) return null;

  return (
    <div className={cn("rounded-2xl border px-4 py-3 lg:col-span-12", conflicts.blocked ? "border-rose-200 bg-rose-50" : "border-amber-200 bg-amber-50")} data-testid="leave-conflict-warning">
      <div className="flex items-start gap-3">
        <AlertTriangle className={cn("mt-0.5 h-5 w-5 shrink-0", conflicts.blocked ? "text-rose-600" : "text-amber-600")} />
        <div>
          <p className="text-sm font-black text-slate-950">{conflicts.blocked ? "Leave conflict requires action" : "Leave conflict warning"}</p>
          <div className="mt-1 space-y-1 text-sm font-semibold text-slate-700">
            {conflicts.warnings.map((warning) => <p key={warning.code}>{warning.message}</p>)}
            {conflicts.overlappingRequests.length ? <p>{conflicts.overlappingRequests.length} overlapping approved or pending request{conflicts.overlappingRequests.length === 1 ? "" : "s"} found for the selected dates.</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function LeaveRequestForm({
  holidays,
  leaveTypes,
  onToast,
  policy,
}: {
  holidays?: PublicHoliday[];
  leaveTypes: LeaveType[];
  onToast: (message: string | null) => void;
  policy?: LeavePolicy;
}) {
  const [formState, setFormState] = useState({ endDate: "", leaveTypeId: leaveTypes[0]?.id ?? "", reason: "", startDate: "" });
  const [conflicts, setConflicts] = useState<LeaveConflictResult | null>(null);
  const [isCheckingConflicts, setIsCheckingConflicts] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const workingDays = calculateWorkingDaysPreview(formState.startDate, formState.endDate, holidays, policy?.weekendDays);
  const invalidRange = Boolean(formState.startDate && formState.endDate && formState.endDate < formState.startDate);
  const canCheckConflicts = Boolean(formState.startDate && formState.endDate && !invalidRange && workingDays > 0);

  useEffect(() => {
    if (!canCheckConflicts) return;

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setIsCheckingConflicts(true);
      fetch("/api/leave/conflicts", {
        body: JSON.stringify({ endDate: formState.endDate, startDate: formState.startDate }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.error ?? "Unable to check leave conflicts.");
          setConflicts(payload.conflicts);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setConflicts(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsCheckingConflicts(false);
        });
    }, 150);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [canCheckConflicts, formState.endDate, formState.startDate]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    onToast(null);
    try {
      const response = await fetch("/api/leave/requests", {
        body: new FormData(event.currentTarget),
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to submit leave request.");
      onToast("Leave request submitted.");
      window.setTimeout(() => window.location.reload(), 650);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Unable to submit leave request.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Panel>
      <PanelHeader
        description="Submit a request using Phoenix policy rules, working-day calculation, and balance validation."
        icon={<CalendarCheck className="h-5 w-5" />}
        title="New Leave Request"
      />
      <form className="grid gap-4 p-4 sm:p-5 lg:grid-cols-12" data-testid="leave-submit-form" onSubmit={submit}>
        <label className="lg:col-span-3">
          <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Leave Type</span>
          <select className={fieldClassName} data-testid="leave-type-select" name="leaveTypeId" onChange={(event) => setFormState((current) => ({ ...current, leaveTypeId: event.target.value }))} value={formState.leaveTypeId}>
            {leaveTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
          </select>
        </label>
        <label className="lg:col-span-2">
          <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">From Date</span>
          <input className={fieldClassName} data-testid="leave-start-date-input" min={new Date().toISOString().slice(0, 10)} name="startDate" onChange={(event) => setFormState((current) => ({ ...current, startDate: event.target.value }))} required type="date" value={formState.startDate} />
        </label>
        <label className="lg:col-span-2">
          <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">To Date</span>
          <input className={fieldClassName} data-testid="leave-end-date-input" min={formState.startDate || new Date().toISOString().slice(0, 10)} name="endDate" onChange={(event) => setFormState((current) => ({ ...current, endDate: event.target.value }))} required type="date" value={formState.endDate} />
        </label>
        <div className="lg:col-span-2">
          <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Duration</span>
          <div className={cn(fieldClassName, "flex items-center bg-slate-50 text-slate-950")}>{invalidRange ? "Invalid range" : `${workingDays} working day${workingDays === 1 ? "" : "s"}`}</div>
        </div>
        <label className="lg:col-span-3">
          <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Attachment</span>
          <div className="flex h-11 items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-3 text-sm font-semibold text-slate-500">
            <Upload className="h-4 w-4" />
            <input className="min-w-0 flex-1 text-xs" data-testid="leave-attachment-input" name="attachment" type="file" />
          </div>
        </label>
        <ConflictWarning conflicts={canCheckConflicts ? conflicts : null} isLoading={canCheckConflicts && isCheckingConflicts} />
        <label className="lg:col-span-9">
          <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Reason / Comment</span>
          <textarea className={textAreaClassName} data-testid="leave-reason-input" name="reason" onChange={(event) => setFormState((current) => ({ ...current, reason: event.target.value }))} value={formState.reason} />
        </label>
        <div className="flex items-end lg:col-span-3">
          <button className={cn(buttonClassName, "w-full bg-orange-600 text-white shadow-[0_14px_30px_rgba(249,115,22,0.24)] hover:bg-orange-700")} data-testid="leave-request-submit-button" disabled={isSubmitting || invalidRange || workingDays <= 0 || Boolean(canCheckConflicts && conflicts?.blocked)} type="submit">
            <CalendarCheck className="h-4 w-4" />
            {isSubmitting ? "Submitting..." : "Submit Request"}
          </button>
        </div>
      </form>
    </Panel>
  );
}
