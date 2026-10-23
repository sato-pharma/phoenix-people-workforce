/**
 * Customer Validation — the doctor is PICKED from a rep's Phoenix CRM list, not typed.
 *
 * Owner, 2026-10-23: "the district manager or the manager is no more able to add in the customer
 * validation free type doctor name … he will choose the area, okay, by his hand. Then cascading will
 * appear the doctors in this area for the rep in his team." And: "the area he will put by his hand,
 * it will not replace the area of the GPS. The area of GPS will keep as it is."
 *
 * His three answers the same evening decide the rest:
 *  - A Medical Rep picks from HIS OWN list; his area is fixed, never chosen.
 *  - A role with no team of its own (Product, Group Product, Marketing and SFE Managers, the CEO, the
 *    Super Admin) chooses ANY area in the company, then that area's reps' doctors.
 *  - A doctor not on the rep's list may still be TYPED — "allow typing, but flag, clearly flag in all
 *    approval steps". `crm_list_status = 'not_on_list'` is that flag, and `crmListFlag` is the one
 *    sentence every approval surface prints.
 *
 * The chosen area lands in `marketing_customers.chosen_area_seat_id / chosen_area_name` — its own
 * columns. It never writes `area_id` or `extracted_area_name`, which stay what the GPS capture said.
 *
 * Pure: no database, no React. The server read is `crm-doctor-pick-service.ts`.
 */

import type { OrgSeat } from "@/lib/phoenix-crm/scope";

/** The roles that choose from every area in the company — none of them holds a team of reps. */
export const CRM_DOCTOR_COMPANY_ROLES: ReadonlySet<string> = new Set([
  "Super Admin",
  "CEO",
  "SFE Manager",
  "Marketing Manager",
  "Product Manager",
  "Group Product Manager",
]);

/** Whether this role reads every area, rather than the territories it holds and the ones below it. */
export function readsEveryCrmDoctorArea(role: string, scope?: string | null): boolean {
  return scope === "system" || CRM_DOCTOR_COMPANY_ROLES.has(role);
}

/** A Medical Rep's area is his own territory's, shown fixed — he never chooses one. */
export function crmDoctorAreaIsFixed(role: string): boolean {
  return role === "Medical Rep";
}

export type CrmListStatus = "on_list" | "not_on_list";

/** What every approval step prints beside a customer whose name was typed by hand. */
export const NOT_ON_CRM_LIST_FLAG =
  "Not on the rep's Phoenix CRM list — this doctor's name was typed by hand at validation, not picked from a rep's list.";

/** The flag sentence for a stored `crm_list_status`, or null. A NULL status predates the rule and is not flagged. */
export function crmListFlag(status: unknown): string | null {
  return status === "not_on_list" ? NOT_ON_CRM_LIST_FLAG : null;
}

export type CrmDoctorAreaChoice = { seatId: string; areaName: string };

export type CrmDoctorAreasPayload = {
  areas: CrmDoctorAreaChoice[];
  /** A Medical Rep: the one area is pre-chosen and cannot be changed. */
  areaFixed: boolean;
};

export type CrmDoctorOption = {
  crmCustomerId: string;
  name: string;
  speciality: string | null;
  listType: "AM" | "PM";
  /** The rep whose list holds him; null when the territory is vacant (the previous rep's list). */
  repName: string | null;
  lineName: string | null;
};

export type CrmDoctorListPayload = {
  area: CrmDoctorAreaChoice;
  doctors: CrmDoctorOption[];
};

/** What the save writes for one new customer's pick. */
export type ResolvedCrmDoctorPick = {
  chosenAreaName: string | null;
  chosenAreaSeatId: string | null;
  crmListStatus: CrmListStatus;
  /** The doctor's name AS THE CRM LIST HOLDS IT — the link is only true if the name is his. */
  displayName: string | null;
  phoenixCrmCustomerId: string | null;
};

/** No area and no doctor: a name typed with nothing picked (an offline capture queued before the rule). Flagged. */
export const UNPICKED_CRM_DOCTOR: ResolvedCrmDoctorPick = Object.freeze({
  chosenAreaName: null,
  chosenAreaSeatId: null,
  crmListStatus: "not_on_list",
  displayName: null,
  phoenixCrmCustomerId: null,
});

/** One area holds several rep seats (one per line and more); they share this key. */
export function crmAreaKeyOf(seat: Pick<OrgSeat, "areaCode" | "areaName" | "seatId">): string {
  return seat.areaCode ?? seat.areaName ?? seat.seatId;
}

/** The areas of these territories, one per area, by name. The first seat of an area stands for it. */
export function crmDoctorAreaChoices(seats: ReadonlyArray<OrgSeat>): CrmDoctorAreaChoice[] {
  const seen = new Set<string>();
  const out: CrmDoctorAreaChoice[] = [];
  for (const seat of [...seats].sort((left, right) => left.seatId.localeCompare(right.seatId))) {
    if (seat.isOtherPseudoDm) continue;
    const key = crmAreaKeyOf(seat);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ seatId: seat.seatId, areaName: seat.areaName ?? seat.seatLabel ?? seat.seatId });
  }
  return out.sort((left, right) => left.areaName.localeCompare(right.areaName));
}

/**
 * The territories of the area a chosen seat stands for — inside the viewer's reach only. Null when the
 * seat is not one he may choose, which the caller refuses.
 */
export function crmSeatsOfArea(reach: ReadonlyArray<OrgSeat>, chosenSeatId: string | null | undefined): OrgSeat[] | null {
  if (!chosenSeatId) return null;
  const chosen = reach.find((seat) => seat.seatId === chosenSeatId);
  if (!chosen || chosen.isOtherPseudoDm) return null;
  const key = crmAreaKeyOf(chosen);
  return reach.filter((seat) => !seat.isOtherPseudoDm && crmAreaKeyOf(seat) === key);
}

/** The doctor-pick half of one customer line on the form. */
export type CrmDoctorPickState = {
  /** False when the viewer has no area with a CRM list at all — then only a typed name is possible. */
  areasAvailable: boolean;
  areaSeatId: string;
  crmCustomerId: string;
  /** He chose "Not on the list — type the name". */
  notOnList: boolean;
};

/** The first thing the doctor pick still needs, or null. Read by the save gate, never re-derived. */
export function describeMissingDoctorPick(pick: CrmDoctorPickState, customerNumber: number): string | null {
  if (pick.areasAvailable && !pick.areaSeatId) return `Choose the area for Customer ${customerNumber} first.`;
  if (pick.areasAvailable && !pick.crmCustomerId && !pick.notOnList) {
    return `Choose Customer ${customerNumber} from the doctor list, or pick "Not on the list".`;
  }
  return null;
}
