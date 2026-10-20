"use client";

/**
 * Phoenix CRM — one week of the plan board (owner, 2026-09-29).
 *
 * A week is due the Thursday before it. A late week is ACCEPTED and STAMPED — never refused, because a
 * rep who cannot plan cannot work. The week carries its own status, its own due date, its own late
 * stamp and its own buttons: Send this week for the rep, Approve and Return for the reviewer (the SFE
 * Manager can Return). Nothing here sends or approves on its own — every one of them is a press, and
 * Send asks once more before it goes.
 *
 * 🔴 Owner, 2026-10-01: a rep no longer takes a sent week back himself. "Ask to edit this week" — one
 * button, no reason — sends a request to his district manager, then SFE, and SFE's approval
 * opens the week again (plan-edits.ts). Where the request stands is said on the week. A week can be
 * asked to edit twice at most (owner, 2026-10-20): the count left sits under the button, and once both
 * asks are spent the button gives way to a note saying so.
 *
 * Its six days sit under it as tabs; the day on screen is PlanDayPanel.
 *
 * 🔴 Owner, 2026-10-02 — "Only that day" reopens: a reviewer may return ONE day of a sent week
 * (PlanDecision's "Return one day"). On the rep's own week that day is the only one he can open — the
 * others are greyed, "As sent" — and the week says "Your manager returned Tuesday 6 Oct: <note>". The
 * server holds the same line (`assertRepMayChangeWeek` → `savePlan`), so greying is never the guard.
 * The days left as sent still count as PLANNED ("Still planned", owner, 2026-10-02 — plan-rules.ts
 * `planDayStatus`); only the returned day's visits wait for the week to be sent again.
 *
 * Beside each copy sits its suggestion (owner, 2026-09-30): "Suggest the week" beside "Copy last week",
 * "Suggest this day" beside "Copy a day". Both go through `onCopied`, the board's one way into the
 * draft, so a suggestion is reviewed and saved exactly like a copy. The rep sees them on his own plan
 * only; on a week or day he cannot change they stay on screen, disabled, with the reason in words.
 *
 * The week and the day on screen each carry an orange bar and a tick in their chooser, so on a long
 * page he never has to work out which week he is changing.
 */

import { useState, type ReactNode } from "react";
import { Check } from "lucide-react";

