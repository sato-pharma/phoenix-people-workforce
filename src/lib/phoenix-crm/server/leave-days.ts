import { logError } from "@/lib/observability/log";
import { leaveDayKey, type LeaveDays } from "@/lib/phoenix-crm/plan-leave";
import { personKey, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { loadApprovedLeaveDays, loadPendingLeaveDays } from "@/lib/vacation/approved-leave-days";

/**
 * Phoenix CRM — the days HR approved leave for whoever holds these territories, for the reports that
 * set a plan against what happened. `plan-leave.ts` holds the rule they apply to it.
 *
 * 🔴 THE READ IS HR'S. A Phoenix CRM service reads nothing outside its own tables but the organogram,
 * people's names and the product list (`tests/phoenix-crm-boundary`), so leave crosses from the
 * vacation module as plain data — the same door the team calendar and the day page come through.
 *
 * 🔴 A FAILED READ IS SAID, NEVER SWALLOWED. The team calendar may lose leave quietly, because there
 * it is only the annotation on a blank day. Here it is the difference between "on leave" and
 * "missed", so a report keeps its figures — losing the whole report to a second table that was
 * briefly unreachable trades the thing he asked for against the thing he did not — and carries
 * `unread: true`, and the screen says so beside them.
 */
export type SeatLeaveDays = { days: LeaveDays; unread: boolean };

/** Whoever holds each territory, `person → the territories he holds` — the one reading both answers below start from. */
function seatsByOccupant(seats: readonly OrgSeat[]): Map<string, string[]> {
  const seatsByHrId = new Map<string, string[]>();
  for (const seat of seats) {
    if (!seat.occupantHrId) continue;
    seatsByHrId.set(seat.occupantHrId, [...(seatsByHrId.get(seat.occupantHrId) ?? []), seat.seatId]);
  }
  return seatsByHrId;
}

export async function loadSeatLeaveDays(seats: readonly OrgSeat[], range: { from: string; to: string }): Promise<SeatLeaveDays> {
  const seatsByHrId = seatsByOccupant(seats);
  // A vacant territory has nobody to be on leave: its plan, if any, is judged as it stands.
  if (seatsByHrId.size === 0) return { days: new Set<string>(), unread: false };

  try {
    const away = await loadApprovedLeaveDays(seatsByHrId.keys(), range);
    const days = new Set<string>();
    for (const row of away) {
      // `personKey` is the one canonicalisation the org index already applied to `occupantHrId`.
      for (const seatId of seatsByHrId.get(personKey(row.hrId) ?? "") ?? []) days.add(leaveDayKey(seatId, row.day));
    }
    return { days, unread: false };
  } catch (error) {
    logError("Phoenix CRM: approved leave could not be read for a report", {
      error,
      labels: { event: "phoenix_crm_report_leave_unread" },
    });
    return { days: new Set<string>(), unread: true };
  }
}

/**
 * Phoenix CRM — the rep's own DAYS OFF on his plan (owner, 2026-10-02): every day HR approved a FULL day
 * of leave for whoever holds this territory, as `day → the leave's own name` ("Annual Vacation"). The
 * plan greys such a day exactly as it greys a public holiday (plan-holidays.ts): its `listTypes` are
 * empty, so Suggest and every copy skip it, it is never the day the board opens on, "Next day" steps
 * over it, and a save that still names it is refused (`resolvePlanItems`).
 *
 * The same reader as the reports above, through the same door — HR's approved requests of every type
 * (`loadApprovedLeaveDays`) — so the plan and plan against actual can never disagree about which days
 * he was away. What the plan adds is the half day: an "AM only" or "PM only" request is NOT a day
 * off — the other half is still his to plan — and an excuse (a few hours, `v2_excuse_requests`) never
 * reaches this reader at all.
 *
 * NEVER THROWS, and fails the other way from the reports. A plan is not a judgement of the past: a
 * read that fails gives no day off, so the day stays plannable, as before this function existed —
 * a missed day off leaves a day open that should be greyed, and blocks nothing he wants to do.
 */
export async function loadSeatDaysOff(seat: OrgSeat, range: { from: string; to: string }): Promise<Map<string, string>> {
  return (await loadSeatsDaysOff([seat], range)).get(seat.seatId) ?? new Map<string, string>();
}

/**
 * Phoenix CRM — the days the rep has ASKED for leave and nobody has decided yet, on his plan (owner,
 * 2026-10-08: "if the employee submitted a vacation, show in his plan that it is pending approval"), as
 * `day → the leave's own name` ("Annual Vacation", or "Annual Vacation (half day)").
 *
 * 🔴 A PENDING DAY IS INFORMATION, NEVER A DAY OFF. The plan names it so the rep and his manager read the
 * request beside the week, and that is all: the day stays plannable, no save is refused over it, no
 * report excuses it, and a request is not an absence. It becomes a day off the moment HR approves it —
 * `loadSeatDaysOff` above then takes it, with no step from him — and a rejected or returned request
 * simply stops appearing. Leave is read through the vacation module's own door, never inferred.
 *
 * NEVER THROWS: a failed read shows no pending day, exactly as the plan was before this existed.
 */
export async function loadSeatPendingLeave(seat: OrgSeat, range: { from: string; to: string }): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const seatsByHrId = seatsByOccupant([seat]);
  if (seatsByHrId.size === 0) return out;
  try {
    for (const row of await loadPendingLeaveDays(seatsByHrId.keys(), range)) {
      if (!out.has(row.day)) out.set(row.day, row.fullDay ? row.typeLabel : `${row.typeLabel} (half day)`);
    }
  } catch (error) {
    logError("Phoenix CRM plan could not read pending leave", {
      error,
      labels: { event: "phoenix_crm_plan_pending_leave_failed" },
    });
  }
  return out;
}

