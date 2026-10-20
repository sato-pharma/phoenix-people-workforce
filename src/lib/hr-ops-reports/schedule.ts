// HR Daily & Weekly Reports — the scheduled run.
//
// Called from the weekly attendance review's cron (app/api/cron/attendance-weekly-digest), which
// fires twice a Cairo day, so no new cron-job.org entry is needed. Each run:
//   1. builds yesterday's daily report (none for a Friday) and, on a Sunday, last week's weekly
//      report. A report already built is REFRESHED while it is still with her — punches arrive
//      late in the morning, so the second run of the day sees the complete day — and left alone
//      once she has submitted it;
//   2. tells her once, in-app, the first time a report appears;
//   3. retries every decided day still waiting to reach the weekly attendance review.
// A failure in one step never stops the next, and every failure is returned. The cron logs them and
// carries on: this run never fails the weekly attendance review's own digest steps.
// A database that does not have the tables yet is reported as skipped, never as a failure.

import { cairoTodayIso } from "@/lib/attendance/working-days";

import { retryWaitingBridges } from "./bridge";
import { buildHrOpsReport, type HrOpsBuildResult } from "./build";
import { findReportByPeriod } from "./store";
import { notifyReportReady } from "./notify";
import { scheduledPeriods } from "./periods";
import { isHrOpsReportsError } from "./types";

export type HrOpsScheduleResult = {
  todayIso: string;
  /** Set when the module is not set up in this database: nothing was attempted. */
  skipped: "not_set_up" | null;
  built: Array<Pick<HrOpsBuildResult, "created" | "flaggedCount" | "lineCount" | "periodKey" | "skipped" | "title" | "warnings">>;
  notified: number;
  bridge: Awaited<ReturnType<typeof retryWaitingBridges>> | null;
  failures: string[];
};

function isNotSetUp(error: unknown): boolean {
  return isHrOpsReportsError(error) && error.status === 503;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runHrOpsReportsSchedule(input: { todayIso?: string } = {}): Promise<HrOpsScheduleResult> {
  const todayIso = input.todayIso ?? cairoTodayIso();
  const result: HrOpsScheduleResult = { bridge: null, built: [], failures: [], notified: 0, skipped: null, todayIso };

  for (const period of scheduledPeriods(todayIso)) {
    try {
      const built = await buildHrOpsReport({ period, today: todayIso });
      result.built.push({
        created: built.created,
        flaggedCount: built.flaggedCount,
        lineCount: built.lineCount,
        periodKey: built.periodKey,
        skipped: built.skipped,
        title: built.title,
        warnings: built.warnings,
      });
      if (built.created) {
        const report = await findReportByPeriod(built.periodKey);
        if (report) result.notified += await notifyReportReady(report, built.flaggedCount);
      }
    } catch (error) {
      if (isNotSetUp(error)) {
        result.skipped = "not_set_up";
        return result;
      }
      result.failures.push(`${period.periodKey}: ${describe(error)}`);
    }
  }

  try {
    result.bridge = await retryWaitingBridges();
  } catch (error) {
    const message = describe(error);
    const missingTable = /hr_ops_report/i.test(message) && /does not exist|schema cache/i.test(message);
    if (!isNotSetUp(error) && !missingTable) {
      result.failures.push(`Carrying decided days into the weekly review: ${message}`);
    }
  }
  return result;
}
