import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { resolveBridgingWindows } from "../src/lib/payroll/copilot/holiday-bridging.ts";
import { getHolidayCalendarReadinessForLeave } from "../src/lib/vacation/company-vacation-report.ts";
import { getConfirmedNationalHolidaysForPeriods } from "../src/lib/vacation/national-holidays.ts";
import { validateOfficialHolidayAdjacency } from "../src/lib/vacation/service.ts";

/**
 * A Google Calendar outage is NOT the same as "no holidays", and that difference costs money.
 *
 * When the iCal feed cannot be read, national-holidays.ts falls back to the company list plus
 * Egypt's seven fixed-date public holidays. So a month holding one of those (1 May, 25 Jan, …)
 * comes back `connected: true` with a non-empty holiday list — while both Eids, Islamic New Year,
 * the Prophet's Birthday and Coptic Easter are simply missing and read as ordinary working days.
 * Every gate written against `connected` therefore passed straight through the outage.
 *
 * `calendarReachable` is the flag that tells the truth, and the owner's rule (2026-09-16) is that
 * a path which can take money or a balance day off an employee REFUSES while it is false, rather
 * than charge, approve or settle a day that was actually a public holiday. Display surfaces keep
 * working and say the calendar is degraded.
 *
 * The behavioural assertions here drive the real lookup with `fetch` stubbed out — the same shape
 * as a live outage. Year 2099 keeps them clear of the 10-minute holiday cache a real month fills,
 * and each block uses its own month because a degraded result is itself cached for 10 minutes.
 * The rest are wiring pins: those paths are Supabase-backed and cannot run in this runner.
 */

async function withGoogleUnreachable<T>(run: () => Promise<T>): Promise<T> {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = savedFetch;
  }
}

async function messageOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

