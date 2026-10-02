/**
 * Phoenix CRM — a rep's off-plan DAY, and the day an off-plan visit was moved from. No I/O.
 *
 * Two of the owner's picks on 2026-10-02, both about the out-of-plan visit (unplanned-rules.ts):
 *
 *   A · OFF-PLAN DAY IN ONE PLACE. 8.9% of September's regular calls were off the plan, and each one
 *       goes to the district manager and then SFE — about 48 a day for one SFE Manager. The visits
 *       waiting at the viewer's step are ONE card per rep per visit day, the oldest day first. A person
 *       still decides EACH visit: every visit keeps its own Approve and Refuse, and "Approve all" is a
 *       confirmed loop of that same per-visit decision — one decision per visit, by this person,
 *       through the one route that decides a visit. Nothing here decides anything by itself.
 *
 *   B · THE MOVED DAY. 250 of those calls were a customer on the rep's SENT plan for ANOTHER day of
 *       the same field week. The reason fills itself in ("Planned for Tuesday 6 Oct; seen today
 *       instead.") and he can still change it: no step added, typing removed. The approver reads the
 *       planned day from the SERVER — the sent plan as it stood at the visit's own captured_at — and
 *       never from the rep's text.
 *
 * "Sent" is the module's one rule (plan-rules.ts `isPlanDaySent`, `standingReturnedDay`). All this file
 * adds is the plan AS IT STOOD AT AN INSTANT, read from the plan's own events, so the one rule can be
 * asked about the moment a visit was logged rather than about now.
 */

import { fieldWeekDays, fieldWeekStart, isIsoDay, planDayListTypes } from "@/lib/phoenix-crm/calendar";
import { isPlanDaySent, planDayLabel, standingReturnedDay } from "@/lib/phoenix-crm/plan-rules";
import type { PhoenixCrmPlanStatus } from "@/lib/phoenix-crm/types";
import { isUnplannedVisitWaiting, type UnplannedVisitStatus } from "@/lib/phoenix-crm/unplanned-rules";

/** An instant's place in time, for ordering — never its text, whose fractions and offsets vary. */
function timeOf(iso: string | null | undefined): number {
  const time = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
}

// ── A · One card per rep per visit day ──────────────────────────────────────────────────────────

/** What the grouping reads of one off-plan visit. The Team tab's TeamUnplannedVisit carries all of it. */
export type OffPlanVisitFacts = {
  visitId: string;
  seatId: string;
  /** Who the visit was his; the name is what is shown. */
  repHrId: string | null;
  repName: string;
  territoryName: string;
  visitDate: string;
  raisedAt: string;
  status: UnplannedVisitStatus;
  /** This viewer decides the step the visit is waiting on. */
  canDecide: boolean;
};

export type OffPlanDay<T extends OffPlanVisitFacts> = {
  /** Territory, rep and visit day: one card. */
  key: string;
  seatId: string;
  repName: string;
  territoryName: string;
  visitDate: string;
  /** The day's visits in the order he logged them. */
  visits: T[];
};

/** The card a visit belongs on. A territory's rep on one visit day is one card. */
export function offPlanDayKey(visit: Pick<OffPlanVisitFacts, "seatId" | "repHrId" | "repName" | "visitDate">): string {
  return `${visit.seatId}|${visit.repHrId ?? visit.repName}|${visit.visitDate}`;
}

/**
 * One card per rep per visit day, the OLDEST day first (a visit waiting longest is the one he went on
 * earliest); inside a card, the visits in the order he logged them.
 */
export function groupOffPlanDays<T extends OffPlanVisitFacts>(visits: ReadonlyArray<T>): Array<OffPlanDay<T>> {
  const byKey = new Map<string, OffPlanDay<T>>();
  for (const visit of visits) {
    const key = offPlanDayKey(visit);
    let day = byKey.get(key);
    if (!day) {
      day = { key, seatId: visit.seatId, repName: visit.repName, territoryName: visit.territoryName, visitDate: visit.visitDate, visits: [] };
      byKey.set(key, day);
    }
    day.visits.push(visit);
  }
  const days = [...byKey.values()];
  for (const day of days) {
    day.visits.sort((left, right) => timeOf(left.raisedAt) - timeOf(right.raisedAt) || left.visitId.localeCompare(right.visitId));
  }
  return days.sort(
    (left, right) =>
      left.visitDate.localeCompare(right.visitDate) ||
      timeOf(left.visits[0]?.raisedAt) - timeOf(right.visits[0]?.raisedAt) ||
      left.repName.localeCompare(right.repName) ||
      left.key.localeCompare(right.key),
  );
}

