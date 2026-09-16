import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  ANSWER_WINDOW_LEAVE_STATUSES,
  answerDueDate,
  balanceCoversDays,
  balanceReadIsComplete,
  buildDisputeDecidedMessage,
  buildWeekReleasedMessage,
  canManageWeeklyReview,
  countsTowardAnswerWindow,
  deadlineApplies,
  decisionForSettlement,
  disputeSalaryFallbackText,
  heldAnswerDueDate,
  isAnswerOverdue,
  MAX_MARKED_DAYS,
  editedDaysApplyToCandidate,
  parseMarkedDays,
  payrollDaysForSettledLine,
  payrollDecisionBlocksBalance,
  pickDefaultReviewWeek,
  releaseNoticeReached,
  reviewWeekStage,
} from "../src/lib/attendance/digest-rules.ts";
import { closedWeeksOfCurrentCycle, latestClosedSettlementWeek } from "../src/lib/attendance/digest-weeks.ts";
import { withWeekBuildLock } from "../src/lib/attendance/week-build-lock.ts";

// The weekly attendance review, owner decisions 2026-09-15 and 2026-09-16:
//   release gate → employee chooses salary or annual balance → may then dispute →
//   no answer within 2 working days of release → salary. Days on leave, approved or still waiting
//   for approval, do not count toward those 2 days, and the employee is told how a dispute was
//   decided. Month-end payroll cannot approve a day still waiting for release or for their answer.

/** Friday off for everyone, plus one named holiday. Egypt's weekend shape. */
function workingDayWithHoliday(holidayIso: string) {
  return (dateIso: string) => new Date(`${dateIso}T00:00:00Z`).getUTCDay() !== 5 && dateIso !== holidayIso;
}

