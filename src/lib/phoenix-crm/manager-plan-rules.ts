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
 *     own list, or one he types (grade A/B/C and potential grade; speciality, phone, address and brick
 *     optional, filled in by hand or by Capture location, the area and brick cascading drop-lists; NO
 *     validation step — "there will not be validation because they are managers").
 *
 * Rules around it, every one his own answer that day:
 *   - It REPLACES his legacy Weekly/Monthly plan, once his own team is live (`dmPlansInPhoenixCrm`).
 *   - One week only: the coming Saturday's, due Thursday 23:55 Cairo like his reps' (calendar.ts
 *     `repPlanWeek`, `weeklyPlanDueOn`). A late send is accepted and stamped late, and the week he is IN
 *     can still be sent late while he never sent it — the rep's own rule (`repWeekState`).
 *   - Approved by his RSM/NSM — the nearest manager above his seat (`territoryReviewer`) — in the
 *     Approvals Hub, as today. When that first approver is a REGIONAL manager, the National Sales
 *     Manager above him approves next, always (owner, 2026-10-17 — `managerPlanApprovers`). No HR
 *     acknowledgement and no SFE step. The Administrator may act in place of whoever holds the step
 *     (Phoenix CRM's rule of 2026-10-14).
 *   - 🔴 THE REP NEVER SEES IT. Ticking a rep is NOT a double visit — "the double visit is only counted
 *     when the rep submit and log a visit and choose double visit and his manager". The actual is the
 *     visit the REP logs naming him, and the single visits HE logs himself, which count in his own
 *     report and nowhere else.
 *   - A rep who later drops a customer he ticked: his row stays and is FLAGGED, never removed.
 *
 * 🔴 WIDENED (owner, 2026-10-17): "Now do the same for the product managers and the national sales
 * managers and the regional manager. The only difference is that he first choose the region or the
 * district manager, then the areas of this district manager appear." Four kinds of planner now
 * (`ManagerPlannerKind`): the district manager as above; the regional and the national sales managers,
 * who first pick one of the district managers below their seat; and the product managers (Rasha Sabry and
 * Ahmed SharafEldeen), who first pick Pedia or Anti Infective, then a district manager of that line or
 * "any rep in the line". The district manager is picked once a day by default, a half on request. Their
 * approvers are "as today, HR auto acknowledge" — their own manager, then the CEO (`legacyStyleApprovers`)
 * — and only their weeks gain Office, the day their attendance is judged by.
 */

import { addDaysIso } from "@/lib/crm/dates";
import { normalizeContactName } from "@/lib/crm/campaign-contact-match";
import { fieldWeekDays, fieldWeekStart, isIsoDay, planDayListTypes, repPlanWeek, VISIT_DAY_CUTOFF_HOURS } from "@/lib/phoenix-crm/calendar";
import { dayActivityLabel, isDayActivity, PHOENIX_CRM_DAY_ACTIVITIES, type PhoenixCrmDayActivity } from "@/lib/phoenix-crm/day-activities";
import { countsAsManagersDoubleVisit, DOUBLE_VISIT_PLANNER_TIERS } from "@/lib/phoenix-crm/double-visit-plan-rules";
import { isUuid } from "@/lib/phoenix-crm/plan-rules";
import {
  heldManagerSeats,
  personKey,
  TERRITORY_TIER,
  territoriesBelow,
  territoryReviewer,
  type ChainMember,
  type OrgIndex,
  type OrgSeat,
} from "@/lib/phoenix-crm/scope";
import { secondApproverHrIdForManager } from "@/lib/workforce/plan-second-approver";

// ── The words ───────────────────────────────────────────────────────────────────────────────────

export type ManagerPlanStatus = "draft" | "submitted" | "first_approved" | "approved" | "returned";
export type ManagerSlotKind = "with_rep" | "admin" | "single_visit" | "with_dm" | "with_senior" | "with_area";
export type ManagerHalf = "AM" | "PM";

export const MANAGER_PLAN_HALVES: readonly ManagerHalf[] = ["AM", "PM"];

/**
 * The things a half-day can be, in the order the form offers them. 🔴 "With a district manager" is the
 * regional, national and product managers' only (owner, 2026-10-23: "add an option for him to visit with DM …
 * also GPM or PM") — a district manager is never offered it (`managerSlotKinds`) and the database refuses it
 * for one (`manager_plan_bad_kind`).
 */
export const MANAGER_SLOT_KINDS: ReadonlyArray<{ key: ManagerSlotKind; label: string }> = [
  { key: "with_rep", label: "With a rep" },
  { key: "with_dm", label: "With a district manager" },
  { key: "with_senior", label: "With my manager or product manager" },
  { key: "with_area", label: "An area" },
  { key: "admin", label: "Admin" },
  { key: "single_visit", label: "Single visit" },
];

/**
 * The half-day kinds one planner is offered. A district manager plans With my manager or product manager and
 * never With a district manager (owner, 2026-10-23: "in district managers account make them able to put the
 * pm/gpm w regional manager … follow organogram").
 *
 * 🔴 THE NATIONAL, REGIONAL AND PRODUCT MANAGERS PLAN A HALF-DAY WITH ONE ANOTHER TOO (owner, 2026-10-25: "in
 * weekly plan for nsm make an option to dv with product manager and if poedia make an option to with regional
 * manager same to product manager option 2 double visit with nsm and so on") — With a district manager AND
 * With a manager or product manager: the national manager with the line's product managers and his regional
 * managers, the regional manager with his national manager and the product managers, the product manager with
 * the regional and national managers of his lines. Never a product manager with another.
 *
 * 🔴 THE TRAINING MANAGER PLANS A REGION, THEN A REP OR AN AREA — NEVER A CUSTOMER, NEVER A DISTRICT MANAGER
 * (owner, 2026-10-24: "he neevr choose dr he choose the region then the area/rep only"; asked, "Rep, area or
 * Office"). With a rep, An area, and Admin (Office first); An area is hers alone.
 */
export function managerSlotKinds(kind: ManagerPlannerKind): ReadonlyArray<{ key: ManagerSlotKind; label: string }> {
  if (kind === "tm") return MANAGER_SLOT_KINDS.filter((entry) => entry.key === "with_rep" || entry.key === "with_area" || entry.key === "admin");
  return MANAGER_SLOT_KINDS.filter((entry) => entry.key !== "with_area" && (kind !== "dm" || entry.key !== "with_dm")).map((entry) =>
    entry.key === "with_senior" && kind !== "dm" ? { key: entry.key, label: MANAGER_PEER_SLOT_LABEL } : entry,
  );
}

/** What a regional, national or product manager's With a manager half-day is called — he has no "my manager" to name. */
export const MANAGER_PEER_SLOT_LABEL = "With a manager or product manager";

/** The most areas one half-day with a district manager holds — the database's own limit. */
export const MANAGER_DM_VISIT_AREA_MAX = 60;

/** The most customers one half-day holds — a rep's PM day is capped at 15, so this is room, not a target. */
export const MANAGER_SLOT_CUSTOMER_MAX = 60;
export const MANAGER_PLAN_NOTE_MAX = 500;
export const MANAGER_PLAN_REASON_MAX = 500;

/**
 * 🔴 A DISTRICT SALES MANAGER HAS ONE DAY OF SINGLE VISITS A WEEK WITHOUT APPROVAL — TWO HALF-DAYS, ANY MIX
 * (owner, 2026-10-19: "currently the single visits are accepted in 2 days in a week no cap it to 1 day in the
 * week"; the limit covers the visits he logs, not only the plan). A morning on Saturday and an afternoon on
 * Monday are one day together. It binds the district manager only — a regional, national or product
 * manager's single visits are not limited.
 *
 * 🔴 THE SECOND AND THIRD DAY ARE HIS MANAGERS' TO APPROVE, ONE NAMED DATE AT A TIME (owner, 2026-10-20: "if
 * you need to do the second or the third day maximum, he need to send an approval … not from the first day,
 * from the second day"; asked, "Ask first, then plan", "One named date", "Yes, planned and unplanned"). He asks
 * for a date; his regional manager and then the national sales manager above him approve it (or the national
 * sales manager alone where there is no regional manager), and an APPROVED date then holds single visits —
 * planned and logged — on both its halves without spending the free day. Two such dates a week at most
 * (`DM_SINGLE_VISIT_EXTRA_DAYS_MAX`).
 */
export const DM_SINGLE_VISIT_HALF_DAYS_MAX = 2;

/** The second and the third day: dates asked or approved in one week, at most. */
export const DM_SINGLE_VISIT_EXTRA_DAYS_MAX = 2;

/** The line his screens show under the limit: the board's Single visit part and "My single visits". */
export function dmSingleVisitLimitLine(used: number, approvedDays = 0): string {
  const free = `One day of single visits a week needs no approval, which is two half-days. This week holds ${used} of ${DM_SINGLE_VISIT_HALF_DAYS_MAX}.`;
  if (approvedDays > 0) return `${free} ${plural(approvedDays, "more day is", "more days are")} approved by your managers.`;
  return `${free} A second or third day needs your managers' approval first.`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** One half-day of one date, the unit the limit counts. */
export function singleVisitHalfKey(date: string, half: ManagerHalf): string {
  return `${date}|${half}`;
}

/** The date a half-day key names. */
export function singleVisitDateOfKey(key: string): string {
  return key.split("|")[0] ?? "";
}

/**
 * The half-days that spend the FREE day: every one the week holds, less those on a date his managers
 * approved — an approved date is paid for by its own approval.
 */
export function freeSingleVisitHalves(used: ReadonlySet<string>, approvedDates: ReadonlySet<string>): Set<string> {
  return new Set([...used].filter((key) => !approvedDates.has(singleVisitDateOfKey(key))));
}

/**
 * The half an unplanned visit falls in, from the Cairo hour it was logged: before noon is the morning.
 * 🔴 The hours before the visit-day cutoff (00:00–01:59) belong to the PREVIOUS day's evening — the visit is
 * filed on that day (`cairoBusinessDay`) — so they are its afternoon, never a morning. Read as a morning, a
 * visit logged at 00:08 opened a phantom second half-day on the day before, the week read "2 of 2", and the
 * "Log an unplanned customer" button vanished for the rest of the week (owner, 2026-10-20: "no button").
 */
export function singleVisitHalfOfHour(cairoHour: number): ManagerHalf {
  return cairoHour >= VISIT_DAY_CUTOFF_HOURS && cairoHour < 12 ? "AM" : "PM";
}

/**
 * 🔴 THE DAYS A WEEK'S OWN SINGLE VISITS ARE COUNTED OVER — Saturday through FRIDAY, from this one place.
 * The limit below (`manager-single-visit-cap.ts`) and the actual-versus-planned report
 * (`manager-plan-report.ts`) both read his logged visits over it, so they cannot disagree about which
 * visits belong to a week. A week is PLANNED Saturday to Thursday, but a visit can be LOGGED on any day, and a
 * Friday belongs to the field week before it (`fieldWeekStart`): a window that stopped at Thursday counted a
 * Friday visit in neither the limit nor any report. Friday is still not a planning day, and a Friday visit is
 * never refused — real extra work happens then — it is simply counted in the week it belongs to.
 */
export function managerVisitWindow(weekStart: string): { from: string; to: string } {
  return { from: weekStart, to: addDaysIso(weekStart, 6) };
}

/**
 * Whether one more half-day of single visits fits the week. `used` holds the half-days the week already
 * spends on them (planned ones and visits already logged); one that is among them is no new half-day. A
 * half-day on a date his managers APPROVED always fits, and the approved dates' half-days never count
 * against the free day. Null when it fits, else the words he is shown.
 */
export function dmSingleVisitCapError(
  used: ReadonlySet<string>,
  next: string,
  what: "plan" | "visit",
  approvedDates: ReadonlySet<string> = new Set(),
): string | null {
  if (approvedDates.has(singleVisitDateOfKey(next))) return null;
  const free = freeSingleVisitHalves(used, approvedDates);
  if (free.has(next) || free.size < DM_SINGLE_VISIT_HALF_DAYS_MAX) return null;
  const head = "A district manager has one day of single visits a week without approval, which is two half-days. Your week already holds two";
  return what === "plan"
    ? `${head}, so this half-day cannot be a single visit until your managers approve another day of single visits on this date. Ask for it under Single visit.`
    : `${head}, so this visit cannot be logged until your managers approve another day of single visits on this date. Ask for it under My single visits.`;
}

// ── His ask for a second or third day (owner, 2026-10-20) ───────────────────────────────────────────

export type SingleVisitDayAskStatus = "pending" | "first_approved" | "approved" | "refused" | "expired";

export function isSingleVisitDayAskStatus(value: unknown): value is SingleVisitDayAskStatus {
  return value === "pending" || value === "first_approved" || value === "approved" || value === "refused" || value === "expired";
}

/** Waiting on someone, or approved: the asks that hold one of the week's two extra dates. */
export function holdsAnExtraDay(status: SingleVisitDayAskStatus): boolean {
  return status === "pending" || status === "first_approved" || status === "approved";
}

/**
 * 🔴 AN ASK FOR A DAY IS LIVE ONLY WHILE ITS DATE HAS NOT PASSED. The database closes one nobody finished
 * deciding the day after (`phoenix_crm_expire_manager_single_visit_days`), and every reader asks this too, so
 * a row the pass has not closed yet never reaches an approver's queue or offers an Approve that would fail.
 */
export function isSingleVisitDayAskLive(status: unknown, visitDate: string, cairoToday: string): boolean {
  return (status === "pending" || status === "first_approved") && visitDate >= cairoToday;
}

/** What his screen says about one ask, given who it waits on. */
export function singleVisitDayAskStatusLabel(status: SingleVisitDayAskStatus, waitingOnName: string | null, live: boolean): string {
  if ((status === "pending" || status === "first_approved") && !live) return "Closed when the day passed";
  if (status === "pending" || status === "first_approved") return `Waiting for ${waitingOnName ?? "your manager"}`;
  if (status === "approved") return "Approved";
  if (status === "expired") return "Closed when the day passed";
  return "Refused";
}

/**
 * The dates he may ask for: a field day of this week or the coming one, from today on, not a holiday, and
 * not one already asked or approved. Null when this date may be asked, else why not.
 */
export function singleVisitDayAskError(input: {
  date: string;
  cairoToday: string;
  holiday: string | null;
  heldDates: ReadonlySet<string>;
}): string | null {
  if (!isIsoDay(input.date) || !managerPlanWeeks(input.cairoToday).includes(fieldWeekStart(input.date))) {
    return "Choose a day of this week or the coming one.";
  }
  if (input.date < input.cairoToday) return "This day has passed. Choose today or a later day.";
  if (input.holiday) return `${input.holiday} is a public holiday, so it holds no plan.`;
  if (managerDayHalves(input.date, null).length === 0) return "Choose a field day — Saturday to Thursday.";
  if (input.heldDates.has(input.date)) return "This day is already asked for. Its answer shows below.";
  const sameWeek = [...input.heldDates].filter((date) => fieldWeekStart(date) === fieldWeekStart(input.date)).length;
  if (sameWeek >= DM_SINGLE_VISIT_EXTRA_DAYS_MAX) {
    return "A week holds two more days of single visits at most — the second and the third. Both are already asked for.";
  }
  return null;
}

/** The grades he gives a customer he adds himself (owner, 2026-10-16: "A/B/C and potential grade"). */
export const MANAGER_CUSTOMER_GRADES = ["A", "B", "C"] as const;
export const MANAGER_CUSTOMER_POTENTIAL_GRADES = ["AA", "AB", "AC", "BA", "BB", "BC"] as const;
export type ManagerCustomerGrade = (typeof MANAGER_CUSTOMER_GRADES)[number];
export type ManagerCustomerPotentialGrade = (typeof MANAGER_CUSTOMER_POTENTIAL_GRADES)[number];

export function isManagerPlanStatus(value: unknown): value is ManagerPlanStatus {
  return value === "draft" || value === "submitted" || value === "first_approved" || value === "approved" || value === "returned";
}

export function isManagerSlotKind(value: unknown): value is ManagerSlotKind {
  return value === "with_rep" || value === "admin" || value === "single_visit" || value === "with_dm" || value === "with_senior" || value === "with_area";
}

/**
 * The half-days whose named doctors he logs as PLANNED visits on the day: a single visit, and With my manager
 * or product manager, whose doctors are optional (owner, 2026-10-27: "if he chose the drs when he submitting
 * the visits he found his today planned drs"). A with-senior visit never spends a single-visit half-day.
 */
export function holdsPlannedDoctors(kind: ManagerSlotKind | null): boolean {
  return kind === "single_visit" || kind === "with_senior";
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

// ── What a customer he adds must carry (owner, 2026-10-18) ──────────────────────────────────────

export const MANAGER_CUSTOMER_ADDRESS_MAX = 300;

/**
 * The first thing a customer he is adding still lacks, in his words, or null when it is complete.
 *
 * Owner, 2026-10-17: "the customer the DSM is adding … must enter his speciality, his name, his phone number,
 * and either fill the address, brick and area manually, or capture the location and the capture fills these
 * fields" — then, the same night, "make all optional … make everything we did now optional". So only the name,
 * the grade, the potential grade and an area of his region are needed; the speciality, the phone, the address
 * and the brick are all optional, and Capture location fills them when he presses it. The form asks this
 * before it sends and the server asks it again.
 */
export function missingManagerCustomerField(input: {
  name: string | null;
  areaChosen: boolean;
  grade: unknown;
  potentialGrade: unknown;
}): string | null {
  if (!input.name) return "Write the customer's name.";
  if (!isManagerCustomerGrade(input.grade)) return "Choose the grade: A, B or C.";
  if (!isManagerCustomerPotentialGrade(input.potentialGrade)) return "Choose the potential grade.";
  if (!input.areaChosen) return "Choose the area.";
  return null;
}

// ── A vacant area (owner, 2026-10-19) ───────────────────────────────────────────────────────────

/**
 * How a vacant area reads wherever a manager picks one: by its area name, with this beside it. Owner,
 * 2026-10-19: "make the vacant areas appear named as areas … when he chooses the vacant area he is able to
 * see the dr list of the previous rep". A territory's list belongs to the seat, not the person, so the list
 * a vacant seat still holds IS the previous rep's.
 */
export const VACANT_AREA_NOTE = "Vacant · the previous rep's list";

/** Where a customer of a vacant territory's list is said to come from, instead of a rep's name. */
export const VACANT_LIST_LABEL = "The previous rep's list";

/**
 * Why a single visit to a doctor of a VACANT territory cannot be saved yet, or null when it can. Owner,
 * 2026-10-19: "if the area is vacant make the district manager obligatory either to fill the dr address by
 * hand or to capture location and the address area and brick are auto filled — either this or this". He
 * chose that it binds the visit log only, not adding a customer to his own list. Nobody holds the territory,
 * so this visit is the only record of where its doctor is. Asked by the form before it sends and by the
 * server again; the database refuses the row too (`phoenix_crm_manager_visits_vacant_place`).
 */
export function vacantVisitPlaceError(input: { vacant: boolean; address: string | null; captured: boolean }): string | null {
  if (!input.vacant || input.captured || (input.address ?? "").trim().length > 0) return null;
  return "This customer's area has no rep. Type the customer's address, or press Capture location to fill in the address, area and brick.";
}

/**
 * Where a visit says its customer is — the address, area and brick the manager recorded — as his Visits
 * tab and the actual-versus-planned report print it (owner, 2026-10-19: what the visit was made to record
 * is shown back). Null when the visit recorded nothing at all. A capture nothing could be read from still
 * says that a location was captured.
 *
 * 🔴 IT IS NO LONGER A VACANT AREA'S PRIVILEGE (owner, 2026-10-20): every single visit now carries the
 * Add-a-customer place block, so every single visit can record a place and every one shows back what it
 * recorded. A visit that recorded nothing still prints nothing.
 */
export function visitPlaceText(input: {
  address: string | null;
  areaName: string | null;
  brickName: string | null;
  captured: boolean;
}): string | null {
  const parts = [
    input.address?.trim() || null,
    input.areaName?.trim() ? `Area: ${input.areaName.trim()}` : null,
    input.brickName?.trim() ? `Brick: ${input.brickName.trim()}` : null,
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) return parts.join(" · ");
  return input.captured ? "Location captured · no address could be read from it" : null;
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
 * 🔴 EXCEPT ON A VACANT TERRITORY, WHERE "MY OWN VISIT" STAYS OPEN AND THE VISIT IS FILED UNDER MY
 * SINGLE VISITS (owner, 2026-10-19: "It is a vacant area. So he must submit it there single"). Nobody
 * holds the seat, so there is no rep to make a double or a chain with — the closed option left the form
 * a dead end, filled to the last step and refused at the save. The save routes it to `logManagerVisit`
 * instead: his own single visits, counting in his own report only, against the same one-day-a-week cap
 * and under the same vacant place rule. The customer still comes from that ONE territory's list — the
 * previous rep's — never a merged list of every vacant area, which would be thousands of doctors.
 */
export const MANAGER_OWN_VISIT_ON_VACANT_NOTE = "Filed under My single visits";

export const MANAGER_OWN_VISIT_ON_VACANT_LINE =
  "Nobody holds this territory, so there is no rep to go with. Your own visit here is filed under My single visits and counts in your own report only. It keeps the products, your comment and where you were.";

/** What he is told after the save, where a rep would read whether the visit was on his plan. */
export const MANAGER_OWN_VISIT_ON_VACANT_SAVED = "Filed under My single visits — it counts in your own report only.";

/**
 * 🔴 WHEN A DISTRICT MANAGER PLANS IN PHOENIX CRM INSTEAD OF THE LEGACY FORM (owner, 2026-10-16): he
 * holds a DM or acting DM seat AND that seat's team is live. Each district manager switches by himself
 * the day his team starts — Mohamed Alaa Eleiwa keeps the legacy form until his does. `liveSeat` is the
 * server's live-team test (`seatIsInLiveTeam`), passed in so this file stays free of I/O.
 */
export function dmPlansInPhoenixCrmFor(seats: ReadonlyArray<OrgSeat>, liveSeat: (seat: OrgSeat) => boolean): boolean {
  return seats.some((seat) => liveSeat(seat));
}

// ── The four kinds of planner (owner, 2026-10-17) ───────────────────────────────────────────────

/**
 * dm — a district manager (or acting); rsm — a regional sales manager; nsm — a national sales manager; pm — a
 * product manager; tm — the Training Manager (owner, 2026-10-24).
 */
export type ManagerPlannerKind = "dm" | "rsm" | "nsm" | "pm" | "tm";

export function isManagerPlannerKind(value: unknown): value is ManagerPlannerKind {
  return value === "dm" || value === "rsm" || value === "nsm" || value === "pm" || value === "tm";
}

/** A planner who sits on no organogram seat — a product manager or the Training Manager, read by role. */
export function isSeatlessPlannerKind(kind: ManagerPlannerKind | null | undefined): boolean {
  return kind === "pm" || kind === "tm";
}

/** The app roles that plan as a product manager — Rasha Sabry (Group Product Manager) and Ahmed SharafEldeen. */
export const PRODUCT_MANAGER_PLAN_ROLES: ReadonlySet<string> = new Set(["Product Manager", "Group Product Manager"]);

/** The app role that plans as the Training Manager — Salma Labib (owner, 2026-10-24). */
export const TRAINING_MANAGER_PLAN_ROLES: ReadonlySet<string> = new Set(["Training Manager"]);

/**
 * 🔴 THE TWO LINES A PRODUCT MANAGER PLANS IN — his own ruling, 2026-10-17: "make him choose between the
 * 2 lines pedia and anti infective … whever he chooses from both appear its district managers", and
 * "Both of them" when asked whether it held for Rasha and Ahmed alike. CNS is not one of them.
 */
export const PRODUCT_MANAGER_PLAN_LINES: readonly string[] = ["pedia", "anti_infective"];

/** The regional and national seats a person holds — the national one first, since it reaches further. */
export function seniorPlanSeats(org: OrgIndex, hrId: string | null | undefined): OrgSeat[] {
  return heldManagerSeats(org, hrId)
    .filter((seat) => seat.tier === "RSM" || seat.tier === "NSM")
    .sort((left, right) => (left.tier === right.tier ? left.seatId.localeCompare(right.seatId) : left.tier === "NSM" ? -1 : 1));
}

export type ManagerPlanWriter = {
  kind: ManagerPlannerKind;
  hrId: string;
  /** The seat the week is filed on; null for a product manager, who holds none. */
  seat: OrgSeat | null;
  /** The lines he plans in: his seat's, or the product managers' two. */
  lineCodes: string[];
};

/**
 * Who plans a week here, and as what. A district manager seat comes first — a person on one plans as the
 * district manager he is, whatever else he holds — then a national or regional seat, then a product
 * manager's role, then the Training Manager's. `productManager` and `trainingManager` are the server's answers
 * (the role, held by a current employee).
 */
export function managerPlanWriterOf(
  org: OrgIndex,
  hrId: string | null | undefined,
  options: { productManager: boolean; trainingManager?: boolean },
): ManagerPlanWriter | null {
  const key = personKey(hrId);
  if (!key) return null;
  const dmSeat = managerPlanSeats(org, key)[0];
  if (dmSeat) return { kind: "dm", hrId: key, seat: dmSeat, lineCodes: dmSeat.lineCode ? [dmSeat.lineCode] : [] };
  const senior = seniorPlanSeats(org, key)[0];
  if (senior) return { kind: senior.tier === "NSM" ? "nsm" : "rsm", hrId: key, seat: senior, lineCodes: senior.lineCode ? [senior.lineCode] : [] };
  if (options.productManager) return { kind: "pm", hrId: key, seat: null, lineCodes: [...PRODUCT_MANAGER_PLAN_LINES] };
  if (options.trainingManager) {
    const lines = [...new Set(org.territories.flatMap((seat) => (seat.lineCode ? [seat.lineCode] : [])))].sort();
    return { kind: "tm", hrId: key, seat: null, lineCodes: lines };
  }
  return null;
}

/** What the screens call him: "District manager", "Regional sales manager", "National sales manager", "Product manager", "Training manager". */
export function managerPlannerTitle(kind: ManagerPlannerKind): string {
  if (kind === "rsm") return "Regional sales manager";
  if (kind === "nsm") return "National sales manager";
  if (kind === "pm") return "Product manager";
  if (kind === "tm") return "Training manager";
  return "District manager";
}

// ── The scope a regional, national or product manager picks first ───────────────────────────────

/**
 * One choice in the picker: a district manager's seat (and its line), or — a product manager's only —
 * a whole line, "any rep in the line" with no district manager (owner, 2026-10-17: "make product managers
 * able to skip district managers and choose a rep with out district manager").
 */
export type ManagerPlanScope = {
  key: string;
  dmSeatId: string | null;
  lineCode: string;
  lineName: string | null;
  /** The district manager on the seat; null for a vacant district, and for a whole line. */
  dmHrId: string | null;
  /** The regional seat a national sales manager's district sits under, so his picker groups it. */
  regionSeatId: string | null;
  regionHrId: string | null;
  /**
   * The Training Manager's scope: a whole region across every line (owner, 2026-10-24: "he choose the region
   * then the area/rep only"). Null for every other scope; a region scope carries no district and no line
   * (`lineCode` is "").
   */
  regionCode?: string | null;
  regionName?: string | null;
};

export function managerScopeKey(dmSeatId: string | null, lineCode: string, regionCode?: string | null): string {
  if (regionCode) return `region:${regionCode}`;
  return dmSeatId ? `dm:${dmSeatId}` : `line:${lineCode}`;
}

/**
 * The regions the Training Manager picks from: every organogram region holding a filled rep seat, in any line
 * — never the "Others" bucket, which holds no reps.
 */
function regionScopes(org: OrgIndex): ManagerPlanScope[] {
  const regions = new Map<string, string | null>();
  for (const seat of org.territories) {
    const code = seat.regionCode ?? null;
    if (!code || seat.tier !== TERRITORY_TIER || seatUnderOthers(org, seat) || !personKey(seat.occupantHrId)) continue;
    if (!regions.has(code) || (!regions.get(code) && seat.regionName)) regions.set(code, seat.regionName);
  }
  return [...regions.entries()]
    .map(([code, name]) => ({
      key: managerScopeKey(null, "", code),
      dmSeatId: null,
      lineCode: "",
      lineName: null,
      dmHrId: null,
      regionSeatId: null,
      regionHrId: null,
      regionCode: code,
      regionName: name ?? code,
    }))
    .sort((left, right) => (left.regionName ?? "").localeCompare(right.regionName ?? ""));
}

/** The district manager seats under a seat — never the per-line "Others" bucket, which holds no reps. */
function districtSeatsUnder(org: OrgIndex, rootSeatId: string): OrgSeat[] {
  return [...org.seats.values()]
    .filter((seat) => DOUBLE_VISIT_PLANNER_TIERS.has(seat.tier) && !seat.isOtherPseudoDm && seat.seatId !== rootSeatId && seat.path.includes(rootSeatId))
    .sort((left, right) => left.seatId.localeCompare(right.seatId));
}

function districtSeatsOfLine(org: OrgIndex, lineCode: string): OrgSeat[] {
  return [...org.seats.values()]
    .filter((seat) => DOUBLE_VISIT_PLANNER_TIERS.has(seat.tier) && !seat.isOtherPseudoDm && seat.lineCode === lineCode)
    .sort((left, right) => left.seatId.localeCompare(right.seatId));
}

function scopeOfDistrict(org: OrgIndex, seat: OrgSeat, writerSeatId: string | null): ManagerPlanScope {
  const region = seat.path
    .map((seatId) => org.seats.get(seatId))
    .find((above): above is OrgSeat => Boolean(above && above.tier === "RSM" && above.seatId !== writerSeatId));
  return {
    key: managerScopeKey(seat.seatId, seat.lineCode ?? ""),
    dmSeatId: seat.seatId,
    lineCode: seat.lineCode ?? "",
    lineName: seat.lineName,
    dmHrId: personKey(seat.occupantHrId),
    regionSeatId: region?.seatId ?? null,
    regionHrId: personKey(region?.occupantHrId),
  };
}

/**
 * The scopes a planner picks from. A district manager picks none — his scope is his own district, as
 * before. A regional or national sales manager: every district below his seat. A product manager: each of
 * his two lines' districts, then the line itself. A vacant district is offered only while its team is
 * live (`isLiveSeat`), since only a live team's reps plan here; a filled one always is.
 */
export function managerPlanScopes(org: OrgIndex, writer: ManagerPlanWriter, isLiveSeat: (seat: OrgSeat) => boolean = () => true): ManagerPlanScope[] {
  if (writer.kind === "dm") return [];
  if (writer.kind === "tm") return regionScopes(org);
  const offered = (seat: OrgSeat) => Boolean(seat.occupantHrId) || isLiveSeat(seat);
  if (writer.kind === "pm") {
    return writer.lineCodes.flatMap((lineCode) => {
      const districts = districtSeatsOfLine(org, lineCode).filter(offered);
      const lineName = districts[0]?.lineName ?? org.territories.find((seat) => seat.lineCode === lineCode)?.lineName ?? null;
      return [
        ...districts.map((seat) => scopeOfDistrict(org, seat, null)),
        { key: managerScopeKey(null, lineCode), dmSeatId: null, lineCode, lineName, dmHrId: null, regionSeatId: null, regionHrId: null },
      ];
    });
  }
  if (!writer.seat) return [];
  return districtSeatsUnder(org, writer.seat.seatId)
    .filter(offered)
    .map((seat) => scopeOfDistrict(org, seat, writer.seat?.seatId ?? null));
}

/** The scope a half-day names, if it is one the planner may pick. */
export function findManagerPlanScope(
  scopes: ReadonlyArray<ManagerPlanScope>,
  input: { dmSeatId: string | null; lineCode: string | null; regionCode?: string | null },
): ManagerPlanScope | null {
  if (input.regionCode) return scopes.find((scope) => scope.regionCode === input.regionCode) ?? null;
  if (!input.lineCode && !input.dmSeatId) return null;
  return scopes.find((scope) => !scope.regionCode && (input.dmSeatId ? scope.dmSeatId === input.dmSeatId : scope.dmSeatId === null && scope.lineCode === input.lineCode)) ?? null;
}

/**
 * The territories of one scope: under the district manager's seat, every one of the line, or — the Training
 * Manager's — every one of the region in every line. Never under "Others", never the planner's own.
 */
export function managerScopeTerritories(
  org: OrgIndex,
  scope: Pick<ManagerPlanScope, "dmSeatId" | "lineCode"> & { regionCode?: string | null },
  plannerHrId: string,
): OrgSeat[] {
  const own = personKey(plannerHrId);
  const seats = scope.regionCode
    ? org.territories.filter((seat) => seat.regionCode === scope.regionCode && !seatUnderOthers(org, seat))
    : scope.dmSeatId
    ? territoriesBelow(org, [scope.dmSeatId])
    : org.territories.filter((seat) => seat.lineCode === scope.lineCode && !seatUnderOthers(org, seat));
  return seats.filter((seat) => seat.tier === TERRITORY_TIER && personKey(seat.occupantHrId) !== own);
}

function seatUnderOthers(org: OrgIndex, seat: OrgSeat): boolean {
  return seat.path.some((seatId) => org.seats.get(seatId)?.isOtherPseudoDm === true);
}

/** Every territory a planner reaches, across all his scopes, once each. A district manager's is his district. */
export function managerWriterTerritories(org: OrgIndex, writer: ManagerPlanWriter, scopes: ReadonlyArray<ManagerPlanScope>): OrgSeat[] {
  if (writer.kind === "dm") {
    const roots = managerPlanSeats(org, writer.hrId).map((seat) => seat.seatId);
    return territoriesBelow(org, roots).filter((seat) => seat.tier === TERRITORY_TIER && personKey(seat.occupantHrId) !== writer.hrId);
  }
  const seen = new Map<string, OrgSeat>();
  for (const scope of scopes) for (const seat of managerScopeTerritories(org, scope, writer.hrId)) seen.set(seat.seatId, seat);
  return [...seen.values()].sort((left, right) => left.seatId.localeCompare(right.seatId));
}

// ── Admin, and Office ───────────────────────────────────────────────────────────────────────────

/**
 * 🔴 OFFICE IS NEVER A DISTRICT MANAGER'S. The national sales managers and the product managers are judged
 * on attendance by the days their plan marks Office (`attendance/plan-office-days.ts`), so the plan that
 * replaces their legacy form must carry it; a district manager's board never offered it, and the database
 * refuses it for one (`manager_plan_bad_kind`).
 */
export type ManagerAdminActivity = PhoenixCrmDayActivity | "office";

export const MANAGER_OFFICE_ACTIVITY = { key: "office", label: "Office" } as const;

export function isManagerAdminActivity(value: unknown): value is ManagerAdminActivity {
  return value === "office" || isDayActivity(value);
}

export function managerAdminActivityLabel(value: unknown): string | null {
  if (value === "office") return MANAGER_OFFICE_ACTIVITY.label;
  return isDayActivity(value) ? dayActivityLabel(value) : null;
}

/** The Admin choices a planner is offered: Office first for everyone but a district manager. */
export function managerAdminActivities(kind: ManagerPlannerKind): Array<{ key: string; label: string }> {
  const days = PHOENIX_CRM_DAY_ACTIVITIES.map((entry) => ({ key: entry.key, label: entry.label }));
  return kind === "dm" ? days : [{ key: MANAGER_OFFICE_ACTIVITY.key, label: MANAGER_OFFICE_ACTIVITY.label }, ...days];
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
  activityType: ManagerAdminActivity | null;
  areaSeatId: string | null;
  /** With a district manager, or with his manager or product manager: the areas ticked for the half-day, one at least. Empty otherwise. */
  areaSeatIds: string[];
  /** With my manager or product manager: the person the district manager goes with. Null otherwise. */
  seniorHrId: string | null;
  /**
   * The scope this half was planned in — a regional, national or product manager's pick (owner,
   * 2026-10-17). A district manager's half-day, an Admin one and a cleared one carry none.
   */
  scopeDmSeatId: string | null;
  scopeLineCode: string | null;
  /** The Training Manager's region (2026-10-24) — her With a rep and An area half-days carry it; nobody else's does. */
  scopeRegionCode: string | null;
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
  if (kind !== null && !isManagerSlotKind(kind)) return { ok: false, error: "Choose what the half-day is: With a rep, With a district manager, With my manager or product manager, An area, Admin or Single visit." };
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
  const scopeDmSeatId = textOf(body.scopeDmSeatId);
  const scopeLineCode = textOf(body.scopeLineCode);
  const scopeRegionCode = textOf(body.scopeRegionCode);
  if (scopeRegionCode && (scopeDmSeatId || scopeLineCode)) return { ok: false, error: "The region you chose could not be read. Reload the page." };
  if (scopeDmSeatId && !scopeLineCode) return { ok: false, error: "The district manager you chose could not be read. Reload the page." };
  const areaSeatIds = [...new Set((Array.isArray(body.areaSeatIds) ? body.areaSeatIds : []).map(textOf).filter((id): id is string => id !== null))];
  if (areaSeatIds.length > MANAGER_DM_VISIT_AREA_MAX) return { ok: false, error: `A half-day holds at most ${MANAGER_DM_VISIT_AREA_MAX} areas.` };
  const draft: ManagerSlotDraft = {
    date,
    half: body.half,
    kind,
    repSeatId: null,
    activityType: null,
    areaSeatId: null,
    areaSeatIds: [],
    seniorHrId: null,
    scopeDmSeatId: null,
    scopeLineCode: null,
    scopeRegionCode: null,
    note,
    customers: [],
  };
  if (kind === null) return { ok: true, value: draft };
  if (kind === "with_rep" && scopeRegionCode) {
    // The Training Manager's: a region, then a rep — never a customer (owner, 2026-10-24: "he neevr choose dr").
    if (!repSeatId) return { ok: false, error: "Choose the rep you go with." };
    if (customers.length > 0) return { ok: false, error: "With a rep, you choose the rep, not customers." };
    return { ok: true, value: { ...draft, repSeatId, scopeRegionCode } };
  }
  if (kind === "with_area") {
    if (!scopeRegionCode) return { ok: false, error: "Choose the region first." };
    if (!areaSeatId) return { ok: false, error: "Choose the area." };
    if (customers.length > 0) return { ok: false, error: "An area half-day names the area, not customers." };
    return { ok: true, value: { ...draft, areaSeatId, scopeRegionCode } };
  }
  if (scopeRegionCode) return { ok: false, error: "Only With a rep and An area are planned in a region." };
  if (kind === "with_rep") {
    if (!repSeatId) return { ok: false, error: "Choose the rep you go with." };
    if (customers.length === 0) return { ok: false, error: "Tick at least one of the rep's customers, or Mark all." };
    if (customers.some((entry) => "managerCustomerId" in entry)) return { ok: false, error: "With a rep, the customers are the rep's own." };
    return { ok: true, value: { ...draft, repSeatId, scopeDmSeatId, scopeLineCode, customers } };
  }
  if (kind === "admin") {
    if (!isManagerAdminActivity(activity)) return { ok: false, error: "Choose what the admin half-day is." };
    return { ok: true, value: { ...draft, activityType: activity } };
  }
  if (kind === "with_dm") {
    if (!scopeDmSeatId) return { ok: false, error: "Choose the district manager you go with." };
    if (areaSeatIds.length === 0) return { ok: false, error: "Tick at least one of the district manager's areas." };
    if (customers.length > 0) return { ok: false, error: "With a district manager, you tick the district manager's areas, not customers." };
    return { ok: true, value: { ...draft, areaSeatIds, scopeDmSeatId, scopeLineCode } };
  }
  if (kind === "with_senior") {
    const seniorHrId = personKey(textOf(body.seniorHrId));
    if (!seniorHrId) return { ok: false, error: "Choose who you go with: a manager or a product manager of the line." };
    if (areaSeatIds.length === 0) return { ok: false, error: "Tick at least one area of the district." };
    // The doctors are optional (owner, 2026-10-27: "he is not required to choose. He may choose or he may
    // press the next") and come from the ticked areas' rep lists — his own list stays a single visit's.
    if (customers.some((entry) => "managerCustomerId" in entry)) return { ok: false, error: "With a manager or product manager, the customers come from the areas' lists." };
    // A district manager's carries no scope (his own district); everyone else's names the district picked
    // first — `managerSlotScopeError` decides which one this planner owes.
    return { ok: true, value: { ...draft, areaSeatIds, seniorHrId, scopeDmSeatId, scopeLineCode, customers } };
  }
  if (!areaSeatId) return { ok: false, error: "Choose the area." };
  if (customers.length === 0) return { ok: false, error: "Choose at least one customer for the single visit." };
  return { ok: true, value: { ...draft, areaSeatId, scopeDmSeatId, scopeLineCode, customers } };
}

/**
 * 🔴 A HALF-DAY'S SCOPE AGAINST WHO PLANS IT. A district manager plans his own district, so his half-days
 * carry none and Office is refused him; everyone else names, on every half-day with a rep or a single
 * visit, the district (or line) he picked for it — one of HIS scopes. Null: the draft stands.
 */
export function managerSlotScopeError(
  kind: ManagerPlannerKind,
  draft: Pick<ManagerSlotDraft, "kind" | "activityType" | "scopeDmSeatId" | "scopeLineCode"> & { scopeRegionCode?: string | null },
  scopes: ReadonlyArray<ManagerPlanScope>,
): string | null {
  if (draft.kind === "admin" && draft.activityType === "office" && kind === "dm") return "Office is not one of a district manager's half-days.";
  // The Training Manager plans a region, then a rep or an area, or Admin — nothing else (owner, 2026-10-24).
  if (kind === "tm") {
    if (draft.kind === null || draft.kind === "admin") return null;
    if (draft.kind !== "with_rep" && draft.kind !== "with_area") return "The Training Manager plans With a rep, An area or Admin.";
    if (!draft.scopeRegionCode) return "Choose the region first.";
    return findManagerPlanScope(scopes, { dmSeatId: null, lineCode: null, regionCode: draft.scopeRegionCode }) ? null : "Choose one of the regions shown. Reload the page.";
  }
  if (draft.scopeRegionCode || draft.kind === "with_area") return "A region and An area are the Training Manager's half-days.";
  if (draft.kind === "with_senior") {
    // A district manager's is in his own district; everyone else's names a district first (owner, 2026-10-25).
    if (kind === "dm") return draft.scopeDmSeatId || draft.scopeLineCode ? "Your half-days are planned in your own district." : null;
    if (!draft.scopeDmSeatId) return "Choose the district manager first.";
  }
  if (draft.kind === "with_dm") {
    if (kind === "dm") return "With a district manager is not one of a district manager's half-days.";
    if (!draft.scopeDmSeatId) return "Choose the district manager you go with.";
  }
  if (draft.kind !== "with_rep" && draft.kind !== "single_visit" && draft.kind !== "with_dm" && draft.kind !== "with_senior") return null;
  if (kind === "dm") return draft.scopeDmSeatId || draft.scopeLineCode ? "Your half-days are planned in your own district." : null;
  if (!draft.scopeDmSeatId && !draft.scopeLineCode) return "Choose the district manager first.";
  return findManagerPlanScope(scopes, { dmSeatId: draft.scopeDmSeatId, lineCode: draft.scopeLineCode }) ? null : "Choose one of the district managers shown. Reload the page.";
}

// ── Who approves ────────────────────────────────────────────────────────────────────────────────

export type ManagerPlanStage = "first" | "second";

export type ManagerPlanApprovers = {
  /** His RSM/NSM — the nearest occupied manager seat above his. Null when the chain above is vacant. */
  first: ChainMember | null;
  /** The National Sales Manager above a regional first approver; null when the first is not regional. */
  secondHrId: string | null;
};

/**
 * Who approves a district manager's week (owner, 2026-10-16: "approval by his RSM/NSM, as today"). The
 * first approver is read from the organogram above HIS seat — the same tree the legacy plan already
 * agreed with for all 19 seats (measured 2026-10-16: zero drift against the HR record).
 *
 * 🔴 AFTER A REGIONAL MANAGER APPROVES, THE NATIONAL SALES MANAGER ABOVE HIM APPROVES TOO — NEVER SKIPPED
 * (owner, 2026-10-17: "if regional manager applicable then after the rm approve the nsm also must
 * approve never skip"). It is read from the organogram, so it holds for every RSM seat and not only for
 * Hany Saad → Ali Mohamed Ali, the one named pair it replaces. An EMPTY NSM seat passes the step upward
 * to the CEO, the way every vacant seat passes upward, so the week never closes on the regional
 * manager's approval alone. A district manager whose first approver IS the NSM (no regional manager
 * above him, or that seat empty) has one stage, as before.
 */
export function managerPlanApprovers(org: OrgIndex, managerSeatId: string): ManagerPlanApprovers {
  const first = territoryReviewer(org, managerSeatId);
  return { first, secondHrId: first ? approverAfterRegional(org, first) : null };
}

/** The person who approves after a regional manager: the NSM seat above his, else the CEO's; null when he is not regional. */
function approverAfterRegional(org: OrgIndex, first: ChainMember): string | null {
  if (first.seat.tier !== "RSM") return secondApproverHrIdForManager(first.hrId);
  const above = first.seat.path
    .filter((seatId) => seatId !== first.seat.seatId)
    .reverse()
    .map((seatId) => org.seats.get(seatId))
    .filter((seat): seat is OrgSeat => Boolean(seat && seat.occupantHrId && seat.occupantHrId !== first.hrId));
  return (above.find((seat) => seat.tier === "NSM") ?? above.find((seat) => seat.tier === "CEO"))?.occupantHrId ?? null;
}

/** The two approvers of a week or an ask, by person: whoever the planner's kind sends it to. */
export type ManagerApproverPair = { firstHrId: string | null; secondHrId: string | null };

/** The CEO: whoever sits on the organogram's CEO seat, or null while it is empty. */
export function ceoHrIdOf(org: OrgIndex): string | null {
  for (const seat of org.seats.values()) if (seat.tier === "CEO" && seat.occupantHrId) return personKey(seat.occupantHrId);
  return null;
}

/**
 * 🔴 "AS TODAY, HR AUTO ACKNOWLEDGE" (owner, 2026-10-17) — a regional, national or product manager's week,
 * his ask to edit it and his ask to take a customer off his own list go where his legacy weekly plan goes:
 * his own manager (`employees.manager_hr_id`) approves, then the CEO; when that manager IS the CEO, or he
 * has none, the CEO approves alone, in one step. HR's acknowledgement then follows by itself (the
 * transition stamps it). Measured on production that day: Hany Saad → Ali Mohamed Ali → the CEO; each
 * national sales manager → the CEO; Ahmed SharafEldeen → Rasha Sabry → the CEO; Rasha Sabry → Hossam
 * Reda → the CEO. A district manager's week never comes here — `managerPlanApprovers` keeps his seat chain.
 */
export function legacyStyleApprovers(input: { plannerHrId: string; managerHrId: string | null | undefined; ceoHrId: string | null | undefined }): ManagerApproverPair {
  const planner = personKey(input.plannerHrId);
  const manager = personKey(input.managerHrId);
  const ceo = personKey(input.ceoHrId);
  const ceoApprover = ceo && ceo !== planner ? ceo : null;
  if (!manager || manager === planner || manager === ceo) return { firstHrId: ceoApprover, secondHrId: null };
  return { firstHrId: manager, secondHrId: ceoApprover };
}

/** Whose turn a week is at: the first approver on a sent week, the second once the first approved. */
export function managerPlanStage(status: ManagerPlanStatus | null): ManagerPlanStage | null {
  if (status === "submitted") return "first";
  if (status === "first_approved") return "second";
  return null;
}

/**
 * Whose turn his ask to reopen a sent week, or to take a customer off his own list, is at — read off the
 * ask's own status. 🔴 The two asks follow the week (owner, 2026-10-17, "Week + edit asks + removals"):
 * after the regional manager agrees, the national sales manager stored on the ask decides too.
 */
export function managerAskStage(status: unknown): ManagerPlanStage | null {
  if (status === "pending" || status === "removal_pending") return "first";
  if (status === "first_approved" || status === "removal_first_approved") return "second";
  return null;
}

/**
 * 🔴 AN ASK TO EDIT A SENT WEEK IS LIVE ONLY WHILE THAT WEEK IS STILL A SENT ONE. Its Reopen is allowed on a
 * submitted, first-approved or approved week and nowhere else, so an ask still open on a week the approver
 * RETURNED (or that is a draft again) can decide nothing. The database closes such an ask in the transition
 * that returns or re-sends the week (20261018234000); every Hub reader asks this too, so a row the database
 * has not closed yet — or an old one — never reaches an approver's queue or shows a Reopen that would fail.
 * Edit asks only: an own-list removal does not hang on a week, so a removal's status never matches here.
 */
export function isManagerAskLive(askStatus: unknown, planStatus: ManagerPlanStatus | null | undefined): boolean {
  return (askStatus === "pending" || askStatus === "first_approved") && isManagerPlanSent(planStatus ?? null);
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
  /** HR acknowledged the approved week by itself — a regional, national or product manager's only. */
  hrAcknowledged?: boolean;
}): string {
  const manager = nameOrNull(input.managerName);
  const first = nameOrNull(input.firstName);
  const second = nameOrNull(input.secondName);
  const decider = input.byAdministrator ? "the Administrator" : nameOrNull(input.deciderName);
  if (input.status === "draft") return manager ? `Drafted by ${manager}` : managerPlanStatusLabel("draft");
  if (input.status === "submitted") return first ? `Waiting for ${first} to approve` : managerPlanStatusLabel("submitted");
  if (input.status === "first_approved") return second ? `Waiting for ${second} to approve` : managerPlanStatusLabel("first_approved");
  if (input.status === "returned") return manager ? `Waiting for ${manager} to edit and resend` : managerPlanStatusLabel("returned");
  if (input.status === "approved") {
    const approved = decider ? `Approved by ${decider}` : managerPlanStatusLabel("approved");
    return input.hrAcknowledged ? `${approved} · ${MANAGER_PLAN_HR_ACK_TEXT}` : approved;
  }
  return manager ? `Not started — ${manager} drafts it` : managerPlanStatusLabel(null);
}

/** The tracker's last step on a regional, national or product manager's approved week. */
export const MANAGER_PLAN_HR_ACK_TEXT = "Acknowledged by HR automatically";

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

/**
 * 🔴 A REP'S VISIT THAT ANSWERS A MANAGER'S "WITH A REP" HALF-DAY. A district, regional or national sales
 * manager: the double or chain visit naming him (`countsAsManagersDoubleVisit`, unchanged). A product
 * manager (owner, 2026-10-17): the rep's visit naming him as its product manager — the slot the visit form
 * already has for him (`product_manager_hr_id`), never a double visit of anyone else. Only the two kinds
 * that can carry him count — a product manager visit and a chain visit (`entry-rules.ts` writes the slot
 * for no other) — as the district manager's rule asks `double` or `chain` of its own slot.
 */
export function countsAsPlannersVisitWithRep(
  visit: { kind: unknown; managerHrId: unknown; seniorHrId: unknown; productManagerHrId?: unknown },
  plannerHrId: string | null | undefined,
): boolean {
  if (countsAsManagersDoubleVisit(visit, plannerHrId)) return true;
  const planner = personKey(plannerHrId);
  if (!planner || typeof visit.productManagerHrId !== "string") return false;
  if (visit.kind !== "product_manager" && visit.kind !== "chain") return false;
  return personKey(visit.productManagerHrId) === planner;
}

/**
 * 🔴 A REP'S VISIT THAT ANSWERS A "WITH A DISTRICT MANAGER" HALF-DAY (owner, 2026-10-23: "Done if a chain visit
 * names him"). The rep's visit must count as the planner's visit with a rep (`countsAsPlannersVisitWithRep`:
 * he is its senior, or its product manager) AND name that district manager as its manager — a chain visit, the
 * three of them together. A district with no district manager (a vacant seat the planner may still pick)
 * has nobody to name, so there the planner alone is asked of the visit. The caller matches the visit's seat
 * to the area and its day to the half-day's.
 */
export function countsAsPlannersVisitWithDm(
  visit: { kind: unknown; managerHrId: unknown; seniorHrId: unknown; productManagerHrId?: unknown },
  plannerHrId: string | null | undefined,
  dmHrId: string | null | undefined,
): boolean {
  if (!countsAsPlannersVisitWithRep(visit, plannerHrId)) return false;
  const dm = personKey(dmHrId);
  if (!dm) return true;
  return typeof visit.managerHrId === "string" && personKey(visit.managerHrId) === dm;
}

/** One area of a "with a district manager" half-day, as the row stores it (`dm_visit.areas`). */
export type ManagerDmVisitArea = { seatId: string; areaCode: string | null; areaName: string; seatIds: string[] };

/** A "with a district manager" half-day's own content: who he goes with and the areas he ticked. */
export type ManagerDmVisit = { dmHrId: string | null; areas: ManagerDmVisitArea[] };

/** The `dm_visit` column read strictly; null when it holds no area. */
export function parseManagerDmVisit(raw: unknown): ManagerDmVisit | null {
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  if (!body || !Array.isArray(body.areas)) return null;
  const areas: ManagerDmVisitArea[] = [];
  for (const entry of body.areas) {
    const area = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const seatId = textOf(area.seat_id);
    if (!seatId) continue;
    const seatIds = (Array.isArray(area.seat_ids) ? area.seat_ids : []).map(textOf).filter((id): id is string => id !== null);
    areas.push({ seatId, areaCode: textOf(area.area_code), areaName: textOf(area.area_name) ?? seatId, seatIds: seatIds.length > 0 ? seatIds : [seatId] });
  }
  if (areas.length === 0) return null;
  return { dmHrId: personKey(textOf(body.dm_hr_id)), areas };
}

/**
 * 🔴 WHO A DISTRICT MANAGER MAY GO WITH, FROM THE ORGANOGRAM (owner, 2026-10-23: "put the pm/gpm w regional
 * manager dr hany fi pedia w el ba3den de ali mohamed but anti infective district manager to national sales
 * manager … follow organogram"). The occupied manager seats above HIS seat, nearest first — the regional
 * manager where the line has one, then the national sales manager; the national sales manager alone where
 * there is no regional manager — and the product managers of the line. The very people a rep's chain visit
 * offers (`loadDoubleVisitOffers`); the server builds the list, and the save refuses anyone not on it.
 */
export type ManagerSeniorOffer = {
  hrId: string;
  role: "manager" | "product_manager";
  title: string;
  /** The line the person is offered in — the seat's line, or the planner's for a product manager. Null: every line. */
  lineCode?: string | null;
  /** The manager seat the person is offered on; null for a product manager. A regional seat is offered only in its own districts. */
  seatId?: string | null;
  /** The seat's tier ("RSM", "NSM"); null for a product manager. */
  tier?: string | null;
};

/**
 * 🔴 THE PEOPLE OFFERED IN ONE DISTRICT (owner, 2026-10-25). A regional, national or product manager picks the
 * district first, so the list narrows to it: a person of another line is dropped, and a regional manager only
 * where the district sits under his seat. A district manager's list is his own district's already — no scope,
 * everything stands.
 */
export function seniorOffersForScope<T extends ManagerSeniorOffer>(
  offers: ReadonlyArray<T>,
  scope: Pick<ManagerPlanScope, "lineCode" | "regionSeatId"> | null | undefined,
): T[] {
  if (!scope) return [...offers];
  return offers.filter((offer) => {
    if (offer.lineCode && scope.lineCode && offer.lineCode !== scope.lineCode) return false;
    if (offer.tier === "RSM") return Boolean(offer.seatId) && offer.seatId === scope.regionSeatId;
    return true;
  });
}

/** The title a manager seat above a district manager reads as on the picker. */
export function managerSeniorTitle(tier: string): string {
  if (tier === "RSM") return "Regional sales manager";
  if (tier === "NSM") return "National sales manager";
  return "Manager";
}

/**
 * 🔴 A REP'S VISIT THAT ANSWERS A DISTRICT MANAGER'S "WITH MY MANAGER OR PRODUCT MANAGER" HALF-DAY (owner,
 * 2026-10-23 — the mirror of `countsAsPlannersVisitWithDm`): a chain visit naming the district manager as its
 * manager AND the person picked as its senior or its product manager. The caller matches the visit's seat to
 * a ticked area and its day to the half-day's.
 */
export function countsAsDmsVisitWithSenior(
  visit: { kind: unknown; managerHrId: unknown; seniorHrId: unknown; productManagerHrId?: unknown },
  dmHrId: string | null | undefined,
  seniorHrId: string | null | undefined,
): boolean {
  const dm = personKey(dmHrId);
  const senior = personKey(seniorHrId);
  if (!dm || !senior || visit.kind !== "chain") return false;
  if (personKey(textOf(visit.managerHrId)) !== dm) return false;
  return personKey(textOf(visit.seniorHrId)) === senior || personKey(textOf(visit.productManagerHrId)) === senior;
}

/**
 * 🔴 A REP'S VISIT THAT ANSWERS A REGIONAL, NATIONAL OR PRODUCT MANAGER'S "WITH A MANAGER OR PRODUCT MANAGER"
 * HALF-DAY (owner, 2026-10-25): a chain visit naming BOTH of them, whichever column each sits in — a chain of
 * two managers stores the nearer as its manager and the farther as its senior, a manager with a product manager
 * as manager and product manager (`companyToStorage`). The caller matches the seat to a ticked area and the day.
 */
export function countsAsPlannersVisitWithPeer(
  visit: { kind: unknown; managerHrId: unknown; seniorHrId: unknown; productManagerHrId?: unknown },
  plannerHrId: string | null | undefined,
  peerHrId: string | null | undefined,
): boolean {
  const planner = personKey(plannerHrId);
  const peer = personKey(peerHrId);
  if (!planner || !peer || planner === peer || visit.kind !== "chain") return false;
  const named = new Set([visit.managerHrId, visit.seniorHrId, visit.productManagerHrId].map((value) => personKey(textOf(value))).filter(Boolean));
  return named.has(planner) && named.has(peer);
}

/** A "with my manager or product manager" half-day's own content: who goes with the district manager, and the areas ticked. */
export type ManagerSeniorVisit = { seniorHrId: string; role: "manager" | "product_manager"; title: string | null; areas: ManagerDmVisitArea[] };

/**
 * Who an approved district manager's week names as the manager or product manager he goes with, and on which
 * half-days (owner, 2026-10-24: the picked person is told). One entry per person, half-days in date order,
 * never the district manager himself.
 */
export function managerPlanWithYou(
  managerHrId: string,
  slots: ReadonlyArray<{ kind: ManagerSlotKind; date: string; half: ManagerHalf; areaName: string | null; seniorVisit: ManagerSeniorVisit | null }>,
): Array<{ recipientHrId: string; halves: Array<{ date: string; half: ManagerHalf; areaName: string | null }> }> {
  const self = personKey(managerHrId);
  const byPerson = new Map<string, Array<{ date: string; half: ManagerHalf; areaName: string | null }>>();
  for (const slot of slots) {
    const who = slot.kind === "with_senior" ? personKey(slot.seniorVisit?.seniorHrId) : null;
    if (!who || who === self) continue;
    const halves = byPerson.get(who) ?? [];
    halves.push({ date: slot.date, half: slot.half, areaName: slot.areaName });
    byPerson.set(who, halves);
  }
  return [...byPerson.entries()].map(([recipientHrId, halves]) => ({
    recipientHrId,
    halves: halves.sort((left, right) => left.date.localeCompare(right.date) || left.half.localeCompare(right.half)),
  }));
}

/** The `senior_visit` column read strictly; null when it names nobody or holds no area. */
export function parseManagerSeniorVisit(raw: unknown): ManagerSeniorVisit | null {
  const body = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null;
  const seniorHrId = personKey(textOf(body?.senior_hr_id));
  if (!body || !seniorHrId) return null;
  const areas = parseManagerDmVisit({ areas: body.areas })?.areas ?? [];
  if (areas.length === 0) return null;
  return { seniorHrId, role: body.role === "product_manager" ? "product_manager" : "manager", title: textOf(body.title), areas };
}

/** "With Hany Ibrahim (Regional sales manager) · Nasr City, Heliopolis" — the half-day in a line. */
export function managerSeniorVisitTitle(seniorName: string | null, title: string | null, areaNames: string | null): string {
  const who = `With ${seniorName ?? "your manager"}${title ? ` (${title})` : ""}`;
  return areaNames ? `${who} · ${areaNames}` : who;
}

/** "With Nermeen Adel · Nasr City, Heliopolis" — the half-day in a line. */
export function managerDmVisitTitle(dmName: string | null, areaNames: string | null): string {
  const who = `With ${dmName ?? "the district manager"}`;
  return areaNames ? `${who} · ${areaNames}` : who;
}

export function managerOutcomeLabel(outcome: ManagerOutcome): string {
  if (outcome === "done") return "Done";
  if (outcome === "not_done") return "Not done";
  if (outcome === "open") return "Today";
  if (outcome === "ahead") return "Coming";
  return "Admin";
}

export type ManagerPlanSummary = { planned: number; done: number; notDone: number; unplanned: number };

/**
 * What would make one planned customer DONE, as a key: the same key means the same visit. A with-a-rep
 * customer is answered by the rep's visit on that customer that day (seat, day and customer); a single-visit
 * customer by the visit HE logged that day on that customer. Null when nothing can share it (an admin
 * half-day, a with-rep row that names no customer).
 */
export function managerEvidenceKey(input: {
  kind: ManagerSlotKind;
  repSeatId: string | null;
  date: string;
  customerId: string | null;
  managerCustomerId: string | null;
  /** With a district manager: the area the row is about. One chain visit in it answers it on both halves of the day. */
  areaSeatId?: string | null;
  /** The Training Manager's row: her With a rep names no customer. */
  trainingManager?: boolean;
}): string | null {
  if (input.kind === "with_rep") {
    if (input.repSeatId && input.customerId) return `rep|${input.repSeatId}|${input.date}|${input.customerId}`;
    // The Training Manager's With a rep names the rep alone: one visit of his with her that day answers it.
    return input.repSeatId && input.trainingManager ? `tmrep|${input.repSeatId}|${input.date}` : null;
  }
  if (input.kind === "with_area") return input.areaSeatId ? `area|${input.date}|${input.areaSeatId}` : null;
  if (input.kind === "with_dm") return input.areaSeatId ? `dm|${input.date}|${input.areaSeatId}` : null;
  if (input.kind === "with_senior") return input.areaSeatId ? `sr|${input.date}|${input.areaSeatId}` : null;
  if (input.kind === "single_visit") {
    if (input.customerId) return `own|${input.date}|c:${input.customerId}`;
    return input.managerCustomerId ? `own|${input.date}|m:${input.managerCustomerId}` : null;
  }
  return null;
}

/** One planned customer of a sent week, as the report's counts read it. */
export type ManagerCountRow = {
  outcome: ManagerOutcome;
  /** The customer has since left the list (a rep's) or come off Manager's own list. */
  gone: boolean;
  /** `managerEvidenceKey`: rows sharing one are answered by one visit. */
  evidenceKey: string | null;
};

/**
 * 🔴 THE REPORT'S THREE COUNTS — planned, done and not done — from the rows of a sent week. Two rows that
 * are about the SAME PIECE OF EVIDENCE count once: a customer ticked in both halves of one day is one visit
 * to make (his single visit is keyed by day and customer, the rep's by seat, day and customer), so a visit
 * that marks both rows Done is one done, and none is one missed, never two. A customer who has since left
 * the list — a rep dropped him, or he came off Manager's own list — is still LISTED, with his flag, but is
 * no longer owed a visit: he is in none of the three counts. An admin half-day is not checkable and is
 * counted nowhere. The rows keep their own outcome for display; only the counts merge them.
 */
export function countManagerOutcomes(rows: ReadonlyArray<ManagerCountRow>): Pick<ManagerPlanSummary, "planned" | "done" | "notDone"> {
  const seen = new Set<string>();
  const counts = { planned: 0, done: 0, notDone: 0 };
  for (const row of rows) {
    if (row.outcome === "not_checkable" || row.gone) continue;
    if (row.evidenceKey !== null) {
      if (seen.has(row.evidenceKey)) continue;
      seen.add(row.evidenceKey);
    }
    counts.planned += 1;
    if (row.outcome === "done") counts.done += 1;
    if (row.outcome === "not_done") counts.notDone += 1;
  }
  return counts;
}

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