/**
 * The Team tab's two halves: the cards of what waits at THIS viewer's step, and the cards of what
 * waits on somebody else. A rep's day can be on both — the visits his manager has passed to SFE sit
 * with SFE while the rest still sit with the manager — and each card holds only its own half, so
 * "Approve all" on it is exactly the visits whose own Approve this viewer may press.
 */
export function splitOffPlanDays<T extends OffPlanVisitFacts>(visits: ReadonlyArray<T>): { forYou: Array<OffPlanDay<T>>; others: Array<OffPlanDay<T>> } {
  return {
    forYou: groupOffPlanDays(visits.filter((visit) => visit.canDecide)),
    others: groupOffPlanDays(visits.filter((visit) => !visit.canDecide)),
  };
}

/** The visits "Approve all" decides: every visit on the card still waiting at this viewer's step. */
export function approveAllTargets<T extends OffPlanVisitFacts>(day: OffPlanDay<T>): T[] {
  return day.visits.filter((visit) => visit.canDecide && isUnplannedVisitWaiting(visit.status));
}

/** "Approve all" is offered from two visits up: for one, the visit's own Approve is the same press. */
export const APPROVE_ALL_FROM = 2;

/**
 * What the one decide route takes for one visit — the SAME body the visit's own Approve and Refuse
 * send. "Approve all" sends it once per visit, so every decision carries the version that visit was
 * read at, and the database refuses one that moved on rather than deciding a step nobody saw.
 */
export function offPlanDecisionBody(
  visit: { visitId: string; version: number },
  decision: "approve" | "refuse",
  note: string | null,
): { visitId: string; decision: "approve" | "refuse"; note: string | null; expectedVersion: number } {
  return { visitId: visit.visitId, decision, note, expectedVersion: visit.version };
}

/** Why one decision in "Approve all" did not go through, in the words the card's own refusals use. */
export function approveAllFailureText(code: string | null, message: string): string {
  if (code === "phoenix_crm_unplanned_decided") return "it was already decided";
  if (code === "phoenix_crm_unplanned_wrong_stage") return "it has moved on to the next step";
  if (code === "phoenix_crm_unplanned_not_found") return "it is no longer waiting for a decision";
  if (code === "phoenix_crm_version_conflict") return "it changed on another screen";
  return message.trim() || "it was not saved";
}

export type ApproveAllOutcome = { customerName: string; ok: true } | { customerName: string; ok: false; why: string };

/**
 * What the manager is told when "Approve all" has run: how many went through, and by name which did
 * not and why. The ones that went through stand — a failure never undoes them.
 */
export function approveAllNotice(input: {
  repName: string;
  visitDate: string;
  outcomes: ReadonlyArray<ApproveAllOutcome>;
}): { tone: "info" | "warn" | "bad"; title: string; failures: string[] } {
  const total = input.outcomes.length;
  const approved = input.outcomes.filter((outcome) => outcome.ok).length;
  const day = planDayLabel(input.visitDate);
  const visits = total === 1 ? "off-plan visit" : "off-plan visits";
  const failures = input.outcomes.flatMap((outcome) => (outcome.ok ? [] : [`${outcome.customerName}: ${outcome.why}.`]));
  if (approved === total) return { tone: "info", title: `Approved: ${total} ${visits} of ${input.repName} on ${day}.`, failures };
  if (approved === 0) return { tone: "bad", title: `None of the ${total} ${visits} of ${input.repName} on ${day} was approved.`, failures };
  return { tone: "warn", title: `Approved ${approved} of the ${total} ${visits} of ${input.repName} on ${day}.`, failures };
}