/** Every date from one day to another, both included. */
function datesBetween(fromIso: string, toIso: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(`${fromIso}T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= toIso) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

/** Friday off, no holidays, and the given days on leave — counted the way the service counts them. */
function workingDayOnLeave(leaveDates: string[]) {
  const leaveDays = new Set(leaveDates);
  return (dateIso: string) =>
    countsTowardAnswerWindow({
      isScheduledWorkingDay: new Date(`${dateIso}T00:00:00Z`).getUTCDay() !== 5,
      isPublicHoliday: false,
      onLeave: leaveDays.has(dateIso),
    });
}

export async function runAttendanceDigestRulesTests() {
  // --- The deadline -----------------------------------------------------------
  // 2026-09-15 is a Tuesday. Two working days after it: Wednesday 16th, Thursday 17th.
  assert.equal(
    answerDueDate({ releasedOnIso: "2026-09-15", workingDays: 2, isWorkingDay: workingDayWithHoliday("none") }),
    "2026-09-17",
    "the release day itself never counts — a week released at 11pm must not have spent half its window",
  );
  // Released Thursday 17th: Friday is off, so Saturday 19th and Sunday 20th.
  assert.equal(
    answerDueDate({ releasedOnIso: "2026-09-17", workingDays: 2, isWorkingDay: workingDayWithHoliday("none") }),
    "2026-09-20",
    "a weekly day off does not count as one of the two WORKING days",
  );
  assert.equal(
    answerDueDate({ releasedOnIso: "2026-09-15", workingDays: 2, isWorkingDay: workingDayWithHoliday("2026-09-16") }),
    "2026-09-19",
    "a public holiday does not count either (16th holiday, 17th counts, 18th Friday, 19th counts)",
  );
  assert.equal(
    answerDueDate({ releasedOnIso: "2026-09-15", workingDays: 2, isWorkingDay: () => false }),
    "2029-06-11",
    "a calendar that never says 'working' cannot loop forever, and never gives an EARLIER date than a real walk could: it returns the last day walked, 1,000 days on",
  );

  // --- Days on leave do not count (owner, 2026-09-15 — "Pause for leave days"; 2026-09-16 — "Pending pauses too") ---
  assert.equal(countsTowardAnswerWindow({ isScheduledWorkingDay: true, isPublicHoliday: false, onLeave: false }), true, "an ordinary working day counts");
  assert.equal(countsTowardAnswerWindow({ isScheduledWorkingDay: false, isPublicHoliday: false, onLeave: false }), false, "a weekly day off does not count");
  assert.equal(countsTowardAnswerWindow({ isScheduledWorkingDay: true, isPublicHoliday: true, onLeave: false }), false, "a public holiday does not count");
  assert.equal(
    countsTowardAnswerWindow({ isScheduledWorkingDay: true, isPublicHoliday: false, onLeave: true }),
    false,
    "a day on leave does not count — someone on leave is not at work to answer",
  );
  {
    const vacation = readFileSync("src/lib/vacation/service.ts", "utf8");
    const inFlightDeclaration = /const IN_FLIGHT_VACATION_STATUSES = \[([^\]]*)\]/.exec(vacation)?.[1] ?? "";
    const inFlight = [...inFlightDeclaration.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
    assert.ok(inFlight.length > 0, "the vacation module's in-flight statuses must be found");
    assert.deepEqual(
      [...ANSWER_WINDOW_LEAVE_STATUSES].sort(),
      ["approved", ...inFlight].sort(),
      "leave still waiting for a decision pauses the answer window: approved leave plus exactly the vacation module's in-flight statuses",
    );
  }
  // Released Tuesday 15th, on leave Wednesday 16th and Thursday 17th. Friday is off, so Saturday 19th and Sunday 20th.
  assert.equal(
    answerDueDate({ releasedOnIso: "2026-09-15", workingDays: 2, isWorkingDay: workingDayOnLeave(["2026-09-16", "2026-09-17"]) }),
    "2026-09-20",
    "the deadline moves past the leave",
  );
  assert.equal(
    answerDueDate({ releasedOnIso: "2026-09-15", workingDays: 2, isWorkingDay: workingDayOnLeave(datesBetween("2026-09-16", "2026-11-24")) }),
    "2026-11-26",
    "a leave longer than 60 days still moves the deadline past it — the old 60-day cap fell back to 17 Sep, mid-leave",
  );
  assert.equal(
    answerDueDate({ releasedOnIso: "2026-09-15", workingDays: 2, isWorkingDay: workingDayOnLeave(datesBetween("2026-09-16", "2026-12-24")) }),
    "2026-12-27",
    "a leave ending on a Thursday: Friday is off, so Saturday 26th and Sunday 27th",
  );
  assert.equal(
    heldAnswerDueDate({ toldDueOn: "2026-09-17", recomputedDueOn: "2026-09-20" }),
    "2026-09-20",
    "leave approved since the release moves the deadline later",
  );
  assert.equal(
    heldAnswerDueDate({ toldDueOn: "2026-09-20", recomputedDueOn: "2026-09-17" }),
    "2026-09-20",
    "a deadline already given is never brought EARLIER — a cancelled leave or a shorter setting must not take salary sooner",
  );
  assert.equal(heldAnswerDueDate({ toldDueOn: null, recomputedDueOn: "2026-09-17" }), "2026-09-17", "with no date on record, the worked-out date stands");

  assert.equal(isAnswerOverdue("2026-09-17", "2026-09-17"), false, "the due date itself is still open — 'by the end of Thursday'");
  assert.equal(isAnswerOverdue("2026-09-17", "2026-09-18"), true, "the day after, it is overdue");
  assert.equal(isAnswerOverdue(null, "2026-12-31"), false, "a week with no deadline (never released) is never overdue");

  // --- Annual balance covers the whole day or none of it ----------------------
  assert.equal(balanceCoversDays({ days: 0.5, paidDurationDays: 0.5, unpaidReason: null }), true, "exactly enough balance covers");
  assert.equal(
    balanceCoversDays({ days: 1, paidDurationDays: 0.5, unpaidReason: null }),
    false,
    "a part-covered day is NOT offered — the rest would fall on salary without anyone choosing that",
  );
  assert.equal(
    balanceCoversDays({ days: 0.5, paidDurationDays: 0.5, unpaidReason: "Insufficient balance" }),
    false,
    "any unpaid reason from the vacation calculator refuses the balance option",
  );
  assert.equal(balanceCoversDays({ days: 0, paidDurationDays: 5, unpaidReason: null }), false, "a zero-day line is never charged to leave");

  // --- What payroll does with each answer --------------------------------------
  // The one that costs money if wrong: a day paid from annual balance must NOT also be deducted
  // from salary at month end.
  assert.equal(
    decisionForSettlement("annual_balance", "annual_balance")?.status,
    "Do Not Take Action",
    "a day charged to annual balance must never ALSO be approved for payroll — that takes the day twice",
  );
  assert.equal(
    decisionForSettlement("dispute_rejected", "annual_balance")?.status,
    "Do Not Take Action",
    "a rejected dispute on a balance choice is charged to balance, not payroll",
  );
  assert.equal(decisionForSettlement("dispute_rejected", "salary")?.status, "Approved for Payroll");
  assert.equal(decisionForSettlement("salary", "salary")?.status, "Approved for Payroll");
  assert.equal(decisionForSettlement("auto_salary", "salary")?.status, "Approved for Payroll", "silence past the deadline is salary");
  assert.equal(decisionForSettlement("dispute_upheld", "salary")?.status, "Do Not Take Action", "an upheld dispute charges nothing");
  assert.equal(decisionForSettlement("confirmed", null)?.status, "Approved for Payroll", "the old 2026-09-08 answer still reads");
  assert.equal(decisionForSettlement("pending", null), null, "an open day has no payroll decision");
  assert.equal(decisionForSettlement("disputed", "salary"), null, "a day under dispute has no payroll decision yet");
  assert.equal(
    decisionForSettlement("removed", null)?.status,
    "Do Not Take Action",
    "a day removed before release must close its month-end deduction — 'never charged' needs a record payroll acts on",
  );

  // --- The double-charge guard ------------------------------------------------------
  // Paying from balance is permanent, and salary is spared only while the day's month-end deduction
  // is undecided and unlocked.
  assert.equal(payrollDecisionBlocksBalance(null), false, "no month-end deduction yet is normal — the bridge applies the answer later");
  assert.equal(payrollDecisionBlocksBalance({ lockedAt: null, decisionStatus: null }), false);
  assert.equal(payrollDecisionBlocksBalance({ lockedAt: null, decisionStatus: "Pending" }), false);
  assert.equal(
    payrollDecisionBlocksBalance({ lockedAt: null, decisionStatus: "Approved for Payroll" }),
    true,
    "a deduction already approved for payroll must refuse balance — otherwise the day is taken from leave AND pay",
  );
  assert.equal(
    payrollDecisionBlocksBalance({ lockedAt: null, decisionStatus: "Do Not Take Action" }),
    true,
    "a deduction a person already cleared must refuse balance — otherwise leave is spent on a day nobody charges",
  );
  assert.equal(
    payrollDecisionBlocksBalance({ lockedAt: "2026-09-30T10:00:00Z", decisionStatus: "Pending" }),
    true,
    "a published (locked) deduction can no longer be closed by the bridge, so balance is refused",
  );

  // --- A balance the calculator under-read is not trusted ------------------------------
  assert.equal(balanceReadIsComplete({ calculatorUsedDays: 3, carriedOverDebtDays: 0, requestDays: 2, chargeDays: 0.5, copilotDays: 0.5 }), true);
  assert.equal(
    balanceReadIsComplete({ calculatorUsedDays: 2.5, carriedOverDebtDays: 0, requestDays: 2, chargeDays: 0.5, copilotDays: 0.5 }),
    false,
    "if the calculator saw less than the database holds, 'covers' is refused",
  );
  // The risk review's case: requests 2, Copilot ledger 3 (unread), debt 3. The calculator's used
  // figure is 2 + 0 + 3 = 5, the database's is 2 + 3 = 5 — equal, yet the balance is 3 days too big.
  assert.equal(
    balanceReadIsComplete({ calculatorUsedDays: 5, carriedOverDebtDays: 3, requestDays: 2, chargeDays: 0, copilotDays: 3 }),
    false,
    "carried debt must not hide days the calculator failed to see — take the debt out before comparing",
  );
  assert.equal(balanceReadIsComplete({ calculatorUsedDays: 8, carriedOverDebtDays: 3, requestDays: 2, chargeDays: 0, copilotDays: 3 }), true, "debt on top of a complete read is fine");
  assert.equal(balanceReadIsComplete({ calculatorUsedDays: 0.13, carriedOverDebtDays: 0, requestDays: 0, chargeDays: 0.125, copilotDays: 0 }), true, "2- vs 3-decimal rounding is tolerated");

  // …and the calculator is asked to read the payroll ledger fail-closed, so a failed read refuses.
  {
    const digestService = readFileSync("src/lib/attendance/digest-service.ts", "utf8");
    const check = digestService.slice(digestService.indexOf("async function checkAnnualBalance"), digestService.indexOf("// The settle function"));
    assert.match(check, /failClosedLedgerRead: true/, "the balance offered for an attendance day must read the payroll ledger fail-closed");
    assert.match(check, /carriedOverDebtDays: snapshot\.carriedOverDebtDays/, "the completeness check must be given the carried debt");
    const vacation = readFileSync("src/lib/vacation/service.ts", "utf8");
    assert.match(vacation, /if \(input\.failClosed\) throw error;/, "balanceSettledDaysInPeriod must throw when asked to fail closed");
    const debtWalk = vacation.slice(vacation.indexOf("async function getDeferredDebtFromPreviousPeriods"), vacation.indexOf("export async function calculatePaymentForRequest"));
    assert.match(debtWalk, /failClosedLedgerRead: input\.failClosedLedgerRead/, "the carried-debt walk must pass fail-closed down to every earlier period");
  }

  // --- The deadline only runs for someone who was told ----------------------------------
  assert.equal(deadlineApplies({ answerDueOn: "2026-09-17", notifiedAt: "2026-09-15T09:00:00Z", todayCairoIso: "2026-09-18" }), true);
  assert.equal(
    deadlineApplies({ answerDueOn: "2026-09-17", notifiedAt: null, todayCairoIso: "2026-09-30" }),
    false,
    "a day nobody was told about is never settled to salary for going unanswered",
  );
  assert.equal(deadlineApplies({ answerDueOn: "2026-09-17", notifiedAt: "2026-09-15T09:00:00Z", todayCairoIso: "2026-09-17" }), false);

  assert.equal(releaseNoticeReached([{ channel: "in_app", status: "sent" }]), true);
  assert.equal(releaseNoticeReached([{ channel: "in_app", status: "skipped" }, { channel: "telegram", status: "pending" }]), true);
  assert.equal(
    releaseNoticeReached([{ channel: "in_app", status: "skipped" }, { channel: "telegram", status: "failed" }]),
    false,
    "a notice every channel skipped or failed told nobody, and must not start the clock",
  );
  assert.equal(releaseNoticeReached([]), false, "no delivery at all is not a notice");
  assert.equal(releaseNoticeReached([{ channel: "email", status: "sent" }]), false, "email is not one of this notice's channels");

  // --- Week 4 is built ---------------------------------------------------------------------
  // Cycle 2026-09 runs 24 Aug to 23 Sep; its week 4 is 14-23 Sep.
  {
    const on24th = latestClosedSettlementWeek("2026-09-24", 24);
    assert.equal(on24th?.cycle.cycleKey, "2026-09", "on the 24th the week that just closed belongs to the PREVIOUS cycle");
    assert.equal(on24th?.week.index, 4, "…and it is week 4 — asking only today's cycle never built it");
    assert.equal(on24th?.week.startIso, "2026-09-14");
    assert.equal(on24th?.week.endIso, "2026-09-23");
    const on30th = latestClosedSettlementWeek("2026-09-30", 24);
    assert.equal(on30th?.cycle.cycleKey, "2026-09", "until the new cycle's week 1 closes, week 4 stays the one due");
    assert.equal(on30th?.week.index, 4);
    const onOct1 = latestClosedSettlementWeek("2026-10-01", 24);
    assert.equal(onOct1?.cycle.cycleKey, "2026-10");
    assert.equal(onOct1?.week.index, 1);
    const onSep15 = latestClosedSettlementWeek("2026-09-15", 24);
    assert.equal(onSep15?.cycle.cycleKey, "2026-09");
    assert.equal(onSep15?.week.index, 3);
    assert.equal(onSep15?.week.startIso, "2026-09-07");
  }

  // --- The release notice -----------------------------------------------------
  const notice = buildWeekReleasedMessage({ weekStart: "2026-09-07", weekEnd: "2026-09-13", dayCount: 2, answerDueOn: "2026-09-17" });
  // en-GB abbreviates September as "Sept" on current ICU and "Sep" on older builds.
  assert.match(notice.title, /7 Sept? to 13 Sept?/, "the title names the week");
  assert.match(notice.message, /salary/i, "the notice asks the owner's question: salary…");
  assert.match(notice.message, /annual vacation balance/i, "…or annual balance");
  assert.match(notice.message, /dispute/i, "and says a dispute is possible after choosing");
  assert.match(notice.message, /Thursday 17 September/, "and gives the deadline");
  assert.doesNotMatch(notice.message, /EGP|\d+\.\d{2}/, "no amount on a lock-screen channel");

  // --- The dispute decision notice (owner, 2026-09-15 — "Yes, in-app and Telegram") ------------------
  // 2026-09-10 is a Thursday.
  {
    const accepted = buildDisputeDecidedMessage({ workDate: "2026-09-10", upheld: true, appliedMethod: null, chosenMethod: "salary", balanceRefusal: null, hasReviewerNote: false });
    assert.match(accepted.title, /accepted — 10 Sept?/, "the title names the outcome and the day");
    assert.match(accepted.message, /Thursday 10 September was accepted\. Nothing is deducted for that day\./, "an accepted dispute says nothing is deducted");
    assert.doesNotMatch(accepted.message, /reviewer left a note/, "no note, no mention of one");

    const balance = buildDisputeDecidedMessage({ workDate: "2026-09-10", upheld: false, appliedMethod: "annual_balance", chosenMethod: "annual_balance", balanceRefusal: null, hasReviewerNote: true });
    assert.match(balance.title, /rejected — 10 Sept?/, "a rejected dispute's title says so");
    assert.match(balance.message, /annual vacation balance, as you chose/, "a rejected dispute says where the day is taken from");
    assert.match(
      balance.message,
      /reviewer left a note on your weekly attendance page/,
      "a note is pointed to, never quoted — it is free text on a lock-screen channel",
    );

    const fellBack = buildDisputeDecidedMessage({ workDate: "2026-09-10", upheld: false, appliedMethod: "salary", chosenMethod: "annual_balance", balanceRefusal: "insufficient_balance", hasReviewerNote: false });
    assert.ok(
      fellBack.message.includes(disputeSalaryFallbackText("insufficient_balance")),
      "when annual balance could not be used, the notice gives the real cause, not a bare 'salary'",
    );

    const salary = buildDisputeDecidedMessage({ workDate: "2026-09-10", upheld: false, appliedMethod: "salary", chosenMethod: "salary", balanceRefusal: null, hasReviewerNote: false });
    assert.match(salary.message, /taken from your salary, as you chose/, "a salary choice is named as theirs");
    const noChoice = buildDisputeDecidedMessage({ workDate: "2026-09-10", upheld: false, appliedMethod: "salary", chosenMethod: null, balanceRefusal: null, hasReviewerNote: false });
    assert.match(noChoice.message, /taken from your salary\.$/, "with no recorded choice it says salary, and never claims they chose it");

    for (const decided of [accepted, balance, fellBack, salary, noChoice]) {
      assert.doesNotMatch(decided.message, /EGP|\d+\.\d{2}/, "no amount on a lock-screen channel");
    }
  }

  // --- The release gate is asked by every surface --------------------------------
  // Asserted on sources because none can run without Supabase, and the defect guarded against is
  // a surface that never calls the gate at all.
  for (const surface of [
    "app/employee-portals/attendance/digests/page.tsx",
    "app/api/attendance/digests/route.ts",
    "app/api/attendance/digests/[id]/answer/route.ts",
  ]) {
    assert.match(
      readFileSync(surface, "utf8"),
      /canOpenDigestPortal\(access\)\.catch\(\(\) => false\)/,
      `${surface} must ask canOpenDigestPortal and fail CLOSED on a surface showing somebody their own pay`,
    );
  }
  for (const surface of [
    "app/(admin)/attendance/weekly-review/page.tsx",
    "app/api/attendance/weekly-review/route.ts",
    "app/(admin)/attendance/disputes/page.tsx",
  ]) {
    assert.match(
      readFileSync(surface, "utf8"),
      /canReviewDisputes\(access\)\.catch\(\(\) => false\)/,
      `${surface} shows OTHER people's pay: it must gate on canReviewDisputes and fail closed`,
    );
  }

  // --- Choosing days, building a week and releasing it: the Super Admin only ---------------------
  assert.equal(canManageWeeklyReview({ role: "Super Admin" }), true, "the Super Admin ticks days, builds and releases");
  for (const role of ["HR Advisory", "HR Operations", "CEO", "Employee", null, undefined]) {
    assert.equal(canManageWeeklyReview({ role }), false, `${String(role)} must not tick a day, build or release a week, even as a named dispute reviewer`);
  }
  for (const surface of [
    "app/api/attendance/weekly-review/release/route.ts",
    "app/api/attendance/weekly-review/lines/[lineId]/mark/route.ts",
    "app/api/attendance/weekly-review/build/route.ts",
  ]) {
    const source = readFileSync(surface, "utf8");
    assert.match(source, /if \(!canManageWeeklyReview\(access\)\) \{\s*return NextResponse\.json\([^)]*\{ status: 403 \}\)/, `${surface} must refuse anyone but the Super Admin with a 403`);
    assert.match(source, /actorRole: access\.role \?\? null/, `${surface} must hand the caller's role to the service, which checks it again`);
  }
  assert.equal(
    existsSync("app/api/attendance/weekly-review/lines/[lineId]/remove/route.ts"),
    false,
    "Remove this day was replaced by the ticks (owner, 2026-09-15) and must stay deleted",
  );
  const serviceSource = readFileSync("src/lib/attendance/digest-service.ts", "utf8");
  for (const fn of ["export async function markDigestLine", "export async function buildReviewWeek", "export async function releaseWeek"]) {
    const body = serviceSource.slice(serviceSource.indexOf(fn), serviceSource.indexOf("\n}\n", serviceSource.indexOf(fn)));
    assert.match(body, /assertCanManageWeeklyReview\(input\.actorRole\)/, `${fn} must refuse anyone but the Super Admin itself, not only in the route`);
  }
  const reviewPage = readFileSync("src/components/attendance/weekly-attendance-review.tsx", "utf8");
  assert.match(reviewPage, /const canMark =\s+canManage && /, "a dispute reviewer must not see the ticks");
  assert.match(reviewPage, /const releasable =\s+canManage && /, "a dispute reviewer must not see Release this week");
  assert.match(reviewPage, /const canBuild = canManage && /, "a dispute reviewer must not see Build this week");
  assert.match(readFileSync("app/(admin)/attendance/weekly-review/page.tsx", "utf8"), /canManage=\{canManageWeeklyReview\(access\)\}/, "the page must pass the Super Admin check down");

  // --- A rejected dispute that falls back to salary says why ----------------------------------
  assert.match(disputeSalaryFallbackText("payroll_decided"), /already decided this day; that decision stands/, "never claim salary was taken when the month-end review had already decided the day");
  assert.doesNotMatch(disputeSalaryFallbackText("payroll_decided"), /no longer covered/, "…and never blame the balance for it");
  assert.match(disputeSalaryFallbackText("insufficient_balance"), /no longer covered this day/);
  assert.match(disputeSalaryFallbackText("first_six_months"), /first six months/);
  assert.match(disputeSalaryFallbackText("missing_hire_date"), /hire date/);
  for (const retired of ["app/api/attendance/digests/[id]/confirm/route.ts", "app/api/attendance/digests/[id]/dispute/route.ts"]) {
    assert.equal(existsSync(retired), false, `${retired} is the pre-2026-09-15 flow and must stay deleted`);
  }

  // --- Nothing reaches an employee before release --------------------------------
  const service = readFileSync("src/lib/attendance/digest-service.ts", "utf8");
  const mine = service.slice(service.indexOf("export async function listMyDigests"), service.indexOf("export async function answerDigestLine"));
  assert.match(mine, /\.not\("released_at", "is", null\)/, "listMyDigests must only return RELEASED weeks");
  assert.match(mine, /\.eq\("dry_run", false\)/, "listMyDigests must never return a trial-run week");
  const release = service.slice(service.indexOf("export async function releaseWeek"), service.indexOf("export type MyDigestLine"));
  assert.match(
    release,
    /\.rpc\("phx_attendance_release_digest", \{/,
    "the release must go through the database function that clears the unticked days under the week's lock",
  );
  assert.doesNotMatch(release, /from\("attendance_weekly_digests"\)\s*\.update\(\{ status: "open"/, "…never a plain status write that skips the clearing");
  assert.match(release, /if \(outcome\.status !== "open" \|\| dayCount === 0\) continue;/, "a week with nothing ticked is released to nobody");

  const cron = readFileSync("app/api/cron/attendance-weekly-digest/route.ts", "utf8");
  assert.doesNotMatch(cron, /notifyAttendanceWeekReleased|releaseWeek/, "the daily job must never release or notify — only the owner's click does");
  assert.match(
    cron,
    /const failed = Boolean\(bridgeError \|\| deadlineError \|\| deadlineFailures > 0 \|\| balanceAlerts\.length > 0\);/,
    "a day the sweep could not settle, or money taken twice, must make the daily job fail loudly",
  );
  assert.match(cron, /\{ status: failed \? 500 : 200 \}/, "…and fail loudly means a 500 the scheduler sees");

  // --- The guards the database and the deductions module enforce -------------------------------
  // Source pins: the settle function, the removal function and recordDecision cannot run here.
  const migration = readFileSync("supabase/migrations/20260915210000_weekly_digest_release_and_balance_choice.sql", "utf8");
  const settleFn = migration.slice(
    migration.indexOf("create or replace function public.phx_attendance_settle_digest_line"),
    migration.indexOf("revoke execute on function public.phx_attendance_settle_digest_line"),
  );
  assert.ok(settleFn.length > 0 && settleFn.length < migration.length / 2, "the settle function slice must find both of its markers");
  assert.match(
    settleFn,
    /c\.locked_at is not null or coalesce\(d\.decision_status, 'Pending'\) <> 'Pending'/,
    "the settle function must refuse a balance charge once the day's month-end deduction is decided or locked",
  );
  assert.ok(
    settleFn.indexOf("c.locked_at is not null") > settleFn.indexOf("pg_advisory_xact_lock"),
    "the double-charge check must run under the per-employee lock",
  );
  assert.match(settleFn, /v_digest\.dry_run is distinct from false/, "nothing in a trial-run week may settle, whoever calls");
  assert.match(settleFn, /round\(v_copilot_days, 3\) <> round\(coalesce\(p_seen_copilot_days, -1\), 3\)/, "balance a payroll run spent must be re-checked too");

  const removeFn = migration.slice(
    migration.indexOf("create or replace function public.phx_attendance_remove_digest_line"),
    migration.indexOf("revoke execute on function public.phx_attendance_remove_digest_line"),
  );
  assert.ok(removeFn.length > 0 && removeFn.length < migration.length / 2, "the removal function slice must find both of its markers");
  assert.match(removeFn, /v_digest\.status <> 'awaiting_release'/, "a day can only be removed before release");
  assert.match(
    removeFn,
    /insert into public\.attendance_settlements \([^;]*'removed'[^;]*;/,
    "a removal must leave a 'removed' settlement for the bridge",
  );

  // The Super Admin's ticks (owner, 2026-09-15 — "I want full control").
  const selection = readFileSync("supabase/migrations/20260915230000_weekly_review_day_selection.sql", "utf8");
  const markFn = selection.slice(
    selection.indexOf("create or replace function public.phx_attendance_mark_digest_line"),
    selection.indexOf("revoke execute on function public.phx_attendance_mark_digest_line"),
  );
  assert.ok(markFn.length > 0 && markFn.length < selection.length / 2, "the mark function slice must find both of its markers");
  assert.match(markFn, /v_digest\.dry_run is distinct from false/, "a trial-run week's days can never be ticked");
  assert.match(markFn, /v_digest\.status <> 'awaiting_release'/, "a day can only be ticked or changed before release");
  assert.match(markFn, /v_line\.action <> 'pending'/, "an answered day can never be changed");
  assert.match(markFn, /if v_days <= 0 or v_days > 3 then/, "the database refuses 0 days and more than 3, whoever calls");
  assert.ok(markFn.indexOf("for update") < markFn.indexOf("v_digest.status <> 'awaiting_release'"), "the release check must run under the week's lock");
  assert.match(
    markFn,
    /select \* into v_digest from public\.attendance_weekly_digests\s+where id = \(select digest_id from public\.attendance_digest_lines where id = p_line_id\)\s+for update;[\s\S]*select \* into v_line from public\.attendance_digest_lines where id = p_line_id and digest_id = v_digest\.id for update;/,
    "lock the week before the day, the order release takes them in — the other order deadlocks a tick against a release",
  );
  assert.match(selection, /grant execute on function public\.phx_attendance_mark_digest_line\([^)]*\) to service_role;/);

  const releaseFn = selection.slice(
    selection.indexOf("create or replace function public.phx_attendance_release_digest"),
    selection.indexOf("revoke execute on function public.phx_attendance_release_digest"),
  );
  assert.ok(releaseFn.length > 0 && releaseFn.length < selection.length / 2, "the release function slice must find both of its markers");
  assert.match(
    releaseFn,
    /where digest_id = v_digest\.id and action = 'pending' and deduct = false/,
    "release must clear exactly the unticked days that are still pending",
  );
  assert.match(
    releaseFn,
    /insert into public\.attendance_settlements \([^;]*'removed'[^;]*;/,
    "an unticked day must leave a 'removed' settlement, or payroll could still approve it",
  );
  assert.match(releaseFn, /v_digest\.status <> 'awaiting_release' or v_digest\.dry_run is distinct from false/, "release refuses a trial run or a week already released");
  assert.match(releaseFn, /when v_kept = 0 then 'void'/, "a week with nothing ticked is voided, never opened to the employee");
  assert.match(selection, /grant execute on function public\.phx_attendance_release_digest\([^)]*\) to service_role;/);

  assert.match(
    release,
    /if \(!answerWindow\.context\) \{\s*throw conflictError/,
    "release must refuse when the holiday calendar or leave requests are unreadable — a deadline worked out without them comes too early",
  );
  assert.match(release, /answerDeadlineFor\(answerContext, \{/, "release sets each deadline from the answer window it just read");

  // --- The answer window: holidays, the employee's own days off, and leave (approved or waiting) ----------
  const answerWindowSource = service.slice(service.indexOf("async function loadAnswerWindow"), service.indexOf("export type ReleaseResult"));
  assert.ok(
    answerWindowSource.length > 0 && answerWindowSource.length < service.length / 4,
    "the answer window slice must find both of its markers",
  );
  assert.match(
    answerWindowSource,
    /if \(!calendar\.holidaySourceConnected\) \{\s*return \{ context: null/,
    "an unreadable holiday calendar gives no deadline — a holiday would count as a working day to answer in",
  );
  assert.match(
    answerWindowSource,
    /if \(leave instanceof Error\) \{\s*return \{ context: null/,
    "unreadable leave requests give no deadline either — a day away would count as a day to answer in",
  );
  assert.match(answerWindowSource, /isAttendanceScheduledWorkingDay\(\{ dateIso, jobTitle, workingWeekdays \}\)/, "the deadline uses the employee's own weekly-off policy");
  assert.match(answerWindowSource, /onLeave: leaveDays\.has\(dateIso\)/, "the deadline skips the employee's days on leave");
  assert.match(
    answerWindowSource,
    /statuses: ANSWER_WINDOW_LEAVE_STATUSES,/,
    "the deadline reads leave still waiting for approval, not only approved leave (owner, 2026-09-16 — \"Pending pauses too\")",
  );
  const workingDays = readFileSync("src/lib/attendance/working-days.ts", "utf8");
  const leaveReader = workingDays.slice(workingDays.indexOf("export async function getLeaveDayMap"));
  assert.equal(
    (leaveReader.match(/\.in\("status", statuses\)/g) ?? []).length,
    2,
    "both leave reads, batched and whole, filter on the statuses asked for",
  );
  assert.match(
    workingDays,
    /export async function getApprovedLeaveDayMap\([\s\S]*?return getLeaveDayMap\(\{ \.\.\.input, statuses: \["approved"\] \}\);/,
    "every other reader of leave still sees approved leave only",
  );
  assert.match(
    answerWindowSource,
    /deadlines\.set\(digest\.id, heldAnswerDueDate\(\{ toldDueOn: digest\.answerDueOn, recomputedDueOn \}\)\)/,
    "a deadline worked out again never comes before the one the employee was given",
  );

  const sweep = service.slice(service.indexOf("export async function settleOverdueAnswers"));
  assert.match(sweep, /\.not\("notified_at", "is", null\)/, "the deadline sweep must skip anyone who was never notified");
  assert.match(
    sweep,
    /heldAnswerDeadlines\(\{ digests: withPending/,
    "the sweep works each deadline out again before settling — leave filed or approved since the release moves it",
  );
  assert.match(
    sweep,
    /if \(!held\.deadlines\) \{\s*throw new Error/,
    "when the calendar or leave requests cannot be read, the sweep settles NOTHING and fails loudly",
  );
  assert.match(
    sweep,
    /if \(!dueOn \|\| !isAnswerOverdue\(dueOn, input\.todayIso\)\) continue;/,
    "a day is settled to salary only when the deadline it holds NOW has passed",
  );
  assert.ok(
    sweep.indexOf("if (!dueOn || !isAnswerOverdue(dueOn, input.todayIso)) continue;") < sweep.indexOf("await settleLine({"),
    "…and that is checked before any day is settled",
  );
  assert.ok(
    sweep.includes("await saveLaterAnswerDeadlines(") &&
      sweep.indexOf("await saveLaterAnswerDeadlines(") < sweep.indexOf("for (const digest of withPending) {"),
    "every deadline that moved later is saved before the first day of any week is settled",
  );
  assert.match(
    sweep,
    /\.select\("answer_due_on"\)\s*\.eq\("id", digest\.id\)\s*\.eq\("status", "open"\)\s*\.maybeSingle\(\);/,
    "the sweep reads the stored deadline ONE more time, right before it settles that week",
  );
  assert.ok(
    sweep.includes('.select("answer_due_on")') && sweep.indexOf('.select("answer_due_on")') < sweep.indexOf("await settleLine({"),
    "…before the day is taken to salary, not after",
  );
  assert.match(
    sweep,
    /if \(!isAnswerOverdue\(heldAnswerDueDate\(\{ toldDueOn: storedNow, recomputedDueOn: dueOn \}\), input\.todayIso\)\) continue;/,
    "a week whose stored deadline moved later while this run was working settles nothing",
  );
  assert.match(sweep, /if \(storedError\) \{\s*failures \+= 1;/, "a deadline that could not be read again settles nothing and is reported");
  assert.match(sweep, /if \(!storedRow\) continue;/, "a week that is no longer open is left alone");

  // The answer path and the employee's page hold the deadline the sweep holds.
  const answerPath = service.slice(service.indexOf("export async function answerDigestLine"), service.indexOf("export type PendingDispute"));
  assert.ok(answerPath.length > 0 && answerPath.length < service.length / 4, "the answer slice must find both of its markers");
  assert.match(answerPath, /heldAnswerDeadlines\(\{ digests: \[digest\]/, "the answer path works the deadline out again before refusing");
  assert.match(
    answerPath,
    /if \(isAnswerOverdue\(dueOn, todayIso\)\) \{\s*throw conflictError\("The deadline for this week has passed/,
    "…and refuses only on the deadline it holds now",
  );
  assert.match(mine, /heldAnswerDeadlines\(\{ digests: pastStoredDate/, "the employee's page works a passed deadline out again, as the answer path does");
  assert.match(
    mine,
    /const answerDueOn = held\?\.get\(digest\.id\) \?\? digest\.answerDueOn;/,
    "the employee's page shows the deadline the answer path accepts, not the stored one",
  );

  // Showing a later deadline is a promise, so whoever works one out SAVES it. The daily job settles
  // on the STORED date: a date only shown would be taken back the moment that leave is rejected.
  const saver = service.slice(service.indexOf("async function saveLaterAnswerDeadlines"), service.indexOf("export type ReleaseResult"));
  assert.ok(saver.length > 0 && saver.length < service.length / 4, "the saver slice must find both of its markers");
  assert.match(
    saver,
    /if \(!move\.dueOn \|\| !move\.storedDueOn \|\| move\.dueOn <= move\.storedDueOn\) continue;/,
    "only a LATER deadline is ever written back",
  );
  assert.match(
    saver,
    /\.eq\("status", "open"\)\s*\.lt\("answer_due_on", move\.dueOn\)/,
    "saving a moved deadline must never bring one forward, nor touch a week already settled",
  );
  // All three surfaces save the deadline they show, each on its own line below: the employee's page,
  // the answer they file, and the daily job.
  for (const [surface, slice] of [["the employee's page", mine], ["the answer path", answerPath], ["the daily job", sweep]] as const) {
    assert.match(slice, /saveLaterAnswerDeadlines\(/, surface + " saves the later deadline it worked out");
  }
  assert.match(
    mine,
    /for \(const id of unsaved\.keys\(\)\) deadlines\.delete\(id\);/,
    "a deadline the page could not save is not shown either — the stored one stands",
  );

  const review = service.slice(service.indexOf("export async function reviewDispute"), service.indexOf("export type SweepResult"));
  assert.match(review, /if \(digest\.dryRun\) throw conflictError/, "a dispute in a trial-run week cannot be decided");
  assert.match(review, /assertNotOwnPay\(digest\.employeeHrId, input\.reviewerHrId, input\.reviewerRole\)/, "a named reviewer never rules on their own day");
  assert.match(
    review,
    /if \(balance\.refusal === "balance_unreadable"\) \{\s*throw conflictError/,
    "a balance that failed to read must refuse the ruling, never move the day to salary for good",
  );
  assert.match(review, /disputeSalaryFallbackText\(balance\.refusal\)/, "the salary fallback must record its real cause");

  // The employee is told how their dispute was decided (owner, 2026-09-15 — "Yes, in-app and Telegram").
  {
    assert.equal(
      [...review.matchAll(/notifyAttendanceDisputeDecided\(\{/g)].length,
      2,
      "both an accepted and a rejected dispute must tell the employee",
    );
    const settles = [...review.matchAll(/await settleLine\(\{/g)].map((match) => Number(match.index));
    const notices = [...review.matchAll(/notifyAttendanceDisputeDecided\(\{/g)].map((match) => Number(match.index));
    assert.equal(settles.length, 2, "one settle per outcome");
    const [acceptedSettle = -1, rejectedSettle = -1] = settles;
    const [acceptedNotice = -1, rejectedNotice = -1] = notices;
    assert.ok(
      acceptedSettle < acceptedNotice && acceptedNotice < rejectedSettle && rejectedSettle < rejectedNotice,
      "the employee is told only after the decision is saved",
    );
    assert.match(review, /balanceRefusal = balance\.refusal;/, "the notice must be given the real cause when balance fell to salary");
    assert.match(
      review,
      /return \{ appliedMethod: method, balanceRefusal, notified \};/,
      "the reviewer's screen must learn the cause and whether the employee was told",
    );

    const notify = readFileSync("src/lib/attendance/digest-notify.ts", "utf8");
    assert.ok(notify.includes("export async function notifyAttendanceDisputeDecided"), "the decision notice must exist");
    const decidedNotice = notify.slice(notify.indexOf("export async function notifyAttendanceDisputeDecided"));
    assert.match(decidedNotice, /eventType: "dispute_decided",/, "the decision notice is its own event, never a second release notice");
    assert.match(
      decidedNotice,
      /idempotencyKey: `attendance_digest:line:\$\{input\.lineId\}:dispute_decided`,/,
      "one decision notice per day, so a retried request cannot tell the employee twice",
    );
    assert.match(decidedNotice, /\} catch \(error\) \{[\s\S]*return false;/, "a notice that fails must never undo a saved decision");

    const inbox = readFileSync("src/components/attendance/dispute-review-inbox.tsx", "utf8");
    assert.match(inbox, /if \(payload\?\.notified === false\) \{/, "the reviewer is told when the employee could not be");
    assert.match(inbox, /disputeSalaryFallbackText\(payload\?\.balanceRefusal \?\? null\)/, "the reviewer sees the real cause of a salary fallback");
  }

  const cronWindow = readFileSync("app/api/cron/attendance-weekly-digest/route.ts", "utf8");
  assert.match(
    cronWindow,
    /for \(const key of \[previousMonthKey\(previous\), previous, monthKey\]\)/,
    "the bridge must look back three months: a late dispute can be decided well into the month after next",
  );

  const deductions = readFileSync("src/lib/deductions/service.ts", "utf8");
  const record = deductions.slice(deductions.indexOf("export async function recordDecision"));
  const approvalGuard = /if \(input\.decisionStatus === "Approved for Payroll" && candidateRow\.category === "fingerprint"\) \{[^}]*\};\s*await assertDayNotPaidFromAnnualBalance\(reviewedDay\);\s*await assertDayNotClearedInAttendanceReview\(reviewedDay\);/;
  assert.match(
    record,
    approvalGuard,
    "approving a fingerprint deduction must first check the day was not paid from annual balance, removed, upheld or still disputed",
  );
  for (const guard of ["assertDayNotPaidFromAnnualBalance(", "assertDayNotClearedInAttendanceReview("]) {
    assert.ok(record.indexOf(guard) > 0 && record.indexOf(guard) < record.indexOf(".upsert(payload"), `${guard} must run before the decision is written`);
  }
  const cleared = deductions.slice(
    deductions.indexOf("async function assertDayNotClearedInAttendanceReview"),
    deductions.indexOf("export async function recordDecision"),
  );
  assert.match(cleared, /\.in\("action", \["removed", "dispute_upheld"\]\)/, "a removed or upheld day must refuse approval");
  assert.match(cleared, /\.eq\("action", "disputed"\)/, "a day still under dispute must refuse approval");
  assert.match(
    cleared,
    /\.eq\("attendance_digest_lines\.attendance_weekly_digests\.dry_run", false\)/,
    "a trial-run week's removal never reaches payroll, so it must not block the real deduction",
  );
  assert.match(cleared, /\.eq\("attendance_weekly_digests\.dry_run", false\)/, "…nor a trial-run week's dispute");
  assert.match(cleared, /if \(read\.error && !isMissingTableError\(read\.error\)\) \{\s*throw/, "the check fails CLOSED on a read error");
  // A day still pending in a real week cannot be approved either: waiting for release (owner, 2026-09-15 —
  // "Block until released"), or released and not answered yet (owner, 2026-09-16 — "Block until answered").
  const undecidedStatuses = /\.eq\("action", "pending"\)[\s\S]*?\.in\("attendance_weekly_digests\.status", \[([^\]]*)\]\)/.exec(cleared)?.[1] ?? "";
  assert.match(
    undecidedStatuses,
    /"awaiting_release"/,
    "a pending day of a week still waiting for release must refuse approval — the employee has not been asked",
  );
  assert.match(
    undecidedStatuses,
    /"open"/,
    "a pending day of a released week the employee has not answered yet must refuse approval — they can still choose annual balance or dispute",
  );
  assert.match(cleared, /for \(const read of \[cleared, disputed, undecided\]\)/, "that read fails CLOSED too");
  assert.match(cleared, /if \(undecidedRows\.length\) \{/, "a hit refuses the approval");
  assert.match(
    cleared,
    /=== "awaiting_release"\)/,
    "a week waiting for release is told apart from one released and not answered, so the refusal names the right next step",
  );
  assert.match(cleared, /Release that week on the Weekly Attendance Review page first/, "and says what to do instead");
  assert.match(
    cleared,
    /Wait for their answer or for the answer deadline to settle it/,
    "…and, for a released week, to wait for the employee's answer or the deadline",
  );

  // The Employee Day-by-Day Report WRITES before it calls recordDecision, so it runs the same two
  // checks itself first — a refusal must not leave a raised candidate behind.
  const dayReport = readFileSync("src/lib/attendance/employee-day-report.ts", "utf8");
  assert.match(
    dayReport,
    /if \(input\.decisionStatus === "Approved for Payroll"\) \{\s*await assertFingerprintDayApprovable\(\{ employeeHrId: hrId, dates: \[input\.dateIso\] \}\);/,
    "the day-by-day report asks the weekly attendance review before it writes anything",
  );
  assert.ok(
    dayReport.includes("assertFingerprintDayApprovable(") &&
      dayReport.indexOf("assertFingerprintDayApprovable(") < dayReport.indexOf("insertCandidateDrafts("),
    "…before the day's candidate is created, not after",
  );
  assert.match(
    deductions,
    /export async function assertFingerprintDayApprovable\([\s\S]*?await assertDayNotPaidFromAnnualBalance\(input\);\s*await assertDayNotClearedInAttendanceReview\(input\);/,
    "and that one export runs BOTH of the checks recordDecision runs",
  );

  // A leaver is never notified, so their unanswered day is HR's to decide (owner, 2026-09-16 — "HR decides").
  assert.match(
    cleared,
    /attendance_weekly_digests!inner\(employee_hr_id,status,dry_run,notified_at\)/,
    "the undecided read asks for whether that week's notice was ever sent",
  );
  assert.match(
    cleared,
    /const untold = allUndecidedRows\.filter\(\(row\) => weekStatus\(row\) === "open" && !weekNotified\(row\)\);/,
    "a released week whose notice reached nobody is told apart from one the employee was really asked about",
  );
  assert.match(
    cleared,
    /untold\.length && \(await employeeHasLeft\(hrId\)\)/,
    "…and it stops blocking the final payroll only for somebody who has LEFT — anyone still here can still answer",
  );
  assert.match(
    deductions,
    /async function employeeHasLeft\([\s\S]*?if \(error \|\| !data\) return false;/,
    "an employee record that could not be read counts as still here, so the block stays",
  );
  assert.match(deductions, /return isTerminalEmploymentStatus\(/, "…and who has left is the auth module's own test, never a second list of statuses");

  const bridge = readFileSync("src/lib/attendance/digest-bridge.ts", "utf8");
  assert.match(bridge, /try \{\s*await recordDecision\(/, "one locked candidate must not abort every other day in the month");
  assert.match(
    bridge,
    /if \(decision\.status === "Do Not Take Action" && currentStatus === "Approved for Payroll"\) \{/,
    "a day the review cleared that payroll already approved must alert every run",
  );
  assert.match(bridge, /if \(decision\.status === "Do Not Take Action"\) result\.alerts\.push\(line\);/, "a cleared day that could not be closed is money: it alerts, not warns");
  assert.match(bridge, /\.range\(from, from \+ PAGE - 1\);[\s\S]*if \(page\.length < PAGE\) break;/, "settlements are read page by page, so skipped rows cannot hide newer answers");

  // --- Choosing the days (owner, 2026-09-15 — "I want full control") -------------------------------
  // The week picker: every closed week of the current payroll month. Cycle 2026-09 runs 24 Aug–23 Sep.
  {
    const sep15 = closedWeeksOfCurrentCycle("2026-09-15", 24);
    assert.equal(sep15?.cycle.cycleKey, "2026-09");
    assert.deepEqual(sep15?.weeks.map((week) => week.index), [1, 2, 3], "on the 15th weeks 1-3 are closed; week 4 is still running and cannot be judged");
    const sep24 = closedWeeksOfCurrentCycle("2026-09-24", 24);
    assert.equal(sep24?.cycle.cycleKey, "2026-09", "on the 24th the month that just ended is still the one to review");
    assert.deepEqual(sep24?.weeks.map((week) => week.index), [1, 2, 3, 4]);
    const oct1 = closedWeeksOfCurrentCycle("2026-10-01", 24);
    assert.equal(oct1?.cycle.cycleKey, "2026-10");
    assert.deepEqual(oct1?.weeks.map((week) => week.index), [1], "once the new month's week 1 closes, the previous month drops out of the picker");
  }

  assert.equal(reviewWeekStage([]), "not_built");
  assert.equal(reviewWeekStage([{ status: "awaiting_release", dryRun: true }]), "trial", "a trial-run week is never releasable");
  assert.equal(
    reviewWeekStage([{ status: "awaiting_release", dryRun: true }, { status: "awaiting_release", dryRun: false }]),
    "awaiting_release",
    "one real employee waiting makes the week releasable",
  );
  assert.equal(reviewWeekStage([{ status: "open", dryRun: false }, { status: "void", dryRun: false }]), "released");
  assert.equal(reviewWeekStage([{ status: "settled", dryRun: false }]), "released");
  assert.equal(reviewWeekStage([{ status: "void", dryRun: false }]), "closed", "a week released with nothing ticked deducted nothing");

  {
    const options = [
      { stage: "released" as const, weekStart: "2026-09-07" },
      { stage: "awaiting_release" as const, weekStart: "2026-08-31" },
      { stage: "not_built" as const, weekStart: "2026-09-14" },
    ];
    assert.equal(pickDefaultReviewWeek(options)?.weekStart, "2026-08-31", "the page opens on the week waiting for his release");
    assert.equal(pickDefaultReviewWeek(options.filter((option) => option.stage !== "awaiting_release"))?.weekStart, "2026-09-07", "…else the newest released week");
    assert.equal(pickDefaultReviewWeek([{ stage: "not_built" as const, weekStart: "2026-09-14" }])?.weekStart, "2026-09-14");
    assert.equal(pickDefaultReviewWeek([]), null);
  }

  assert.deepEqual(parseMarkedDays("0.5"), { days: 0.5, error: null });
  assert.deepEqual(parseMarkedDays(1.23456), { days: 1.235, error: null }, "days are kept to 3 decimals, as the database stores them");
  assert.equal(parseMarkedDays(MAX_MARKED_DAYS).days, 3, "3 days is allowed — he may raise a day");
  assert.match(parseMarkedDays(3.001).error ?? "", /at most 3 days/, "more than 3 is a typo guard: 30 instead of 0.3");
  assert.match(parseMarkedDays(0).error ?? "", /Untick it/, "0 days is an untick, not a ticked day");
  for (const blank of ["", "abc", null, undefined]) {
    assert.match(parseMarkedDays(blank).error ?? "", /Enter the number/, `${String(blank)} is not a number of days`);
  }

  assert.equal(payrollDaysForSettledLine({ deductionDays: 0.5, detectedDays: 0.5 }), undefined, "an unchanged day leaves payroll's own figure alone");
  assert.equal(payrollDaysForSettledLine({ deductionDays: 0.25, detectedDays: 0.5 }), 0.25, "a lowered day reaches payroll");
  assert.equal(payrollDaysForSettledLine({ deductionDays: 2, detectedDays: 0.5 }), 2, "a RAISED day reaches payroll too — 'Raise too'");
  assert.equal(payrollDaysForSettledLine({ deductionDays: 1, detectedDays: null }), undefined, "a line built before detected days existed is left alone");

  assert.equal(editedDaysApplyToCandidate({ detectedDays: 1, candidateRawValue: 1 }), true, "the same detected days: his figure replaces payroll's");
  assert.equal(editedDaysApplyToCandidate({ detectedDays: 0.125, candidateRawValue: 0.13 }), true, "the deductions table keeps 2 decimals, so 0.125 stored as 0.13 is the same day");
  assert.equal(
    editedDaysApplyToCandidate({ detectedDays: 1, candidateRawValue: 0.25 }),
    false,
    "month-end detected different days: lowering 1 to 0.5 against a 0.25 base would charge MORE, so it must go to a person",
  );
  assert.equal(editedDaysApplyToCandidate({ detectedDays: 1, candidateRawValue: Number.NaN }), false, "an unreadable month-end figure never takes his edit");
  assert.match(
    bridge,
    /if \(setDays !== undefined && !editedDaysApplyToCandidate\(\{ detectedDays: detectedDaysByLine\.get\(settlement\.digest_line_id\) \?\? Number\.NaN, candidateRawValue: candidateRaw \}\)\) \{\s*result\.alerts\.push\(/,
    "a changed day whose month-end deduction detected different days must alert and stay Pending, never be charged from another base",
  );
  assert.match(bridge, /\.select\("id,unit,raw_value"\)/, "the bridge must read the month-end deduction's detected days to compare them");

  assert.match(
    bridge,
    /decision\.status === "Approved for Payroll" && candidateUnit === "days" \? payrollDaysByLine\.get\(settlement\.digest_line_id\)/,
    "only an approved day-unit deduction takes the Super Admin's figure",
  );
  assert.match(
    bridge,
    /\.\.\.\(setDays === undefined \? \{\} : \{ appliedValue: setDays, allowAboveDetected: true \}\)/,
    "a day whose days the Super Admin changed must reach payroll at his figure, raised or lowered",
  );
  assert.match(
    record,
    /input\.appliedValue === undefined && appliedValueInput != null && appliedValueInput > Number\(candidateRow\.raw_value\)/,
    "a raised figure already on the decision must carry forward on a later Decide instead of throwing",
  );
  assert.match(service, /detected_days: line\.deductionDays,/, "a built week must keep the detected days apart from the figure he may change");

  // --- A week is built whole or not at all ----------------------------------------------------------
  const build = service.slice(service.indexOf("async function generateDigestsForWeek"), service.indexOf("async function undoPartialBuild"));
  assert.ok(build.length > 0 && build.length < service.length / 4, "the build slice must find both of its markers");
  assert.match(
    build,
    /\.code === "23505"\) \{\s*skippedExisting \+= 1;\s*continue;/,
    "another build of the same week getting there first is skipped, not a failure that undoes this one",
  );
  assert.match(build, /await undoPartialBuild\(\{/, "a build that fails removes what it created, so the week is never left half-built");
  assert.match(build, /throw buildError;/, "…and still fails loudly");
  const undoStart = service.indexOf("async function undoPartialBuild");
  const undo = service.slice(undoStart, service.indexOf("\n}\n", undoStart));
  assert.match(undo, /\.eq\("status", "awaiting_release"\)/, "the undo only deletes a digest still waiting for release");
  assert.match(undo, /\.is\("released_at", null\)/, "…and never one a Release click already reached");

  // --- Only one build of a week runs at a time (risk review, 2026-09-16) ------------------------------
  // The daily job and a Build this week click on the same week would otherwise interleave: the click
  // skips the employees the job has just created, the job fails and undoes them, and nobody builds
  // them again.
  {
    const events: string[] = [];
    let finishFirst: () => void = () => undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const first = withWeekBuildLock("2026-09", 2, async () => {
      events.push("first started");
      await firstMayFinish;
      events.push("first finished");
      throw new Error("the first build failed");
    });
    const second = withWeekBuildLock("2026-09", 2, async () => {
      events.push("second started");
      return "second built";
    });
    const otherWeek = withWeekBuildLock("2026-09", 3, async () => {
      events.push("other week started");
      return "other week built";
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(events.includes("other week started"), "a build of another week never waits for this one");
    assert.ok(
      events.includes("first started") && !events.includes("second started"),
      "a second build of the same week waits while the first is still running",
    );
    finishFirst();
    const firstOutcome = await first.then(
      () => "finished without an error",
      (error: Error) => error.message,
    );
    assert.equal(firstOutcome, "the first build failed", "the failed build's own error still reaches the caller that started it");
    const secondOutcome = await second.then(
      (value) => value,
      (error: Error) => `rejected: ${error.message}`,
    );
    assert.equal(secondOutcome, "second built", "a failed build releases the lock, so the next build of that week still runs");
    assert.ok(
      events.indexOf("second started") > events.indexOf("first finished"),
      "the second build starts only after the first has finished",
    );
    assert.equal(await otherWeek, "other week built");
  }
  assert.match(
    service,
    /return withWeekBuildLock\(cycle\.cycleKey, week\.index, \(\) => generateDigestsForWeek\(/,
    "the daily job builds a week only while holding that week's build lock",
  );
  const releaseStart = service.indexOf("export async function releaseWeek");
  const releaseGate = service.slice(releaseStart, service.indexOf("\n}\n", releaseStart));
  assert.match(
    releaseGate,
    /return withWeekBuildLock\(input\.cycleKey, input\.weekIndex, \(\) => releaseBuiltWeek\(input\)\);/,
    "a release takes the week's build lock too, so it can never open half a week a build is still writing",
  );
  assert.ok(
    releaseGate.includes("assertCanManageWeeklyReview(input.actorRole)") &&
      releaseGate.indexOf("assertCanManageWeeklyReview(input.actorRole)") < releaseGate.indexOf("withWeekBuildLock("),
    "…and the role check still refuses before any lock is taken",
  );

  const buildClickStart = service.indexOf("export async function buildReviewWeek");
  const buildClick = service.slice(buildClickStart, service.indexOf("\n}\n", buildClickStart));
  const lockAt = buildClick.indexOf("withWeekBuildLock(");
  assert.ok(
    lockAt > 0 && lockAt < buildClick.indexOf("This week has already been built."),
    "a Build click checks whether the week is built only inside the lock, after any build of it still running has finished",
  );
}
