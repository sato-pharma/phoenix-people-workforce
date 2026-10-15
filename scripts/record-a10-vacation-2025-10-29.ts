/**
 * ONE-OFF OPS SCRIPT — records Nahed Hattab's (A-10) missing annual vacation day of 29 Oct 2025.
 *
 * Owner instruction, 2026-09-17: of her emailed leave requests, the ones worded "instead of
 * Friday" are COMPENSATORY days (a day worked at a conference, taken back later) and must NOT
 * consume balance. The other days are real vacation and must be counted in her balance and
 * subtracted from her entitlement in Phoenix.
 *
 * Her mailbox (omar.anwar@satopharma.com, read-only IMAP) holds exactly three leave requests from
 * her, all with him on copy:
 *   28 Oct 2025 23:51  "Vacation request"                          -> a vacation day the next day,
 *                      approved by Khaled Salah at 23:53.             i.e. Wednesday 29 Oct 2025.
 *                      The same mail also asks to move her weekly day off from Friday to Thursday
 *                      that week — a weekly-off SWAP, not leave, so nothing is charged for it.
 *   12 Feb 2026 12:58  "Request for Day Off in stead of Friday"    -> COMPENSATORY (conference in
 *                      approved by Hossam Reda at 13:00.              Ismailia). Not charged.
 *   01 Mar 2026 14:12  "Request for Day Off in stead of Friday      -> COMPENSATORY (conference in
 *                      13th Feb", Hossam Reda replied "ok" 15:44.     El Mahalla). Not charged.
 *
 * So exactly one day is written here: 29 Oct 2025, annual, full day, approved.
 *
 * WHICH PERIOD IT LANDS IN. She was hired 2025-07-27, so 29 Oct 2025 sits in her FIRST-YEAR
 * period (2025-07-27 -> 2026-07-27, 15 days accruing at 1.25/month). It does not touch her live
 * 2026-07-27 -> 2027-07-27 balance unless the earlier period ends in unpaid debt, and it does not:
 * three days charged against a 15-day first year. That is the correct bookkeeping — a day taken in
 * October 2025 belongs to the entitlement it was taken from, not to today's.
 *
 * WHAT ACTUALLY HAPPENED, 17 September 2026 — READ THIS BEFORE RE-RUNNING.
 * The insert succeeded and created VAC-0554, but the engine wrote it UNPAID. She was hired
 * 2025-07-27, so calculateVacationPayment's first-six-months rule (calculations.ts, the
 * defaultUnpaid("first_six_months") branch) applies to every annual day before 2026-01-27, and
 * 29 October 2025 sits inside it. An unpaid row carries paid_duration_days = 0, and the live
 * balance is the sum of paid_duration_days — so the day consumed nothing and the owner's
 * instruction was not met by the insert alone.
 *
 * Phoenix holds no salary record for her before January 2026, and no unpaid-vacation deduction was
 * ever taken for October 2025 (salary_records.unpaid_vacations is 0 in every month she has, the
 * deductions module holds no vacation candidate for her at all, and there are no balance
 * settlements or attendance charges). The day was approved by her manager and paid at the time.
 * On the owner's instruction that it be counted in her balance and subtracted from her entitlement,
 * VAC-0554 was corrected by hand to PAID and the two later paid rows in the same period had their
 * display-only snapshot trio re-sequenced. updateVacationRequestAsAdmin could not do it: it
 * re-runs the same engine and would re-derive the same unpaid verdict.
 *
 * Pre-image: ops_backup.v2_vacation_requests_a10_pre_paidfix_20260917 (all 4 rows). The correction
 * also wrote one admin_updated event on VAC-0554 carrying the before/after values.
 *
 *   VAC-0554  2025-10-29  paid 1.00  used 0.00  balance 3.75 -> 2.75   (was unpaid, zeros)
 *   VAC-0358  2026-05-18  paid 1.00  used 1.00  balance 11.50 -> 10.50 (was used 0, 12.50 -> 11.50)
 *   VAC-0340  2026-06-02  paid 1.00  used 2.00  balance 11.75 -> 10.75 (was used 1, 12.75 -> 11.75)
 *
 * Verified through the domain service afterwards, not from the SQL: period 2025-07-27 -> 2026-07-27
 * entitlement 15, used 3, balance 12, carried debt 0; period 2026-07-27 -> 2027-07-27 entitlement
 * 21, used 0.5, balance 20.5, carried debt 0 — her live balance is unchanged, which is correct: a
 * day taken in October 2025 belongs to the entitlement it was taken from.
 *
 * Uses createVacationRequestAsAdmin — the same engine the admin UI uses — so the working-day
 * count, the weekly-off policy snapshot, the payment status and the balance snapshot are all
 * computed by the domain service rather than written by hand. That path sends NO email.
 *
 * Usage (dry run first):
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/record-a10-vacation-2025-10-29.ts [--execute]
 */
import { systemAccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { createVacationRequestAsAdmin, vacationErrorMessage } from "@/lib/vacation/service";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "record-a10-vacation-2025-10-29",
  entry: import.meta.url,
  known: ["--execute"],
});

const execute = process.argv.includes("--execute");
const MARKER = "A10_MAILBOX_BACKFILL_2026-09-17";
const EMPLOYEE_HR_ID = "A-10";
const START_DATE = "2025-10-29";

const note = `[${MARKER}] Annual vacation day taken on Wednesday 29 October 2025. Requested by email on 28 October 2025 at 23:51 Cairo ("I would like to request a vacation day tomorrow") and approved by Khaled Salah at 23:53 the same evening. Backfilled into Phoenix on 2026-09-17 on the owner's instruction, which also ruled that her two "day off in stead of Friday" requests (12 February 2026 and 1 March 2026) are compensatory days for conference attendance and must not consume balance.`;

async function snapshot(label: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("request_code,vacation_type,day_part,start_date,duration_days,paid_duration_days,status,payment_status,period_start,period_end,entitlement_days,balance_before_days,balance_after_days")
    .eq("employee_hr_id", EMPLOYEE_HR_ID)
    .order("start_date");
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  console.log(`\n=== ${label} ===`);
  for (const row of rows) {
    console.log(
      `  ${String(row.start_date)}  ${String(row.request_code).padEnd(9)} ${String(row.vacation_type).padEnd(11)}`
      + ` ${String(row.duration_days)}d ${String(row.payment_status).padEnd(7)} ${String(row.status).padEnd(9)}`
      + ` period ${String(row.period_start)} -> ${String(row.period_end)}`
      + ` (entitlement ${String(row.entitlement_days)}, balance ${String(row.balance_before_days)} -> ${String(row.balance_after_days)})`,
    );
  }
  for (const [periodStart, periodEnd] of [["2025-07-27", "2026-07-27"], ["2026-07-27", "2027-07-27"]]) {
    const inPeriod = rows.filter((row) =>
      row.status === "approved"
      && row.vacation_type !== "compensatory"
      && String(row.start_date) >= periodStart
      && String(row.start_date) < periodEnd);
    const annual = inPeriod.filter((row) => row.vacation_type === "annual");
    const charged = annual.reduce((sum, row) => sum + Number(row.paid_duration_days ?? row.duration_days ?? 0), 0);
    const entitlement = periodStart === "2025-07-27" ? 15 : 21;
    console.log(`  period ${periodStart} -> ${periodEnd}: annual days charged ${charged.toFixed(2)} of ${entitlement} (remaining ${(entitlement - charged).toFixed(2)})`);
  }
  return rows;
}

await snapshot("BEFORE");

if (!execute) {
  console.log(`\nDRY RUN — nothing written. Planned: ${EMPLOYEE_HR_ID} annual full-day vacation on ${START_DATE}, status approved.`);
  console.log("Re-run with --execute to apply.");
} else {
  console.log(`\nRecording ${START_DATE}...`);
  try {
    const created = await createVacationRequestAsAdmin(systemAccessContext, {
      dayPart: "full_day",
      employeeHrId: EMPLOYEE_HR_ID,
      endDate: START_DATE,
      notes: note,
      startDate: START_DATE,
      status: "approved",
      vacationType: "annual",
    });
    console.log(
      `  OK  ${created.requestCode ?? created.id}: duration=${created.durationDays} payment=${created.paymentStatus}`
      + ` status=${created.status} period=${created.periodStart} -> ${created.periodEnd}`
      + ` balance ${created.balanceBeforeDays} -> ${created.balanceAfterDays}`,
    );
  } catch (error) {
    console.log(`  FAIL ${START_DATE}: ${vacationErrorMessage(error) || String(error)}`);
    process.exitCode = 1;
  }
  await snapshot("AFTER");
}
