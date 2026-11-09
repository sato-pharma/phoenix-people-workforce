import { forbiddenError } from "@/lib/http/api-errors";
import { addDaysIso, cairoTodayIso } from "@/lib/crm/dates";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { leaveDayKey } from "@/lib/phoenix-crm/plan-leave";
import {
  isManagerPlanSent,
  isManagerWeekEndedUndecided,
  managerAdminActivityLabel,
  managerPlanStatusLabel,
  managerPlannerTitle,
  type ManagerHalf,
  type ManagerPlannerKind,
  type ManagerPlanStatus,
  type ManagerSlotKind,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { NO_REGION, seatRegionName } from "@/lib/phoenix-crm/region-manager-groups";
import { personKey, seatOccupants, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readsRegionalTeamReports, regionalReportWorlds, regionalTeamRepSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadSeatLeaveDays } from "@/lib/phoenix-crm/server/leave-days";
import { loadManagerPlanHalfDays, loadManagerPlansInRange, managerHalfDayText, managerPlanHref } from "@/lib/phoenix-crm/server/manager-plan-readers";
import { loadManagerSlotCustomers, loadManagerSlotRows, type ManagerSlotRow } from "@/lib/phoenix-crm/server/manager-plan-rows";
import { loadRepWeeks, type RepWeekState } from "@/lib/phoenix-crm/server/manager-plans";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";

/**
 * Who is with which rep on which day — and the district managers' own weeks, as the Regional Sales Manager reads
 * them (owner, 2026-11-08, Dr. Hany Saad's fifth and sixth needs: "when the manager picks the day to go with a
 * rep, is someone already working with him, is anyone else going with him", "when planning with the manager,
 * know who he goes with and whom he will visit").
 *
 * 🔴 SAME REP + SAME DAY + TWO OF HIS MANAGERS IS A CHAIN VISIT, SHOWN NEUTRALLY — NEVER A WARNING OR A CLASH
 * (owner, 2026-10-24, the planning calendar's rule, applied here word for word). It is information only: it
 * never blocks a save and never colours a half-day as a problem.
 *
 * Read from the Phoenix CRM manager plans, every planner kind, SENT weeks only (`isManagerPlanSent`): a draft is
 * an intention nobody was asked about. The old weekly plan form is not read — its last plan was written on
 * 24 October 2026, before the Phoenix CRM plan took over.
 */

export type RepDayBooking = {
  repSeatId: string;
  date: string;
  half: ManagerHalf;
  managerHrId: string;
  plannerKind: ManagerPlannerKind;
};

export type ChainVisitPerson = { name: string; title: string };

/** "Chain visit — Mohamed Alaa Eleiwa (District manager) is also with Ahmed Ali this day". */
export function chainVisitLine(other: ChainVisitPerson, repName: string): string {
  return `Chain visit — ${other.name} (${other.title}) is also with ${repName} this day`;
}

/**
 * The OTHER managers booked on this rep this day — any half, each person once. Pure, so the rule is pinned
 * without a database: the manager asked about is never his own chain visit.
 */
export function otherManagersOnRepDay(
  bookings: ReadonlyArray<RepDayBooking>,
  repSeatId: string,
  date: string,
  exceptHrId: string | null,
): RepDayBooking[] {
  const except = personKey(exceptHrId);
  const seen = new Map<string, RepDayBooking>();
  for (const booking of bookings) {
    if (booking.repSeatId !== repSeatId || booking.date !== date) continue;
    const key = personKey(booking.managerHrId);
    if (!key || key === except || seen.has(key)) continue;
    seen.set(key, booking);
  }
  return [...seen.values()];
}

/** Every sent with-a-rep half-day on these reps' seats inside [from, to], from every kind of planner. */
export async function loadRepDayBookings(input: {
  repSeatIds: ReadonlyArray<string>;
  from: string;
  to: string;
  isTest: boolean;
}): Promise<RepDayBooking[]> {
  if (input.repSeatIds.length === 0) return [];
  const seats = new Set(input.repSeatIds);
  const halves = await loadManagerPlanHalfDays({ customerCounts: false, from: input.from, isTest: input.isTest, sentOnly: true, to: input.to });
  return halves.flatMap((half) =>
    half.kind === "with_rep" && half.repSeatId && seats.has(half.repSeatId)
      ? [{ date: half.date, half: half.half, managerHrId: half.managerHrId, plannerKind: half.plannerKind, repSeatId: half.repSeatId }]
      : [],
  );
}

// ── District Managers' Plans ─────────────────────────────────────────────────────────────────────

const DISTRICT_TIERS = new Set(["DM", "ACTING_DM"]);

const REP_DAY_LABEL: Record<RepWeekState, string> = {
  sent: "Sent",
  not_sent: "Not sent",
  old_crm: "Old CRM plan",
  no_plan: "No plan",
};

/**
 * One customer ticked for a half-day, as the list holds it now (owner, 2026-11-08, Dr. Hany Saad's sixth need: "know
 * who he goes with and whom he will visit"). The grade is the list's A, B or C, or null when it has none.
 */
export type DistrictPlanCustomer = {
  name: string;
  grade: "A" | "B" | "C" | null;
  speciality: string | null;
  /** The customer has since left the rep's list or come off the manager's own. */
  gone: boolean;
  /** From the manager's own list, not a rep's. */
  ownList: boolean;
};

/** "A", "B" or "C" from whatever the list holds ("a", " B "); anything else is no grade. */
export function districtCustomerGrade(value: string | null | undefined): DistrictPlanCustomer["grade"] {
  const grade = (value ?? "").trim().toUpperCase();
  return grade === "A" || grade === "B" || grade === "C" ? grade : null;
}

export type DistrictPlanHalf = {
  half: ManagerHalf;
  /** The customers ticked, each with its grade and speciality — the same customers as `customers`, in the same order. */
  customerDetails: DistrictPlanCustomer[];
  /** What the half-day is — with a rep, admin, a single visit, with his own manager. The panels count by it. */
  kind: ManagerSlotKind;
  /** The rep seat he is with — with a rep only. */
  repSeatId: string | null;
  /** The area a single visit or an area half-day names. */
  areaName: string | null;
  /** The customers ticked for the half that have since left the list or come off his own — named, and counted here. */
  goneCustomers: number;
  /** The rep is on approved leave that day (never set when leave could not be read). */
  repOnLeave: boolean;
  /** The rep's own week this week — with a rep only. */
  repWeekState: RepWeekState | null;
  /** "With Ahmed Ali", "Training", "Single visit · Nasr City" — the words every manager-plan screen prints. */
  text: string;
  repName: string | null;
  /** The customers he ticked for the half, by name. */
  customers: string[];
  /** The rep's own day: "On leave", or his week's state ("Sent", "Not sent", "Old CRM plan", "No plan"). With a rep only. */
  repDay: string | null;
  /** Neutral Chain visit lines — another manager with the same rep the same day. */
  chainVisits: string[];
};

export type DistrictPlanDay = {
  date: string;
  dateText: string;
  halves: DistrictPlanHalf[];
  /**
   * The district manager himself is on approved leave this day (owner, 2026-11-09: "if vacation put it") — a day he
   * planned nothing on then reads "On leave", never "Nothing planned".
   */
  managerOnLeave: boolean;
};

/** One rep seat in a district manager's team, as this week finds it (owner, 2026-11-09: the premium pass). */
export type DistrictTeamRep = {
  seatId: string;
  /** The person in the seat, or the territory when it is vacant. */
  name: string;
  territory: string;
  vacant: boolean;
  /** The rep's own week: sent, not sent, the old CRM's, or no plan. */
  weekState: RepWeekState;
  /** The days of this week the rep is on approved leave — empty when leave could not be read. */
  leaveDays: string[];
  /** Every manager with a sent half-day on this rep this week, the district manager included — each person once. */
  managers: string[];
  /** How many sent half-days any manager has booked with this rep this week — two managers on one half count twice. */
  managerHalves: number;
};

export type DistrictManagerWeek = {
  /** The organogram region — the heading names it with the manager (owner, 2026-11-09). */
  regionName: string;
  /** The region's rep seats with nobody in them. */
  vacantSeats: number;
  repSeats: number;
  managerHrId: string | null;
  managerName: string;
  districtName: string;
  /**
   * "Approved", "Waiting for approval", "Ended before it was approved" for a sent week its Thursday passed undecided,
   * or "Not sent yet" for a draft, a returned week or none at all.
   */
  statusText: string;
  sent: boolean;
  /** His district manager seat. */
  districtSeatId: string;
  /** The week's own plan, when there is one — sent or not. */
  planId: string | null;
  /** Where a SENT week opens on the Approvals Hub (`managerPlanHref`); null for a week not sent, whose draft is never shown. */
  planHref: string | null;
  status: ManagerPlanStatus | null;
  /** The day the week was due to be sent. */
  dueOn: string | null;
  submittedAt: string | null;
  /** Sent after it was due — the database's own stamp. */
  submittedLate: boolean;
  /** When the last decision on it was taken. */
  decidedAt: string | null;
  /** A sent week nobody finished deciding before its Thursday passed (`isManagerWeekEndedUndecided`). */
  endedUndecided: boolean;
  /** The rep seats under his district, in territory order. */
  reps: DistrictTeamRep[];
  /** The days of this week he is on approved leave himself — empty when leave could not be read. */
  managerLeaveDays: string[];
  /** Empty unless the week is sent: his draft is never shown. */
  days: DistrictPlanDay[];
};

export type DistrictManagersPlans = {
  weekStart: string;
  weekEnd: string;
  /** The Cairo day the report was read on — whether the week is past, running or ahead is judged from it. */
  cairoToday: string;
  weeks: DistrictManagerWeek[];
  /** Approved leave could not be read: "On leave" is then not shown, and the page says so. */
  leaveUnread: boolean;
};

/** The district manager seats under the Regional Sales Manager's own seat — never the line's "Others". */
export function regionalDistrictSeats(viewer: Pick<PhoenixCrmViewer, "org" | "managerSeats">): OrgSeat[] {
  const regional = new Set(viewer.managerSeats.filter((seat) => seat.tier === "RSM").map((seat) => seat.seatId));
  const out: OrgSeat[] = [];
  for (const seat of viewer.org.seats.values()) {
    if (!DISTRICT_TIERS.has(seat.tier) || seat.isOtherPseudoDm) continue;
    if (seat.path.some((ancestorId) => ancestorId !== seat.seatId && regional.has(ancestorId))) out.push(seat);
  }
  return out.sort((left, right) => territoryName(left).localeCompare(territoryName(right)));
}

/** One planned half-day, in the words every manager-plan screen prints. */
function halfText(slot: ManagerSlotRow, repName: string | null, names: PeopleNames): string {
  return managerHalfDayText(
    { activityLabel: slot.kind === "admin" ? (managerAdminActivityLabel(slot.activityType) ?? "Admin") : null, areaName: slot.areaName, kind: slot.kind },
    repName,
    slot.seniorVisit?.seniorHrId ? nameOf(names, slot.seniorVisit.seniorHrId) : null,
  );
}

/** These district managers' plans for one week, the sent weeks' half-days, and each half's customers by name. */
async function readDistrictWeeks(managerHrIds: ReadonlyArray<string>, weekStart: string, worlds: ReadonlyArray<boolean>) {
  const weekEnd = addDaysIso(weekStart, 6);
  const plans = managerHrIds.length
    ? (await Promise.all(worlds.map((isTest) => loadManagerPlansInRange({ from: weekStart, isTest, managerHrIds, plannerKinds: ["dm"], to: weekEnd }))))
        .flat()
        .filter((plan) => plan.weekStart === weekStart)
    : [];
  const sentPlans = plans.filter((plan) => isManagerPlanSent(plan.status));
  const slots = sentPlans.length ? await loadManagerSlotRows(sentPlans.map((plan) => plan.planId)) : [];
  const customers = slots.length ? await loadManagerSlotCustomers(slots.filter((slot) => slot.kind !== "admin").map((slot) => slot.slotId)) : [];
  const customersBySlot = new Map<string, string[]>();
  const detailsBySlot = new Map<string, DistrictPlanCustomer[]>();
  const goneBySlot = new Map<string, number>();
  for (const row of customers) {
    customersBySlot.set(row.slotId, [...(customersBySlot.get(row.slotId) ?? []), row.name]);
    detailsBySlot.set(row.slotId, [
      ...(detailsBySlot.get(row.slotId) ?? []),
      { gone: row.gone, grade: districtCustomerGrade(row.grade), name: row.name, ownList: row.managerCustomerId !== null, speciality: row.speciality },
    ]);
    if (row.gone) goneBySlot.set(row.slotId, (goneBySlot.get(row.slotId) ?? 0) + 1);
  }
  // A test account reads both worlds, so a manager can have a real week and a test one: the sent real week first,
  // then a sent test week, then whichever is left.
  const planOf = (managerHrId: string | null) => {
    if (!managerHrId) return null;
    const mine = plans.filter((row) => personKey(row.managerHrId) === personKey(managerHrId));
    return (
      mine.find((row) => !row.isTest && isManagerPlanSent(row.status)) ??
      mine.find((row) => isManagerPlanSent(row.status)) ??
      mine.find((row) => !row.isTest) ??
      mine[0] ??
      null
    );
  };
  return { customersBySlot, detailsBySlot, goneBySlot, planOf, slots };
}

/** One rep week per seat across the worlds read: the real week, unless it is "No plan" and a test week is there. */
export function mergeRepWeeks<T extends { state: RepWeekState }>(maps: ReadonlyArray<Map<string, T>>): Map<string, T> {
  const out = new Map<string, T>();
  for (const map of maps) {
    for (const [seatId, week] of map) {
      const held = out.get(seatId);
      if (!held || (held.state === "no_plan" && week.state !== "no_plan")) out.set(seatId, week);
    }
  }
  return out;
}

function dayText(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Cairo", weekday: "long" });
}

export async function loadDistrictManagersPlans(viewer: PhoenixCrmViewer, anyDayOfWeek: string): Promise<DistrictManagersPlans> {
  if (!readsRegionalTeamReports(viewer)) throw forbiddenError("This report is for the Regional Sales Manager.");
  const weekStart = fieldWeekStart(anyDayOfWeek);
  const weekEnd = addDaysIso(weekStart, 6);
  const cairoToday = cairoTodayIso();
  // A test account reads the real team and its own test work beside it (regionalReportWorlds).
  const worlds = regionalReportWorlds(viewer);
  const districts = regionalDistrictSeats(viewer);
  const managerHrIds = districts.flatMap((seat) => (seat.occupantHrId ? [seat.occupantHrId] : []));
  const repSeats = regionalTeamRepSeats(viewer);

  const [{ customersBySlot, detailsBySlot, goneBySlot, planOf, slots }, bookings, repWeeks, repLeave, managerLeave] = await Promise.all([
    readDistrictWeeks(managerHrIds, weekStart, worlds),
    Promise.all(worlds.map((isTest) => loadRepDayBookings({ from: weekStart, isTest, repSeatIds: repSeats.map((seat) => seat.seatId), to: weekEnd }))).then((parts) => parts.flat()),
    Promise.all(worlds.map((isTest) => loadRepWeeks(repSeats.map((seat) => seat.seatId), weekStart, isTest))).then(mergeRepWeeks),
    loadSeatLeaveDays(repSeats, { from: weekStart, to: weekEnd }),
    loadSeatLeaveDays(districts, { from: weekStart, to: weekEnd }),
  ]);
  // One flag for the page: either read failing means "On leave" is not shown this time, for anyone.
  const leaveUnread = repLeave.unread || managerLeave.unread;
  const leave = { days: repLeave.days, unread: leaveUnread };
  const managerOnLeave = (seatId: string, date: string) => !leaveUnread && managerLeave.days.has(leaveDayKey(seatId, date));

  const repSeatById = new Map(repSeats.map((seat) => [seat.seatId, seat]));
  const names = await loadPeopleNames([
    ...managerHrIds,
    ...bookings.map((booking) => booking.managerHrId),
    ...slots.map((slot) => slot.repHrId),
    ...slots.map((slot) => slot.seniorVisit?.seniorHrId ?? null),
    ...repSeats.map((seat) => seat.occupantHrId),
  ]);
  const repNameOf = (seatId: string | null, hrId: string | null): string | null => {
    const holder = hrId ?? (seatId ? (repSeatById.get(seatId)?.occupantHrId ?? viewer.org.seats.get(seatId)?.occupantHrId ?? null) : null);
    if (holder) return nameOf(names, holder);
    const seat = seatId ? viewer.org.seats.get(seatId) : undefined;
    return seat ? territoryName(seat) : null;
  };

  const days = Array.from({ length: 7 }, (_, offset) => addDaysIso(weekStart, offset));
  const weeks: DistrictManagerWeek[] = districts.map((district) => {
    const managerHrId = district.occupantHrId ?? null;
    const plan = planOf(managerHrId);
    const sent = Boolean(plan && isManagerPlanSent(plan.status));
    const mySlots = sent && plan ? slots.filter((slot) => slot.planId === plan.planId) : [];
    const planDays: DistrictPlanDay[] = [];
    for (const date of days) {
      const daySlots = mySlots.filter((slot) => slot.date === date).sort((left, right) => left.half.localeCompare(right.half));
      // Friday is shown only when he planned something on it.
      if (daySlots.length === 0 && new Date(`${date}T12:00:00Z`).getUTCDay() === 5) continue;
      planDays.push({
        date,
        dateText: dayText(date),
        managerOnLeave: managerOnLeave(district.seatId, date),
        halves: daySlots.map((slot): DistrictPlanHalf => {
          const repName = slot.kind === "with_rep" ? repNameOf(slot.repSeatId, slot.repHrId) : null;
          let repDay: string | null = null;
          let repOnLeave = false;
          let repWeekState: RepWeekState | null = null;
          const chainVisits: string[] = [];
          if (slot.kind === "with_rep" && slot.repSeatId) {
            repOnLeave = !leave.unread && leave.days.has(leaveDayKey(slot.repSeatId, date));
            repWeekState = repWeeks.get(slot.repSeatId)?.state ?? "no_plan";
            repDay = repOnLeave ? "On leave" : REP_DAY_LABEL[repWeekState];
            for (const other of otherManagersOnRepDay(bookings, slot.repSeatId, date, managerHrId)) {
              chainVisits.push(chainVisitLine({ name: nameOf(names, other.managerHrId), title: managerPlannerTitle(other.plannerKind) }, repName ?? "the rep"));
            }
          }
          return {
            areaName: slot.areaName,
            chainVisits,
            customerDetails: detailsBySlot.get(slot.slotId) ?? [],
            customers: customersBySlot.get(slot.slotId) ?? [],
            goneCustomers: goneBySlot.get(slot.slotId) ?? 0,
            half: slot.half,
            kind: slot.kind,
            repDay,
            repName,
            repOnLeave,
            repSeatId: slot.kind === "with_rep" ? slot.repSeatId : null,
            repWeekState,
            text: halfText(slot, repName, names),
          };
        }),
      });
    }
    const underHim = repSeats.filter((seat) => seat.path.includes(district.seatId));
    const reps: DistrictTeamRep[] = underHim
      .map((seat): DistrictTeamRep => {
        const vacant = seatOccupants(seat).length === 0;
        const managers = new Map<string, string>();
        let managerHalves = 0;
        for (const booking of bookings) {
          if (booking.repSeatId !== seat.seatId) continue;
          managerHalves += 1;
          const key = personKey(booking.managerHrId);
          if (key && !managers.has(key)) managers.set(key, nameOf(names, booking.managerHrId));
        }
        return {
          leaveDays: leave.unread ? [] : days.filter((date) => leave.days.has(leaveDayKey(seat.seatId, date))),
          managerHalves,
          managers: [...managers.values()],
          name: vacant ? territoryName(seat) : (repNameOf(seat.seatId, seat.occupantHrId ?? null) ?? territoryName(seat)),
          seatId: seat.seatId,
          territory: territoryName(seat),
          vacant,
          weekState: repWeeks.get(seat.seatId)?.state ?? "no_plan",
        };
      })
      .sort((left, right) => left.territory.localeCompare(right.territory) || left.name.localeCompare(right.name));
    const endedUndecided = Boolean(sent && plan && isManagerWeekEndedUndecided(plan.status, weekStart, cairoToday));
    return {
      days: planDays,
      decidedAt: plan?.decidedAt ?? null,
      districtSeatId: district.seatId,
      dueOn: plan?.dueOn ?? null,
      endedUndecided,
      planHref: sent && plan ? managerPlanHref(plan.planId) : null,
      planId: plan?.planId ?? null,
      managerLeaveDays: days.filter((date) => managerOnLeave(district.seatId, date)),
      reps,
      status: plan?.status ?? null,
      submittedAt: plan?.submittedAt ?? null,
      submittedLate: plan?.submittedLate === true,
      districtName: territoryName(district),
      regionName: seatRegionName(district) ?? NO_REGION,
      repSeats: underHim.length,
      vacantSeats: underHim.filter((seat) => seatOccupants(seat).length === 0).length,
      managerHrId,
      managerName: managerHrId ? nameOf(names, managerHrId) : "Seat is vacant",
      sent,
      // 🔴 Asked WITH the week (2026-11-09): a sent week its Thursday passed undecided reads "Ended before it was
      // approved", never "Waiting for approval" — nobody can approve it any more (`isManagerWeekEndedUndecided`).
      statusText: sent && plan ? managerPlanStatusLabel(plan.status, { cairoToday, weekStart }) : "Not sent yet",
    };
  });
  // Region order, as every Regional Sales Manager screen (`groupByRegionAndManager`).
  weeks.sort((left, right) => Number(left.regionName === NO_REGION) - Number(right.regionName === NO_REGION) || left.regionName.localeCompare(right.regionName));
  return { cairoToday, leaveUnread, weekEnd, weekStart, weeks };
}

// ── The Regional Sales Manager's approval view of a district manager's week ─────────────────────

/**
 * The neutral lines under each with-a-rep half of a week he is reading — keyed "<date>|<half>": a Chain visit
 * line for every other manager with that rep that day, and "On leave" where the rep is. Information only: the
 * approval is his and these lines decide nothing.
 */
export async function loadWeekHalfNotes(input: {
  plannerHrId: string;
  weekStart: string;
  /** The worlds read: `regionalReportWorlds` — the real team, and a test week's own beside it. */
  worlds: ReadonlyArray<boolean>;
  viewer: Pick<PhoenixCrmViewer, "org">;
  halves: ReadonlyArray<{ date: string; half: ManagerHalf; repSeatId: string; repName: string }>;
}): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  if (input.halves.length === 0) return out;
  const weekEnd = addDaysIso(input.weekStart, 6);
  const seatIds = [...new Set(input.halves.map((half) => half.repSeatId))];
  const seats = seatIds.flatMap((seatId) => {
    const seat = input.viewer.org.seats.get(seatId);
    return seat ? [seat] : [];
  });
  const [bookings, leave] = await Promise.all([
    Promise.all(input.worlds.map((isTest) => loadRepDayBookings({ from: input.weekStart, isTest, repSeatIds: seatIds, to: weekEnd }))).then((parts) => parts.flat()),
    loadSeatLeaveDays(seats, { from: input.weekStart, to: weekEnd }),
  ]);
  const names = await loadPeopleNames(bookings.map((booking) => booking.managerHrId));
  for (const half of input.halves) {
    const lines = otherManagersOnRepDay(bookings, half.repSeatId, half.date, input.plannerHrId).map((other) =>
      chainVisitLine({ name: nameOf(names, other.managerHrId), title: managerPlannerTitle(other.plannerKind) }, half.repName),
    );
    if (!leave.unread && leave.days.has(leaveDayKey(half.repSeatId, half.date))) lines.push(`${half.repName} is on leave this day`);
    if (lines.length) out[`${half.date}|${half.half}`] = lines;
  }
  return out;
}

