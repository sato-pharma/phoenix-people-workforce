/**
 * The doctors on one plan, GROUPED BY DAY and joined to the contact list — the pure shape.
 *
 * Two of the owner's three instructions on 2026-09-01 land here: "when you are showing the rep
 * plan, differentiate day by day, group day by day", and "you will show the address exactly as the
 * contact list ... you will make the table exactly as in the contact list."
 *
 * ## Why the plan row is joined to the CONTACT rather than dressed up on its own
 *
 * The plan mirror holds a name, a grade, a speciality and a CRM region, and nothing else. The
 * contact list holds the brick, the observed address with its check-in date, the location
 * confidence, the neighbours at the same address, the list type and the phone. Making the plan's
 * table "exactly as the contact list" therefore cannot be a matter of copying column headings — the
 * columns would have nothing to put in them. It has to be the same ROW, fetched from the same
 * place, rendered by the same cells. So this module joins each plan entry to the rep's own contact
 * row and the table renders `RepsListContact` exactly as tab one does.
 *
 * ## A doctor NOT on the rep's list keeps his row
 *
 * 1,796 of August's 9,769 doctor-plan pairs were planned against a doctor who is not on the rep's
 * current list (measured 2026-08-28). That is not a join failure and must never render as a missing
 * row: it is a rep planning outside his own assignment, which is one of the more interesting things
 * a verifying manager can be shown. Those rows carry `contact: null` and the table says so in the
 * columns the contact list would have filled, rather than dropping them or leaving five cells blank.
 *
 * ## Undated rows sort LAST, not first
 *
 * The mirror reads them nulls-first, which is right for a flat list ordered by date. Grouped by
 * day it is wrong: a plan whose first heading is "No day recorded" reads as a broken plan before
 * the reader has seen a single real day. An undated row is an anomaly, so it goes at the end where
 * an anomaly belongs.
 */

import { formatPlanDay } from "@/lib/crm/plan-week";
import type { PlanEntryRow } from "@/lib/crm/plan-board";
import type { RepsListContact, RepsListForRep } from "@/lib/crm/reps-list";

/** A contact as the Reps List board knows it, plus the brick heading of the group it sits in. */
export type PlanDoctorContact = {
  /** The group's own heading and whether it is a real brick — the two things the Brick column needs. */
  brick: { heading: string; mapped: boolean };
  contact: RepsListContact;
};

export type PlanDoctorRow = {
  /** The shift, as the CRM records it. Rendered inside the Contact cell, never as a column. */
  ampm: string | null;
  /** Null when this doctor is not on the rep's current contact list — see the header. */
  contact: PlanDoctorContact | null;
  /** The plan's own row, which is the only source for the shift, the date and the frequency. */
  entry: PlanEntryRow;
  /** Stable React key. The same doctor can appear on two days, so the date is part of it. */
  key: string;
};

export type PlanDoctorDay = {
  /** ISO date, or null for a plan row the CRM left undated. */
  date: string | null;
  /** "Sat 30 Aug", or "No day recorded". Never a raw ISO string — the owner's standing rule. */
  label: string;
  rows: PlanDoctorRow[];
};

/**
 * contactCrmId -> the contact list's own row for it.
 *
 * Built from the GROUPS rather than from a flat list because the brick is a property of the group,
 * not of the contact: `groupContactsByBrick` resolves it from the contact's own mapping first and
 * its region's second, and re-deriving that here would be a second implementation of the one rule
 * the Brick column depends on.
 */
export function indexContactList(list: RepsListForRep | null | undefined): Map<number, PlanDoctorContact> {
  const byContactId = new Map<number, PlanDoctorContact>();
  for (const group of list?.groups ?? []) {
    for (const contact of group.rows) {
      // A contact carried on two of the rep's lists (AM and PM) appears twice. The first wins;
      // both rows carry the same brick and the same address, so the choice is not observable.
      if (!byContactId.has(contact.contactCrmId)) {
        byContactId.set(contact.contactCrmId, {
          brick: { heading: group.heading, mapped: group.mapped },
          contact,
        });
      }
    }
  }
  return byContactId;
}

/** AM before PM, then by name — the order a manager reads a day's route in. */
function compareWithinDay(left: PlanDoctorRow, right: PlanDoctorRow): number {
  const byShift = (left.ampm ?? "").localeCompare(right.ampm ?? "");
  if (byShift !== 0) return byShift;
  return left.entry.contactName.localeCompare(right.entry.contactName);
}

/**
 * The plan's rows, grouped into days.
 *
 * Pure and total: an empty plan gives an empty array, and a contact index that could not be read
 * gives every row `contact: null`, which the table renders as "not on his list" rather than as a
 * blank. That degradation is deliberate — the plan is what the manager came to sign, and a contact
 * mirror that was briefly unreachable must not be able to hide it.
 */
export function buildPlanDoctorDays(
  entries: readonly PlanEntryRow[],
  byContactId: ReadonlyMap<number, PlanDoctorContact>,
): PlanDoctorDay[] {
  const days = new Map<string, PlanDoctorDay>();

  for (const [index, entry] of entries.entries()) {
    const date = entry.planDate ?? null;
    const key = date ?? "";
    let day = days.get(key);
    if (!day) {
      day = { date, label: date ? formatPlanDay(date) : "No day recorded", rows: [] };
      days.set(key, day);
    }
    day.rows.push({
      ampm: entry.ampm,
      contact: (entry.contactCrmId == null ? null : byContactId.get(entry.contactCrmId)) ?? null,
      entry,
      key: `${entry.contactCrmId ?? "x"}:${date ?? "x"}:${entry.ampm ?? "x"}:${index}`,
    });
  }

  for (const day of days.values()) day.rows.sort(compareWithinDay);

  // Undated last; see the header. Everything else in calendar order, which for an ISO date is the
  // same as string order — no Date is constructed, so no timezone can shift a day here.
  return [...days.values()].sort((left, right) => {
    if (left.date === right.date) return 0;
    if (left.date == null) return 1;
    if (right.date == null) return -1;
    return left.date.localeCompare(right.date);
  });
}
