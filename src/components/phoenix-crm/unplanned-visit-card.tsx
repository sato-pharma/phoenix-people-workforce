"use client";

/**
 * Phoenix CRM — a rep's off-plan DAY, as the manager and then the SFE see it.
 *
 * Owner, 2026-09-26: a rep may visit a customer who is not on today's plan, but he writes why, and the
 * visit counts in NOTHING until his direct manager approves it and then the SFE does. One refusal at
 * either step ends it, and a refusal needs a note, because the rep reads why.
 *
 * Owner, 2026-10-02 ("Off-plan day in one place"): about 48 of these reach one SFE Manager a day, so
 * the visits waiting at the viewer's step are ONE card per rep per visit day, the oldest day first,
 * instead of a card each. A person still decides EACH visit. Every visit keeps its own Approve and
 * Refuse exactly as before, and "Approve all" — behind a confirm — is a loop of that same decision,
 * one per visit, through the one route that decides a visit (`postOffPlanDecision`). One that fails is
 * named and the others stand; nothing is decided that nobody pressed for.
 *
 * Each visit shows what it is decided on: the customer, AM or PM, what the rep wrote, and — when the
 * customer stood on his sent plan for another day of that week — the day it was planned for, read by
 * the SERVER from the plan as it stood when he logged the visit, never from his text. The rest of the
 * evidence is on the visit and is shown rather than described: the photo when there is one, what he
 * discussed, and where he stood.
 */

import { useId, useState, type ReactNode } from "react";
import { CalendarClock } from "lucide-react";

