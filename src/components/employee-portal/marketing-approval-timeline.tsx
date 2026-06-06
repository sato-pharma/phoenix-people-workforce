"use client";

import type {
  MarketingRequestStepProgress,
  MarketingRequestTimelineStep,
} from "@/lib/marketing-requests/service";

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Status pill styling ------------------------------------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function pillClasses(status: MarketingRequestTimelineStep["status"]): string {
  switch (status) {
    case "approved":
      return "border-emerald-200 bg-emerald-50 text-emerald-700";
    case "current":
      return "border-orange-200 bg-orange-50 text-orange-700";
    case "rejected":
      return "border-rose-200 bg-rose-50 text-rose-700";
    case "returned":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "skipped":
      return "border-slate-200 bg-slate-50 text-slate-400";
    default:
      return "border-slate-200 bg-slate-50 text-slate-500";
  }
}

function dotClasses(status: MarketingRequestTimelineStep["status"]): string {
  switch (status) {
    case "approved":
      return "bg-emerald-500";
    case "current":
      return "bg-orange-500";
    case "rejected":
      return "bg-rose-500";
    case "returned":
      return "bg-amber-500";
    case "skipped":
      return "bg-slate-300";
    default:
      return "bg-slate-300";
  }
}

function statusLabel(status: MarketingRequestTimelineStep["status"]): string {
  return status.replace(/_/g, " ");
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Compact progress strip --------------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export function MarketingProgressStrip({
  progress,
}: {
  progress: MarketingRequestStepProgress | null;
}) {
  if (!progress) {
    return (
      <p className="text-[11px] font-medium text-slate-400">
        Progress not available.
      </p>
    );
  }

  const currentApprover =
    progress.currentApproverName.trim().length > 0
      ? ` — ${progress.currentApproverName}`
      : "";

  return (
    <div className="space-y-1">
      <p className="text-[11px] font-bold text-slate-600">
        Step {progress.sequence}/{progress.totalGatingSteps} · Currently with:{" "}
        {progress.currentStepName}
        {currentApprover}
      </p>
      {progress.returnReason ? (
        <p className="rounded-sm border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] font-medium text-amber-800">
          Returned: {progress.returnReason}
        </p>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Vertical approval timeline ----------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export function MarketingApprovalTimeline({
  steps,
}: {
  steps: MarketingRequestTimelineStep[];
}) {
  if (steps.length === 0) {
    return (
      <p className="rounded-sm border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-[11px] font-medium text-slate-400">
        No approval steps recorded yet.
      </p>
    );
  }

  return (
    <ol className="space-y-1.5">
      {steps.map((step) => {
        const muted = step.isCc || step.status === "skipped";
        return (
          <li
            className={`rounded-sm border p-2.5 ${
              muted
                ? "border-slate-100 bg-slate-50/60"
                : "border-slate-200 bg-white"
            }`}
            key={`${step.sequence}-${step.stepName}`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex min-w-0 items-start gap-2">
                <span
                  className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-sm ${dotClasses(
                    step.status,
                  )}`}
                />
                <div className="min-w-0">
                  <p
                    className={`text-[12px] font-bold ${
                      muted ? "text-slate-500" : "text-slate-950"
                    }`}
                  >
                    {step.stepName}
                    {step.isCc ? (
                      <span className="ml-1.5 rounded-sm bg-slate-200/70 px-1 py-0.5 text-[9px] font-black uppercase tracking-[0.08em] text-slate-500">
                        CC
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-[10px] font-medium text-slate-400">
                    {step.assignedRole}
                    {step.assignedName ? ` · ${step.assignedName}` : ""}
                  </p>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.06em] ${pillClasses(
                  step.status,
                )}`}
              >
                {statusLabel(step.status)}
              </span>
            </div>

            {step.decisionAt || step.decisionByName || step.decisionNote ? (
              <div className="mt-1.5 border-t border-slate-100 pt-1.5 text-[10px] font-medium text-slate-500">
                {step.decisionByName ? (
                  <span className="font-bold text-slate-600">
                    {step.decisionByName}
                  </span>
                ) : null}
                {step.decisionAt ? (
                  <span className="text-slate-400">
                    {step.decisionByName ? " · " : ""}
                    {step.decisionAt}
                  </span>
                ) : null}
                {step.decisionNote ? (
                  <p className="mt-0.5 break-words text-slate-500">
                    {step.decisionNote}
                  </p>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
