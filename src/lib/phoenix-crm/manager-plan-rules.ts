/**
 * Phoenix CRM — the district manager's weekly plan, with no I/O.
 *
 * Owner, 2026-10-16: "the weekly plan for the managers. Let's start with the district sales manager …
 * exactly like the numbered form that the medical reps use … instead of the doctors, the medical reps
 * appear, and the bricks they are going to today." The rep's numbered form, inverted. For each half-day
 * (AM or PM, each its own choice) the district manager does exactly ONE of three things:
 *
 *   - WITH A REP — his reps are shown with where they are going; he picks one, and that rep's own
 *     customers for that half appear. He ticks some, or Mark all. A rep who has not sent his week shows
 *     his draft customers, marked not sent; a rep with no plan at all is skipped.
 *   - ADMIN — one of the seven day activities already in Phoenix CRM, and a note.
 *   - SINGLE VISIT — an area of his district, then customers from that area's rep lists, from Manager's
 *     own list, or one he types (grade A/B/C and potential grade, Capture location optional, NO
 *     validation step — "there will not be validation because they are managers").
 *
 * Rules around it, every one his own answer that day:
 *   - It REPLACES his legacy Weekly/Monthly plan, once his own team is live (`dmPlansInPhoenixCrm`).
 *   - One week only: the coming Saturday's, due Thursday 23:55 Cairo like his reps' (calendar.ts
 *     `repPlanWeek`, `weeklyPlanDueOn`). A late send is accepted and stamped late, and the week he is IN
 *     can still be sent late while he never sent it — the rep's own rule (`repWeekState`).
 *   - Approved by his RSM/NSM — the nearest manager above his seat (`territoryReviewer`) — in the
 *     Approvals Hub, as today. Hany Saad's district managers go on to Ali Mohamed Ali
 *     (`secondApproverHrIdForManager`). No HR acknowledgement and no SFE step. The Administrator may act
 *     in place of whoever holds the step (Phoenix CRM's rule of 2026-10-14).
 *   - 🔴 THE REP NEVER SEES IT. Ticking a rep is NOT a double visit — "the double visit is only counted
 *     when the rep submit and log a visit and choose double visit and his manager". The actual is the
 *     visit the REP logs naming him, and the single visits HE logs himself, which count in his own
 *     report and nowhere else.
 *   - A rep who later drops a customer he ticked: his row stays and is FLAGGED, never removed.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { fieldWeekDays, fieldWeekStart, isIsoDay, planDayListTypes, repPlanWeek } from "@/lib/phoenix-crm/calendar";
import { isDayActivity, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { DOUBLE_VISIT_PLANNER_TIERS } from "@/lib/phoenix-crm/double-visit-plan-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import { heldManagerSeats, territoryReviewer, type ChainMember, type OrgIndex, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { secondApproverHrIdForManager } from "@/lib/workforce/plan-second-approver";

// ── The words ───────────────────────────────────────────────────────────────────────────────────

export type ManagerPlanStatus = "draft" | "submitted" | "first_approved" | "approved" | "returned";
export type ManagerSlotKind = "with_rep" | "admin" | "single_visit";
export type ManagerHalf = "AM" | "PM";

export const MANAGER_PLAN_HALVES: readonly ManagerHalf[] = ["AM", "PM"];

/** The three things a half-day can be, in the order the form offers them. */
export const MANAGER_SLOT_KINDS: ReadonlyArray<{ key: ManagerSlotKind; label: string }> = [
  { key: "with_rep", label: "With a rep" },
  { key: "admin", label: "Admin" },
  { key: "single_visit", label: "Single visit" },
];

/** The most customers one half-day holds — a rep's PM day is capped at 15, so this is room, not a target. */
export const MANAGER_SLOT_CUSTOMER_MAX = 60;
export const MANAGER_PLAN_NOTE_MAX = 500;
export const MANAGER_PLAN_REASON_MAX = 500;