export async function runHolidayCalendarOutageGateTests(): Promise<void> {
  // ── The shared loader: the outage is what `connected` cannot see ─────────────────────────────
  await withGoogleUnreachable(async () => {
    const januaryAndFebruary = await getConfirmedNationalHolidaysForPeriods([
      { month: 1, year: 2099 },
      { month: 2, year: 2099 },
    ]);
    assert.equal(
      januaryAndFebruary.calendarReachable,
      false,
      "a months-at-once lookup must report the calendar unreadable when Google cannot be reached",
    );

    const january = await getConfirmedNationalHolidaysForPeriods([{ month: 1, year: 2099 }]);
    const januaryDates = january.holidays.map((holiday) => holiday.startDate);
    assert.ok(
      januaryDates.includes("2099-01-07") && januaryDates.includes("2099-01-25"),
      "the fixed-date holidays still load during an outage — Coptic Christmas and 25 January",
    );
    assert.equal(
      january.connected,
      true,
      "…so a month holding one reads as CONNECTED through the whole outage, which is exactly why `connected` cannot be the gate",
    );
    assert.equal(
      january.calendarReachable,
      false,
      "…while `calendarReachable` reports the same month honestly",
    );

    // February has no fixed-date holiday, so it degrades to an empty list. One unreadable month
    // must poison the whole answer rather than average out against a month that looks fine.
    const february = await getConfirmedNationalHolidaysForPeriods([{ month: 2, year: 2099 }]);
    assert.equal(february.connected, false, "a month with no fixed-date holiday degrades to nothing at all");
    assert.equal(
      januaryAndFebruary.connected,
      false,
      "both flags are ALL-of, never any-of: one unreadable month makes the whole span unreadable",
    );

    const twice = await getConfirmedNationalHolidaysForPeriods([
      { month: 1, year: 2099 },
      { month: 1, year: 2099 },
    ]);
    assert.equal(
      twice.holidays.length,
      january.holidays.length,
      "a month asked for twice (a leave range that starts and ends in it) contributes its holidays once",
    );
  });

  // ── Leave filed next to a holiday: refuses rather than check against half a calendar ─────────
  {
    const message = await withGoogleUnreachable(() =>
      messageOf(() => validateOfficialHolidayAdjacency({ endDate: "2099-03-12", startDate: "2099-03-10" })),
    );
    assert.match(
      message,
      /public holiday calendar could not be read/i,
      "the adjacency guard must refuse during an outage — otherwise it clears a request sitting right beside an Eid it cannot see",
    );
    assert.match(message, /Nothing was saved/i, "…and must say plainly that nothing was written");
    assert.doesNotMatch(
      message,
      /national holiday/i,
      "the outage wording must avoid 'national holiday': the company-report approve route maps that phrase to its own adjacency message, which would report an outage as a holiday-adjacency refusal",
    );
  }

  // ── The Company Vacation Report's approve click ──────────────────────────────────────────────
  {
    const readiness = await withGoogleUnreachable(() => getHolidayCalendarReadinessForLeave("2099-04-10", "2099-04-10"));
    assert.equal(
      readiness.readable,
      false,
      "approving a CRM leave signal takes a day off the employee's annual balance for good — it must not proceed while the calendar cannot be read",
    );
    assert.match(
      readiness.message ?? "",
      /Nothing was approved and no balance was changed/i,
      "…and the refusal must tell the admin no balance moved",
    );
  }

  {
    const route = readFileSync("app/api/vacation/company-report/approve/route.ts", "utf8");
    assert.ok(
      route.includes("await getHolidayCalendarReadinessForLeave(startDate, endDate)") &&
        route.indexOf("await getHolidayCalendarReadinessForLeave(startDate, endDate)") <
          route.indexOf("await createVacationRequestAsAdmin("),
      "the approve route must ask whether the calendar is readable BEFORE it writes the vacation request",
    );
    assert.match(
      route,
      /if \(!holidayCalendar\.readable\) \{\s*return NextResponse\.json\(\{\s*error: "holiday_calendar_unreadable",/,
      "an unreadable calendar must answer the admin with its own error code, not fall through to a generic failure",
    );
    assert.match(
      route,
      /if \(\/holiday calendar could not be read\/i\.test\(message\)\) \{/,
      "the adjacency guard reads a month the readiness check may not have, so its outage error must map to the same refusal instead of a 500",
    );
  }

  // ── Payroll Copilot holiday bridging: a deduction computed against half a calendar ───────────
  {
    const message = await withGoogleUnreachable(() => messageOf(() => resolveBridgingWindows({ month: 7, year: 2099 })));
    assert.match(
      message,
      /national-holiday calendar could not be read/i,
      "bridging DEDUCTS a day beside a holiday, so it must refuse rather than compute its windows from a calendar missing both Eids",
    );
    assert.match(
      message,
      /Refusing to compute holiday bridging/i,
      "…and must name what it refused to do, so the Copilot tab shows a cause and not an empty list",
    );
  }

  // ── Automated Payroll part 2: CRM leave against the balance ledger ───────────────────────────
  {
    const recommend = readFileSync("src/lib/automated-payroll/recommend.ts", "utf8");
    const loader = recommend.slice(
      recommend.indexOf("async function loadCrmLeaveDatesByCompact"),
      recommend.indexOf("async function loadV2VacationDatesByCompact"),
    );
    assert.ok(loader.length > 0 && loader.length < recommend.length / 4, "the CRM-leave loader slice must find both of its markers");
    assert.match(
      loader,
      /if \(preview\.metadata\?\.holidayCalendarReachable === false \|\| preview\.metadata\?\.holidayConnected === false\) \{\s*throw new PayrollCrmLeaveUnavailableError\(period, "the Egypt national-holiday calendar"\);/,
      "CRM leave raised on an unconfirmed Eid is written into the leave-balance ledger for good — the step must refuse while the calendar is unreadable",
    );
    assert.ok(
      loader.indexOf("holidayCalendarReachable === false") < loader.indexOf("for (const candidate of preview.reviewCandidates)"),
      "…and it must refuse BEFORE reading a single candidate, not after building the map",
    );
    assert.match(
      loader,
      /if \(error instanceof PayrollCrmLeaveUnavailableError\) throw error;/,
      "the catch must let that refusal through unchanged — relabelling it as a failed CRM read hides the real cause from the run",
    );
    // The same two metadata fields the live Field Workforce Compliance engine gates on. Renaming
    // one there without renaming it here would leave this guard silently reading `undefined`.
    const fwc = readFileSync("src/lib/field-workforce-compliance/recommendations.ts", "utf8");
    assert.match(
      fwc,
      /metadata\?\.holidayCalendarReachable === false \|\| metadata\?\.holidayConnected === false/,
      "both readers must gate on the same two metadata fields, so the payroll guard cannot drift into reading a field that no longer exists",
    );
  }

  // ── The weekly review's own day: approving a deduction on a day that may be an Eid ───────────
  {
    const dayReport = readFileSync("src/lib/attendance/employee-day-report.ts", "utf8");
    const decide = dayReport.slice(dayReport.indexOf("export async function upsertAndDecideEmployeeDayDeduction"));
    assert.match(
      decide,
      /if \(input\.decisionStatus === "Approved for Payroll" && !dayReport\.holidayCalendarReachable\) \{\s*throw validationError\(/,
      "approving a day during an outage charges a day that cannot be told apart from a public holiday — it must refuse",
    );
    assert.match(
      decide,
      /Nothing was charged — try again shortly/,
      "…and the Super Admin must be told nothing was charged and that the outage passes",
    );
    assert.ok(
      decide.indexOf("!dayReport.holidayCalendarReachable") < decide.indexOf("await assertFingerprintDayApprovable("),
      "…before any other check reaches a write",
    );
    assert.doesNotMatch(
      decide.slice(0, decide.indexOf("!dayReport.holidayCalendarReachable")),
      /await (getSupabaseAdmin|recordDecision|upsertCandidate)/,
      "nothing may be written before the refusal — a refused approval must leave no candidate behind",
    );
    assert.match(
      decide,
      /decisionStatus === "Approved for Payroll" && !dayReport\.holidayCalendarReachable/,
      "rejecting a day (\"Do Not Take Action\") stays open during an outage: that is the direction that costs nobody money (owner, 2026-09-16)",
    );
  }

  // ── The flag itself: every report carries the month's real state, never a constant ───────────
  // buildAttendanceCalendarContext is the one place that knows whether Google answered; a report
  // that hard-codes `true` here would render a permanently reassuring banner.
  for (const [file, marker] of [
    ["src/lib/attendance/employee-day-report.ts", "holidayCalendarReachable: context.holidayCalendarReachable,"],
    ["src/lib/attendance/monthly-summary.ts", "holidayCalendarReachable: context.holidayCalendarReachable,"],
    ["src/lib/field-workforce-compliance/head-office-attendance.ts", "holidayCalendarReachable: context.holidayCalendarReachable,"],
    ["src/lib/company-activity-report/service.ts", "holidayCalendarReachable: calendarContext.holidayCalendarReachable,"],
  ] as const) {
    assert.ok(
      readFileSync(file, "utf8").includes(marker),
      `${file} must carry the calendar's real state from the month's own context, never a constant`,
    );
  }

  // ── Display surfaces: keep working, but never claim the calendar was fine ────────────────────
  {
    const analytics = readFileSync("src/lib/attendance/analytics.ts", "utf8");
    assert.match(
      analytics,
      /if \(!context\.holidaySourceConnected \|\| !context\.holidayCalendarReachable\) \{/,
      "the attendance banner must fire on an outage too, not only on a month that degraded to nothing",
    );

    const monthly = readFileSync("src/components/attendance/monthly-attendance-summary.tsx", "utf8");
    assert.match(
      monthly,
      /!initialData\.holidaySourceConnected \|\| !initialData\.holidayCalendarReachable/,
      "the monthly summary's warning must read both flags",
    );
    assert.match(
      monthly,
      /moving Islamic and Coptic holidays/,
      "…and must name what is actually missing, rather than imply every holiday was lost",
    );

    const reconciliation = readFileSync("src/lib/reconciliation/checks/deductions-attendance.ts", "utf8");
    assert.match(
      reconciliation,
      /summary\.holidayCalendarReachable && summary\.holidaySourceConnected \? "yes"/,
      "the reconciliation line printed a confident 'yes' through an outage — it must require both flags",
    );

    const activityTable = readFileSync("src/components/company-activity-report/company-activity-report-table.tsx", "utf8");
    assert.match(
      activityTable,
      /\{report\.holidayCalendarReachable \? null : \(/,
      "the Company Activity Report shows an outage on screen",
    );
    const activityExport = readFileSync("src/lib/company-activity-report/export.ts", "utf8");
    assert.match(
      activityExport,
      /\["Public holidays", report\.holidayCalendarReachable/,
      "…and carries the same note into the workbook, so a downloaded copy cannot look cleaner than the screen",
    );

    const headOffice = readFileSync("src/components/field-workforce-compliance/head-office-attendance-panel.tsx", "utf8");
    assert.match(
      headOffice,
      /const holidayCalendarReachable = result\?\.holidayCalendarReachable \?\? true;/,
      "the Head Office attendance panel reads the flag off its own result",
    );
    assert.match(
      headOffice,
      /\{holidayCalendarReachable \? null : \(/,
      "…and warns that a missing day may really be a public holiday",
    );

    // The T-3 confirmation reminder is the one that compounds: the moving holidays are exactly
    // what needs confirming AND exactly what an outage hides, and only a CONFIRMED holiday
    // survives the next outage as an override. Silence here loses that holiday twice.
    const confirmation = readFileSync("src/lib/vacation/holiday-confirmation.ts", "utf8");
    assert.match(
      confirmation,
      /if \(!raw\.calendarReachable\) \{\s*logError\(/,
      "a reminder skipped during an outage must leave a record, not return an empty list that reads as 'nothing to confirm'",
    );
    assert.doesNotMatch(
      confirmation,
      /sendEmail|sendNotification|notifyAdmins/,
      "…and must not send anything: this path only records (owner rule — never fire an email or notification)",
    );
  }
}