/**
 * The same answer for MANY territories at once, `seatId → (day → the leave's own name)` — ONE read of
 * HR's approved requests, not one per seat.
 *
 * The plan reminder is why it exists (2026-10-02): it asks this of every rep whose week is not sent,
 * to leave out the ones whose whole week is days off and who therefore cannot send it at all
 * (`weekIsAllDaysOff`). Per seat that was a query each, twice a day, for a figure most of them answer
 * empty. A territory with nobody on it, and one with no approved leave in the range, are both absent
 * from the map rather than carrying an empty entry — the caller reads a missing seat as no days off,
 * which is what a failed read gives too.
 */
export async function loadSeatsDaysOff(seats: readonly OrgSeat[], range: { from: string; to: string }): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  const seatsByHrId = seatsByOccupant(seats);
  // Vacant territories only: nobody to be on leave.
  if (seatsByHrId.size === 0) return out;
  try {
    for (const row of await loadApprovedLeaveDays(seatsByHrId.keys(), range)) {
      // A HALF day is not a day off — the other half is still his to plan (and to send).
      if (!row.fullDay) continue;
      for (const seatId of seatsByHrId.get(personKey(row.hrId) ?? "") ?? []) {
        const days = out.get(seatId) ?? new Map<string, string>();
        if (!days.has(row.day)) days.set(row.day, row.typeLabel);
        out.set(seatId, days);
      }
    }
  } catch (error) {
    logError("Phoenix CRM plan could not read approved leave", {
      error,
      labels: { event: "phoenix_crm_plan_leave_failed" },
    });
  }
  return out;
}

/**
 * Approved leave for many territories, by its own name, half days included — `seatId → (day → "Annual Vacation"
 * or "Annual Vacation (half day)")` — for Visits — Yesterday and Today, which prints it in the day's square
 * instead of visits (owner, 2026-11-09: "if vacation put it"). Unlike `loadSeatsDaysOff` a failed read is SAID:
 * `unread: true`, and the screen says so instead of reading the day as worked.
 */
export async function loadSeatsLeaveLabels(
  seats: readonly OrgSeat[],
  range: { from: string; to: string },
): Promise<{ days: Map<string, Map<string, string>>; unread: boolean }> {
  const days = new Map<string, Map<string, string>>();
  const seatsByHrId = seatsByOccupant(seats);
  if (seatsByHrId.size === 0) return { days, unread: false };
  try {
    for (const row of await loadApprovedLeaveDays(seatsByHrId.keys(), range)) {
      for (const seatId of seatsByHrId.get(personKey(row.hrId) ?? "") ?? []) {
        const held = days.get(seatId) ?? new Map<string, string>();
        // A full day outranks a half day of the same date.
        if (!held.has(row.day) || row.fullDay) held.set(row.day, row.fullDay ? row.typeLabel : `${row.typeLabel} (half day)`);
        days.set(seatId, held);
      }
    }
    return { days, unread: false };
  } catch (error) {
    logError("Phoenix CRM: approved leave could not be read for Visits — Yesterday and Today", {
      error,
      labels: { event: "phoenix_crm_team_visits_leave_unread" },
    });
    return { days: new Map(), unread: true };
  }
}