/** The grades he gives a customer he adds himself (owner, 2026-10-16: "A/B/C and potential grade"). */
export const MANAGER_CUSTOMER_GRADES = ["A", "B", "C"] as const;
export const MANAGER_CUSTOMER_POTENTIAL_GRADES = ["AA", "AB", "AC", "BA", "BB", "BC"] as const;
export type ManagerCustomerGrade = (typeof MANAGER_CUSTOMER_GRADES)[number];
export type ManagerCustomerPotentialGrade = (typeof MANAGER_CUSTOMER_POTENTIAL_GRADES)[number];

export function isManagerPlanStatus(value: unknown): value is ManagerPlanStatus {
  return value === "draft" || value === "submitted" || value === "first_approved" || value === "approved" || value === "returned";
}

export function isManagerSlotKind(value: unknown): value is ManagerSlotKind {
  return value === "with_rep" || value === "admin" || value === "single_visit";
}

export function isManagerHalf(value: unknown): value is ManagerHalf {
  return value === "AM" || value === "PM";
}

export function managerSlotKindLabel(kind: ManagerSlotKind): string {
  return MANAGER_SLOT_KINDS.find((entry) => entry.key === kind)?.label ?? kind;
}

export function isManagerCustomerGrade(value: unknown): value is ManagerCustomerGrade {
  return typeof value === "string" && (MANAGER_CUSTOMER_GRADES as readonly string[]).includes(value);
}

export function isManagerCustomerPotentialGrade(value: unknown): value is ManagerCustomerPotentialGrade {
  return typeof value === "string" && (MANAGER_CUSTOMER_POTENTIAL_GRADES as readonly string[]).includes(value);
}

// ── Who plans ───────────────────────────────────────────────────────────────────────────────────

/** The district manager seats a person holds (DM or acting DM). Empty for everyone else. */
export function managerPlanSeats(org: OrgIndex, hrId: string | null | undefined): OrgSeat[] {
  return heldManagerSeats(org, hrId)
    .filter((seat) => DOUBLE_VISIT_PLANNER_TIERS.has(seat.tier) && !seat.isOtherPseudoDm)
    .sort((left, right) => left.seatId.localeCompare(right.seatId));
}

/**
 * 🔴 THE OLD "MY OWN VISIT" IS CLOSED FOR A DISTRICT MANAGER (owner, 2026-10-16: his own single visits
 * count in HIS OWN report only). A manager entering a single visit on a rep's territory filed it under that
 * rep's seat, where it counted in the territory's KPIs; a DM or acting DM seat holder now logs it on his
 * own plan instead (Visits tab, "My single visits"). Double and chain entries are unchanged, and the
 * visits already logged that way stay as they are. An RSM or NSM keeps the option — the ruling is the
 * district manager's.
 */
export function managerOwnVisitClosed(org: OrgIndex, hrId: string | null | undefined): boolean {
  return managerPlanSeats(org, hrId).length > 0;
}

export const MANAGER_OWN_VISIT_CLOSED =
  "A district manager's own visits are logged under My single visits on the Visits tab now. Here, choose Double visit or Chain visit.";

/**
 * 🔴 WHEN A DISTRICT MANAGER PLANS IN PHOENIX CRM INSTEAD OF THE LEGACY FORM (owner, 2026-10-16): he
 * holds a DM or acting DM seat AND that seat's team is live. Each district manager switches by himself
 * the day his team starts — Mohamed Alaa Eleiwa keeps the legacy form until his does. `liveSeat` is the
 * server's live-team test (`seatIsInLiveTeam`), passed in so this file stays free of I/O.
 */
export function dmPlansInPhoenixCrmFor(seats: ReadonlyArray<OrgSeat>, liveSeat: (seat: OrgSeat) => boolean): boolean {
  return seats.some((seat) => liveSeat(seat));
}

// ── The weeks and the days ──────────────────────────────────────────────────────────────────────

/** plan — he may tick, save and send it; sent — it is sent, he may ask to edit; asked — his ask waits; closed. */
export type ManagerWeekState = "plan" | "sent" | "asked" | "closed";

export function isManagerPlanEditable(status: ManagerPlanStatus | null): boolean {
  return status === null || status === "draft" || status === "returned";
}

