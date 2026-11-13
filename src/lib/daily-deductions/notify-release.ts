/**
 * THE EMPLOYEE IS TOLD WHEN A DAILY DEDUCTION IS RELEASED — the notice the Release button never sent.
 *
 * Owner, 2026-10-12: *"i released a deduction the employee not recieve an email"*. He released one
 * line on production at 14:13 Cairo that day — Nahed Tarek, 11 October, `no_records_activity`,
 * 1,032.26 EGP — and `notification_outbox` holds nothing for her at all. The monthly Deductions page
 * has told the employee since 2026-09-22 (`src/lib/deductions/notify-deduction.ts`, last fired 9
 * October); the DAILY page's own release path wrote the snapshot and the audit log and notified
 * nobody. Not a delivery failure: nothing was ever enqueued.
 *
 * This sends the SAME notice as a monthly push, through the same function, so there is one wording,
 * one CC rule and one idempotency scheme for a deduction however it reaches the employee:
 *
 *   - the employee gets "Payroll deduction recorded" in-app and on Telegram with no amount and no
 *     category, pointing at their own self-only Deductions page, AND an email that states the
 *     amount, the reason and the days;
 *   - their manager chain gets the bare heads-up with the employee's name, in-app and Telegram only.
 *
 * 🔴 **THE EMAIL IS HIS 2026-10-12 DECISION, taken when this silence was reported to him**: asked
 * whether to keep the 2026-09-22 "never email" rule, he chose *add email, with the amount and the
 * reason*. So the amount and the day count are read back off the stored ROW here and handed to the
 * notifier — the mail must state the figure the line actually froze, not the one a screen showed.
 *
 * Idempotency rides on the ROW ID PLUS ITS DAYS (`releasedLineNoticeKey`). The id is stable per
 * (publication, employee, category, day) through the RPC's `on conflict … do update`, so re-releasing
 * the same deduction re-sends nothing. Since 2026-11-13 every day released on its own is its OWN row
 * (owner: "I want each deduction to be single"), so each day is its own notice naming that day alone.
 *
 * BEST-EFFORT BY CONTRACT, like the monthly path: the money is already committed when this runs, so
 * nothing here may throw back into the release.
 */

import { notifyDeductionPushed, type DeductionPushNotificationResult } from "@/lib/deductions/notify-deduction.ts";
import { logNotificationSendFailure } from "@/lib/notifications/system";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import type { DeductionsCategory } from "@/lib/deductions/types.ts";

/** One released line, as little of it as the notice needs. */
export type ReleasedLineForNotice = {
  id: string;
  category: string;
  employeeHrId: string;
  employeeHrIdCompact: string;
  employeeName: string | null;
  /** The one day a single deduction charges; null for a whole-range row. */
  deductionDate: string | null;
  /** The days the line charges, so the month label comes from the day and not from today. */
  dates: readonly string[];
  rangeEnd: string | null;
  /** EGP released, read back off the stored row — what the email states (owner, 2026-10-12). */
  amount: number | null;
  /** Days released, 0.5 for a half day. */
  daysCount: number | null;
};

export type ReleaseNoticeOutcome = {
  employeeHrId: string;
  category: string;
  lineId: string;
  status: DeductionPushNotificationResult["status"] | "not_found";
  ccCount: number;
};

/**
 * The month a released line belongs to — taken from the EARLIEST day it charges, never from the
 * clock. A release run after midnight on the 1st must still say the month the day fell in.
 */
/**
 * The row id plus the days it charges. A one-day row never changes its day, so this is the id plus
 * that day; an older whole-range row re-released with different days is a new notice.
 */
export function releasedLineNoticeKey(line: Pick<ReleasedLineForNotice, "dates" | "id">): string {
  const days = [...new Set(line.dates)].filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day))).sort();
  return days.length > 0 ? `${line.id}:${days.join(",")}` : line.id;
}

export function releasedLineMonthKey(line: Pick<ReleasedLineForNotice, "dates" | "rangeEnd">): string {
  const days = [...line.dates].filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day))).sort();
  const day = days[0] ?? (/^\d{4}-\d{2}-\d{2}$/.test(String(line.rangeEnd ?? "")) ? String(line.rangeEnd) : null);
  return day ? day.slice(0, 7) : "";
}

/** Which released row a release named: employee x type x day (no day for a whole-range row). */
function noticePairKey(pair: { category: string; employeeHrIdCompact: string; deductionDate?: string | null }): string {
  return `${pair.employeeHrIdCompact}|${pair.category}|${pair.deductionDate ?? ""}`;
}

type LineRow = {
  id: string | null;
  amount: number | string | null;
  category: string | null;
  dates: unknown;
  days_count: number | string | null;
  deduction_date: string | null;
  employee_hr_id: string | null;
  employee_hr_id_compact: string | null;
  employee_name: string | null;
  range_end: string | null;
};

