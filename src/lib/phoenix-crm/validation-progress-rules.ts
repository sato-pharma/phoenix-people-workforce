/**
 * Doctor list validation, by medical rep — the pure half (owner, 26 Nov 2026: "build a page for administrator to be
 * able to export the sheet … and any update happens in the system, the sheet is updated when I export it").
 *
 * What is counted, and why:
 *   - A rep's list is his seat's AM and PM doctors on the list — `active` (validated) or `pending` (carried over or
 *     loaded from a sheet, waiting for him to validate at the clinic). A dropped customer and one waiting OUTSIDE the
 *     list are not on it. Pharmacies are not validated at all ("every pharmacy he has not dropped, validated or not",
 *     list-request-rules.ts), so they are not in this report.
 *   - "Tried and was blocked" means at least one PLACE capture for that doctor was refused and recorded in
 *     phoenix_crm_refused_readings with the doctor's id. A refusal the phone sent with no doctor named (a location or
 *     camera switch the browser blocked, a brand-new capture) cannot be filed against a doctor and is counted on the
 *     rep's row apart, never guessed onto one.
 *   - "Days blocked" counts each visit day once, however many tries were refused on it.
 *
 * Nothing here reads the database; the loader hands it rows. The screen and the workbook read the same rows, so
 * they cannot disagree.
 */

export type ValidationListType = "AM" | "PM";

export type ValidationCustomerRow = {
  id: string;
  seatId: string;
  listType: ValidationListType;
  name: string;
  speciality: string | null;
  grade: string | null;
  validated: boolean;
};

export type ValidationRefusalRow = {
  customerId: string | null;
  repHrId: string | null;
  reason: string;
  visitDate: string;
};

export type ValidationSeat = {
  seatId: string;
  /** Display names of the people on the seat — two during a handover, none when vacant. */
  people: Array<{ hrId: string; name: string; hireDate: string | null }>;
  lineName: string;
  areaName: string;
  managerName: string;
};

export type ValidationRepRow = {
  seatId: string;
  repName: string;
  vacant: boolean;
  hireDate: string | null;
  lineName: string;
  areaName: string;
  managerName: string;
  total: number;
  am: number;
  pm: number;
  validated: number;
  notValidated: number;
  triedBlocked: number;
  neverTried: number;
  /** Refused tries the phone sent with no doctor named, on days counted once. */
  unlinkedBlockedDays: number;
};

export type ValidationDoctorRow = {
  seatId: string;
  repName: string;
  hireDate: string | null;
  lineName: string;
  areaName: string;
  managerName: string;
  doctor: string;
  listType: ValidationListType;
  speciality: string;
  grade: string;
  blockedDays: number;
  refusedTries: number;
  firstBlockedDay: string | null;
  lastBlockedDay: string | null;
  /** "Reason (tries)", most tries first. */
  reasons: string;
  triedBy: string;
};

export type ValidationProgressReport = {
  reps: ValidationRepRow[];
  doctors: ValidationDoctorRow[];
  totals: { total: number; validated: number; notValidated: number; triedBlocked: number; neverTried: number; reps: number; vacantSeats: number };
};

/** Every reason phoenix_crm_refused_readings allows for a place, in words a manager reads. */
export const VALIDATION_REFUSAL_REASONS: Record<string, string> = {
  blocked: "Location or camera blocked on the phone",
  far_from_place: "Too far from the place",
  impossible_travel: "Impossible travel between readings",
  no_fix: "The phone gave no location",
  off_listing: "Not at the Google Maps listing",
  readings_apart: "The two location readings did not agree",
  rough: "Phone location too rough",
  signboard_no_plate: "The photo did not show the nameplate",
  signboard_unreadable: "The nameplate photo could not be read",
  timetable_missing: "The name was not on the timetable",
  timetable_unreadable: "The timetable photo could not be read",
};

export function validationRefusalLabel(reason: string): string {
  return VALIDATION_REFUSAL_REASONS[reason] ?? "Refused for another reason";
}

export const VACANT_SEAT_NAME = "Vacant seat";

function seatName(seat: ValidationSeat | undefined): string {
  if (!seat || seat.people.length === 0) return VACANT_SEAT_NAME;
  return [...new Set(seat.people.map((person) => person.name))].join(" / ");
}

/** The earliest hire date on the seat — during a handover the longer-serving holder's. */
function seatHireDate(seat: ValidationSeat | undefined): string | null {
  const dates = (seat?.people ?? []).map((person) => person.hireDate).filter((date): date is string => Boolean(date));
  return dates.length > 0 ? [...dates].sort()[0] : null;
}

export function validatedShare(row: Pick<ValidationRepRow, "total" | "validated">): number {
  return row.total === 0 ? 0 : row.validated / row.total;
}