/** A week gone for review: waiting on someone, or approved. Never a draft or a returned week. */
export function isManagerPlanSent(status: ManagerPlanStatus | null): boolean {
  return status === "submitted" || status === "first_approved" || status === "approved";
}

/**
 * What he may do with one week — the rep's `repWeekState`, for his statuses. The ONE week he plans is
 * the coming one (`repPlanWeek`). A week returned to him, and the week he is IN while he never sent it
 * (late, and stamped late), open too; every other week is closed — the board greys it and the server
 * refuses it.
 */
export function managerWeekState(input: {
  weekStart: string;
  cairoToday: string;
  status: ManagerPlanStatus | null;
  /** His ask to edit this week is waiting on his approver. */
  editAsked: boolean;
}): ManagerWeekState {
  const thursday = addDaysIso(input.weekStart, 5);
  if (thursday < input.cairoToday) return "closed";
  if (isManagerPlanSent(input.status)) return input.editAsked ? "asked" : "sent";
  if (input.weekStart === repPlanWeek(input.cairoToday)) return "plan";
  if (input.status === "returned") return "plan";
  if (input.weekStart === fieldWeekStart(input.cairoToday)) return "plan";
  return "closed";
}

/** The weeks his board offers: the week he is in while it still has a day ahead, and the coming one. */
export function managerPlanWeeks(cairoToday: string): string[] {
  const thisWeek = fieldWeekStart(cairoToday);
  const weeks: string[] = [];
  if (addDaysIso(thisWeek, 5) >= cairoToday) weeks.push(thisWeek);
  weeks.push(repPlanWeek(cairoToday));
  return weeks;
}

export function isManagerPlanWeek(value: unknown, cairoToday: string): value is string {
  return typeof value === "string" && managerPlanWeeks(cairoToday).includes(value);
}

/** "This week" or "Coming week". */
export function managerPlanWeekName(weekStart: string, cairoToday: string): string {
  return weekStart === fieldWeekStart(cairoToday) ? "This week" : "Coming week";
}

/** The halves a day holds: none on a public holiday or a Friday, the morning on a Thursday. */
export function managerDayHalves(isoDay: string, holiday: string | null | undefined): ManagerHalf[] {
  if (holiday) return [];
  return planDayListTypes(isoDay);
}

/**
 * A day he may still change: a field day from today on — and, while one day is returned to him, that day
 * alone (the database refuses every other, `manager_plan_day_not_returned`).
 */
export function isManagerDayOpen(input: { date: string; cairoToday: string; returnedDay: string | null; holiday: string | null }): boolean {
  if (!isIsoDay(input.date) || input.date < input.cairoToday) return false;
  if (managerDayHalves(input.date, input.holiday).length === 0) return false;
  if (input.returnedDay && input.date !== input.returnedDay) return false;
  return true;
}

/** The days of his week, Saturday to Thursday. */
export function managerWeekDays(weekStart: string): string[] {
  return fieldWeekDays(weekStart);
}

// ── One half-day, as the screen sends it ────────────────────────────────────────────────────────

export type ManagerSlotCustomerRef = { customerId: string } | { managerCustomerId: string };

export type ManagerSlotDraft = {
  date: string;
  half: ManagerHalf;
  /** Null clears the half-day. */
  kind: ManagerSlotKind | null;
  repSeatId: string | null;
  activityType: PhoenixCrmDayActivity | null;
  areaSeatId: string | null;
  note: string | null;
  customers: ManagerSlotCustomerRef[];
};

export type ManagerRuleResult<T> = { ok: true; value: T } | { ok: false; error: string };

function textOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > 0 ? text : null;
}

/**
 * The body of one half-day save, read strictly. Each kind carries its own fields and nothing else:
 * with a rep names the rep's seat and at least one of his customers; admin names one of the seven
 * activities and no customer; a single visit names an area of his district and at least one customer.
 */
