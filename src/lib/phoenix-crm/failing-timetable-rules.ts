/**
 * Buildings whose timetable keeps being refused at the door, and the Super Admin's declaration that a
 * building has no timetable at all.
 *
 * Phoenix CRM validation enhancements, 14 Nov 2026 (owner, "List + declare"). Measured that morning: 380
 * timetable photographs refused in 30 days across 174 buildings, 28 of those buildings refused on two or
 * more different days, and no screen named them. A building refused on one day is one rep's ordinary
 * three tries, which already end in a hold the administrator sees. A building refused again on ANOTHER
 * day is a board that is not getting read: a rep keeps coming back to it and leaving without a seating.
 *
 * 🔴 HOUSEKEEPING, NOT A FLAG. Like the refused readings list, this says where reps are stuck, never who
 * did something wrong, and nobody is told anything by it.
 *
 * 🔴 DECLARING "THIS BUILDING HAS NO TIMETABLE" IS A SCREEN MARKER AND NOTHING ELSE (owner, 2026-10-18,
 * City clinic). It writes `timetable_exempt_at` and `timetable_exempt_by_hr_id` on the building. Nothing
 * validates a customer off it: one seated there later is still held for the administrator, whose Approve
 * on that customer is the exception.
 *
 * Pure: no I/O.
 */

/** How far back the refusals are read. The same window as the refused readings list. */
export const FAILING_TIMETABLE_LOOKBACK_DAYS = 30;
/** Refused on this many different visit days, the building is listed. */
export const FAILING_TIMETABLE_MIN_DAYS = 2;
/** The list draws this many buildings; the count above it is always the whole number. */
export const FAILING_TIMETABLES_SHOWN = 50;

/** One refused timetable photograph, as `phoenix_crm_refused_readings` holds it. */
export type TimetableRefusal = {
  sharedPlaceId: string | null;
  repHrId: string | null;
  /** The Cairo visit day the try was counted on. */
  visitDate: string | null;
  refusedAt: string;
};

export type FailingTimetable = {
  sharedPlaceId: string;
  refusals: number;
  /** Different visit days it was refused on. */
  days: number;
  /** Different people refused at it. */
  reps: number;
  lastRefusedAt: string;
};

/**
 * The buildings refused on `FAILING_TIMETABLE_MIN_DAYS` or more different days, the one refused on the
 * most days first, then the most refusals, then the most recent. A refusal with no building or no visit
 * day is not counted: it cannot say which building, or which day.
 */
export function failingTimetables(refusals: ReadonlyArray<TimetableRefusal>): FailingTimetable[] {
  const byBuilding = new Map<string, { refusals: number; days: Set<string>; reps: Set<string>; lastRefusedAt: string }>();
  for (const refusal of refusals) {
    if (!refusal.sharedPlaceId || !refusal.visitDate) continue;
    const building = byBuilding.get(refusal.sharedPlaceId) ?? { refusals: 0, days: new Set<string>(), reps: new Set<string>(), lastRefusedAt: "" };
    building.refusals += 1;
    building.days.add(refusal.visitDate);
    if (refusal.repHrId) building.reps.add(refusal.repHrId.toUpperCase());
    if (Date.parse(refusal.refusedAt) > (Date.parse(building.lastRefusedAt) || 0)) building.lastRefusedAt = refusal.refusedAt;
    byBuilding.set(refusal.sharedPlaceId, building);
  }
  return [...byBuilding.entries()]
    .map(([sharedPlaceId, building]) => ({
      sharedPlaceId,
      refusals: building.refusals,
      days: building.days.size,
      reps: building.reps.size,
      lastRefusedAt: building.lastRefusedAt,
    }))
    .filter((building) => building.days >= FAILING_TIMETABLE_MIN_DAYS)
    .sort(
      (left, right) =>
        right.days - left.days ||
        right.refusals - left.refusals ||
        Date.parse(right.lastRefusedAt) - Date.parse(left.lastRefusedAt) ||
        (left.sharedPlaceId < right.sharedPlaceId ? -1 : 1),
    );
}

/** What happened at one building, in one sentence a person can act on. */
export function failingTimetableSentence(building: Pick<FailingTimetable, "refusals" | "days" | "reps">): string {
  const photos = `${building.refusals} timetable ${building.refusals === 1 ? "photo" : "photos"} refused`;
  const people = building.reps > 1 ? `, from ${building.reps} people` : "";
  return `${photos} on ${building.days} different days${people}`;
}

// ── Declaring that a building has no timetable ─────────────────────────────────────────────────────

/** What the Super Admin may do about one building's timetable marker; null is nothing. */
export type NoTimetableControl = "declare" | "withdraw" | null;

/**
 * A building in use or being checked can be declared; a declared one can be taken back. A rejected
 * building takes neither: it is not in use, and bringing it back is its own decision.
 */
export function noTimetableControl(input: { canDeclare: boolean; status: "active" | "held" | "retired"; exempt: boolean }): NoTimetableControl {
  if (!input.canDeclare || input.status === "retired") return null;
  return input.exempt ? "withdraw" : "declare";
}

export const NO_TIMETABLE_DECLARE_LABEL = "This building has no timetable";
export const NO_TIMETABLE_WITHDRAW_LABEL = "It has a timetable after all";
/** Read before the click that declares it. It must say what the click does NOT do. */
export const NO_TIMETABLE_DECLARE_EXPLAINER =
  "Declare it only when the building truly has no timetable on its wall. The board will stop treating the missing timetable as a fault, and the building leaves the list of timetables that keep failing. Nobody is validated by this: each customer seated here still waits for your Approve.";
export const NO_TIMETABLE_WITHDRAW_EXPLAINER =
  "Take it back when the building does have a timetable. The board reads the timetable on file again, and nobody's validation changes.";