// ── B · The day an off-plan visit was moved from ────────────────────────────────────────────────

/** One event of a plan, as the as-of rule reads it. */
export type PlanEventFact = {
  /** The event's own id: the database breaks a tie at one instant on it. */
  id: number;
  eventType: string;
  toStatus: PhoenixCrmPlanStatus | null;
  createdAt: string;
  /** A one-day return names its day in the event's details. */
  returnedDay: string | null;
};

/** One customer on one day of a plan. */
export type PlanItemFact = { date: string; customerId: string };

/**
 * The events that SET the plan's status, at or before an instant, the latest first.
 *
 * A save sets nothing: `phoenix_crm_save_plan` writes the status the plan already had, as both its
 * from and its to, and its details hold a COUNT of items and never the returned day. So it is left
 * out here. `phoenix_crm_save_visit` reads the newest event of ANY kind, which means a rep who saves
 * the one day his manager returned hides that day from it; the owner's "Still planned" ruling
 * (2026-10-02) is that the other days stay sent until he sends the week again, and that ruling is the
 * one followed here.
 */
function statusEventsUpTo(events: ReadonlyArray<PlanEventFact>, at: string): PlanEventFact[] {
  const limit = timeOf(at);
  return events
    .filter((event) => event.eventType !== "saved" && event.toStatus !== null && timeOf(event.createdAt) <= limit)
    .sort((left, right) => timeOf(right.createdAt) - timeOf(left.createdAt) || right.id - left.id);
}

/**
 * The plan as it stood at an instant: its status, and the one day a standing return held back.
 *
 * The status is the latest status-setting event at or before it — the question phoenix_crm_save_visit
 * asks of a visit's captured_at. The held-back day is that return's own day, unless HR acknowledged a
 * request to edit the week after the return and by that instant, which opened the whole week to the
 * rep (`standingReturnedDay` — the module's one rule for it).
 */
export function planStoodAt(input: {
  events: ReadonlyArray<PlanEventFact>;
  /** When HR acknowledged each of the week's requests to edit it. */
  acknowledgedAt: ReadonlyArray<string>;
  at: string;
}): { status: PhoenixCrmPlanStatus | null; returnedDay: string | null } {
  const [latest] = statusEventsUpTo(input.events, input.at);
  if (!latest) return { status: null, returnedDay: null };
  const limit = timeOf(input.at);
  const acknowledged = input.acknowledgedAt
    .filter((stamp) => timeOf(stamp) <= limit)
    .sort((left, right) => timeOf(right) - timeOf(left))[0];
  const returnedDay = standingReturnedDay({
    status: latest.toStatus,
    returnedDay: latest.returnedDay,
    decidedAt: latest.createdAt,
    editAcknowledgedAt: acknowledged ?? null,
  });
  return { status: latest.toStatus, returnedDay };
}

/** The days of a field week a plan counts as SENT: the module's one rule, asked day by day. */
export function sentDaysOfWeek(
  weekStart: string,
  stood: { status: PhoenixCrmPlanStatus | null; returnedDay: string | null; returnedFrom?: PhoenixCrmPlanStatus | null },
): string[] {
  return fieldWeekDays(weekStart).filter((date) => isPlanDaySent({ ...stood, date }));
}

/**
 * Whether the plan was opened to the rep after an instant: returned (whole or one day), reopened, or
 * opened by an acknowledged request to edit it. That is the only way its items can have moved since —
 * a sent week's days are not his to change — so only then is the copy kept on the send read.
 */
export function planOpenedAfter(input: { events: ReadonlyArray<PlanEventFact>; acknowledgedAt: ReadonlyArray<string>; at: string }): boolean {
  const limit = timeOf(input.at);
  const after = (stamp: string) => {
    const time = timeOf(stamp);
    return Number.isFinite(time) && time > limit;
  };
  return (
    input.events.some((event) => event.eventType !== "saved" && (event.toStatus === "returned" || event.toStatus === "draft") && after(event.createdAt)) ||
    input.acknowledgedAt.some(after)
  );
}