export function parseManagerSlotDraft(raw: unknown): ManagerRuleResult<ManagerSlotDraft> {
  const body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const date = body.date;
  if (!isIsoDay(date)) return { ok: false, error: "Choose a day of the week." };
  if (!isManagerHalf(body.half)) return { ok: false, error: "Choose the morning (AM) or the evening (PM)." };
  const kind = body.kind === null || body.kind === undefined || body.kind === "" ? null : body.kind;
  if (kind !== null && !isManagerSlotKind(kind)) return { ok: false, error: "Choose With a rep, Admin or Single visit." };
  const note = textOf(body.note);
  if (note && note.length > MANAGER_PLAN_NOTE_MAX) return { ok: false, error: `Keep the note under ${MANAGER_PLAN_NOTE_MAX} characters.` };

  const rawCustomers = Array.isArray(body.customers) ? body.customers : [];
  if (rawCustomers.length > MANAGER_SLOT_CUSTOMER_MAX) {
    return { ok: false, error: `A half-day holds at most ${MANAGER_SLOT_CUSTOMER_MAX} customers.` };
  }
  const customers: ManagerSlotCustomerRef[] = [];
  const seen = new Set<string>();
  for (const entry of rawCustomers) {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const customerId = typeof item.customerId === "string" ? item.customerId.trim() : "";
    const managerCustomerId = typeof item.managerCustomerId === "string" ? item.managerCustomerId.trim() : "";
    if ((customerId === "") === (managerCustomerId === "")) return { ok: false, error: "A customer could not be read. Reload the page." };
    const id = customerId || managerCustomerId;
    if (!isUuid(id)) return { ok: false, error: "A customer could not be read. Reload the page." };
    const key = `${customerId ? "c" : "m"}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    customers.push(customerId ? { customerId } : { managerCustomerId });
  }

  const repSeatId = textOf(body.repSeatId);
  const areaSeatId = textOf(body.areaSeatId);
  const activity = body.activityType;
  const draft: ManagerSlotDraft = {
    date,
    half: body.half,
    kind,
    repSeatId: null,
    activityType: null,
    areaSeatId: null,
    note,
    customers: [],
  };
  if (kind === null) return { ok: true, value: draft };
  if (kind === "with_rep") {
    if (!repSeatId) return { ok: false, error: "Choose the rep you go with." };
    if (customers.length === 0) return { ok: false, error: "Tick at least one of the rep's customers, or Mark all." };
    if (customers.some((entry) => "managerCustomerId" in entry)) return { ok: false, error: "With a rep, the customers are the rep's own." };
    return { ok: true, value: { ...draft, repSeatId, customers } };
  }
  if (kind === "admin") {
    if (!isDayActivity(activity)) return { ok: false, error: "Choose what the admin half-day is." };
    return { ok: true, value: { ...draft, activityType: activity } };
  }
  if (!areaSeatId) return { ok: false, error: "Choose the area of your district." };
  if (customers.length === 0) return { ok: false, error: "Choose at least one customer for the single visit." };
  return { ok: true, value: { ...draft, areaSeatId, customers } };
}

// ── Who approves ────────────────────────────────────────────────────────────────────────────────

export type ManagerPlanStage = "first" | "second";

export type ManagerPlanApprovers = {
  /** His RSM/NSM — the nearest occupied manager seat above his. Null when the chain above is vacant. */
  first: ChainMember | null;
  /** Ali Mohamed Ali for Hany Saad's district managers; null for every other. */
  secondHrId: string | null;
};

/**
 * Who approves a district manager's week (owner, 2026-10-16: "approval by his RSM/NSM, as today"). The
 * first approver is read from the organogram above HIS seat — the same tree the legacy plan already
 * agreed with for all 19 seats (measured 2026-10-16: zero drift against the HR record). The second
 * stage is the one data rule the legacy plan already keeps, never a second copy of it.
 */
export function managerPlanApprovers(org: OrgIndex, managerSeatId: string): ManagerPlanApprovers {
  const first = territoryReviewer(org, managerSeatId);
  return { first, secondHrId: first ? secondApproverHrIdForManager(first.hrId) : null };
}

/** Whose turn a week is at: the first approver on a sent week, the second once the first approved. */
export function managerPlanStage(status: ManagerPlanStatus | null): ManagerPlanStage | null {
  if (status === "submitted") return "first";
  if (status === "first_approved") return "second";
  return null;
}

/** The person a week waits on, or null when it waits on nobody (a draft is his own, approved is closed). */
export function managerPlanWaitingOn(input: {
  status: ManagerPlanStatus | null;
  firstApproverHrId: string | null;
  secondApproverHrId: string | null;
}): string | null {
  const stage = managerPlanStage(input.status);
  if (stage === "first") return input.firstApproverHrId;
  if (stage === "second") return input.secondApproverHrId;
  return null;
}

export function managerPlanStatusLabel(status: ManagerPlanStatus | null): string {
  if (status === "submitted") return "Waiting for approval";
  if (status === "first_approved") return "Waiting for the second approval";
  if (status === "approved") return "Approved";
  if (status === "returned") return "Returned for changes";
  if (status === "draft") return "Draft";
  return "Not started";
}

function nameOrNull(value: string | null | undefined): string | null {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length > 0 ? name : null;
}

/**
 * The status, naming the person it waits on (the rep plan's `planStatusLine`, owner 2026-10-08):
 * "Drafted by …", "Waiting for Hany Saad to approve", "Waiting for Ali Mohamed Ali to approve",
 * "Approved by …", "Waiting for … to edit and resend". Every name arrives resolved.
 */
export function managerPlanStatusLine(input: {
  status: ManagerPlanStatus | null;
  managerName?: string | null;
  firstName?: string | null;
  secondName?: string | null;
  deciderName?: string | null;
  /** The decision was the Administrator's, in place of its holder. */
  byAdministrator?: boolean;
}): string {
  const manager = nameOrNull(input.managerName);
  const first = nameOrNull(input.firstName);
  const second = nameOrNull(input.secondName);
  const decider = input.byAdministrator ? "the Administrator" : nameOrNull(input.deciderName);
  if (input.status === "draft") return manager ? `Drafted by ${manager}` : managerPlanStatusLabel("draft");
  if (input.status === "submitted") return first ? `Waiting for ${first} to approve` : managerPlanStatusLabel("submitted");
  if (input.status === "first_approved") return second ? `Waiting for ${second} to approve` : managerPlanStatusLabel("first_approved");
  if (input.status === "returned") return manager ? `Waiting for ${manager} to edit and resend` : managerPlanStatusLabel("returned");
  if (input.status === "approved") return decider ? `Approved by ${decider}` : managerPlanStatusLabel("approved");
  return manager ? `Not started — ${manager} drafts it` : managerPlanStatusLabel(null);
}

/**
 * What a decision moves the week to — the database's own state machine, written once more so the screen
 * offers exactly the buttons the server will honour. Null: that decision is not open at this status.
 */
export function nextManagerPlanStatus(input: {
  action: "submit" | "approve" | "return";
  status: ManagerPlanStatus | null;
  stage: ManagerPlanStage | null;
  hasSecond: boolean;
}): ManagerPlanStatus | null {
  if (input.action === "submit") return input.status === "draft" || input.status === "returned" ? "submitted" : null;
  if (input.action === "approve") {
    if (input.stage === "first" && input.status === "submitted") return input.hasSecond ? "first_approved" : "approved";
    if (input.stage === "second" && input.status === "first_approved" && input.hasSecond) return "approved";
    return null;
  }
  if (input.stage === "first" && (input.status === "submitted" || (input.status === "approved" && !input.hasSecond))) return "returned";
  if (input.stage === "second" && input.hasSecond && (input.status === "first_approved" || input.status === "approved")) return "returned";
  return null;
}

/** The stage an approved week is returned at: the second approver's when there is one, else the first's. */
export function returnStageOfApproved(hasSecond: boolean): ManagerPlanStage {
  return hasSecond ? "second" : "first";
}

// ── A customer he ticked, read against the rep's own day ────────────────────────────────────────

/**
 * not_sent — the rep's week is not sent yet, so this is a draft of his (owner, 2026-10-16: "show the
 * rep's draft doctors, marked not sent"). dropped — the rep's day no longer holds the customer (owner:
 * "keep the DM's row and flag it"). Null — the rep's sent day holds it.
 */
export type ManagerCustomerFlag = "not_sent" | "dropped";

export function flagManagerCustomer(input: { onRepDay: boolean; repWeekSent: boolean }): ManagerCustomerFlag | null {
  if (!input.onRepDay) return "dropped";
  if (!input.repWeekSent) return "not_sent";
  return null;
}

export function managerCustomerFlagLabel(flag: ManagerCustomerFlag): string {
  return flag === "dropped" ? "No longer on the rep's day" : "Not sent";
}

/** The rep's half-day key: a seat, a day, and AM or PM. */
export function repHalfKey(seatId: string, date: string, half: ManagerHalf): string {
  return `${seatId}|${date}|${half}`;
}

/** The half a customer of the rep's day falls in: AM accounts the morning, PM doctors and pharmacies the evening. */
export function halfOfListType(listType: unknown): ManagerHalf | null {
  if (listType === "AM") return "AM";
  if (listType === "PM" || listType === "Pharmacy") return "PM";
  return null;
}

// ── Planned against actual ──────────────────────────────────────────────────────────────────────

/** done; not_done once the visit day closed; open while it has not; ahead for a day to come; not_checkable for admin. */
export type ManagerOutcome = "done" | "not_done" | "open" | "ahead" | "not_checkable";

/**
 * A planned customer against what happened. A with-rep customer is DONE when the rep logged a visit on
 * him that day naming this manager (`phoenix_crm_report_manager_visits`, the double visit's own rule);
 * a single-visit customer is DONE when he logged it himself. Admin is never checkable. A day closes for
 * its visits at 02:00 Cairo the next morning (`cairoBusinessDay`), so until then it is open.
 */
export function managerOutcome(input: { kind: ManagerSlotKind; date: string; done: boolean; cairoToday: string; visitDay: string }): ManagerOutcome {
  if (input.kind === "admin") return "not_checkable";
  if (input.done) return "done";
  if (input.date < input.visitDay) return "not_done";
  if (input.date <= input.cairoToday) return "open";
  return "ahead";
}

export function managerOutcomeLabel(outcome: ManagerOutcome): string {
  if (outcome === "done") return "Done";
  if (outcome === "not_done") return "Not done";
  if (outcome === "open") return "Today";
  if (outcome === "ahead") return "Coming";
  return "Admin";
}

export type ManagerPlanSummary = { planned: number; done: number; notDone: number; unplanned: number };

/** "Planned 12 · done 9" — with the unplanned single visits named apart when there are any. */
export function managerPlanSummaryText(summary: ManagerPlanSummary): string {
  const base = `Planned ${summary.planned} · done ${summary.done}`;
  return summary.unplanned > 0 ? `${base} · ${summary.unplanned} unplanned` : base;
}

// ── A customer he types: offer the match first ──────────────────────────────────────────────────

export type NameCandidate = { id: string; name: string; source: "rep" | "own" };

/**
 * The customers already on file under the name he typed — his reps' lists and his own list — folded the
 * way `phoenix_crm_fold_name` folds them (`normalizeContactName`), so "د/أحمد" and "Dr Ahmed" meet the
 * way the duplicate board meets them. Namesakes are real, so this OFFERS the match and he may still say
 * it is a different person; it never decides for him. An empty fold matches nothing.
 */
export function matchCustomerName<T extends NameCandidate>(typed: string, candidates: ReadonlyArray<T>, limit = 8): T[] {
  const key = normalizeContactName(typed);
  if (!key) return [];
  const exact: T[] = [];
  const partial: T[] = [];
  for (const candidate of candidates) {
    const folded = normalizeContactName(candidate.name);
    if (!folded) continue;
    if (folded === key) exact.push(candidate);
    else if (key.length >= 4 && (folded.includes(key) || key.includes(folded))) partial.push(candidate);
  }
  return [...exact, ...partial].slice(0, limit);
}