import { cairoStamp, countText, dayLabel, plural, weekLabel } from "@/components/phoenix-crm/format";
import type { BrickTint } from "@/components/phoenix-crm/brick-tints";
import { PlanCopyMenu, PlanSuggestMenu, type CopiedPlacements, type SuggestContext } from "@/components/phoenix-crm/plan-copy-menu";
import { PlanDayPanel } from "@/components/phoenix-crm/plan-day-panel";
import { decisionBusy, PlanDecision, type PlanDecisionAction } from "@/components/phoenix-crm/plan-decision";
import { CrmBlock, CrmButton, CrmChoice, CrmFacts, CrmNote, CrmPill, type NoteTone, type PillTone } from "@/components/phoenix-crm/ui";
import { monthStartOf } from "@/lib/phoenix-crm/calendar";
import { dayActivityLabel, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { planEditAsksLeftLine, planEditAsksNote, planEditRepNote, type PlanEditStatus } from "@/lib/phoenix-crm/plan-edit-rules";
import { startsOn, type PlanDayStarts, type PlannedDayStart } from "@/lib/phoenix-crm/plan-day-starts";
import type { DoctorFilter } from "@/lib/phoenix-crm/plan-filters";
import { returnableDays } from "@/lib/phoenix-crm/plan-review-rules";
import { dayOffPhrase, planDayLabel, type PlanItemDraft } from "@/lib/phoenix-crm/plan-rules";
import { activityOn, daySuggestBlock, weekSuggestBlock, type GradeTargets, type SuggestBlock, type SuggestInput } from "@/lib/phoenix-crm/plan-suggest";
import {
  activitiesOn,
  dayCounts,
  dayFullness,
  dayOffOf,
  emptyDayText,
  emptyPlanDays,
  indexCustomers,
  resolveDayRows,
  type DailyCaps,
  type DayFullness,
  type DraftProblem,
  type PlannedActivity,
} from "@/lib/phoenix-crm/plan-week-draft";
import type { PlannerCustomer } from "@/lib/phoenix-crm/suggestions";
import type { PhoenixCrmDoctorListType, PhoenixCrmGrade, PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import type { MonthlyWeekView, PlanDayView } from "@/lib/phoenix-crm/view-types";

export const PLAN_STATUS_TONE: Record<PhoenixCrmPlanStatus | "none", PillTone> = {
  none: "neutral",
  draft: "neutral",
  submitted: "warn",
  approved: "good",
  returned: "bad",
};

/** What a week's own button is doing. */
export type WeekBusy = "send" | "ask" | PlanDecisionAction;

/** How a request to edit the week reads on it, by where it stands. */
const EDIT_TONE: Record<PlanEditStatus, NoteTone> = {
  manager_pending: "info",
  sfe_pending: "info",
  reopened: "good",
  refused: "bad",
  expired: "warn",
};

/** Why a week's draft is held on the page. */
export type WeekHold = "changed" | "unchecked";

/** "Sat 10 Oct has 16 PM. A day holds 15 PM at most." — a problem the server would refuse, said to the rep. */
export function problemText(problem: DraftProblem): string {
  const day = dayLabel(problem.date);
  if (problem.kind === "holiday") return `${day} is ${dayOffPhrase({ kind: "holiday", name: problem.holiday })}. Take ${problem.name} off it.`;
  if (problem.kind === "leave") return `${day} is ${dayOffPhrase({ kind: "leave", name: problem.leave })}. Take ${problem.name} off it.`;
  if (problem.kind === "morning") return `${day} is a morning for AM only. Take ${problem.name} off it.`;
  return `${day} has ${problem.count} ${problem.listType}. A day holds ${problem.cap} ${problem.listType} at most.`;
}

/**
 * A week returned for ONE day (owner, 2026-10-02): the rep reads "Your manager returned Tuesday 6 Oct:
 * <note>" and what to do; a reviewer reads the same day as the one left open to the rep.
 */
export function ReturnedDayNote({
  className,
  day,
  decidedBySfe,
  note,
  today,
  viewerIsRep,
}: {
  className?: string;
  day: string;
  decidedBySfe: boolean;
  note: string | null;
  today: string;
  viewerIsRep: boolean;
}) {
  const name = planDayLabel(day);
  return (
    <CrmNote className={className} tone="warn">
      <span className="block font-black">
        {viewerIsRep ? `${decidedBySfe ? "SFE" : "Your manager"} returned ${name}` : `Returned ${name} only`}
        {note ? (
          <>
            : <span className="whitespace-pre-line font-medium">{note}</span>
          </>
        ) : null}
      </span>
      <span className="mt-1 block">
        {viewerIsRep
          ? day < today
            ? `${name} has passed, so it can no longer change. Send the week again as it is.`
            : `Change that day, then send the week again. The other days stay as you sent them, and your visits on them still count as planned. Until you send the week again, your visits on ${name} count as off-plan.`
          : "Only that day is open for the rep. Every other day stays as they sent it, and their visits on those days still count as planned."}
      </span>
    </CrmNote>
  );
}

/** A week or day option: the one on screen carries a tick, so it reads without the colour too. */
export function ChoiceLabel({ children, chosen }: { children: ReactNode; chosen: boolean }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {chosen ? <Check aria-hidden className="h-4 w-4 shrink-0 text-orange-600" /> : null}
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/** Why the rep cannot change the week, said under a suggestion button that is off. */
function weekClosedReason(week: MonthlyWeekView): string {
  if (!week.open) return "This week has passed.";
  if (week.status === "submitted") return "This week is sent for review. Ask to edit it to change it.";
  if (week.status === "approved") return "This week is approved. Ask to edit it to change it.";
  return "You plan one week at a time, and this is not it.";
}

function weekSuggestReason(block: SuggestBlock | null): string | null {
  if (block === null) return null;
  if (block === "passed") return "Every day of this week has passed.";
  if (block === "activity") return "Every day left this week is taken by another activity.";
  return "Every day left this week already has its target placed.";
}

/** Why "Suggest this day" is off, naming the activity that takes the day when one does. */
function daySuggestReason(block: SuggestBlock | null, date: string, activities: ReadonlyArray<PlannedActivity>): string | null {
  if (block === null) return null;
  const name = dayLabel(date);
  if (block === "passed") return "This day has passed.";
  if (block === "activity") {
    const whole = activities.find((activity) => !activity.halfDay);
    return `${whole ? dayActivityLabel(whole.activityType) : "Another activity"} takes the whole of ${name}. Make it a half day to plan visits too.`;
  }
  const halfDays = activities.length > 0 && activities.every((activity) => activity.halfDay);
  return `${name} already has its target placed${halfDays ? ` beside its half-day ${activities.length === 1 ? "activity" : "activities"}` : ""}.`;
}

/**
 * "2 AM · 15 PM" on a day's button — never added together; a Thursday morning reads AM alone. A list
 * at its cap turns emerald where it stands, so the eye finds the full ones without reading a word.
 */
function DayPair({ counts, full, listTypes }: { counts: Record<PhoenixCrmDoctorListType, number>; full: DayFullness; listTypes: ReadonlyArray<PhoenixCrmDoctorListType> }) {
  const figure = (listType: PhoenixCrmDoctorListType) => (
    <span className={full[listType] ? "font-black text-emerald-700" : undefined}>
      {countText(counts[listType])} {listType}
    </span>
  );
  return listTypes.includes("PM") || counts.PM > 0 ? (
    <>
      {figure("AM")} · {figure("PM")}
    </>
  ) : (
    figure("AM")
  );
}

export function PlanWeekPanel({
  activities,
  autosave = false,
  busy,
  caps,
  changedDays,
  customers,
  dayFocus,
  dirty,
  editable,
  editLocked,
  filter,
  filterOptions,
  gradeTargets,
  hold,
  idPrefix,
  items,
  locked,
  onActivity,
  onAskToEdit,
  onCopied,
  onDay,
  onDecide,
  onFillDay,
  onFilter,
  onKeepMine,
  onPlace,
  onQuery,
  onRemove,
  onSend,
  onShowLatest,
  onStarts,
  problems,
  query,
  reviewList,
  reviewerSentence,
  seatId,
  section,
  turnSentence,
  selectedDay,
  showProblems,
  showSpread,
  starts,
  suggest,
  test,
  tints,
  today,
  viewerIsRep,
  week,
}: {
  /** The week's drafted activities, one of each kind a day (editable weeks only). */
  activities: ReadonlyArray<PlannedActivity>;
  /**
   * The rep's own board, which saves itself as he ticks (owner, 2026-10-02): no "Unsaved changes" pill —
   * the board's one status line says where the save stands — and no word asking him to press a Save
   * that is not there.
   */
  autosave?: boolean;
  busy: WeekBusy | null;
  caps: DailyCaps;
  /** A reviewer's steps (owner, 2026-10-02): the days a re-sent week changed since the send before. */
  changedDays?: ReadonlySet<string>;
  customers: ReadonlyArray<PlannerCustomer>;
  /** The rep's step form: the one list (AM or PM) step 3 is on. Unset shows the whole day. */
  dayFocus?: PhoenixCrmDoctorListType;
  dirty: boolean;
  /** The rep may still change this week: it is his, open, and a draft or returned. */
  editable: boolean;
  /**
   * Nothing may land in the draft: the ticks, the copies and the suggestions. `locked` when unset. The
   * rep's own board keeps them open while it saves itself and reads itself back, which locks the
   * week's buttons (Send, Ask to edit) but never his ticks.
   */
  editLocked?: boolean;
  filter: DoctorFilter;
  filterOptions: {
    bricks: ReadonlyArray<{ value: string; label: string }>;
    grades: ReadonlyArray<PhoenixCrmGrade>;
    specialities: ReadonlyArray<string>;
    /** Polyclinics and centres customers are seated in; absent or empty hides the picker. */
    venues?: ReadonlyArray<{ value: string; label: string }>;
  };
  /** The grade numbers (Settings): a validated customer's row reads his month against them. */
  gradeTargets: GradeTargets;
  /** The week's draft is held on the page through a save that failed or crossed another. */
  hold: WeekHold | null;
  idPrefix: string;
  /** The week's drafted placements (editable weeks only). */
  items: ReadonlyArray<PlanItemDraft>;
  locked: boolean;
  onActivity: (date: string, activityType: PhoenixCrmDayActivity, next: Pick<PlannedActivity, "halfDay" | "note"> | null) => void;
  /** "Ask to edit this week" — the request to the district manager, then SFE. */
  onAskToEdit: () => void;
  onCopied: (placements: CopiedPlacements) => void;
  onDay: (date: string) => void;
  /** A decision on the week; `day` names the ONE day returned (owner, 2026-10-02), else null. */
  onDecide: (action: PlanDecisionAction, note: string, day: string | null) => Promise<boolean>;
  /** "Fill the day for me" on the step form: the day's suggestion, applied to the draft. */
  onFillDay?: () => void;
  onFilter: (next: DoctorFilter) => void;
  onKeepMine: () => void;
  onPlace: (item: PlanItemDraft) => void;
  onQuery: (next: string) => void;
  onRemove: (date: string, customerId: string) => void;
  onSend: () => void;
  onShowLatest: () => void;
  onStarts: (date: string, next: PlanDayStarts) => void;
  problems: ReadonlyArray<DraftProblem>;
  query: string;
  /** A reviewer's steps (owner, 2026-10-02): the one list (AM or PM) his day step reads. Unset shows the whole day. */
  reviewList?: PhoenixCrmDoctorListType;
  /** "Ahmed Samir reviews it." */
  reviewerSentence: string;
  seatId: string;
  /**
   * The rep's step form (owner, 2026-10-02) shows the week a part at a time: "days" is step 2 (the
   * week's days, and suggest or copy the week), "day" is step 3 (one day's customers), "send" is step
   * 4 (where the week stands, Send this week, Ask to edit). Unset is the whole week at once — the
   * manager reviewing from Team, whose board is unchanged.
   */
  section?: "days" | "day" | "send";
  selectedDay: PlanDayView;
  /**
   * Whose turn this week is on (`planTurnSentence`), shown exactly where the decision block would
   * have been when there is no decision to make (owner, 2026-10-07: "no buttons, but say whose turn
   * it is"). Before it, a manager who had returned a week scrolled to the bottom of it and found the
   * page simply ending.
   */
  turnSentence?: string | null;
  showProblems: boolean;
  showSpread: boolean;
  /** The week's drafted Start AM / Start PM (editable weeks only). */
  starts: ReadonlyArray<PlannedDayStart>;
  /** The grade numbers and the month so far, for the two suggestions — null for anyone but the rep. */
  suggest: SuggestContext | null;
  test: boolean;
  tints: ReadonlyMap<string, BrickTint>;
  today: string;
  viewerIsRep: boolean;
  week: MonthlyWeekView;
}) {
  const [confirm, setConfirm] = useState<"send" | "ask" | null>(null);
  const draftLocked = editLocked ?? locked;

  const byId = indexCustomers(customers);
  const { plan } = week;
  const status = plan?.status ?? null;
  const dayCountsOf = (day: PlanDayView): Record<PhoenixCrmDoctorListType, number> =>
    editable && day.editable ? dayCounts(resolveDayRows(day, items, byId)) : day.counts;
  const totals = week.days.reduce(
    (sum, day) => {
      const counts = dayCountsOf(day);
      return { AM: sum.AM + counts.AM, PM: sum.PM + counts.PM };
    },
    { AM: 0, PM: 0 },
  );
  const placed = totals.AM + totals.PM;
  // The days he left empty, named where he sends (owner, 2026-10-02) — read from the draft on screen.
  const emptyDays = editable ? emptyPlanDays(week, items, activities, byId) : [];
  const editingDay = editable && selectedDay.editable;
  const target = { week, items };

  // The two suggestions read the same draft a copy does, and land through the same onCopied.
  const suggestInput: SuggestInput | null = suggest && editable ? { week, items, activities, customers, caps, ...suggest } : null;
  const dayActivities = editingDay ? activitiesOn(activities, selectedDay.date) : [];
  const weekReason = !suggest
    ? null
    : editable
      ? weekSuggestReason(weekSuggestBlock({ week, items, activities, customers, caps, dayTargets: suggest.dayTargets }))
      : weekClosedReason(week);
  const dayReason = !suggest
    ? null
    : editable
      ? daySuggestReason(
          daySuggestBlock({ day: selectedDay, items, activity: activityOn(dayActivities, selectedDay.date), customers, caps, dayTargets: suggest.dayTargets }),
          selectedDay.date,
          dayActivities,
        )
      : weekClosedReason(week);

  const whole = section === undefined;
  const showHeader = whole || section === "send";
  const showWeekSuggest = whole || section === "days";
  const showDays = whole || section === "days" || section === "send";
  const showDay = whole || section === "day";
  const showClose = whole || section === "send";

  const facts: Array<{ label: string; value: string }> = [{ label: "Due", value: week.dueOnLabel }];
  if (plan?.submittedAt) {
    facts.push({
      label: "Last sent for review",
      value: `${cairoStamp(plan.submittedAt)}${plan.submittedByName ? ` · ${plan.submittedByName}` : ""}${plan.submittedVia === "month" ? " · with the month" : ""}`,
    });
  }
  if (plan?.decidedAt && (status === "approved" || status === "returned")) {
    facts.push({
      label: status === "approved" ? "Approved" : "Returned",
      value: `${cairoStamp(plan.decidedAt)}${plan.decidedByName ? ` · ${plan.decidedByName}` : ""}${plan.decidedBySfe ? " (SFE Manager)" : ""}`,
    });
  }

  return (
    <div className="min-w-0">
      {section === "days" ? (
        // Step 2's line on the week it is about: its days, what is placed, and where it stands.
        <CrmBlock>
          <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="break-words text-lg font-black leading-tight text-slate-950">{weekLabel(week.weekStart)}</p>
              <p className="mt-1 break-words text-sm font-bold text-slate-700">
                {countText(totals.AM)} AM · {countText(totals.PM)} PM placed this week
              </p>
            </div>
            <span className="flex max-w-full flex-wrap gap-1">
              <CrmPill tone={PLAN_STATUS_TONE[status ?? "none"]}>{week.statusLabel}</CrmPill>
              {dirty && !autosave ? <CrmPill tone="orange">Unsaved changes</CrmPill> : null}
            </span>
          </div>
          {/* The day his manager returned, said where he chooses the day (owner, 2026-10-02). */}
          {viewerIsRep && week.returnedDay ? (
            <ReturnedDayNote
              className="mt-3"
              day={week.returnedDay}
              decidedBySfe={plan?.decidedBySfe ?? false}
              note={plan?.decisionNote ?? null}
              today={today}
              viewerIsRep
            />
          ) : null}
        </CrmBlock>
      ) : null}
      {showHeader ? (
      <CrmBlock
        actions={
          <span className="flex max-w-full flex-wrap gap-1">
            <CrmPill tone={PLAN_STATUS_TONE[status ?? "none"]}>{week.statusLabel}</CrmPill>
            {plan?.submittedLate ? <CrmPill tone="warn">Sent late</CrmPill> : null}
            {week.overdue ? <CrmPill tone="bad">Overdue</CrmPill> : null}
            {!week.open ? <CrmPill>Passed</CrmPill> : null}
            {dirty && !autosave ? <CrmPill tone="orange">Unsaved changes</CrmPill> : null}
          </span>
        }
        className="border-l-4 border-t border-slate-100 border-l-orange-500"
        title={week.label}
      >
        <p className="break-words text-lg font-black leading-tight text-slate-950">{weekLabel(week.weekStart)}</p>
        <p className="mt-1 break-words text-sm font-bold text-slate-700">
          {countText(totals.AM)} AM · {countText(totals.PM)} PM placed this week
        </p>
        <div className="mt-3">
          <CrmFacts facts={facts} />
        </div>

        {/* The week this month opens with and does not own (owner, 2026-10-01). It is shown here so he
            can reach his first days from the month he is planning — and told, in words, that the
            month's own Send will not take it, which is the whole reason it was worth showing. */}
        {week.leadingNote ? (
          <CrmNote className="mt-3" title="This week belongs to the month before" tone="info">
            {week.leadingNote}
          </CrmNote>
        ) : null}

        {/* The deadline, said once where he is working. Never a block: a late week is accepted and stamped —
            the week he is IN too (owner, 2026-10-02), whose visits count as planned only from the send. */}
        {viewerIsRep && week.overdue ? (
          <CrmNote className="mt-3" title={`This week was due ${week.dueOnLabel}`} tone="warn">
            Send it as soon as it is ready. It will still be accepted, and it will be marked as sent late.
            {week.weekStart <= today ? " Your visits count as planned from the moment you send it." : null}
          </CrmNote>
        ) : null}
        {plan?.submittedLate ? (
          <CrmNote className="mt-3" title="Sent late" tone="warn">
            This week was due {week.dueOnLabel} and was sent {plan.submittedAt ? cairoStamp(plan.submittedAt) : "after it"}.
          </CrmNote>
        ) : null}
        {week.returnedDay ? (
          <ReturnedDayNote
            className="mt-3"
            day={week.returnedDay}
            decidedBySfe={plan?.decidedBySfe ?? false}
            note={plan?.decisionNote ?? null}
            today={today}
            viewerIsRep={viewerIsRep}
          />
        ) : plan?.decisionNote && (status === "returned" || status === "approved") ? (
          <CrmNote className="mt-3" title={status === "returned" ? "What to change" : "Manager's note"} tone={status === "returned" ? "warn" : "good"}>
            <span className="block whitespace-pre-line">{plan.decisionNote}</span>
          </CrmNote>
        ) : null}

        {editable ? (
          confirm === "send" ? (
            <div className="mt-3 grid min-w-0 gap-2 border border-orange-200 bg-orange-50/40 px-3.5 py-3">
              <p className="text-sm font-black text-slate-950">Send this week for review?</p>
              <p className="break-words text-sm font-medium leading-6 text-slate-600">
                {countText(totals.AM)} AM · {countText(totals.PM)} PM across the week.{dirty ? " Your changes are saved first." : ""} {reviewerSentence} Once
                it is sent, changing it needs your manager and SFE.
              </p>
              <EmptyDaysNote dates={emptyDays} />
              {problems.length > 0 ? (
                <CrmNote title="Fix these first" tone="bad">
                  <ProblemList onDay={onDay} problems={problems} />
                </CrmNote>
              ) : null}
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                <CrmButton
                  busy={busy === "send"}
                  disabled={locked || problems.length > 0 || hold === "changed"}
                  onClick={() => {
                    setConfirm(null);
                    onSend();
                  }}
                  variant="primary"
                >
                  Send
                </CrmButton>
                <CrmButton disabled={busy === "send"} onClick={() => setConfirm(null)}>
                  Not yet
                </CrmButton>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap sm:items-center">
                <CrmButton busy={busy === "send"} disabled={locked || placed === 0} onClick={() => setConfirm("send")} variant="primary">
                  {status === "returned" ? "Send this week again" : "Send this week"}
                </CrmButton>
                {placed === 0 ? <span className="text-xs font-semibold leading-5 text-slate-500">Place at least one customer before sending the week.</span> : null}
              </div>
              {placed > 0 ? <EmptyDaysNote className="mt-3" dates={emptyDays} /> : null}
            </>
          )
        ) : null}

        {/* Where his request to edit the week stands (owner, 2026-10-01), in the same words wherever
            he meets it. A refusal carries its note, because he reads why. */}
        {viewerIsRep && week.editRequest ? (
          <CrmNote className="mt-3" title={week.editRequest.statusLabel} tone={EDIT_TONE[week.editRequest.status]}>
            <span className="block">{planEditRepNote(week.editRequest.status)}</span>
            {week.editRequest.status === "refused" && (week.editRequest.sfeNote ?? week.editRequest.managerNote) ? (
              <span className="mt-1 block whitespace-pre-line">Note: {week.editRequest.sfeNote ?? week.editRequest.managerNote}</span>
            ) : null}
          </CrmNote>
        ) : null}

        {/* Both asks spent (owner, 2026-10-20: twice a week at most): the button is gone, and the week says why. */}
        {viewerIsRep && plan && week.repState === "sent" && week.editAsksLeft === 0 ? (
          <CrmNote className="mt-3" title="No asks left this week" tone="warn">
            {planEditAsksNote(0)}
          </CrmNote>
        ) : null}

        {week.canAskToEdit && plan ? (
          confirm === "ask" ? (
            <div className="mt-3 grid min-w-0 gap-2 border border-slate-200 bg-slate-50 px-3.5 py-3">
              <p className="text-sm font-black text-slate-950">Ask to edit this week?</p>
              <p className="break-words text-sm font-medium leading-6 text-slate-600">
                Your district manager decides first, then SFE. The week opens again once SFE approves it, and until you send it
                again your visits this week count as off-plan.
              </p>
              <p className="break-words text-sm font-semibold leading-6 text-slate-700">{planEditAsksNote(week.editAsksLeft)}</p>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                <CrmButton
                  busy={busy === "ask"}
                  disabled={locked}
                  onClick={() => {
                    setConfirm(null);
                    onAskToEdit();
                  }}
                  variant="primary"
                >
                  Ask
                </CrmButton>
                <CrmButton disabled={busy === "ask"} onClick={() => setConfirm(null)}>
                  Not yet
                </CrmButton>
              </div>
            </div>
          ) : (
            <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap sm:items-center">
              <CrmButton busy={busy === "ask"} disabled={locked} onClick={() => setConfirm("ask")}>
                Ask to edit this week
              </CrmButton>
              <span className="text-xs font-semibold leading-5 text-slate-500">{planEditAsksLeftLine(week.editAsksLeft)}</span>
            </div>
          )
        ) : null}
      </CrmBlock>
      ) : null}

      {hold === "changed" ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote title="This week changed since you started" tone="bad">
            <span className="block">
              It was saved on another screen, or a save of yours went through before its answer came back. Your ticks are still on this page.
            </span>
            <span className="mt-2 grid gap-2 sm:flex sm:flex-wrap">
              <CrmButton disabled={locked} onClick={onKeepMine} size="sm" variant="primary">
                Keep my ticks
              </CrmButton>
              <CrmButton disabled={locked} onClick={onShowLatest} size="sm">
                Show the saved week
              </CrmButton>
            </span>
          </CrmNote>
        </CrmBlock>
      ) : null}
      {hold === "unchecked" ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote title="Phoenix could not confirm the save" tone="warn">
            {autosave
              ? "Your ticks are kept on this page. Check the connection: they save again once it is back, or press Try again."
              : "Your ticks are kept on this page. Check the connection, then save again."}
          </CrmNote>
        </CrmBlock>
      ) : null}
      {showProblems && problems.length > 0 ? (
        <CrmBlock className="border-t border-slate-100">
          <CrmNote title={problems.length === 1 ? "Fix this before saving" : `Fix these ${problems.length} before saving`} tone="bad">
            <ProblemList currentDate={selectedDay.date} onDay={onDay} problems={problems} />
          </CrmNote>
        </CrmBlock>
      ) : null}

      {showWeekSuggest && (editable || suggest) ? (
        <CrmBlock className="border-t border-slate-100" title={editable ? "Suggest or copy the week" : "Suggest the week"}>
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            {suggest ? (
              <PlanSuggestMenu
                autosave={autosave}
                blockedReason={weekReason}
                disabled={draftLocked}
                input={suggestInput}
                key={`suggest-${week.weekStart}`}
                onPlace={onCopied}
                scope={{ kind: "week" }}
              />
            ) : null}
            {editable ? (
              <PlanCopyMenu
                autosave={autosave}
                caps={caps}
                customers={customers}
                disabled={draftLocked}
                key={week.weekStart}
                onPlace={onCopied}
                scope={{ kind: "week", target }}
                seatId={seatId}
                test={test}
              />
            ) : null}
          </div>
        </CrmBlock>
      ) : null}

      {showDays ? (
      <CrmBlock className="border-t border-slate-100" title="Days">
        <CrmChoice
          columns={3}
          label="Day"
          onChange={onDay}
          options={week.days.map((day) => {
            // Every kind the day holds, in the order they are ticked from — never only the first.
            const activityTypes = (editable && day.editable ? activitiesOn(activities, day.date) : day.activities).map((entry) => entry.activityType);
            const counts = dayCountsOf(day);
            const full = dayFullness(counts, caps, day.listTypes);
            // One day returned (owner, 2026-10-02): on his own week every other day is greyed, as sent.
            const asSent = viewerIsRep && editable && week.returnedDay !== null && day.date !== week.returnedDay;
            // A day off (owner, 2026-10-02) — a public holiday, or a full day of his own approved leave —
            // is greyed, named, and never opened, unless something is still on it, which he must be able
            // to reach to take off.
            const off = dayOffOf(day);
            if (off) {
              return {
                value: day.date,
                label: <ChoiceLabel chosen={day.date === selectedDay.date}>{dayLabel(day.date)}</ChoiceLabel>,
                // Approved leave says so (owner, 2026-10-08): the day is a vacation, not merely a day off.
                note: off.kind === "leave" ? `${off.name} · approved` : `Day off · ${off.name}`,
                disabled: counts.AM + counts.PM === 0,
              };
            }
            return {
              value: day.date,
              label: <ChoiceLabel chosen={day.date === selectedDay.date}>{dayLabel(day.date)}</ChoiceLabel>,
              note: (
                <>
                  {day.date === today ? "Today · " : null}
                  <DayPair counts={counts} full={full} listTypes={day.listTypes} />
                  {activityTypes.length > 0 ? ` · ${activityTypes.map(dayActivityLabel).join(", ")}` : null}
                  {day.pendingLeave ? " · Vacation pending approval" : null}
                  {asSent ? " · As sent" : null}
                  {changedDays?.has(day.date) ? " · Changed since the last send" : null}
                </>
              ),
              disabled: asSent || undefined,
              tone: full.day ? ("good" as const) : undefined,
            };
          })}
          value={selectedDay.date}
        />
      </CrmBlock>
      ) : null}

      {showDay ? (
      <PlanDayPanel
        activities={dayActivities}
        caps={caps}
        copyMenu={
          editingDay ? (
            <PlanCopyMenu
              autosave={autosave}
              caps={caps}
              compact={dayFocus !== undefined}
              customers={customers}
              disabled={draftLocked}
              key={selectedDay.date}
              onPlace={onCopied}
              scope={{ kind: "day", target, date: selectedDay.date }}
              seatId={seatId}
              test={test}
            />
          ) : undefined
        }
        customers={customers}
        day={selectedDay}
        editing={editingDay}
        filter={filter}
        filterOptions={filterOptions}
        focus={dayFocus}
        gradeTargets={gradeTargets}
        idPrefix={`${idPrefix}-${week.weekStart}`}
        items={items}
        key={`${selectedDay.date}|${dayFocus ?? "day"}`}
        locked={draftLocked}
        onActivity={(activityType, next) => onActivity(selectedDay.date, activityType, next)}
        onFill={editingDay ? onFillDay : undefined}
        planCopyMenu={
          // Step 3 of the rep's form (owner, 2026-10-02): the week's two copies sit beside the day's — last
          // week's plan, and the period plan (last month's, his iReports360 plan in his first Phoenix month).
          // Both fill only the days he can still change, and only the draft.
          dayFocus !== undefined && editable ? (
            <>
              <PlanCopyMenu
                autosave={autosave}
                caps={caps}
                compact
                customers={customers}
                disabled={draftLocked}
                key={`week-${week.weekStart}`}
                onPlace={onCopied}
                scope={{ kind: "week", target }}
                seatId={seatId}
                test={test}
              />
              <PlanCopyMenu
                autosave={autosave}
                caps={caps}
                compact
                customers={customers}
                disabled={draftLocked}
                key={`period-${week.weekStart}`}
                onPlace={onCopied}
                scope={{ kind: "month", monthStart: monthStartOf(week.weekStart), weeks: [target] }}
                seatId={seatId}
                test={test}
              />
            </>
          ) : undefined
        }
        onFilter={onFilter}
        onPlace={onPlace}
        onQuery={onQuery}
        onRemove={(customerId) => onRemove(selectedDay.date, customerId)}
        onStarts={(next) => onStarts(selectedDay.date, next)}
        query={query}
        reviewList={reviewList}
        showSpread={showSpread}
        starts={editingDay ? startsOn(starts, selectedDay.date) : selectedDay.starts}
        suggestMenu={
          suggest ? (
            <PlanSuggestMenu
              autosave={autosave}
              blockedReason={dayReason}
              disabled={draftLocked}
              input={suggestInput}
              key={`suggest-${selectedDay.date}`}
              onPlace={onCopied}
              scope={{ kind: "day", date: selectedDay.date }}
            />
          ) : undefined
        }
        tints={tints}
        today={today}
      />
      ) : null}

      {/* 🔴 WHOSE TURN IT IS, WHERE THE BUTTONS WOULD BE (owner, 2026-10-07). PlanDecision draws
          nothing when this viewer can neither approve nor return — a week he has just returned, a
          week nobody has sent, a week that is already approved — and the page ended there. */}
      {showClose && turnSentence && !week.canApprove && !week.canReturn ? (
        <CrmBlock className="border-t border-slate-100" title="Where this week stands">
          <CrmNote tone="info">{turnSentence}</CrmNote>
        </CrmBlock>
      ) : null}

      {showClose && plan ? (
        <PlanDecision
          approved={status === "approved"}
          busy={decisionBusy(busy)}
          canApprove={week.canApprove}
          canReturn={week.canReturn}
          idPrefix={`${idPrefix}-${week.weekStart}`}
          key={`${plan.planId}|${plan.version}`}
          locked={locked}
          onDecide={onDecide}
          returnDays={week.canReturn ? returnableDays(week.days, today).map((day) => day.date) : undefined}
          subject="week"
        />
      ) : null}

      {showClose && editable && placed > 0 ? (
        <CrmBlock className="border-t border-slate-100">
          <p className="break-words text-xs font-semibold leading-5 text-slate-500">
            {plural(week.days.filter((day) => dayCountsOf(day).AM + dayCountsOf(day).PM > 0).length, "day", "days")} of {countText(week.days.length)} planned.
            Send the week when it is ready.
          </p>
        </CrmBlock>
      ) : null}
    </div>
  );
}

/**
 * The days still his to change that he left empty — no customer and no other activity — named where he
 * sends (owner, 2026-10-02: on 1 October 15 working days went out empty across 14 sent weeks). One note
 * he reads and can still press Send past: it never refuses the week and never greys the button.
 */
function EmptyDaysNote({ className, dates }: { className?: string; dates: ReadonlyArray<string> }) {
  if (dates.length === 0) return null;
  return (
    <CrmNote className={className} title={dates.length === 1 ? "1 day is empty" : `${countText(dates.length)} days are empty`} tone="warn">
      {dates.map((date) => (
        <span className="block" key={date}>
          {emptyDayText(date)}
        </span>
      ))}
      <span className="mt-1 block">Plan them, or send the week as it is.</span>
    </CrmNote>
  );
}

function ProblemList({
  currentDate = null,
  onDay,
  problems,
}: {
  currentDate?: string | null;
  onDay: (date: string) => void;
  problems: ReadonlyArray<DraftProblem>;
}) {
  return (
    <ul className="mt-1 grid min-w-0 gap-1.5">
      {problems.map((problem, position) => (
        <li className="flex min-w-0 flex-wrap items-center gap-2" key={`${problem.date}-${position}`}>
          <span className="min-w-0 flex-1 basis-56 break-words">{problemText(problem)}</span>
          {problem.date !== currentDate ? (
            <CrmButton onClick={() => onDay(problem.date)} size="sm">
              Open {dayLabel(problem.date)}
            </CrmButton>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
