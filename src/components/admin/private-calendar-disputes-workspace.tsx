"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { PrivateCalendarReviewRequestThread } from "@/components/private-calendar/review-request-thread";
import type { DisputeContext } from "@/lib/private-calendar/dispute-context";
import type { PrivateCalendarReviewMessage, PrivateCalendarReviewRequest } from "@/lib/private-calendar/logic";
import { cn } from "@/lib/utils";

export type AdminPrivateCalendarDispute = {
  adminDecisionNote: string | null;
  adminHrId: string | null;
  claimSourceText: string;
  claimText: string;
  // Who the employee is, who they report to, how long this has waited, and what Phoenix ALREADY
  // holds for the disputed day. Optional so a surface that has not built it still renders — the
  // request is readable without it, just not decidable on this screen alone.
  context?: DisputeContext;
  createdAt: string;
  decidedAt: string | null;
  disputeDate: string;
  displayedSummary: string;
  employeeHrId: string;
  employeeName: string | null;
  id: string;
  itemSource: string | null;
  itemSourceRecordId: string | null;
  // The replies on this request, oldest first. The opening claim is `claimText` above and is not
  // repeated here, so the thread renders the claim and then these.
  messages: PrivateCalendarReviewMessage[];
  status: "pending_review" | "accepted" | "rejected";
};

/**
 * The reviewer's row, in the shape the shared thread component takes.
 *
 * Mapped rather than renamed at the source: `adminDecisionNote`/`disputeDate` are what the dispute
 * table and its service have always called these, and the thread is used by the employee's calendar
 * too, so one of the two has to translate.
 */
function asReviewRequest(dispute: AdminPrivateCalendarDispute): PrivateCalendarReviewRequest {
  return {
    claimSourceText: dispute.claimSourceText,
    claimText: dispute.claimText,
    createdAt: dispute.createdAt,
    date: dispute.disputeDate,
    decidedAt: dispute.decidedAt,
    decisionNote: dispute.adminDecisionNote,
    employeeHrId: dispute.employeeHrId,
    employeeName: dispute.employeeName,
    id: dispute.id,
    messages: dispute.messages ?? [],
    status: dispute.status,
  };
}

// DATE-ONLY (a calendar-item date, a `date` column), which `new Date` parses as UTC midnight. UTC here
// is CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not an
// instant — do not "fix" this one to Cairo.
function formatDate(iso: string) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(date);
}

/**
 * The one sentence that answers the owner's own question — *"I don't know what is she disputing
 * about"* (2026-10-08).
 *
 * Built from the stored request rather than a template the employee filled in, because the three
 * stored strings on their own ("No Activity Recorded" / "Traveling" / "Manager Confirmation") read as
 * three unrelated labels — which is exactly how this screen failed on 2026-10-08.
 */
function claimSentence(dispute: AdminPrivateCalendarDispute) {
  const who = dispute.employeeName ?? dispute.employeeHrId;
  const weekday = dispute.context?.weekday;
  const when = weekday ? `${weekday}, ${formatDate(dispute.disputeDate)}` : formatDate(dispute.disputeDate);
  const what = dispute.context?.itemSourceLabel ?? null;
  const scope = what ? `the ${what} record on ${when}` : `the whole of ${when}`;
  return `${who} says ${scope} is wrong, and asks you to show the correction instead.`;
}

// Each fact Phoenix already holds for the day wears its severity, so a problem flag and a proof of
// work do not read alike. No fills beyond these tints — the ink rule is for documents, and this is a
// screen, but the square-edge rule applies everywhere.
const FACT_TONE: Record<string, string> = {
  danger: "border-red-200 bg-red-50 text-red-900",
  info: "border-slate-200 bg-slate-50 text-slate-800",
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
};

