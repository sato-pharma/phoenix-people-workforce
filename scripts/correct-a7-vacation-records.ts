/**
 * ONE-OFF OPS SCRIPT — corrects A-7 (Ahmed Elkawas) annual-vacation records.
 *
 * Owner-approved 2026-08-03, under two rules he stated:
 *   1. "if less than 8 hrs by 2 hr then it was an excuse not vacation" — a day where the employee
 *      was present for 6 hours or more is an EXCUSE, not leave, and must not consume balance.
 *   2. "do not count fri or sat from balance, already vacations" — the weekly rest days never
 *      consume balance.
 *
 * Applied to the four affected records:
 *   08-10 Jan  re-saved unchanged so the engine recomputes duration with Friday + Saturday
 *              excluded (2.00 -> expected 1.00). Rule 2 is applied BY the engine, not by hand.
 *   15 Mar     full day -> PM half-day (present 3.16h; CRM recorded PM).
 *   30 Mar     full day -> PM half-day (present 3.90h; CRM recorded PM).
 *   09 Apr     present 6.14h, i.e. within 2 hours of a full 8-hour day -> rule 1 makes this an
 *              excuse. Set to 'rejected' so it stops consuming balance while the row and its
 *              history stay visible and the change stays reversible. ('cancelled' is not a legal
 *              status here — the check constraint allows needs_assignment / pending_manager /
 *              pending_hr / approved / rejected / returned.)
 *
 * Uses updateVacationRequestAsAdmin — the same balance engine the admin UI uses — so duration,
 * payment status and the balance snapshot are all recomputed by the domain service rather than
 * written by raw SQL.
 *
 * Usage:
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs \
 *     scripts/correct-a7-vacation-records.ts [--execute]
 */
import { systemAccessContext } from "@/lib/auth/permissions";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { updateVacationRequestAsAdmin, vacationErrorMessage } from "@/lib/vacation/service";

import { refuseUnknownFlags } from "./lib/refuse-arguments.mjs";

// A flag this script does not know is refused, never ignored (scripts/lib/refuse-arguments.mjs).
refuseUnknownFlags({
  name: "correct-a7-vacation-records",
  entry: import.meta.url,
  known: ["--execute"],
});

const execute = process.argv.includes("--execute");
const MARKER = "A7_CORRECTION_2026-08-03";

type Target = {
  dayPart: string;
  endDate: string;
  expectation: string;
  label: string;
  note: string;
  requestId: string;
  startDate: string;
  status: string;
  vacationType: string;
};

const targets: Target[] = [
  {
    dayPart: "full_day",
    endDate: "2026-01-10",
    expectation: "duration 2.00 -> 1.00 (Friday and Saturday are rest days)",
    label: "08-10 January 2026",
    note: `[${MARKER}] Recomputed so the Friday and Saturday weekly rest days do not consume annual balance, per owner rule of 2026-08-03 ("do not count fri or sat from balance"). Only Thursday 08 January is a working day in this span.`,
    requestId: "2089a747-cbc1-4074-bed0-153f5242af77",
    startDate: "2026-01-08",
    status: "approved",
    vacationType: "annual",
  },
  {
    dayPart: "pm_only",
    endDate: "2026-03-15",
    expectation: "duration 1.00 -> 0.50 (PM half-day)",
    label: "15 March 2026",
    note: `[${MARKER}] Reduced from a full day to a PM half-day. Fingerprint shows him present 09:28:00 to 12:37:36 (3.16 hours) and CRM visit 1133160 records the day as PM. Corrected per owner instruction of 2026-08-03.`,
    requestId: "5252c5d7-c8f7-4ebc-b9c8-786080d5d1fa",
    startDate: "2026-03-15",
    status: "approved",
    vacationType: "annual",
  },
  {
    dayPart: "pm_only",
    endDate: "2026-03-30",
    expectation: "duration 1.00 -> 0.50 (PM half-day)",
    label: "30 March 2026",
    note: `[${MARKER}] Reduced from a full day to a PM half-day. Fingerprint shows him present 09:06:36 to 13:00:32 (3.90 hours) and CRM visit 1140281 records the day as PM. Corrected per owner instruction of 2026-08-03.`,
    requestId: "811ba20f-f9b6-4425-abf2-dac10f31f39a",
    startDate: "2026-03-30",
    status: "approved",
    vacationType: "annual",
  },
  {
    dayPart: "full_day",
    endDate: "2026-04-09",
    expectation: "status approved -> rejected (excuse, stops consuming balance: -1.00)",
    label: "09 April 2026",
    note: `[${MARKER}] Reclassified as an EXCUSE, not vacation, per owner rule of 2026-08-03: a day worked to within 2 hours of a full 8-hour day is an excuse. Fingerprint shows him present 08:51:49 to 15:00:08 = 6 hours 8 minutes. The record's earlier claim that 2026-04-09 was a company holiday (Coptic Maundy Thursday) is not supported: there is no calendar event in April 2026, no holiday override, and nine other employees punched in that day between 08:24 and 17:55.`,
    requestId: "76cb1b66-c6b7-4aa0-8911-bd68f02e85da",
    startDate: "2026-04-09",
    status: "rejected",
    vacationType: "annual",
  },
];

async function snapshot(label: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("v2_vacation_requests")
    .select("id,start_date,end_date,day_part,duration_days,status,payment_status,balance_after_days")
    .eq("employee_hr_id", "A-7")
    .order("start_date");
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  const approved = rows.filter((r: Record<string, unknown>) => r.status === "approved");
  const charged = approved.reduce((s: number, r: Record<string, unknown>) => s + Number(r.duration_days ?? 0), 0);
  console.log(`\n=== ${label} ===`);
  console.log(`  rows: ${rows.length}   approved: ${approved.length}   days charged: ${charged.toFixed(2)}   balance: ${(21 - charged).toFixed(2)}`);
  return { charged, rows };
}

await snapshot("BEFORE");

if (!execute) {
  console.log("\nDRY RUN — no changes written. Planned:");
  for (const t of targets) console.log(`  ${t.label}: ${t.expectation}`);
  console.log("\nRe-run with --execute to apply.");
} else {
  console.log("\nApplying corrections...");
  for (const t of targets) {
    try {
      const updated = await updateVacationRequestAsAdmin(systemAccessContext, {
        dayPart: t.dayPart,
        employeeHrId: "A-7",
        endDate: t.endDate,
        notes: t.note,
        requestId: t.requestId,
        startDate: t.startDate,
        status: t.status,
        vacationType: t.vacationType,
      });
      console.log(`  OK  ${t.label}: duration=${updated.durationDays} status=${updated.status} payment=${updated.paymentStatus}`);
    } catch (error) {
      console.log(`  FAIL ${t.label}: ${vacationErrorMessage(error) || String(error)}`);
    }
  }
  await snapshot("AFTER");
}
