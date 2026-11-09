import { forbiddenError } from "@/lib/http/api-errors";
import { addDaysIso } from "@/lib/crm/dates";
import { fieldWeekStart } from "@/lib/phoenix-crm/calendar";
import { leaveDayKey } from "@/lib/phoenix-crm/plan-leave";
import {
  isManagerPlanSent,
  managerAdminActivityLabel,
  managerPlanStatusLabel,
  managerPlannerTitle,
  type ManagerHalf,
  type ManagerPlannerKind,
} from "@/lib/phoenix-crm/manager-plan-rules";
import { NO_REGION, seatRegionName } from "@/lib/phoenix-crm/region-manager-groups";
import { personKey, seatOccupants, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { readsRegionalTeamReports, readWorldFor, regionalTeamRepSeats, type PhoenixCrmViewer } from "@/lib/phoenix-crm/server/access";
import { loadSeatLeaveDays } from "@/lib/phoenix-crm/server/leave-days";
import { loadManagerPlanHalfDays, loadManagerPlansInRange, managerHalfDayText } from "@/lib/phoenix-crm/server/manager-plan-readers";
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

export type DistrictPlanHalf = {
  half: ManagerHalf;
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

export type DistrictPlanDay = { date: string; dateText: string; halves: DistrictPlanHalf[] };

export type DistrictManagerWeek = {
  /** The organogram region — the heading names it with the manager (owner, 2026-11-09). */
  regionName: string;
  /** The region's rep seats with nobody in them. */
  vacantSeats: number;
  repSeats: number;
  managerHrId: string | null;
  managerName: string;
  districtName: string;
  /** "Approved", "Waiting for approval", or "Not sent yet" for a draft, a returned week or none at all. */
  statusText: string;
  sent: boolean;
  /** Empty unless the week is sent: his draft is never shown. */
  days: DistrictPlanDay[];
};

export type DistrictManagersPlans = {
  weekStart: string;
  weekEnd: string;
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
async function readDistrictWeeks(managerHrIds: ReadonlyArray<string>, weekStart: string, isTest: boolean) {
  const weekEnd = addDaysIso(weekStart, 6);
  const plans = managerHrIds.length
    ? (await loadManagerPlansInRange({ from: weekStart, isTest, managerHrIds, plannerKinds: ["dm"], to: weekEnd })).filter((plan) => plan.weekStart === weekStart)
    : [];
  const sentPlans = plans.filter((plan) => isManagerPlanSent(plan.status));
  const slots = sentPlans.length ? await loadManagerSlotRows(sentPlans.map((plan) => plan.planId)) : [];
  const customers = slots.length ? await loadManagerSlotCustomers(slots.filter((slot) => slot.kind !== "admin").map((slot) => slot.slotId)) : [];
  const customersBySlot = new Map<string, string[]>();
  for (const row of customers) customersBySlot.set(row.slotId, [...(customersBySlot.get(row.slotId) ?? []), row.name]);
  const planOf = (managerHrId: string | null) => (managerHrId ? (plans.find((row) => personKey(row.managerHrId) === personKey(managerHrId)) ?? null) : null);
  return { customersBySlot, planOf, slots };
}

function dayText(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Cairo", weekday: "long" });
}

export async function loadDistrictManagersPlans(viewer: PhoenixCrmViewer, anyDayOfWeek: string): Promise<DistrictManagersPlans> {
  if (!readsRegionalTeamReports(viewer)) throw forbiddenError("This report is for the Regional Sales Manager.");
  const weekStart = fieldWeekStart(anyDayOfWeek);
  const weekEnd = addDaysIso(weekStart, 6);
  const isTest = readWorldFor(viewer, null);
  const districts = regionalDistrictSeats(viewer);
  const managerHrIds = districts.flatMap((seat) => (seat.occupantHrId ? [seat.occupantHrId] : []));
  const repSeats = regionalTeamRepSeats(viewer);

  const [{ customersBySlot, planOf, slots }, bookings, repWeeks, leave] = await Promise.all([
    readDistrictWeeks(managerHrIds, weekStart, isTest),
    loadRepDayBookings({ from: weekStart, isTest, repSeatIds: repSeats.map((seat) => seat.seatId), to: weekEnd }),
    loadRepWeeks(
      repSeats.map((seat) => seat.seatId),
      weekStart,
      isTest,
    ),
    loadSeatLeaveDays(repSeats, { from: weekStart, to: weekEnd }),
  ]);

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
        halves: daySlots.map((slot): DistrictPlanHalf => {
          const repName = slot.kind === "with_rep" ? repNameOf(slot.repSeatId, slot.repHrId) : null;
          let repDay: string | null = null;
          const chainVisits: string[] = [];
          if (slot.kind === "with_rep" && slot.repSeatId) {
            repDay = !leave.unread && leave.days.has(leaveDayKey(slot.repSeatId, date))
              ? "On leave"
              : REP_DAY_LABEL[repWeeks.get(slot.repSeatId)?.state ?? "no_plan"];
            for (const other of otherManagersOnRepDay(bookings, slot.repSeatId, date, managerHrId)) {
              chainVisits.push(chainVisitLine({ name: nameOf(names, other.managerHrId), title: managerPlannerTitle(other.plannerKind) }, repName ?? "the rep"));
            }
          }
          return {
            chainVisits,
            customers: customersBySlot.get(slot.slotId) ?? [],
            half: slot.half,
            repDay,
            repName,
            text: halfText(slot, repName, names),
          };
        }),
      });
    }
    const underHim = repSeats.filter((seat) => seat.path.includes(district.seatId));
    return {
      days: planDays,
      districtName: territoryName(district),
      regionName: seatRegionName(district) ?? NO_REGION,
      repSeats: underHim.length,
      vacantSeats: underHim.filter((seat) => seatOccupants(seat).length === 0).length,
      managerHrId,
      managerName: managerHrId ? nameOf(names, managerHrId) : "Seat is vacant",
      sent,
      statusText: sent && plan ? managerPlanStatusLabel(plan.status) : "Not sent yet",
    };
  });
  // Region order, as every Regional Sales Manager screen (`groupByRegionAndManager`).
  weeks.sort((left, right) => Number(left.regionName === NO_REGION) - Number(right.regionName === NO_REGION) || left.regionName.localeCompare(right.regionName));
  return { leaveUnread: leave.unread, weekEnd, weekStart, weeks };
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
  isTest: boolean;
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
    loadRepDayBookings({ from: input.weekStart, isTest: input.isTest, repSeatIds: seatIds, to: weekEnd }),
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
  isTest: boolean;
}): Promise<Map<string, RegionalBoardDayNotes>> {
  const weekEnd = addDaysIso(input.weekStart, 6);
  const repSeats = input.repSeats.filter((seat) => Boolean(personKey(seat.occupantHrId)));
  const [bookings, leave] = await Promise.all([
    loadRepDayBookings({ from: input.weekStart, isTest: input.isTest, repSeatIds: repSeats.map((seat) => seat.seatId), to: weekEnd }),
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
