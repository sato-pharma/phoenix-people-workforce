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

export async function loadSeatLeaveDays(seats: readonly OrgSeat[], range: { from: string; to: string }): Promise<SeatLeaveDays> {
  const seatsByHrId = new Map<string, string[]>();
  for (const seat of seats) {
    if (!seat.occupantHrId) continue;
    seatsByHrId.set(seat.occupantHrId, [...(seatsByHrId.get(seat.occupantHrId) ?? []), seat.seatId]);
  }
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
