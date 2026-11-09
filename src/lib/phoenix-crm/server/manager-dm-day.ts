import { managerAdminActivityLabel, managerPlanStatusLabel, type ManagerHalf, type ManagerPlanStatus } from "@/lib/phoenix-crm/manager-plan-rules";
import { personKey, territoryName, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { dedupeIds } from "@/lib/phoenix-crm/server/db";
import {
  loadManagerSlotCustomers,
  loadManagerSlotRows,
  loadWeekPlanRows,
  type ManagerSlotCustomerRow,
  type ManagerSlotRow,
} from "@/lib/phoenix-crm/server/manager-plan-rows";
import { loadPeopleNames, nameOf, type PeopleNames } from "@/lib/phoenix-crm/server/people";

/**
 * Phoenix CRM — THE DISTRICT MANAGER'S OWN DAY, SHOWN TO THE MANAGER WHO GOES WITH HIM (owner, 2026-11-08: "if a
 * regional manager, a national sales manager, a product manager, group product manager are making their weekly
 * plan, they decided that we'll go this day with a district manager. They must see this district manager plan is
 * planning what today — with a rep, a single, double, area — and see the doctors also").
 *
 * On a "With a district manager" half-day the board shows, beside his areas, what that district manager's own week
 * holds for the same date: each half, whether it is a double visit (and with which rep), a single visit, a visit
 * with his own manager or Admin, the area, and the doctors he ticked.
 *
 * 🔴 READ ONLY, AND NEVER JUDGED. His week is read as it stands — a draft included, marked by its status — because
 *    both weeks are planned before the same Thursday deadline; nothing here approves, flags or changes it.
 * 🔴 THE DISTRICT MANAGER'S OWN WEEK ONLY (`plannerKind` 'dm'). A seat with nobody on it has no week to show.
 * 🔴 A READ THAT FAILS IS SAID (`districtManagerPlanUnread` on the board), never shown as "nothing planned".
 */

/** One half of the district manager's day, in words. */
export type DistrictManagerDayHalf = {
  half: ManagerHalf;
  /** "Double visit", "Single visit", "Double visit with a manager", "Admin". */
  kindLabel: string;
  /** The rep he goes with on a double visit; null otherwise. */
  repName: string | null;
  /** The area — or the areas, joined — the half is spent in; null on Admin. */
  areaName: string | null;
  /** Admin's activity ("Training"), or who a with-a-manager half goes with; null otherwise. */
  detail: string | null;
  /** The doctors he ticked for the half, by name. */
  customers: Array<{ key: string; name: string; speciality: string | null; grade: string | null; gone: boolean }>;
};

/** The district manager's day as the senior manager's board shows it. */
export type DistrictManagerDay = {
  dmSeatId: string;
  dmName: string;
  /** His week's status in words: "Draft", "Waiting for approval", "Approved", "Not started". */
  statusLabel: string;
  /** False while his week is a draft or not started — the day may still change. */
  sent: boolean;
  /** Only the halves he has planned, AM first. Empty: nothing planned for the date yet. */
  halves: DistrictManagerDayHalf[];
};

/** One district manager's week, read once and cut into days by `districtManagerDayOn`. */
/**
 * One district manager week per seat across the worlds read (owner, 2026-11-09, his test login reads the real team):
 * the first world's week (the real one), unless it holds no plan and a later world's does.
 */
export function mergeDistrictManagerWeeks(parts: ReadonlyArray<ReadonlyArray<DistrictManagerWeek>>): DistrictManagerWeek[] {
  const out = new Map<string, DistrictManagerWeek>();
  for (const weeks of parts) {
    for (const week of weeks) {
      const held = out.get(week.dmSeatId);
      if (!held || (held.status === null && week.status !== null)) out.set(week.dmSeatId, week);
    }
  }
  return [...out.values()];
}

export type DistrictManagerWeek = {
  dmSeatId: string;
  dmName: string;
  status: ManagerPlanStatus | null;
  statusLabel: string;
  slots: ManagerSlotRow[];
  customersBySlot: Map<string, ManagerSlotCustomerRow[]>;
  names: PeopleNames;
};

type SeatLookup = (seatId: string) => Pick<OrgSeat, "areaName" | "regionName" | "lineName" | "seatLabel" | "seatId"> | undefined;

const HALF_ORDER: Record<ManagerHalf, number> = { AM: 0, PM: 1 };

/** The areas a with-a-manager half names, joined in his words. */
function joinedAreas(areas: ReadonlyArray<{ areaName: string }> | undefined): string | null {
  const names = (areas ?? []).map((area) => area.areaName).filter(Boolean);
  return names.length > 0 ? names.join(" · ") : null;
}

/** One half-day of his week, in the words the senior manager reads. */
export function districtManagerHalfOf(slot: ManagerSlotRow, customers: ReadonlyArray<ManagerSlotCustomerRow>, names: PeopleNames, seatOf: SeatLookup): DistrictManagerDayHalf {
  const planned = [...customers]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((row) => ({
      key: row.customerId ?? row.managerCustomerId ?? `${row.slotId}:${row.name}`,
      name: row.name,
      speciality: row.speciality,
      grade: row.grade,
      gone: row.gone,
    }));
  if (slot.kind === "with_rep") {
    const repSeat = slot.repSeatId ? seatOf(slot.repSeatId) : undefined;
    return {
      half: slot.half,
      kindLabel: "Double visit",
      repName: slot.repHrId ? nameOf(names, slot.repHrId) : "No rep in this territory",
      areaName: repSeat ? (repSeat.areaName ?? territoryName(repSeat)) : null,
      detail: null,
      customers: planned,
    };
  }
  if (slot.kind === "single_visit") {
    return { half: slot.half, kindLabel: "Single visit", repName: null, areaName: slot.areaName, detail: null, customers: planned };
  }
  if (slot.kind === "with_senior") {
    const senior = slot.seniorVisit;
    const who = senior?.seniorHrId ? nameOf(names, senior.seniorHrId) : null;
    return {
      half: slot.half,
      kindLabel: senior?.role === "product_manager" ? "Double visit with a product manager" : "Double visit with a manager",
      repName: null,
      areaName: joinedAreas(senior?.areas) ?? slot.areaName,
      detail: who ? (senior?.title ? `${who} · ${senior.title}` : who) : null,
      customers: planned,
    };
  }
  // Admin, and any kind a district manager's week cannot hold today, read as what it is.
  return {
    half: slot.half,
    kindLabel: "Admin",
    repName: null,
    areaName: null,
    detail: slot.kind === "admin" ? managerAdminActivityLabel(slot.activityType) : null,
    customers: planned,
  };
}

/** His day on one date: the halves he planned, AM first. */
export function districtManagerDayOn(week: DistrictManagerWeek, date: string, seatOf: SeatLookup): DistrictManagerDay {
  const halves = week.slots
    .filter((slot) => slot.date === date)
    .sort((left, right) => HALF_ORDER[left.half] - HALF_ORDER[right.half])
    .map((slot) => districtManagerHalfOf(slot, week.customersBySlot.get(slot.slotId) ?? [], week.names, seatOf));
  return {
    dmSeatId: week.dmSeatId,
    dmName: week.dmName,
    statusLabel: week.statusLabel,
    sent: week.status !== null && week.status !== "draft",
    halves,
  };
}

/**
 * The district managers' own weeks for these seats — one read of the plans, one of their half-days, one of the
 * doctors and one of the names, whatever the number of seats. A vacant seat is left out.
 */
export async function loadDistrictManagerWeeks(input: {
  org: { seats: ReadonlyMap<string, OrgSeat> };
  dmSeatIds: ReadonlyArray<string | null>;
  weekStart: string;
  cairoToday: string;
  isTest: boolean;
}): Promise<DistrictManagerWeek[]> {
  const seats = dedupeIds(input.dmSeatIds).flatMap((seatId) => {
    const hrId = personKey(input.org.seats.get(seatId)?.occupantHrId);
    return hrId ? [{ seatId, hrId }] : [];
  });
  if (seats.length === 0) return [];
  const plans = (await loadWeekPlanRows(seats.map((seat) => seat.hrId), input.weekStart, input.isTest)).filter((plan) => plan.plannerKind === "dm");
  const planByHr = new Map(plans.map((plan) => [personKey(plan.managerHrId) ?? plan.managerHrId, plan]));
  const slots = plans.length > 0 ? await loadManagerSlotRows(plans.map((plan) => plan.planId)) : [];
  const [customers, names] = await Promise.all([
    slots.length > 0 ? loadManagerSlotCustomers(slots.map((slot) => slot.slotId)) : Promise.resolve([] as ManagerSlotCustomerRow[]),
    loadPeopleNames([...seats.map((seat) => seat.hrId), ...slots.map((slot) => slot.repHrId), ...slots.map((slot) => slot.seniorVisit?.seniorHrId)]),
  ]);
  const customersBySlot = new Map<string, ManagerSlotCustomerRow[]>();
  for (const row of customers) {
    const list = customersBySlot.get(row.slotId) ?? [];
    list.push(row);
    customersBySlot.set(row.slotId, list);
  }
  return seats.map((seat) => {
    const plan = planByHr.get(seat.hrId) ?? null;
    return {
      dmSeatId: seat.seatId,
      dmName: nameOf(names, seat.hrId),
      status: plan?.status ?? null,
      statusLabel: managerPlanStatusLabel(plan?.status ?? null, { weekStart: input.weekStart, cairoToday: input.cairoToday }),
      slots: plan ? slots.filter((slot) => slot.planId === plan.planId) : [],
      customersBySlot,
      names,
    };
  });
}
