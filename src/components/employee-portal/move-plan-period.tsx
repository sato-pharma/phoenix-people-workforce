"use client";

import { useState, useTransition } from "react";
import { CalendarDays, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * HR / Super Admin control to re-date a whole plan onto a different period.
 *
 * This exists for one recurring situation: the employee picked the wrong week in the editor and
 * submitted an otherwise correct plan against it. Before this, the wrong week stayed approved and
 * the right week stayed blocked, and only a hand-written database change could separate them.
 *
 * Deliberately self-contained — its own state, its own error line — so it can be dropped beside
 * any plan without threading state through the workspace. The server is the real gate
 * (moveWeeklyPlanToPeriod asserts the weekly_plans approve grant AND HR/Super-Admin); rendering
 * this button is UX only.
 */
export function MovePlanPeriod({
  currentPeriodLabel,
  onMoved,
  planId,
  planKind,
}: {
  currentPeriodLabel: string;
  onMoved: () => void | Promise<void>;
  planId: string;
  planKind: "weekly" | "monthly";
}) {
  const [open, setOpen] = useState(false);
  const [targetDate, setTargetDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const response = await fetch(`/api/weekly-plans/${encodeURIComponent(planId)}/move-period`, {
          body: JSON.stringify({ targetAnchorDate: targetDate }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.message ?? "Unable to move this plan.");
        }
        setOpen(false);
        setTargetDate("");
        await onMoved();
      } catch (moveError) {
        setError(moveError instanceof Error ? moveError.message : "Unable to move this plan.");
      }
    });
  }

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} type="button" variant="secondary">
        <CalendarDays className="mr-2 h-4 w-4" />
        Move to another {planKind === "monthly" ? "month" : "week"}
      </Button>
    );
  }

  return (
    <div className="w-full border border-slate-200 bg-slate-50 p-3">
      <p className="text-sm font-black text-slate-800">
        Move this {planKind} plan off {currentPeriodLabel}
      </p>
      <p className="mt-1 text-xs font-semibold text-slate-600">
        Pick any date inside the destination {planKind === "monthly" ? "month" : "week"}. Every day in
        the plan shifts by the same number of days, so a Sunday visit stays on Sunday. Nothing is
        approved or re-decided.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          aria-label={`Destination ${planKind === "monthly" ? "month" : "week"}`}
          className="border border-slate-300 bg-white px-2.5 py-2 text-sm font-semibold text-slate-800"
          onChange={(event) => setTargetDate(event.target.value)}
          type="date"
          value={targetDate}
        />
        <Button disabled={isPending || !targetDate} onClick={submit} type="button">
          {isPending ? "Moving…" : "Move plan"}
        </Button>
        <Button
          disabled={isPending}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
          type="button"
          variant="secondary"
        >
          Cancel
        </Button>
      </div>
      {error ? (
        <div
          className="mt-3 flex items-start gap-2 border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800"
          role="alert"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}
