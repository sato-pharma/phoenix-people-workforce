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
import { LANDING_FOCUS } from "@/components/employee-portal/landing-kit";

/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */
/* --------- Step state: the rail's colour, never a filled pill ------------------------------------------------------------------------------------ */
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

/**
 * One clean vertical rail (the landing kit): emerald approved, amber waiting, rose rejected, slate
 * not reached. A returned step is back with its requester, so it waits in amber too. Whole literals,
 * so Tailwind ships every one.
 */
function railClass(status: MarketingRequestTimelineStep["status"]): string {
  switch (status) {
    case "approved":
      return "border-l-emerald-500";
    case "current":
      return "border-l-amber-400";
    case "rejected":
      return "border-l-rose-500";
    case "returned":
      return "border-l-amber-500";
    case "skipped":
      return "border-l-slate-200";
    default:
      return "border-l-slate-300";
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
      <p className="text-phx-xs font-medium text-slate-500">
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
      <p className="break-words text-phx-xs font-bold text-slate-600">
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
        <div className="flex min-w-0 gap-2">
          <span aria-hidden="true" className="w-1 shrink-0 self-stretch bg-amber-400" />
          <p className="min-w-0 break-words text-phx-sm font-medium text-amber-800" dir="auto">
            Returned: {progress.returnReason}
          </p>
        </div>
      ) : null}
      {requestId ? (
        <a
          className={`inline-block text-phx-sm font-bold text-[#08111f] underline decoration-slate-300 underline-offset-2 transition-colors hover:decoration-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`}
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
/* --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

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
      <p className="break-words py-3 text-phx-sm font-medium text-slate-500">
        No approval steps recorded yet.
      </p>
    );
  }

  return (
    <ol className="space-y-2">
      {steps.map((step) => {
        const muted = step.isCc || step.status === "skipped";
        return (
          <li
            className={`min-w-0 border-l-[3px] py-1 pl-3 ${muted ? "border-l-slate-200" : railClass(step.status)}`}
            key={`${step.sequence}-${step.stepName}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p
                className={`min-w-0 break-words text-phx-sm font-bold ${
                  muted ? "text-slate-500" : "text-[#08111f]"
                }`}
              >
                {step.stepName}
                {step.isCc ? (
                  <span className="ml-1.5 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-500">
                    CC
                  </span>
                ) : null}
              </p>
              <span className="text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500">
                {statusLabel(step.status)}
              </span>
            </div>
            <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500" dir="auto">
              {step.assignedRole}
              {step.assignedName ? ` · ${step.assignedName}` : ""}
            </p>

            {step.decisionAt || step.decisionByName || step.decisionNote ? (
              <div className="mt-1 text-phx-xs font-medium text-slate-500">
                {step.decisionByName ? (
                  <span className="font-semibold text-slate-700" dir="auto">
                    {step.decisionByName}
                  </span>
                ) : null}
                {step.decisionAt ? (
                  <span className="tabular-nums text-slate-500">
                    {step.decisionByName ? " · " : ""}
                    {step.decisionAt}
                  </span>
                ) : null}
                {step.decisionNote ? (
                  <p
                    className={`mt-0.5 break-words ${
                      isMarketingAdminOverrideNote({ requestCode, stepName: step.stepName })
                        ? MARKETING_ADMIN_OVERRIDE_NOTE_CLASSES
                        : "text-slate-600"
                    }`}
                    dir="auto"
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
