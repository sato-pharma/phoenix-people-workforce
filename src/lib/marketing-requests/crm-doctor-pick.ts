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

/** The owner's number for two photos at one place (2026-10-27). Lives here so this client-safe file needs nothing else. */
export const CRM_LIST_SAME_PLACE_METRES = 500;

/** The list check found nobody on the rep's list. Nobody typed anything, so the sentence must not say so. */
export const CHECKED_NOT_ON_CRM_LIST_FLAG = "Not on the rep's Phoenix CRM list — the list check found nobody matching this customer on the rep's list.";
export const LEFT_CRM_LIST_FLAG = "Left the rep's Phoenix CRM list — this doctor was on the rep's list and no longer is.";
export const CRM_LIST_NEEDS_CHECK_FLAG = "Not confirmed on the rep's Phoenix CRM list — the list check found a possible match that a person still has to confirm.";
export const CRM_LIST_NO_HOLDER_FLAG = "No rep holds this area on this line — this customer cannot be on a rep's Phoenix CRM list.";
export const CRM_LIST_NURSERY_FLAG = "Looks like a nursery — the name says this is a nursery, and a marketing request is never on a nursery. A person has to check it.";

function crmListFarFlag(metres: number): string {
  const distance = metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${metres} m`;
  return `Check the two photos — the customer and the doctor on the rep's list stand ${distance} apart, more than the ${CRM_LIST_SAME_PLACE_METRES} m allowed.`;
}

/** The list check's facts about a customer, where it has run (`marketing_customer_list_checks`). */
export type CrmListFlagCheck = { looksLikeNursery?: boolean | null; metresApart?: number | null; state?: string | null };

/**
 * The one sentence every approval step prints, or null.
 *
 * With no check to read it answers as it always did: `not_on_list` was typed by hand, and a NULL status
 * predates the rule and is not flagged. The check's facts come first because they are newer than the
 * status. 🔴 "typed by hand" is printed only for a name someone really typed: a row the check itself marked
 * reads `source = 'checked'` and gets its own sentence. It flags and never blocks.
 */
export function crmListFlag(status: unknown, options?: { check?: CrmListFlagCheck | null; source?: unknown }): string | null {
  const check = options?.check ?? null;
  if (check?.looksLikeNursery) return CRM_LIST_NURSERY_FLAG;
  if (check?.state === "left_list") return LEFT_CRM_LIST_FLAG;
  if (check?.state === "check") return CRM_LIST_NEEDS_CHECK_FLAG;
  if (check?.state === "no_holder") return CRM_LIST_NO_HOLDER_FLAG;
  if (check?.state === "on_list" && typeof check.metresApart === "number" && check.metresApart > CRM_LIST_SAME_PLACE_METRES) {
    return crmListFarFlag(check.metresApart);
  }
  if (status !== "not_on_list") return null;
  return options?.source === "checked" ? CHECKED_NOT_ON_CRM_LIST_FLAG : NOT_ON_CRM_LIST_FLAG;
}

/** The short form of a flag, for the chip under a card's customer name. */
export function crmListFlagChip(flag: string): string {
  if (flag === NOT_ON_CRM_LIST_FLAG) return "Not on the rep's CRM list — name typed by hand";
  if (flag === CHECKED_NOT_ON_CRM_LIST_FLAG) return "Not on the rep's CRM list";
  if (flag === LEFT_CRM_LIST_FLAG) return "Left the rep's CRM list";
  if (flag === CRM_LIST_NEEDS_CHECK_FLAG) return "Rep's CRM list — not confirmed";
  if (flag === CRM_LIST_NO_HOLDER_FLAG) return "No rep holds this area";
  if (flag === CRM_LIST_NURSERY_FLAG) return "Looks like a nursery";
  return "Check the two photos";
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

/**
 * The doctor field is one type-to-search box: a value from the rep's list OR a name typed over it
 * (owner, 2026-10-26: "choose customer from rep list or free type outside of his list"). A typed name
 * travels through the field's string value behind this prefix, so it can never be mistaken for a CRM id.
 */
export const TYPED_CRM_DOCTOR_PREFIX = "__typed_doctor__:";

/** The longest customer name the form takes, typed or picked. */
export const TYPED_CRM_DOCTOR_MAX_LENGTH = 160;

/** The field value for a name typed by hand, or "" when nothing readable was typed. */
export function typedCrmDoctorValue(name: string): string {
  const clean = name.replace(/\s+/g, " ").trim().slice(0, TYPED_CRM_DOCTOR_MAX_LENGTH);
  return clean ? `${TYPED_CRM_DOCTOR_PREFIX}${clean}` : "";
}

/** The typed name inside a field value, or null when the value is a CRM id, the placeholder or the "not on the list" row. */
export function readTypedCrmDoctorName(value: string): string | null {
  if (!value.startsWith(TYPED_CRM_DOCTOR_PREFIX)) return null;
  const clean = value.slice(TYPED_CRM_DOCTOR_PREFIX.length).replace(/\s+/g, " ").trim();
  return clean || null;
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
