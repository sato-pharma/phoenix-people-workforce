"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";
import {
  phxButtonApproveClassName,
  phxButtonDangerClassName,
  phxButtonGhostClassName,
  phxLabelTextClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";
import { PrivateCalendarReviewRequestThread } from "@/components/private-calendar/review-request-thread";
import {
  EXPLAIN_CONFIRMATION_LABELS,
  EXPLAIN_REASON_CODES,
  explainDatesPhrase,
  explainDayLabel,
  explainReason,
  explainReasonPhrase,
  type DisputeExplanation,
  type ExplainReasonCode,
} from "@/lib/dispute-center/explain-reasons";
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
  /** The reason, the confirmer and their answer (owner, 2026-11-16). Null on a request filed before then. */
  explanation?: DisputeExplanation | null;
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
/** "9 Nov 2026" — the same day-month spelling as every other date on the card, plus the year. */
function formatDate(iso: string) {
  const label = explainDayLabel(iso);
  // A value that is not a real day comes back as sent; anything else drops its weekday ("Mon ").
  return label === iso ? iso : `${label.slice(4)} ${iso.slice(0, 4)}`;
}

/**
 * The one sentence that answers the owner's own question — *"I don't know what is she disputing
 * about"* (2026-10-08).
 *
 * Since 2026-11-16 the employee EXPLAINS a day rather than calling it wrong (owner: "there's nothing
 * wrong … he's the one that has the issue"), so the sentence says what they explained and where the
 * confirmation stands. A request filed before then has no reason and is read from its own words.
 */
function claimSentence(dispute: AdminPrivateCalendarDispute) {
  const who = dispute.employeeName ?? dispute.employeeHrId;
  const when = explainDayLabel(dispute.disputeDate);
  const explanation = dispute.explanation;
  if (explanation) {
    if (explanation.reasonCode === "other") return `${who} explains ${when} in their own words.`;
    const confirmer = explanation.confirmerName ?? "the person they named";
    const standing =
      explanation.confirmationStatus === "confirmed"
        ? ` ${confirmer} confirmed it.`
        : explanation.confirmationStatus === "declined"
          ? ` ${confirmer} did not confirm it.`
          : explanation.confirmationStatus === "awaiting"
            ? ` Waiting for ${confirmer} to confirm.`
            : "";
    return `${who} says they were ${explainReasonPhrase(explanation.reasonCode)} on ${when}.${standing}`;
  }
  const what = dispute.context?.itemSourceLabel ?? null;
  const scope = what ? `the ${what} record on ${when}` : when;
  return `${who} asks you to look again at ${scope}.`;
}

/** Which shelf of the inbox a request sits on: ready for you, not confirmed, or still with the confirmer. */
type Shelf = "ready" | "declined" | "awaiting";

const SHELVES: readonly Shelf[] = ["ready", "declined", "awaiting"];

const SHELF_TITLES: Record<Shelf, string> = {
  awaiting: "Waiting for the person they named to confirm",
  declined: "Not confirmed by the person they named",
  ready: "Ready for your decision",
};

/** One line under each shelf's title: what its requests have in common, and what is yours to do. */
const SHELF_NOTES: Record<Shelf, string> = {
  awaiting: "Still with the person they named. You can decide now, but their answer is not in yet.",
  declined: "The person they named said it was not as described. Read their note before you decide.",
  ready: "Confirmed by the person they named, or nobody needed to confirm it. Yours to decide.",
};

/** A confirmation state as a flat square and a word — no pill, no fill behind the text. */
const CONFIRMATION_MARK: Record<string, { ink: string; square: string }> = {
  awaiting: { ink: "text-slate-600", square: "bg-slate-400" },
  confirmed: { ink: "text-emerald-700", square: "bg-emerald-600" },
  declined: { ink: "text-rose-700", square: "bg-rose-600" },
  not_needed: { ink: "text-slate-600", square: "bg-slate-300" },
};

/** The same shelves in two words, for the counts in the header strip. */
const SHELF_SHORT: Record<Shelf, string> = {
  awaiting: "with the confirmer",
  declined: "not confirmed",
  ready: "ready for you",
};

function shelfOf(dispute: AdminPrivateCalendarDispute): Shelf {
  const status = dispute.explanation?.confirmationStatus;
  if (status === "awaiting") return "awaiting";
  if (status === "declined") return "declined";
  return "ready";
}

/** Requests with the same reason on the same shelf, so one decision can cover a training week. */
type ReasonGroup = {
  key: string;
  title: string;
  reasonCode: ExplainReasonCode | null;
  /** "Accept all" only where every request was confirmed by the person named — never "Something else", never a pre-list request. */
  bulkAcceptable: boolean;
  disputes: AdminPrivateCalendarDispute[];
};

function groupByReason(disputes: AdminPrivateCalendarDispute[]): ReasonGroup[] {
  const groups = new Map<string, ReasonGroup>();
  for (const dispute of disputes) {
    const code = dispute.explanation?.reasonCode ?? null;
    const key = code ?? "legacy";
    const group = groups.get(key) ?? {
      bulkAcceptable: code !== null && code !== "other",
      disputes: [],
      key,
      reasonCode: code,
      title: code ? explainReason(code).label : "Filed before the reason list",
    };
    group.disputes.push(dispute);
    if (dispute.explanation?.confirmationStatus !== "confirmed") group.bulkAcceptable = false;
    groups.set(key, group);
  }
  const rank = (group: ReasonGroup) => (group.reasonCode ? EXPLAIN_REASON_CODES.indexOf(group.reasonCode) : EXPLAIN_REASON_CODES.length);
  return Array.from(groups.values()).sort((left, right) => rank(left) - rank(right));
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
  const [done, setDone] = useState<string | null>(null);
  const [noteById, setNoteById] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  // "Accept all" takes two clicks: the first arms one group, the second sends it.
  const [armedGroup, setArmedGroup] = useState<string | null>(null);
  const shelfCounts: Record<Shelf, number> = { awaiting: 0, declined: 0, ready: 0 };
  for (const dispute of disputes) shelfCounts[shelfOf(dispute)] += 1;
  const [bulkBusy, setBulkBusy] = useState(false);

  async function acceptGroup(group: ReasonGroup) {
    setError(null);
    setDone(null);
    setBulkBusy(true);
    try {
      const response = await fetch("/api/private-calendar/disputes/decide-many", {
        body: JSON.stringify({ decision: "accept", disputeIds: group.disputes.map((dispute) => dispute.id), note: "" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to accept these requests.");
      const decidedIds = new Set<string>(
        (Array.isArray(payload.data?.decided) ? payload.data.decided : []).map((dispute: { id: string }) => dispute.id),
      );
      const people = new Set(group.disputes.filter((dispute) => decidedIds.has(dispute.id)).map((dispute) => dispute.employeeHrId)).size;
      setDisputes((current) => current.filter((dispute) => !decidedIds.has(dispute.id)));
      setDone(
        `Accepted ${decidedIds.size} ${group.title.toLowerCase()} request${decidedIds.size === 1 ? "" : "s"} from ${people} ${people === 1 ? "person" : "people"}. Each person was told once, with every day listed.`,
      );
    } catch (bulkError) {
      setError(bulkError instanceof Error ? bulkError.message : "Unable to accept these requests.");
    } finally {
      setBulkBusy(false);
      setArmedGroup(null);
    }
  }

  async function decide(disputeId: string, decision: "accept" | "reject") {
    const note = (noteById[disputeId] ?? "").trim();
    setError(null);
    setDone(null);
    setSubmittingId(disputeId);
    try {
      const response = await fetch(`/api/private-calendar/disputes/${disputeId}/decide`, {
        body: JSON.stringify({ decision, note }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to decide this dispute.");
      const decided = disputes.find((dispute) => dispute.id === disputeId);
      const who = decided?.employeeName ?? "The employee";
      setDisputes((current) => current.filter((dispute) => dispute.id !== disputeId));
      // It leaves this inbox, which holds only what is waiting; the decided case stays readable in the
      // Dispute Center for both sides, for ever.
      setDone(
        decision === "accept"
          ? `Accepted. ${who}'s day now shows as explained, and they were told. It stays readable in the Dispute Center.`
          : `Rejected. ${who}'s day stays as it was, and they were told why. It stays readable in the Dispute Center.`,
      );
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Unable to decide this dispute.");
    } finally {
      setSubmittingId(null);
    }
  }

  // One request's card. A function, not a component, so the decide() pins and the note state stay
  // exactly where they were before the inbox was grouped.
  const renderCard = (dispute: AdminPrivateCalendarDispute) => (
    <div className="px-5 py-4" key={dispute.id}>
      {/* The sentence FIRST, then the labels. A reviewer who reads only one line must still
          know who is asking, about which day, and for what. */}
      <p className="text-base font-bold text-slate-900">{claimSentence(dispute)}</p>

      {/* The day, the scope and the wait as one quiet line — the name is already in the sentence
          above, so it is not repeated as a chip beside it. */}
      <p className={cn(phxLabelTextClassName, "mt-2 flex flex-wrap items-center gap-x-2 gap-y-1")}>
        <span className="tabular-nums text-slate-600">{formatDate(dispute.disputeDate)}</span>
        <span aria-hidden className="text-slate-300">/</span>
        <span>{dispute.itemSource ? `One ${dispute.context?.itemSourceLabel ?? dispute.itemSource} record` : "Whole day"}</span>
        {dispute.context ? (
          <>
            <span aria-hidden className="text-slate-300">/</span>
            <span className={dispute.context.waitingDays >= 3 ? "text-amber-700" : undefined}>
              {dispute.context.waitingDays === 0
                ? "Raised today"
                : `Waiting ${dispute.context.waitingDays} day${dispute.context.waitingDays === 1 ? "" : "s"}`}
            </span>
          </>
        ) : null}
      </p>

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

      {/* Three facts side by side on a desktop, stacked on a phone, ruled like a ledger. */}
      <div className="mt-4 grid divide-y divide-slate-200 border border-slate-200 md:grid-cols-3 md:divide-x md:divide-y-0">
        <div className="min-w-0 px-3 py-2.5">
          <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">The calendar shows</p>
          <p className="mt-1 break-words text-sm font-semibold text-slate-700">{dispute.displayedSummary}</p>
        </div>
        {dispute.explanation ? (
          <>
            <div className="min-w-0 px-3 py-2.5">
              <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Their reason</p>
              <p className="mt-1 text-sm font-black text-slate-900">{explainReason(dispute.explanation.reasonCode).label}</p>
              {dispute.explanation.detailText ? (
                <p className="mt-0.5 whitespace-pre-wrap break-words text-sm font-semibold text-slate-700">{dispute.explanation.detailText}</p>
              ) : null}
              {dispute.explanation.dates.length > 1 ? (
                <p className="mt-1 text-xs font-semibold text-slate-500">
                  Sent together for {dispute.explanation.dates.length} days: {explainDatesPhrase(dispute.explanation.dates)}
                </p>
              ) : null}
            </div>
            <div className="min-w-0 px-3 py-2.5">
              <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Confirmation</p>
              {dispute.explanation.confirmerHrId ? (
                <>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{dispute.explanation.confirmerName ?? "The person they named"}</p>
                  <p
                    className={cn(
                      "mt-1 flex items-center gap-1.5 text-phx-xs font-black uppercase tracking-[0.08em]",
                      CONFIRMATION_MARK[dispute.explanation.confirmationStatus]?.ink,
                    )}
                  >
                    <span aria-hidden className={cn("h-2 w-2 shrink-0", CONFIRMATION_MARK[dispute.explanation.confirmationStatus]?.square)} />
                    {EXPLAIN_CONFIRMATION_LABELS[dispute.explanation.confirmationStatus]}
                  </p>
                  {dispute.explanation.confirmationNote ? (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm font-semibold text-slate-700">{dispute.explanation.confirmationNote}</p>
                  ) : null}
                </>
              ) : (
                <p className="mt-1 text-sm font-semibold text-slate-700">Nobody to confirm it. Read their words and decide.</p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="min-w-0 px-3 py-2.5">
              <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">They say it was</p>
              <p className="mt-1 break-words text-sm font-semibold text-slate-900">{dispute.claimText}</p>
            </div>
            <div className="min-w-0 px-3 py-2.5">
              <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Check it with</p>
              <p className="mt-1 break-words text-sm font-semibold text-slate-900">
                {dispute.claimSourceText}
                {dispute.context?.managerName ? ` — ${dispute.context.managerName}` : ""}
              </p>
            </div>
          </>
        )}
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

      {/* THE DECISION IS ALWAYS ON THE CARD (owner, 2026-11-07: "today I do not have the option
          except reply"). It sat behind a small "Review" button under the conversation, which
          read as if replying were the only thing this inbox could do. */}
      <div className="mt-3 border border-slate-200 bg-slate-50 p-3">
        {/* What each button actually does, beside the buttons. Accepting overlays the
            verified correction on the calendar day; the original punch or CRM visit is
            never rewritten, because Phoenix does not own that upstream record. */}
        <p className="text-sm font-semibold text-slate-600">
          <span className="font-black text-emerald-800">Accept</span> marks that day as explained in their calendar and
          sends them your note. The original punch or visit record is not changed.{" "}
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
        </div>
      </div>
    </div>
  );

  return (
    <section className="border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-100 bg-slate-900 px-5 py-3">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
          {disputes.length} review request{disputes.length === 1 ? "" : "s"} pending
        </h2>
        {/* How the pile splits, before any scrolling: what is yours now, and what is still out. */}
        {disputes.length > 0 ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">
            {SHELVES.map((shelf) => {
              const count = shelfCounts[shelf];
              if (count === 0) return null;
              return (
                <span className={shelf === "ready" ? "text-orange-300" : undefined} key={shelf}>
                  <span className="tabular-nums">{count}</span> {SHELF_SHORT[shelf]}
                </span>
              );
            })}
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {done ? (
        <div className="flex items-center gap-2 border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-semibold text-emerald-800" role="status">
          <Check className="h-4 w-4 shrink-0" />
          {done}
        </div>
      ) : null}

      {disputes.length === 0 ? (
        <div className="p-10 text-center">
          <p className="text-sm font-bold text-slate-500">No review requests are waiting.</p>
        </div>
      ) : (
        <div>
          {SHELVES.map((shelf) => {
            const onShelf = disputes.filter((dispute) => shelfOf(dispute) === shelf);
            if (onShelf.length === 0) return null;
            return (
              <div key={shelf}>
                <div className="border-b border-slate-200 bg-slate-100 px-5 py-2.5">
                  <h3 className="flex items-center gap-2 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-700">
                    <span aria-hidden className={cn("h-2 w-2 shrink-0", shelf === "ready" ? "bg-orange-600" : shelf === "declined" ? "bg-rose-600" : "bg-slate-400")} />
                    {SHELF_TITLES[shelf]}
                    <span className="tabular-nums text-slate-500">· {onShelf.length}</span>
                  </h3>
                  <p className="mt-0.5 pl-4 text-xs font-semibold text-slate-500">{SHELF_NOTES[shelf]}</p>
                </div>
                {groupByReason(onShelf).map((group) => {
                  const groupKey = `${shelf}:${group.key}`;
                  const people = new Set(group.disputes.map((dispute) => dispute.employeeHrId)).size;
                  const span = explainDatesPhrase(group.disputes.map((dispute) => dispute.disputeDate));
                  const offerAll = shelf === "ready" && group.bulkAcceptable && group.disputes.length > 1;
                  return (
                    <div className="border-b border-slate-200" key={groupKey}>
                      <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-5 py-2">
                        <p className="text-sm font-black text-slate-900">
                          {group.title}
                          <span className="ml-2 text-xs font-semibold text-slate-500">
                            {group.disputes.length} request{group.disputes.length === 1 ? "" : "s"} · {people} {people === 1 ? "person" : "people"}
                            {span ? ` · ${span}` : ""}
                          </span>
                        </p>
                        {offerAll ? (
                          armedGroup === groupKey ? (
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="text-xs font-bold text-slate-700">Every one was confirmed by the person named.</span>
                              <button className={phxButtonApproveClassName} disabled={bulkBusy} onClick={() => acceptGroup(group)} type="button">
                                <Check className="h-3.5 w-3.5" />
                                Yes, accept all {group.disputes.length}
                              </button>
                              <button className={phxButtonGhostClassName} disabled={bulkBusy} onClick={() => setArmedGroup(null)} type="button">
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button className={phxButtonApproveClassName} disabled={bulkBusy} onClick={() => setArmedGroup(groupKey)} type="button">
                              <Check className="h-3.5 w-3.5" />
                              Accept all {group.disputes.length}
                            </button>
                          )
                        ) : null}
                      </div>
                      <div className="divide-y divide-slate-100">{group.disputes.map((dispute) => renderCard(dispute))}</div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
