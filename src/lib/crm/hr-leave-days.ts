/**
 * HR's approved leave as the field-work leave record, from the day iReports360 was retired.
 *
 * Before that day the field-work leave record is iReports360's own Annual Vacation code (-4), served
 * from the archive exactly as it was (owner, 7 Oct 2026: "they find everything they did as it is").
 * From that day nothing writes -4 any more, and Phoenix CRM records no leave of its own — a rep's
 * leave is HR's approved vacation request, the same one Phoenix CRM's own vacation-day rule reads
 * (native-visits/vacation-days.ts). Without this, every leave day after the retirement reads as a day
 * with no field activity.
 *
 * The boundary is the date of `crm_cutover.vendor_sync_retired_at`, read the same way the CRM doors
 * bound their iReports360 branch (`vendor_sync_retired_at::date`, 20261106235920). No retirement on
 * file means no HR-leave days at all, so the archive alone answers, exactly as before.
 *
 * Read-only: no vacation request, balance or deduction is touched.
 */

import { getApprovedLeaveDayMap } from "@/lib/attendance/working-days";
import { getCrmCutoverSetting, type CrmCutoverSetting } from "@/lib/crm/cutover";

/** The first day HR leave is the field-work leave record (UTC date of the retirement), or null. */
export function fieldLeaveFromHrStartsOn(setting: Pick<CrmCutoverSetting, "vendorSyncRetiredAt">): string | null {
  const raw = setting.vendorSyncRetiredAt;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}

/** The part of [start, end] on or after `startsOn`, or null when none of it is. Pure. */
export function fieldLeaveFromHrWindow(input: { end: string; start: string; startsOn: string | null }): { end: string; start: string } | null {
  if (!input.startsOn) return null;
  const start = input.start > input.startsOn ? input.start : input.startsOn;
  return start > input.end ? null : { end: input.end, start };
}

/**
 * Approved HR leave days per employee (the map getApprovedLeaveDayMap returns, HR ids normalized),
 * limited to the days from the retirement on. THROWS when a read fails; a caller that is a review
 * surface catches it and says so.
 */
export async function loadFieldLeaveDaysFromHr(input: {
  end: string;
  start: string;
  employeeHrIds?: string[];
}): Promise<{ days: Map<string, Set<string>>; startsOn: string | null }> {
  const startsOn = fieldLeaveFromHrStartsOn(await getCrmCutoverSetting());
  const window = fieldLeaveFromHrWindow({ end: input.end, start: input.start, startsOn });
  if (!window) return { days: new Map(), startsOn };
  const days = await getApprovedLeaveDayMap({
    dateFromIso: window.start,
    dateToIso: window.end,
    ...(input.employeeHrIds ? { employeeHrIds: input.employeeHrIds } : {}),
  });
  return { days, startsOn };
}
