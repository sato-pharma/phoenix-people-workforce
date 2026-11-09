"use client";

import {
  isMarketingAdminOverrideNote,
  MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES,
} from "@/lib/marketing-requests/admin-override-note";
import type {
  MarketingRequestStepProgress,
  MarketingRequestTimelineStep,
} from "@/lib/marketing-requests/service";
import type { MarketingRequestStatus } from "@/lib/marketing-requests/types";

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

/**
 * Where the request is, in one line.
 *
 * `status` is REQUIRED and is the whole point. MarketingRequestStepProgress carries no status, so
 * this strip used to print "Currently with: Finance Execution" on every request it was given —
 * including refused ones, where it names a rung Finance never saw and asserts that somebody is
 * still holding a request that ended weeks ago. This is the tracking surface the audit called the
 * module's headline failure, and that sentence was the failure.
 *
 * A finished request says what happened to it. Only a request actually in flight says who has it.
 */
export function MarketingProgressStrip({
  progress,
  requestId,
  status,
}: {
  progress: MarketingRequestStepProgress | null;
  /** When given, the strip offers the full record rather than being the end of the road. */
  requestId?: string;
  status: MarketingRequestStatus;
}) {
  if (!progress) {
    return (
      <p className="text-phx-xs font-medium text-slate-400">
        Progress not available.
      </p>
    );
  }

  const inFlight = status === "pending_approval";
  const currentApprover =
    progress.currentApproverName.trim().length > 0
      ? ` — ${progress.currentApproverName}`
      : "";

  return (
    <div className="space-y-1">
      <p className="text-phx-xs font-bold text-slate-600">
        {inFlight ? (
          <>
            Step {progress.sequence}/{progress.totalGatingSteps} · Currently with:{" "}
            {progress.currentStepName}
            {currentApprover}
          </>
        ) : (
          <>
            {progress.approvedGatingCount}/{progress.totalGatingSteps} approvals ·{" "}
            {terminalSentence(status)}
          </>
        )}
      </p>
      {progress.returnReason ? (
        <p className="rounded-sm border border-amber-200 bg-amber-50 px-2 py-1 text-phx-sm font-medium text-amber-800">
          Returned: {progress.returnReason}
        </p>
      ) : null}
      {requestId ? (
        <a
          className="inline-block text-phx-sm font-bold text-orange-700 underline underline-offset-2 hover:text-orange-800"
          href={`/marketing-requests/${requestId}`}
        >
          Open the full record
        </a>
      ) : null}
    </div>
  );
}

/** What happened to a request that is no longer moving. Never "currently with". */
function terminalSentence(status: MarketingRequestStatus): string {
  switch (status) {
    case "rejected":
      return "Refused — nobody is waiting on this";
    case "returned":
      return "Returned to the requester for changes";
    case "approved":
      return "Approved — no approvals outstanding";
    case "active":
      return "Approved and executing";
    case "draft":
      return "Draft — not submitted yet";
    default:
      return `No longer in approval (${status.replace(/_/g, " ")})`;
  }
}

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Vertical approval timeline ----------------------------------------------------------------------------------------------------------- */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export function MarketingApprovalTimeline({
  requestCode,
  steps,
}: {
  /**
   * Optional, and only read to spot the one out-of-band SFE Validation note (see
   * `admin-override-note.ts`). A caller that omits it gets the ordinary treatment on every note.
   */
  requestCode?: string | null;
  steps: MarketingRequestTimelineStep[];
}) {
  if (steps.length === 0) {
    return (
      <p className="rounded-sm border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-center text-phx-xs font-medium text-slate-400">
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
                    className={`text-phx-sm font-bold ${
                      muted ? "text-slate-500" : "text-slate-950"
                    }`}
                  >
                    {step.stepName}
                    {step.isCc ? (
                      <span className="ml-1.5 rounded-sm bg-slate-200/70 px-1 py-0.5 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                        CC
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-phx-sm font-medium text-slate-400">
                    {step.assignedRole}
                    {step.assignedName ? ` · ${step.assignedName}` : ""}
                  </p>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-phx-sm font-bold uppercase tracking-[0.06em] ${pillClasses(
                  step.status,
                )}`}
              >
                {statusLabel(step.status)}
              </span>
            </div>

            {step.decisionAt || step.decisionByName || step.decisionNote ? (
              <div className="mt-1.5 border-t border-slate-100 pt-1.5 text-phx-sm font-medium text-slate-500">
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
                  <p
                    className={`mt-0.5 break-words ${
                      isMarketingAdminOverrideNote({ requestCode, stepName: step.stepName })
                        ? MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES
                        : "text-slate-500"
                    }`}
                  >
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