function DayRecord({ context }: { context: DisputeContext | undefined }) {
  if (!context) return null;
  const facts = context.dayFacts;
  return (
    <div className="mt-3 border border-slate-200 bg-white">
      <p className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
        What Phoenix already holds for that day
      </p>
      {facts.length === 0 ? (
        <p className="px-3 py-3 text-sm font-semibold text-slate-600">
          {context.dayRecordIncomplete
            ? "Phoenix could not read every source for this day, so treat an empty record as unknown rather than as proof that nothing happened."
            : "Nothing at all — no punch, no visit, no approved plan activity, no leave and no holiday. Their claim is the only account of this day."}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {facts.map((fact, index) => (
            <li className="flex flex-wrap items-baseline gap-2 px-3 py-2" key={`${fact.source}-${index}`}>
              <span className={cn("border px-2 py-0.5 text-phx-xs font-bold", FACT_TONE[fact.severity] ?? FACT_TONE.info)}>
                {fact.sourceLabel}
              </span>
              <span className="text-sm font-bold text-slate-900">{fact.title}</span>
              {fact.time ? <span className="font-mono text-phx-xs font-semibold text-slate-500">{fact.time}</span> : null}
              {fact.detail ? <span className="text-sm font-medium text-slate-600">{fact.detail}</span> : null}
              {/* Phoenix keeps an approved Travel / Admin / Meeting day nowhere else, so there is
                  nothing else to look for beside it — but the plan is what was INTENDED and never
                  settles the day (owner, 2026-10-12). Neutral, not green, for exactly that reason. */}
              {fact.plannedWithNoOtherRecord ? (
                <span className="border border-slate-300 bg-slate-50 px-2 py-0.5 text-phx-xs font-black uppercase tracking-[0.08em] text-slate-700">
                  Approved plan — what was intended, not a record of the day
                </span>
              ) : null}
            </li>
          ))}
          {context.dayRecordIncomplete ? (
            <li className="flex items-start gap-2 px-3 py-2 text-sm font-semibold text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              One or more calendar sources could not be read, so this list may be incomplete.
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

export function PrivateCalendarDisputesWorkspace({
  initialDisputes,
  initialError,
  viewerHrId,
}: {
  initialDisputes: AdminPrivateCalendarDispute[];
  initialError: string | null;
  /** The reviewer's own HR id, so a reply he wrote reads "You" rather than his own name. */
  viewerHrId?: string | null;
}) {
  const router = useRouter();
  const [disputes, setDisputes] = useState(initialDisputes);
  const [error, setError] = useState(initialError);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [noteById, setNoteById] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  async function decide(disputeId: string, decision: "accept" | "reject") {
    const note = (noteById[disputeId] ?? "").trim();
    setError(null);
    setSubmittingId(disputeId);
    try {
      const response = await fetch(`/api/private-calendar/disputes/${disputeId}/decide`, {
        body: JSON.stringify({ decision, note }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to decide this dispute.");
      setDisputes((current) => current.filter((dispute) => dispute.id !== disputeId));
      setDecidingId(null);
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Unable to decide this dispute.");
    } finally {
      setSubmittingId(null);
    }
  }

  return (
    <section className="border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-900 px-5 py-3">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
          {disputes.length} review request{disputes.length === 1 ? "" : "s"} pending
        </h2>
      </div>

      {error ? (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {disputes.length === 0 ? (
        <div className="p-10 text-center">
          <p className="text-sm font-bold text-slate-500">No review requests are waiting.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {disputes.map((dispute) => (
            <div className="px-5 py-4" key={dispute.id}>
              {/* The sentence FIRST, then the labels. A reviewer who reads only one line must still
                  know who is asking, about which day, and for what. */}
              <p className="text-base font-bold text-slate-900">{claimSentence(dispute)}</p>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="whitespace-nowrap font-mono text-phx-xs font-semibold text-slate-500">{formatDate(dispute.disputeDate)}</span>
                <span className="whitespace-nowrap bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-700">
                  {dispute.employeeName ?? dispute.employeeHrId} ({dispute.employeeHrId})
                </span>
                {dispute.itemSource ? (
                  <span className="whitespace-nowrap bg-indigo-100 px-2 py-0.5 text-phx-xs font-semibold text-indigo-700">
                    One {dispute.context?.itemSourceLabel ?? dispute.itemSource} record
                  </span>
                ) : (
                  <span className="whitespace-nowrap bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-500">
                    whole day
                  </span>
                )}
                {dispute.context ? (
                  <span
                    className={cn(
                      "whitespace-nowrap px-2 py-0.5 text-phx-xs font-semibold",
                      dispute.context.waitingDays >= 3 ? "bg-amber-100 text-amber-800" : "bg-slate-100 text-slate-600",
                    )}
                  >
                    {dispute.context.waitingDays === 0
                      ? "raised today"
                      : `waiting ${dispute.context.waitingDays} day${dispute.context.waitingDays === 1 ? "" : "s"}`}
                  </span>
                ) : null}
              </div>

              {/* Who the employee is and who can vouch for them — "Manager Confirmation" is unusable as a
                  verification route until the manager is NAMED (owner, 2026-10-08). Names, never ids. */}
              {dispute.context ? (
                <p className="mt-1.5 text-sm font-semibold text-slate-600">
                  {[
                    dispute.context.jobTitle,
                    dispute.context.lineName ? `${dispute.context.lineName} line` : null,
                    dispute.context.areaName,
                    dispute.context.managerName ? `reports to ${dispute.context.managerName}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              ) : null}

              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <div>
                  <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">The calendar shows</p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">{dispute.displayedSummary}</p>
                </div>
                <div>
                  <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">They say it was</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{dispute.claimText}</p>
                </div>
                <div>
                  <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Check it with</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">
                    {dispute.claimSourceText}
                    {dispute.context?.managerName ? ` — ${dispute.context.managerName}` : ""}
                  </p>
                </div>
              </div>

              <DayRecord context={dispute.context} />

              {/* The conversation, above the decision: a reviewer should be able to ask where to look
                  and read the answer before accepting or rejecting the day. */}
              <div className="mt-3">
                <PrivateCalendarReviewRequestThread
                  canReply
                  claimAuthorLabel={dispute.employeeName ?? dispute.employeeHrId}
                  onPosted={() => router.refresh()}
                  request={asReviewRequest(dispute)}
                  viewerHrIdKey={viewerHrId ? viewerHrId.trim().toLowerCase() : null}
                />
              </div>

              {decidingId === dispute.id ? (
                <div className="mt-3 border border-slate-200 bg-slate-50 p-3">
                  {/* What each button actually does, beside the buttons. Accepting overlays the
                      verified correction on the calendar day; the original punch or CRM visit is
                      never rewritten, because Phoenix does not own that upstream record. */}
                  <p className="text-sm font-semibold text-slate-600">
                    <span className="font-black text-emerald-800">Accept</span> shows your correction on top of that day in their
                    calendar and emails them your note. The original punch or visit record is not changed.{" "}
                    <span className="font-black text-red-800">Reject</span> leaves the day exactly as it is and emails them why.
                  </p>
                  <textarea
                    className={cn(phxTextareaClassName, "mt-2")}
                    onChange={(event) => setNoteById((current) => ({ ...current, [dispute.id]: event.target.value }))}
                    placeholder="Decision note (optional — what you found when you checked)"
                    rows={2}
                    value={noteById[dispute.id] ?? ""}
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      className={phxButtonApproveClassName}
                      disabled={submittingId === dispute.id}
                      onClick={() => decide(dispute.id, "accept")}
                      type="button"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Accept
                    </button>
                    <button
                      className={phxButtonDangerClassName}
                      disabled={submittingId === dispute.id}
                      onClick={() => decide(dispute.id, "reject")}
                      type="button"
                    >
                      <X className="h-3.5 w-3.5" />
                      Reject
                    </button>
                    <button
                      className={phxButtonGhostClassName}
                      onClick={() => setDecidingId(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className={cn(phxButtonGhostClassName, "mt-3")}
                  onClick={() => setDecidingId(dispute.id)}
                  type="button"
                >
                  Review
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
