import { logError } from "@/lib/observability/log";
import { leaveDayKey, type LeaveDays } from "@/lib/phoenix-crm/plan-leave";
import { personKey, type OrgSeat } from "@/lib/phoenix-crm/scope";
import { loadApprovedLeaveDays } from "@/lib/vacation/approved-leave-days";

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
  const daysOff = new Map<string, string>();
  const seatsByHrId = seatsByOccupant([seat]);
  // A vacant territory has nobody to be on leave.
  if (seatsByHrId.size === 0) return daysOff;
  try {
    for (const row of await loadApprovedLeaveDays(seatsByHrId.keys(), range)) {
      if (!row.fullDay || !seatsByHrId.has(personKey(row.hrId) ?? "")) continue;
      if (!daysOff.has(row.day)) daysOff.set(row.day, row.typeLabel);
    }
  } catch (error) {
    logError("Phoenix CRM plan could not read approved leave", {
      error,
      labels: { event: "phoenix_crm_plan_leave_failed" },
    });
  }
  return daysOff;
}