export function buildValidationProgress(input: {
  customers: ReadonlyArray<ValidationCustomerRow>;
  refusals: ReadonlyArray<ValidationRefusalRow>;
  seats: ReadonlyMap<string, ValidationSeat>;
  peopleNames: ReadonlyMap<string, string>;
}): ValidationProgressReport {
  const byCustomer = new Map<string, ValidationRefusalRow[]>();
  const unlinkedDaysByPerson = new Map<string, Set<string>>();
  for (const refusal of input.refusals) {
    if (refusal.customerId) {
      const list = byCustomer.get(refusal.customerId) ?? [];
      list.push(refusal);
      byCustomer.set(refusal.customerId, list);
    } else if (refusal.repHrId) {
      const key = refusal.repHrId.toUpperCase();
      const days = unlinkedDaysByPerson.get(key) ?? new Set<string>();
      days.add(refusal.visitDate);
      unlinkedDaysByPerson.set(key, days);
    }
  }

  const repRows = new Map<string, ValidationRepRow>();
  const repRow = (seatId: string): ValidationRepRow => {
    const existing = repRows.get(seatId);
    if (existing) return existing;
    const seat = input.seats.get(seatId);
    const unlinked = new Set<string>();
    for (const person of seat?.people ?? []) for (const day of unlinkedDaysByPerson.get(person.hrId.toUpperCase()) ?? []) unlinked.add(day);
    const row: ValidationRepRow = {
      seatId,
      repName: seatName(seat),
      vacant: !seat || seat.people.length === 0,
      hireDate: seatHireDate(seat),
      lineName: seat?.lineName ?? "",
      areaName: seat?.areaName ?? "",
      managerName: seat?.managerName ?? "",
      total: 0,
      am: 0,
      pm: 0,
      validated: 0,
      notValidated: 0,
      triedBlocked: 0,
      neverTried: 0,
      unlinkedBlockedDays: unlinked.size,
    };
    repRows.set(seatId, row);
    return row;
  };

  const doctors: ValidationDoctorRow[] = [];
  for (const customer of input.customers) {
    const row = repRow(customer.seatId);
    row.total += 1;
    if (customer.listType === "AM") row.am += 1;
    else row.pm += 1;
    if (customer.validated) {
      row.validated += 1;
      continue;
    }
    row.notValidated += 1;
    const tries = byCustomer.get(customer.id) ?? [];
    const days = [...new Set(tries.map((entry) => entry.visitDate))].sort();
    if (days.length > 0) row.triedBlocked += 1;
    else row.neverTried += 1;
    const reasonCounts = new Map<string, number>();
    for (const entry of tries) {
      const label = validationRefusalLabel(entry.reason);
      reasonCounts.set(label, (reasonCounts.get(label) ?? 0) + 1);
    }
    const triedBy = [
      ...new Set(tries.map((entry) => entry.repHrId).filter((id): id is string => Boolean(id)).map((id) => input.peopleNames.get(id.toUpperCase()) ?? id)),
    ].sort((left, right) => left.localeCompare(right));
    doctors.push({
      seatId: customer.seatId,
      repName: row.repName,
      hireDate: row.hireDate,
      lineName: row.lineName,
      areaName: row.areaName,
      managerName: row.managerName,
      doctor: customer.name,
      listType: customer.listType,
      speciality: customer.speciality ?? "",
      grade: customer.grade ?? "",
      blockedDays: days.length,
      refusedTries: tries.length,
      firstBlockedDay: days[0] ?? null,
      lastBlockedDay: days.at(-1) ?? null,
      reasons: [...reasonCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([label, count]) => `${label} (${count})`)
        .join("; "),
      triedBy: triedBy.join(", "),
    });
  }

  const order = (left: { lineName: string; areaName: string; repName: string }, right: { lineName: string; areaName: string; repName: string }) =>
    left.lineName.localeCompare(right.lineName) || left.areaName.localeCompare(right.areaName) || left.repName.localeCompare(right.repName);
  const reps = [...repRows.values()].sort(order);
  doctors.sort((left, right) => order(left, right) || right.blockedDays - left.blockedDays || left.doctor.localeCompare(right.doctor));

  const totals = reps.reduce(
    (sum, row) => ({
      total: sum.total + row.total,
      validated: sum.validated + row.validated,
      notValidated: sum.notValidated + row.notValidated,
      triedBlocked: sum.triedBlocked + row.triedBlocked,
      neverTried: sum.neverTried + row.neverTried,
      reps: sum.reps + (row.vacant ? 0 : 1),
      vacantSeats: sum.vacantSeats + (row.vacant ? 1 : 0),
    }),
    { total: 0, validated: 0, notValidated: 0, triedBlocked: 0, neverTried: 0, reps: 0, vacantSeats: 0 },
  );
  return { reps, doctors, totals };
}