import { AdministratorStepNote } from "@/components/phoenix-crm/administrator-decline";
import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { cairoStamp, countText, dayLabelLong } from "@/components/phoenix-crm/format";
import { listText } from "@/components/phoenix-crm/labels";
import { OffPlanStandingStrip } from "@/components/phoenix-crm/offplan-allowance";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { CrmButton, CrmCard, CrmField, CrmNote, CrmPill, crmTextareaClassName, type NoteTone, type PillTone } from "@/components/phoenix-crm/ui";
import {
  APPROVE_ALL_FROM,
  approveAllFailureText,
  approveAllNotice,
  approveAllTargets,
  offPlanDecisionBody,
  plannedForText,
  type ApproveAllOutcome,
  type OffPlanDay,
} from "@/lib/phoenix-crm/offplan-day";
import { OFF_PLAN_EXEMPT_CARD_TEXT } from "@/lib/phoenix-crm/offplan-cap-rules";
import { planDayLabel } from "@/lib/phoenix-crm/plan-rules";
import { UNPLANNED_DECISION_NOTE_MAX, type UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";
import type { TeamUnplannedVisit } from "@/lib/phoenix-crm/view-types";

const STATUS: Record<UnplannedVisitStatus, { label: string; tone: PillTone; accent: string }> = {
  // A recorded visit: the Administrator approves it first, on the Visit Recording page (owner, 2026-10-16).
  admin_pending: { label: "Waiting for the Administrator", tone: "warn", accent: "border-l-amber-500" },
  manager_pending: { label: "Waiting for the manager", tone: "warn", accent: "border-l-amber-500" },
  sfe_pending: { label: "Waiting for SFE", tone: "warn", accent: "border-l-amber-500" },
  approved: { label: "Approved — it counts", tone: "good", accent: "border-l-emerald-500" },
  refused: { label: "Refused — it does not count", tone: "bad", accent: "border-l-rose-500" },
};

/** What the decider needs to know about where the rep stood, in the words the visit already uses. */
function locationLine(flag: string | null): string | null {
  if (flag === "far") return "Saved far from the customer's place.";
  if (flag === "weak_gps") return "Weak location signal when it was saved.";
  if (flag === "no_place") return "No place saved yet to compare with.";
  return null;
}

/** The visit's own Approve, in words that say where it goes. */
function approveLabel(status: UnplannedVisitStatus): string {
  return status === "manager_pending" ? "Approve · goes to SFE" : "Approve · it counts";
}

/** Where "Approve all" sends the day's visits, when they all sit at one step. */
function approveAllStep(visits: ReadonlyArray<TeamUnplannedVisit>): "manager" | "sfe" | null {
  if (visits.every((visit) => visit.status === "manager_pending")) return "manager";
  if (visits.every((visit) => visit.status === "sfe_pending")) return "sfe";
  return null;
}

/**
 * THE one decision of one off-plan visit — the route its own Approve and Refuse post to, and the route
 * "Approve all" posts to once per visit. The route reads the step from the row and checks this person
 * against it every time (server/unplanned.ts `decideUnplannedVisit`), and notifies the rep of each.
 */
function postOffPlanDecision(visit: TeamUnplannedVisit, decision: "approve" | "refuse", note: string | null): Promise<unknown> {
  return crmPost("/api/phoenix-crm/visits/unplanned", offPlanDecisionBody(visit, decision, note), "visit");
}

/** What the Team tab shows at its top once "Approve all" has run. */
export type OffPlanDayNotice = { tone: NoteTone; title: string; message: ReactNode };

function OffPlanVisitRow({
  disabled,
  onChanged,
  showStatus,
  visit,
}: {
  /** "Approve all" is running on this card. */
  disabled: boolean;
  /** A decision saved; the Team tab reads its counts again. */
  onChanged: (message: string) => void;
  /** The card's own pill does not already say which step this visit waits on. */
  showStatus: boolean;
  visit: TeamUnplannedVisit;
}) {
  const fieldId = useId();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "refuse" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const status = STATUS[visit.status];
  const noteId = `${fieldId}-note`;
  const location = locationLine(visit.locationFlag);
  const plannedFor = plannedForText(visit.plannedFor);
  const locked = disabled || busy !== null;

  async function decide(decision: "approve" | "refuse") {
    const trimmed = note.trim();
    if (decision === "refuse" && !trimmed) {
      setProblem("Write a note for the rep explaining why.");
      return;
    }
    setBusy(decision);
    setProblem(null);
    try {
      await postOffPlanDecision(visit, decision, trimmed || null);
      onChanged(`${decision === "approve" ? "Approved" : "Refused"}: off-plan visit to ${visit.customerName}.`);
    } catch (error) {
      setProblem(messageOf(error));
      const code = errorCodeOf(error);
      if (code === "phoenix_crm_unplanned_decided" || code === "phoenix_crm_unplanned_wrong_stage") {
        onChanged(`${visit.customerName}: this visit was already decided.`);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid min-w-0 gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex min-w-0 items-start gap-3">
        {visit.photoPath ? (
          <CrmPhotoThumb
            alt={`Visit photo: ${visit.customerName}`}
            caption={`${visit.customerName} · ${cairoStamp(visit.raisedAt)}`}
            path={visit.photoPath}
          />
        ) : null}
        <div className="grid min-w-0 flex-1 gap-1.5 text-sm leading-6">
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            {/* A floor, not `min-w-0` — see visit-customer-picker.tsx for the measurement. */}
            <p className="min-w-[9rem] flex-1 break-words font-black text-slate-950">{visit.customerName}</p>
            <span className="flex max-w-full flex-wrap gap-1">
              <CrmPill>{listText(visit.customerListType)}</CrmPill>
              {/* Waiting on somebody else: which step it is on, when the card's own pill does not say it.
                  At this viewer's step the button says it. */}
              {showStatus ? <CrmPill tone={status.tone}>{status.label}</CrmPill> : null}
            </span>
          </div>
          {/* The day he was planned to be seen, from the plan itself as it stood when the visit was logged
              — the server's reading, never the rep's text (owner, 2026-10-02). */}
          {plannedFor ? (
            <p className="flex min-w-0 items-start gap-1.5 text-xs font-black leading-5 text-sky-800">
              <CalendarClock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 break-words">{plannedFor}</span>
            </p>
          ) : null}
          <p className="whitespace-pre-line break-words font-medium text-slate-700">
            <span className="font-black text-slate-800">Why they went: </span>
            {visit.clarification ? <span dir="auto">{visit.clarification}</span> : <span className="text-slate-500">No reason written</span>}
          </p>
          {visit.speciality ? <p className="break-words text-xs font-semibold text-slate-500">{visit.speciality}</p> : null}
          {visit.products.length > 0 ? (
            <p className="break-words text-xs font-semibold text-slate-600">
              <span className="font-black text-slate-800">Products: </span>
              {visit.products.join(", ")}
            </p>
          ) : null}
          {visit.comment ? (
            <p className="whitespace-pre-line break-words text-xs font-semibold text-slate-600">
              <span className="font-black text-slate-800">Comment: </span>
              <span dir="auto">{visit.comment}</span>
            </p>
          ) : null}
          {location ? <p className="break-words text-xs font-semibold text-amber-800">{location}</p> : null}
          {/* Who was with him. Added 2026-10-12: the card carried only the evidence, so a manager
              deciding a visit he had been on himself read nothing that said so. It is a fact about the
              visit, not a mark against anybody, and it changes no step of the chain. */}
          {visit.companions.length > 0 ? (
            <p className="break-words text-xs font-semibold text-slate-600">
              <span className="font-black text-slate-800">On the visit: </span>
              {visit.companions.map((companion) => `${companion.name} (${companion.role})`).join(", ")}
            </p>
          ) : null}
          {/* The first step, once it is past. The SFE reads who already said yes before saying it too. */}
          {visit.managerDecidedByName ? (
            <p className="break-words text-xs font-semibold text-slate-600">
              Approved by {visit.managerDecidedByName}
              {visit.managerDecidedByWasOnTheVisit ? ", who was on the visit" : ""}
              {visit.managerNote ? ` · ${visit.managerNote}` : ""}
            </p>
          ) : null}
        </div>
      </div>

      {visit.canDecide || (visit.canOverride && (visit.status === "manager_pending" || visit.status === "sfe_pending")) ? (
        <div className="grid min-w-0 gap-2">
          {/* The Administrator takes the step the visit is AT, with the same buttons (owner, 2026-10-14). */}
          {!visit.canDecide ? <AdministratorStepNote holder={visit.status === "sfe_pending" ? "SFE" : "the district manager"} /> : null}
          <CrmField hint="Needed to refuse. The rep reads it." htmlFor={noteId} label="Note for the rep">
            <textarea
              className={crmTextareaClassName}
              disabled={locked}
              id={noteId}
              maxLength={UNPLANNED_DECISION_NOTE_MAX}
              onChange={(event) => {
                setProblem(null);
                setNote(event.target.value);
              }}
              rows={2}
              value={note}
            />
          </CrmField>
          <div className="flex flex-wrap gap-2">
            <CrmButton disabled={locked} onClick={() => void decide("approve")} variant="primary">
              {busy === "approve" ? "Approving…" : approveLabel(visit.status)}
            </CrmButton>
            <CrmButton disabled={locked} onClick={() => void decide("refuse")}>
              {busy === "refuse" ? "Refusing…" : "Refuse"}
            </CrmButton>
          </div>
          {problem ? (
            <CrmNote tone="bad" title="The decision was not saved">
              {problem}
            </CrmNote>
          ) : null}
        </div>
      ) : null}

    </div>
  );
}

/**
 * One rep's off-plan visits on one day. On the viewer's own half of the Team tab every visit on the card
 * is waiting at his step, and "Approve all" decides exactly those; on the other half the card is read
 * only, and each visit says whose step it is waiting on.
 */
export function OffPlanDayCard({
  day,
  onBatchDone,
  onChanged,
}: {
  day: OffPlanDay<TeamUnplannedVisit>;
  /** "Approve all" has run: what went through, and by name what did not. */
  onBatchDone: (notice: OffPlanDayNotice) => void;
  /** One visit's own decision saved; the Team tab reads its counts again. */
  onChanged: (message: string) => void;
}) {
  const targets = approveAllTargets(day);
  const [confirming, setConfirming] = useState(false);
  // How many of the targets "Approve all" has finished, while it runs; null when it is not running.
  const [done, setDone] = useState<number | null>(null);
  const running = done !== null;
  const count = countText(targets.length);
  const step = approveAllStep(targets);
  const statuses = new Set(day.visits.map((visit) => visit.status));
  const [onlyStatus] = statuses.size === 1 ? [...statuses] : [];

  async function approveAll() {
    const visits = [...targets];
    setConfirming(false);
    setDone(0);
    const outcomes: ApproveAllOutcome[] = [];
    // One at a time, in the order he logged them: each is its own decision through its own route, and a
    // refusal of one is named while the rest go on.
    for (const visit of visits) {
      try {
        await postOffPlanDecision(visit, "approve", null);
        outcomes.push({ customerName: visit.customerName, ok: true });
      } catch (error) {
        outcomes.push({ customerName: visit.customerName, ok: false, why: approveAllFailureText(errorCodeOf(error), messageOf(error)) });
      }
      setDone(outcomes.length);
    }
    setDone(null);
    const notice = approveAllNotice({ repName: day.repName, visitDate: day.visitDate, outcomes });
    onBatchDone({
      tone: notice.tone,
      title: notice.title,
      message:
        notice.failures.length > 0 ? (
          <span className="grid gap-0.5">
            <span className="block">Not approved:</span>
            {notice.failures.map((line, index) => (
              <span className="block" dir="auto" key={index}>
                {line}
              </span>
            ))}
          </span>
        ) : null,
    });
  }

  return (
    <CrmCard
      accent={onlyStatus ? STATUS[onlyStatus].accent : "border-l-amber-500"}
      meta={[dayLabelLong(day.visitDate), day.territoryName].filter(Boolean).join(" · ")}
      status={
        targets.length > 0 ? (
          <CrmPill tone="warn">{`${count} waiting for you`}</CrmPill>
        ) : onlyStatus ? (
          <CrmPill tone={STATUS[onlyStatus].tone}>{STATUS[onlyStatus].label}</CrmPill>
        ) : (
          <CrmPill tone="warn">{`${countText(day.visits.length)} waiting`}</CrmPill>
        )
      }
      title={day.repName}
    >
      {targets.length >= APPROVE_ALL_FROM ? (
        confirming ? (
          <div className="mb-3 grid min-w-0 gap-2 border border-orange-200 bg-orange-50/40 px-3.5 py-3">
            <p className="break-words text-sm font-black text-slate-950">{`Approve all ${count} off-plan visits on ${planDayLabel(day.visitDate)}?`}</p>
            <p className="break-words text-sm font-medium leading-6 text-slate-600">
              Each one is approved on its own, as your decision, exactly as its own Approve does, and the rep is told of each.
              {step === "manager" ? " They go on to SFE, who decides the last step." : step === "sfe" ? " Each one counts from then." : ""} One that cannot
              be approved is named, and the others stand.
            </p>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
              <CrmButton onClick={() => void approveAll()} variant="primary">
                {`Approve all ${count}`}
              </CrmButton>
              <CrmButton onClick={() => setConfirming(false)}>Not yet</CrmButton>
            </div>
          </div>
        ) : (
          <div className="mb-3 flex min-w-0 flex-wrap items-center gap-2">
            <CrmButton busy={running} onClick={() => setConfirming(true)} variant="primary">
              {running
                ? `Approving ${countText(Math.min((done ?? 0) + 1, targets.length))} of ${count}…`
                : `Approve all ${count}${step === "manager" ? " · they go to SFE" : step === "sfe" ? " · they count" : ""}`}
            </CrmButton>
            <span className="min-w-0 break-words text-xs font-semibold leading-5 text-slate-500">Or decide each visit below.</span>
          </div>
        )
      ) : null}
      {/* Where the rep stood that day and that week — the same for every visit on the card, so it is read once. */}
      <OffPlanStandingStrip standing={day.visits[0].repOffPlan} />
      {/* A visit under a named exception to the limit (owner, 2026-10-17) says so, so a long day there reads as expected. */}
      {day.visits.some((visit) => visit.offPlanExempt) ? (
        <p className="mb-3 min-w-0 break-words border border-l-4 border-emerald-200 border-l-emerald-600 bg-emerald-50/40 px-3 py-2 text-xs font-bold leading-5 text-emerald-900">
          {OFF_PLAN_EXEMPT_CARD_TEXT}
        </p>
      ) : null}
      <div className="grid min-w-0 divide-y divide-slate-100">
        {day.visits.map((visit) => (
          <OffPlanVisitRow
            disabled={running}
            key={visit.visitId}
            onChanged={onChanged}
            showStatus={!visit.canDecide && !onlyStatus}
            visit={visit}
          />
        ))}
      </div>
    </CrmCard>
  );
}