/**
 * The send whose copy holds the plan as it stood at an instant, when the plan was opened again after it
 * and the copy is needed at all; null otherwise. Every send since 2026-10-02 keeps a copy of what it sent
 * on its own 'submitted' event (phoenix_crm_plan_transition).
 */
export function sentCopyNeeded(input: { events: ReadonlyArray<PlanEventFact>; acknowledgedAt: ReadonlyArray<string>; at: string }): number | null {
  if (!planOpenedAfter(input)) return null;
  const send = statusEventsUpTo(input.events, input.at).find((event) => event.eventType === "submitted");
  return send ? send.id : null;
}

/**
 * The copy a send kept, as items — null when the event kept none (every send before 2026-10-02), or
 * kept something that is not one.
 */
export function parseSentCopy(raw: unknown): PlanItemFact[] | null {
  if (!Array.isArray(raw)) return null;
  const items: PlanItemFact[] = [];
  for (const entry of raw) {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const date = String(item.plan_date ?? "");
    const customerId = String(item.customer_id ?? "").toLowerCase();
    if (!isIsoDay(date) || !customerId) return null;
    items.push({ date, customerId });
  }
  return items;
}

/**
 * The days of a week a customer stood on the SENT plan, as the plan stood at `at`.
 *
 * The items are the plan's items now, unless the plan was opened to the rep after `at` and the send
 * before it kept a copy — then the copy, because what he changed afterwards was not his plan when he
 * logged the visit. A plan opened again with no copy to read (a send from before copies were kept) is
 * read from its items now: the best there is.
 */
export function plannedDaysAt(input: {
  weekStart: string;
  at: string;
  customerId: string;
  events: ReadonlyArray<PlanEventFact>;
  acknowledgedAt: ReadonlyArray<string>;
  items: ReadonlyArray<PlanItemFact>;
  sentCopy: ReadonlyArray<PlanItemFact> | null;
}): string[] {
  const sent = new Set(sentDaysOfWeek(input.weekStart, planStoodAt(input)));
  if (sent.size === 0) return [];
  const customerId = input.customerId.toLowerCase();
  const days = (input.sentCopy ?? input.items)
    .filter((item) => item.customerId.toLowerCase() === customerId && sent.has(item.date))
    .map((item) => item.date);
  return [...new Set(days)].sort();
}

/**
 * The days a visit was MOVED from: the other days of its field week (Saturday to Thursday — a Friday
 * belongs to the week before it) on which its customer stood on the sent plan. A planned day that has
 * already passed and on which the territory DID see him is left out: then today's visit is another
 * visit, not that one moved, and "seen today instead" would be untrue.
 */
export function movedFromDays(input: { visitDate: string; plannedDays: ReadonlyArray<string>; seenDays: ReadonlyArray<string> }): string[] {
  if (!isIsoDay(input.visitDate)) return [];
  const week = fieldWeekStart(input.visitDate);
  const seen = new Set(input.seenDays);
  return [...new Set(input.plannedDays)]
    .filter(
      (day) =>
        isIsoDay(day) &&
        day !== input.visitDate &&
        fieldWeekStart(day) === week &&
        planDayListTypes(day).length > 0 &&
        !(day < input.visitDate && seen.has(day)),
    )
    .sort();
}

/** "Tuesday 6 Oct", "Saturday 3 Oct and Tuesday 6 Oct", "Saturday 3 Oct, Monday 5 Oct and Tuesday 6 Oct". */
function daysText(days: ReadonlyArray<string>): string {
  const labels = days.map((day) => planDayLabel(day));
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** The approver's line: "Planned for Tuesday 6 Oct". Null when the visit was not moved from a day. */
export function plannedForText(days: ReadonlyArray<string>): string | null {
  return days.length > 0 ? `Planned for ${daysText(days)}` : null;
}

/**
 * The rep's reason, filled in for him when he picks Out of plan for a customer on his sent plan for
 * another day of this week: "Planned for Tuesday 6 Oct; seen today instead." His to change; null when
 * there is no such day, and then the box starts empty as it always has.
 */
export function movedDayReason(days: ReadonlyArray<string>): string | null {
  const planned = plannedForText(days);
  return planned ? `${planned}; seen today instead.` : null;
}