// ── The Regional Sales Manager's own plan board ─────────────────────────────────────────────────

export type RegionalBoardDayNotes = {
  /** Each rep seat's neutral notes for the day: Chain visit lines and "On leave". Information only — never a block. */
  repNotes: Record<string, string[]>;
};

/**
 * What the Regional Sales Manager's board adds beside every rep in his picker (owner, 2026-11-08, Dr. Hany Saad's
 * sixth need): who else is with that rep that day, and whether the rep is on leave. The district manager's own
 * plan for the day is the board's `districtManagerDays` (`server/manager-dm-day.ts`), never read twice. The board
 * asks for this for a regional sales manager only, and a failed read leaves the board as it was.
 */
export async function loadRegionalBoardNotes(input: {
  viewer: Pick<PhoenixCrmViewer, "org">;
  plannerHrId: string;
  repSeats: ReadonlyArray<OrgSeat>;
  weekStart: string;
  /** The worlds read: `regionalReportWorlds` — the real team, and a test board's own beside it (owner, 2026-11-09). */
  worlds: ReadonlyArray<boolean>;
}): Promise<Map<string, RegionalBoardDayNotes>> {
  const weekEnd = addDaysIso(input.weekStart, 6);
  const repSeats = input.repSeats.filter((seat) => Boolean(personKey(seat.occupantHrId)));
  const [bookings, leave] = await Promise.all([
    Promise.all(input.worlds.map((isTest) => loadRepDayBookings({ from: input.weekStart, isTest, repSeatIds: repSeats.map((seat) => seat.seatId), to: weekEnd }))).then((parts) => parts.flat()),
    loadSeatLeaveDays(repSeats, { from: input.weekStart, to: weekEnd }),
  ]);
  const names = await loadPeopleNames([...bookings.map((booking) => booking.managerHrId), ...repSeats.map((seat) => seat.occupantHrId)]);
  const out = new Map<string, RegionalBoardDayNotes>();
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDaysIso(input.weekStart, offset);
    const repNotes: Record<string, string[]> = {};
    for (const seat of repSeats) {
      const repName = nameOf(names, seat.occupantHrId);
      const notes = otherManagersOnRepDay(bookings, seat.seatId, date, input.plannerHrId).map((other) =>
        chainVisitLine({ name: nameOf(names, other.managerHrId), title: managerPlannerTitle(other.plannerKind) }, repName),
      );
      if (!leave.unread && leave.days.has(leaveDayKey(seat.seatId, date))) notes.push("On leave");
      if (notes.length) repNotes[seat.seatId] = notes;
    }
    out.set(date, { repNotes });
  }
  return out;
}