/** A numeric column that may arrive as a PostgREST numeric string — never a guessed 0. */
function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Read back the rows the RPC just wrote, so each notice carries that line's real, stable id. */
export async function loadReleasedLinesForNotice(input: {
  publicationId: string;
  pairs: readonly { category: string; employeeHrIdCompact: string; deductionDate?: string | null }[];
}): Promise<ReleasedLineForNotice[]> {
  if (input.pairs.length === 0) return [];
  const wanted = new Set(input.pairs.map(noticePairKey));

  const { data, error } = await getSupabaseAdmin()
    .from("daily_deductions_lines")
    .select("id,amount,category,dates,days_count,deduction_date,employee_hr_id,employee_hr_id_compact,employee_name,range_end")
    .eq("publication_id", input.publicationId)
    .in("employee_hr_id_compact", [...new Set(input.pairs.map((pair) => pair.employeeHrIdCompact))]);
  if (error) throw new Error(`Failed to read the released lines for notification: ${error.message}`);

  const lines: ReleasedLineForNotice[] = [];
  for (const row of (data ?? []) as LineRow[]) {
    const compact = String(row.employee_hr_id_compact ?? "");
    const category = String(row.category ?? "");
    const deductionDate = typeof row.deduction_date === "string" ? row.deduction_date.slice(0, 10) : null;
    // The `in` filter is per employee, so a person who already had OTHER rows in the snapshot — other
    // types, other days — comes back with those too. Only the rows this release named are notified.
    if (!wanted.has(noticePairKey({ category, deductionDate, employeeHrIdCompact: compact }))) continue;
    lines.push({
      amount: numberOrNull(row.amount),
      category,
      dates: Array.isArray(row.dates) ? row.dates.filter((day): day is string => typeof day === "string") : [],
      daysCount: numberOrNull(row.days_count),
      deductionDate,
      employeeHrId: String(row.employee_hr_id ?? ""),
      employeeHrIdCompact: compact,
      employeeName: row.employee_name ?? null,
      id: String(row.id ?? ""),
      rangeEnd: row.range_end ?? null,
    });
  }
  return lines;
}

/**
 * Tell every employee in this release, and their managers. Returns one outcome per released pair —
 * including the pairs whose row could not be read back, so the release's audit entry can never
 * imply a notice that did not go out.
 */
export async function notifyDailyDeductionsReleased(input: {
  publicationId: string;
  pairs: readonly { category: string; employeeHrIdCompact: string; employeeHrId: string; deductionDate?: string | null }[];
  actorHrId: string | null;
  loadLines?: typeof loadReleasedLinesForNotice;
  notify?: typeof notifyDeductionPushed;
}): Promise<ReleaseNoticeOutcome[]> {
  const loadLines = input.loadLines ?? loadReleasedLinesForNotice;
  const notify = input.notify ?? notifyDeductionPushed;

  let lines: ReleasedLineForNotice[] = [];
  try {
    lines = await loadLines({ pairs: input.pairs, publicationId: input.publicationId });
  } catch (error) {
    logNotificationSendFailure("dailyDeductions.loadReleasedLines", error);
  }

  const byPair = new Map(lines.map((line) => [noticePairKey(line), line]));
  const outcomes: ReleaseNoticeOutcome[] = [];

  for (const pair of input.pairs) {
    const line = byPair.get(noticePairKey(pair));
    if (!line || !line.id) {
      outcomes.push({
        category: pair.category,
        ccCount: 0,
        employeeHrId: pair.employeeHrId,
        lineId: "",
        status: "not_found",
      });
      continue;
    }
    try {
      const result = await notify({
        actorHrId: input.actorHrId,
        line: {
          amount: line.amount,
          category: line.category as DeductionsCategory,
          dates: line.dates,
          daysCount: line.daysCount,
          employeeHrId: line.employeeHrId || pair.employeeHrId,
          employeeName: line.employeeName,
          id: line.id,
          monthKey: releasedLineMonthKey(line),
          noticeKey: releasedLineNoticeKey(line),
        },
      });
      outcomes.push({
        category: line.category,
        ccCount: result.ccHrIds.length,
        employeeHrId: line.employeeHrId || pair.employeeHrId,
        lineId: line.id,
        status: result.status,
      });
    } catch (error) {
      // notifyDeductionPushed does not throw; this is the defensive edge.
      logNotificationSendFailure("dailyDeductions.notifyReleased", error);
      outcomes.push({
        category: line.category,
        ccCount: 0,
        employeeHrId: line.employeeHrId || pair.employeeHrId,
        lineId: line.id,
        status: "failed",
      });
    }
  }

  return outcomes;
}
