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
  MAX_SEEN_RELEASE_LINES,
  editedDaysApplyToCandidate,
  parseMarkedDays,
  parseReleaseDigestId,
  parseSeenReleaseLines,
  payrollDaysForSettledLine,
  payrollDecisionBlocksBalance,
  pickDefaultReviewWeek,
  releaseNoticeRange,
  noticeReachedEmployee,
  noticeRecipientFactsFrom,
  releaseNoticeReached,
  releaseScope,
  reviewWeekStage,
  staleReleaseLines,
} from "../src/lib/attendance/digest-rules.ts";
import { refreshableReviewWeek, reviewWeeksToSync, startedReviewWeeks } from "../src/lib/attendance/digest-weeks.ts";
import { withWeekBuildLock } from "../src/lib/attendance/week-build-lock.ts";
import { buildAttendanceCalendarContext } from "../src/lib/attendance/working-days.ts";

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

  // Owner, 2026-09-17 — "Only a real channel" and "HR decides, never automatic": an employee counts as
  // told only when email or Telegram went out, or the in-app notice reached someone who has signed in
  // before; and a leaver is never counted as told, so their days wait for HR.
  {
    const signedIn = { hasSignedIn: true, stillEmployed: true };
    const neverSignedIn = { hasSignedIn: false, stillEmployed: true };
    const leaver = { hasSignedIn: true, stillEmployed: false };

    assert.equal(releaseNoticeReached([{ channel: "email", status: "sent" }], neverSignedIn), true, "an email that went out tells the employee");
    assert.equal(releaseNoticeReached([{ channel: "telegram", status: "sent" }], neverSignedIn), true, "so does a Telegram message");

    // Only what went out counts. A hold can never go out when there is no linked Telegram or no
    // address, and the outbox files permanent email blocks under "retry" — so none of these starts
    // the clock (risk review, 2026-09-17).
    assert.equal(
      releaseNoticeReached([{ channel: "in_app", status: "skipped" }, { channel: "telegram", status: "pending" }], neverSignedIn),
      false,
      "a Telegram message held for quiet hours has not gone out yet, and may never",
    );
    assert.equal(releaseNoticeReached([{ channel: "email", status: "pending" }], neverSignedIn), false, "an email held for quiet hours has not gone out yet");
    assert.equal(releaseNoticeReached([{ channel: "telegram", status: "retrying" }], neverSignedIn), false, "a Telegram message waiting for a retry has not gone out");
    assert.equal(
      releaseNoticeReached([{ channel: "in_app", status: "sent" }, { channel: "email", status: "sent", queuedForRetry: true }], neverSignedIn),
      false,
      "an email handed to the outbox to retry did not go out — it may be a permanent block recorded as a retry",
    );
    assert.equal(
      releaseNoticeReached([{ channel: "email", status: "sent", queuedForRetry: true }, { channel: "telegram", status: "sent" }], neverSignedIn),
      true,
      "another channel that did go out still tells them",
    );
    assert.equal(
      releaseNoticeReached([{ channel: "email", status: "pending" }, { channel: "in_app", status: "sent" }], signedIn),
      true,
      "during quiet hours the in-app notice still tells someone who uses the app",
    );

    assert.equal(releaseNoticeReached([{ channel: "in_app", status: "sent" }], signedIn), true, "the app tells someone who uses it");
    assert.equal(
      releaseNoticeReached([{ channel: "in_app", status: "sent" }], neverSignedIn),
      false,
      "an in-app notice nobody can open tells nobody — the days wait for HR, never deducted for going unanswered",
    );

    for (const deliveries of [
      [{ channel: "email", status: "sent" }],
      [{ channel: "telegram", status: "sent" }],
      [{ channel: "in_app", status: "sent" }, { channel: "email", status: "sent" }, { channel: "telegram", status: "sent" }],
    ]) {
      assert.equal(
        releaseNoticeReached(deliveries, leaver),
        false,
        `a leaver is never counted as told, even when ${deliveries.map((d) => d.channel).join(" and ")} reached them — HR decides their days in the final pay`,
      );
    }

    assert.equal(
      releaseNoticeReached([{ channel: "in_app", status: "skipped" }, { channel: "email", status: "skipped" }, { channel: "telegram", status: "failed" }], signedIn),
      false,
      "a notice every channel skipped or failed told nobody, and must not start the clock",
    );
    assert.equal(releaseNoticeReached([], signedIn), false, "no delivery at all is not a notice");
    assert.equal(releaseNoticeReached([{ channel: "push", status: "sent" }], neverSignedIn), false, "push is not one of this notice's channels");

    // The dispute decision deducts nothing on the answer, so a reached leaver counts there.
    assert.equal(noticeReachedEmployee([{ channel: "email", status: "sent" }], { hasSignedIn: false }), true);
    assert.equal(noticeReachedEmployee([{ channel: "in_app", status: "sent" }], { hasSignedIn: false }), false);
    assert.equal(noticeReachedEmployee([{ channel: "in_app", status: "sent" }], { hasSignedIn: true }), true);
    assert.equal(noticeReachedEmployee([{ channel: "email", status: "sent", queuedForRetry: true }], { hasSignedIn: false }), false);
    assert.equal(noticeReachedEmployee([{ channel: "telegram", status: "pending" }], { hasSignedIn: true }), false);
  }

  {
    // "Signed in" needs BOTH an active login and a recorded sign-in; "still works here" needs BOTH an
    // employee row and a status that is not a leaver's.
    const facts = (onEmployeeFile: boolean, terminalStatus: boolean, activeLogin: boolean, hasSession: boolean) =>
      noticeRecipientFactsFrom({ onEmployeeFile, terminalStatus, activeLogin, hasSession });
    assert.deepEqual(facts(true, false, true, true), { hasSignedIn: true, stillEmployed: true });
    assert.equal(facts(true, false, true, false).hasSignedIn, false, "an active login that never signed in has not seen the app");
    assert.equal(facts(true, false, false, true).hasSignedIn, false, "a deactivated login cannot open the app, whatever it did before");
    assert.equal(facts(true, false, false, false).hasSignedIn, false);
    assert.equal(facts(true, true, true, true).stillEmployed, false, "a leaver's status is a leaver");
    assert.equal(facts(false, false, true, true).stillEmployed, false, "no employee row is no proof they still work here");
  }

  {
    // The facts behind "signed in" and "still works here" are read from the tables that hold them.
    const notify = readFileSync("src/lib/attendance/digest-notify.ts", "utf8");
    assert.match(notify, /from\("app_sessions"\)/, "a sign-in is read from app_sessions, which every real password or biometric sign-in writes");
    assert.match(notify, /from\("app_auth_users"\)[^\n]*\.eq\("is_active", true\)/, "only an active login counts");
    assert.match(
      notify,
      /return noticeRecipientFactsFrom\(\{\s*onEmployeeFile: Boolean\(employee\.data\),\s*terminalStatus: isTerminalEmploymentStatus\(status\),\s*activeLogin: \(login\.data \?\? \[\]\)\.length > 0,\s*hasSession: \(session\.data \?\? \[\]\)\.length > 0,\s*\}\);/,
      "the facts come from the employee row, payroll's leaver rule, the active login and its sessions",
    );
    assert.match(notify, /return releaseNoticeReached\(result\.deliveries, await loadNoticeRecipientFacts\(input\.employeeHrId\)\);/, "the release notice applies the leaver rule");
    assert.match(notify, /return noticeReachedEmployee\(result\.deliveries, await loadNoticeRecipientFacts\(input\.employeeHrId\)\);/, "the dispute decision deducts nothing, so it does not");
    assert.match(notify, /catch \(error\) \{\s*logError\("Weekly attendance release notification failed"[\s\S]*?return false;/, "a failed read counts as not told");

    // The notification system has to say when an email was only handed to the outbox.
    const system = readFileSync("src/lib/notifications/system.ts", "utf8");
    assert.match(
      system,
      /const handedOffToOutbox = result\.skipped && result\.reason\.startsWith\("Queued for retry:"\);[\s\S]{0,1200}?deliveries\.push\(\{ channel, error, idempotencyKey, \.\.\.\(handedOffToOutbox \? \{ queuedForRetry: true \} : \{\}\), status \}\);/,
      "an email handed to the outbox is reported as queued for retry, so it is not counted as told",
    );
  }

  // --- Releasing while the week runs: only the days the page showed ----------------------------
  // Owner, 2026-09-17: "Show live, release any time". The daily job keeps adding days to a waiting week,
  // so a Release click must not clear, unticked, a day that arrived after the page loaded.
  assert.deepEqual(
    parseSeenReleaseLines([{ id: 7, days: 0.5 }, { id: "8", days: "0.25" }]),
    { lines: [{ id: 7, days: 0.5 }, { id: 8, days: 0.25 }], error: null },
  );
  assert.deepEqual(parseSeenReleaseLines([]), { lines: [], error: null }, "a page with nothing waiting sends an empty list");
  for (const notAList of [undefined, null, "7", { id: 7, days: 0.5 }]) {
    assert.match(
      parseSeenReleaseLines(notAList).error ?? "",
      /the days you saw were not sent/,
      `${JSON.stringify(notAList)} is not a list of days, so nothing may be released`,
    );
  }
  for (const unreadable of [[{ id: 0, days: 0.5 }], [{ id: 1.5, days: 0.5 }], [{ id: 7 }], [{ id: 7, days: -1 }], [{ id: 7, days: "half" }], [null]]) {
    assert.match(
      parseSeenReleaseLines(unreadable).error ?? "",
      /a day you saw could not be read/,
      `${JSON.stringify(unreadable)} is refused, never skipped — a skipped day is one the release would treat as unseen`,
    );
  }
  assert.match(
    parseSeenReleaseLines(Array.from({ length: MAX_SEEN_RELEASE_LINES + 1 }, (_, index) => ({ id: index + 1, days: 1 }))).error ?? "",
    /Too many days/,
  );

  {
    const waitingNow = [
      { id: 1, deductionDays: 0.5 },
      { id: 2, deductionDays: 0.25 },
      { id: 3, deductionDays: 0.125 },
    ];
    assert.deepEqual(
      staleReleaseLines(waitingNow, [{ id: 1, days: 0.5 }, { id: 2, days: 0.25 }, { id: 3, days: 0.125 }]),
      [],
      "every waiting day as the page showed it: the release goes ahead",
    );
    assert.deepEqual(
      staleReleaseLines(waitingNow, [{ id: 1, days: 0.5 }, { id: 2, days: 0.25 }]),
      [3],
      "a day the daily job added after the page loaded stops the release — it would be cleared without being seen",
    );
    assert.deepEqual(
      staleReleaseLines(waitingNow, [{ id: 1, days: 0.5 }, { id: 2, days: 0.5 }, { id: 3, days: 0.125 }]),
      [2],
      "a day whose figure changed since the page loaded stops it too",
    );
    assert.deepEqual(
      staleReleaseLines(waitingNow, [{ id: 1, days: 0.5 }, { id: 2, days: 0.25 }, { id: 3, days: 0.1254 }]),
      [],
      "days are compared at 3 decimals, as the database stores them",
    );
    assert.deepEqual(
      staleReleaseLines([{ id: 1, deductionDays: 0.5 }], [{ id: 1, days: 0.5 }, { id: 9, days: 1 }]),
      [],
      "a day the page showed that a refresh has since taken off is simply not released",
    );
  }

  assert.deepEqual(
    releaseNoticeRange([{ workDate: "2026-09-16" }, { workDate: "2026-09-14" }, { workDate: "2026-09-15" }], { weekStart: "2026-09-14", weekEnd: "2026-09-23" }),
    { weekStart: "2026-09-14", weekEnd: "2026-09-16" },
    "a release in the middle of the week names the days asked about, not days still to come",
  );
  assert.deepEqual(
    releaseNoticeRange([{ workDate: "2026-09-21" }], { weekStart: "2026-09-14", weekEnd: "2026-09-23" }),
    { weekStart: "2026-09-21", weekEnd: "2026-09-21" },
    "a second release names only its own days, never the days the first release already asked about",
  );
  assert.deepEqual(
    releaseNoticeRange([], { weekStart: "2026-09-14", weekEnd: "2026-09-23" }),
    { weekStart: "2026-09-14", weekEnd: "2026-09-23" },
  );

  // --- One employee at a time (owner, 2026-09-17 — "every row has a release beside it … so I can release
  // one employee and after release another") ----------------------------------------------------------
  assert.deepEqual(parseReleaseDigestId(undefined), { digestId: null, error: null }, "no employee picked means the whole week");
  assert.deepEqual(parseReleaseDigestId(null), { digestId: null, error: null });
  assert.deepEqual(parseReleaseDigestId(12), { digestId: 12, error: null });
  assert.deepEqual(parseReleaseDigestId("12"), { digestId: 12, error: null });
  for (const unreadable of [0, -3, 1.5, "abc", "", true, {}, [12], Number.NaN]) {
    assert.match(
      parseReleaseDigestId(unreadable).error ?? "",
      /could not be read/,
      `${String(unreadable)} must be refused, never read as "everyone": that would clear and tell people nobody picked`,
    );
  }
  {
    const waiting = [{ id: 7 }, { id: 8 }, { id: 9 }];
    assert.deepEqual(releaseScope(waiting, null).map((digest) => digest.id), [7, 8, 9], "the week's Release covers everyone waiting");
    assert.deepEqual(
      releaseScope(waiting, 8).map((digest) => digest.id),
      [8],
      "an employee's Release covers that employee only: the others are not cleared or told, and keep waiting",
    );
    assert.deepEqual(releaseScope(waiting, 42), [], "an employee no longer waiting releases nobody, never the whole week");
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
  assert.match(notice.message, /has 2 days with a deduction\.\n\nFor each day, choose/, "the notice keeps its paragraphs");

  // One day reads as that day (owner, 2026-09-17). 2026-09-09 is a Wednesday.
  {
    const oneDay = buildWeekReleasedMessage({ weekStart: "2026-09-09", weekEnd: "2026-09-09", dayCount: 1, answerDueOn: "2026-09-11" });
    assert.equal(oneDay.title, "Attendance review — Wednesday 9 September", "a single day's title names that day, never \"9 Sept to 9 Sept\"");
    assert.doesNotMatch(`${oneDay.title}\n${oneDay.message}`, / to \d/, "no range when there is one day");
    assert.match(oneDay.message, /^Your attendance on Wednesday 9 September has a deduction\.\n\n/);
    assert.match(oneDay.message, /salary or from your annual vacation balance/);
    assert.match(oneDay.message, /dispute/);
    assert.match(oneDay.message, /\n\nPlease answer by the end of Friday 11 September\. Any day not answered by then is deducted from salary\.$/);
  }

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

  // --- Choosing days, refreshing a week and releasing it: the Super Admin only -------------------
  assert.equal(canManageWeeklyReview({ role: "Super Admin" }), true, "the Super Admin ticks days, refreshes and releases");
  for (const role of ["HR Advisory", "HR Operations", "CEO", "Employee", null, undefined]) {
    assert.equal(canManageWeeklyReview({ role }), false, `${String(role)} must not tick a day, refresh or release a week, even as a named dispute reviewer`);
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
  assert.match(
    readFileSync("app/api/attendance/weekly-review/release/route.ts", "utf8"),
    /digestId: payload\.digestId,/,
    "the release route hands the picked employee to the service, which releases that employee only",
  );
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
  assert.match(reviewPage, /const releasable =\s+canManage && /, "a dispute reviewer must not see the week's Release");
  assert.match(reviewPage, /const canRefresh = canManage && /, "a dispute reviewer must not see Refresh");
  assert.match(
    reviewPage,
    /seenLines: seenLines\(current\)/,
    "Release sends the days the page shows, so the server can refuse a day that arrived after it loaded",
  );
  assert.match(
    reviewPage,
    /digestId: employee\.digestId,\s*seenLines: employeeSeenLines\(employee\),/,
    "an employee's Release names that employee and sends only their days, so nobody else is cleared or told",
  );
  assert.match(
    reviewPage,
    /return canManage && current\.stage === "awaiting_release" && waitingForRelease\(employee\);/,
    "a dispute reviewer must not see an employee's Release, and a released or trial-run employee has none",
  );
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
  {
    const scopeAt = release.indexOf("releaseScope(");
    assert.ok(
      scopeAt > 0 && scopeAt < release.indexOf("loadLines(") && scopeAt < release.indexOf('.rpc("phx_attendance_release_digest"'),
      "one employee's release narrows to that employee before any day is checked, cleared or told",
    );
    assert.match(
      release,
      /if \(!digests\.length\) throw conflictError\("This employee is no longer waiting for release\. Reload the page\."\);/,
      "an employee who is no longer waiting releases nobody",
    );
  }
  {
    const staleCheckAt = release.indexOf("staleReleaseLines(pending, input.seenLines)");
    assert.ok(
      staleCheckAt > 0 && staleCheckAt < release.indexOf('.rpc("phx_attendance_release_digest"'),
      "every employee's days are checked against the page before anyone is released, so a stale page releases nobody rather than some",
    );
  }
  assert.match(
    release,
    /p_seen_line_ids: seenIds,\s*p_seen_days: seenDays,/,
    "…and the database function checks them again under the week's row lock",
  );
  assert.match(
    release,
    /const range = releaseNoticeRange\(asked, digest\);/,
    "the notice names the days asked about, so a second release does not repeat the first one's dates",
  );

  const cron = readFileSync("app/api/cron/attendance-weekly-digest/route.ts", "utf8");
  assert.doesNotMatch(cron, /notifyAttendanceWeekReleased|releaseWeek/, "the daily job must never release or notify — only the owner's click does");
  assert.match(
    cron,
    /const failed = Boolean\(bridgeError \|\| deadlineError \|\| deadlineFailures > 0 \|\| balanceAlerts\.length > 0 \|\| syncFailures > 0\);/,
    "a day the sweep could not settle, money taken twice, or a week that could not be brought up to date must make the daily job fail loudly",
  );
  assert.match(cron, /await syncOpenReviewWeeks\(\{/, "the daily job brings every started week up to date, the running one included");
  assert.match(
    readFileSync(".github/workflows/attendance-weekly-digest.yml", "utf8"),
    /- cron: "23 10 \* \* \*"/,
    "an afternoon run picks up yesterday's punches, which reach the fingerprint table after the morning run",
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

  // Live weeks, released in rounds (owner, 2026-09-17 — "Show live, release any time").
  const live = readFileSync("supabase/migrations/20260917120000_weekly_review_live_weeks.sql", "utf8");
  const syncFn = live.slice(
    live.indexOf("create or replace function public.phx_attendance_sync_digest_days"),
    live.indexOf("revoke execute on function public.phx_attendance_sync_digest_days"),
  );
  assert.ok(syncFn.length > 0 && syncFn.length < live.length / 2, "the sync function slice must find both of its markers");
  assert.match(
    syncFn,
    /pg_advisory_xact_lock\(hashtextextended\('attendance_digest_sync:'/,
    "one sync of one employee-week at a time, whichever server runs it",
  );
  assert.match(
    syncFn,
    /and status = 'awaiting_release'\s+and dry_run = p_dry_run\s+order by id\s+limit 1\s+for update;/,
    "the sync locks the waiting digest the way a tick and a release lock it",
  );
  assert.match(syncFn, /if v_line\.action <> 'pending' then\s+continue;/, "a day already answered or cleared is never refreshed");
  assert.match(
    syncFn,
    /and g\.id is distinct from v_digest\.id\s+\) then\s+v_elsewhere := v_elsewhere \+ 1;\s+continue;/,
    "a day already in another digest — released, answered or cleared there — is never asked about twice",
  );
  assert.match(syncFn, /if v_line\.adjusted_by_hr_id is not null then\s+v_days := v_line\.deduction_days;/, "a day whose days the Super Admin changed keeps his figure");
  assert.match(syncFn, /coalesce\(v_day\.evidence, '\{\}'::jsonb\), false\s*\);/, "a new day starts unticked");
  assert.match(
    syncFn,
    /l\.action = 'pending'\s+and l\.work_date = any\(v_cleared_dates\)\s+and not exists \(select 1 from public\.attendance_settlements s where s\.digest_line_id = l\.id\)/,
    "only a waiting day the report cleared is taken off, never one with a settlement",
  );
  assert.match(
    live,
    /create unique index if not exists attendance_weekly_digests_one_awaiting_idx\s+on public\.attendance_weekly_digests \(employee_hr_id, cycle_key, week_index\)\s+where status = 'awaiting_release' and dry_run = false;/,
    "one real digest per employee-week waits for release at a time, so a second release can never open days the first one holds",
  );

  const liveReleaseFn = live.slice(
    live.indexOf("create or replace function public.phx_attendance_release_digest"),
    live.indexOf("revoke execute on function public.phx_attendance_release_digest"),
  );
  assert.ok(liveReleaseFn.length > 0 && liveReleaseFn.length < live.length / 2, "the new release function slice must find both of its markers");
  assert.match(
    liveReleaseFn,
    /where seen\.line_id = l\.id\s+and round\(seen\.days, 3\) = round\(l\.deduction_days, 3\)/,
    "the release refuses a waiting day the page did not show at its current figure",
  );
  {
    const refusedAt = liveReleaseFn.indexOf("using errcode = '40001'");
    assert.ok(
      refusedAt > liveReleaseFn.indexOf("for update") && liveReleaseFn.indexOf("for update") > 0,
      "the page check runs under the week's row lock",
    );
    assert.ok(
      refusedAt < liveReleaseFn.indexOf("where digest_id = v_digest.id and action = 'pending' and deduct = false"),
      "…and before any unticked day is cleared",
    );
  }
  assert.match(
    liveReleaseFn,
    /where digest_id = v_digest\.id and action = 'pending' and deduct = false/,
    "release must clear exactly the unticked days that are still pending",
  );
  assert.match(
    liveReleaseFn,
    /insert into public\.attendance_settlements \([^;]*'removed'[^;]*;/,
    "an unticked day must leave a 'removed' settlement, or payroll could still approve it",
  );
  assert.match(liveReleaseFn, /v_digest\.status <> 'awaiting_release' or v_digest\.dry_run is distinct from false/, "release refuses a trial run or a week already released");
  assert.match(liveReleaseFn, /when v_kept = 0 then 'void'/, "a week with nothing ticked is voided, never opened to the employee");
  assert.match(
    live,
    /drop function if exists public\.phx_attendance_release_digest\(bigint, text, date\);/,
    "the release that checked nothing against the page is dropped, so no caller can go around the check",
  );
  assert.match(live, /grant execute on function public\.phx_attendance_release_digest\(bigint, text, date, bigint\[\], numeric\[\]\) to service_role;/);
  assert.match(live, /grant execute on function public\.phx_attendance_sync_digest_days\([^)]*\) to service_role;/);
  assert.doesNotMatch(live, /\bto (public|anon|authenticated)\b/, "nothing in this migration is granted to a browser role");
  assert.match(
    live,
    /where d\.dry_run = true\s+and d\.status = 'void'\s+and d\.released_at is null\s+and not exists \(/,
    "only a void, never-released trial digest with no settlement is deleted",
  );
  assert.match(
    live,
    /create schema if not exists attendance_backup_20260917;\s+revoke all on schema attendance_backup_20260917 from public, anon, authenticated;/,
    "the trial copy goes in a dated schema no browser role can reach, never in public",
  );
  assert.doesNotMatch(live, /public\.\w*backup/, "…and no backup table lands in public");
  assert.ok(
    live.indexOf("insert into attendance_backup_20260917.trial_digests") > 0 &&
      live.indexOf("insert into attendance_backup_20260917.trial_digests") <
        live.indexOf("delete from public.attendance_weekly_digests\nwhere id in (select id from weekly_review_trial_ids);"),
    "the trial copy is backed up before it is deleted — production has no point-in-time recovery",
  );

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
    /if \(!calendar\.holidayCalendarReachable\) \{\s*return \{ context: null, unreadable: "The public holiday calendar"/,
    "a Google Calendar outage gives no deadline either — a fixed-date holiday keeps the month connected while both Eids are missing",
  );
  // The outage itself, through the real holiday lookup. Google unreachable in May: Labour Day (a fixed
  // date) still loads, so the month reads as connected, the flag release trusted before, while Eid
  // al-Adha is missing. 2099 keeps this month out of the holiday cache a real lookup fills.
  {
    const savedFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;
      const outage = await buildAttendanceCalendarContext({ dateFromIso: "2099-05-01", dateToIso: "2099-05-31" });
      assert.equal(outage.holidaysByDate.get("2099-05-01"), "Labour Day", "a fixed-date holiday still loads during an outage");
      assert.equal(outage.holidaySourceConnected, true, "…so the month still reads as connected, which is why that flag cannot be the gate");
      assert.equal(
        outage.holidayCalendarReachable,
        false,
        "a Google Calendar outage must read as unreachable even in a month a fixed-date holiday keeps connected",
      );
    } finally {
      globalThis.fetch = savedFetch;
    }
  }
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
  // A field day reviewed in the HR operations report (category field_review, 2026-10-20) travels the
  // weekly review exactly as a fingerprint day does, so the same two checks hold it.
  const approvalGuard = /if \(\s*input\.decisionStatus === "Approved for Payroll" &&\s*\(candidateRow\.category === "fingerprint" \|\| candidateRow\.category === "field_review"\)\s*\) \{[^}]*\};\s*await assertDayNotPaidFromAnnualBalance\(reviewedDay\);\s*await assertDayNotClearedInAttendanceReview\(reviewedDay\);/;
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
  // A REJECTED settlement is read too, since 2026-10-09: a decided dispute can be reopened and
  // decided again, so the settlement is only the first draft of the answer. The row is then judged
  // by the LINE it carries — a day whose settlement says rejected may be upheld today, and the
  // reverse — which is why this read cannot stop at the two outcomes that were final before.
  assert.match(
    cleared,
    /\.in\("action", \["removed", "dispute_upheld", "dispute_rejected"\]\)/,
    "a removed or upheld day must refuse approval, and a rejected settlement is read so a revision cannot hide an upheld day",
  );
  assert.match(
    cleared,
    /effectiveSettlement\(/,
    "…and each row is judged by the line it carries, never by the settlement alone",
  );
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
  assert.match(bridge, /try \{\s*(?:const \w+ = )?await recordDecision\(/, "one locked candidate must not abort every other day in the month");
  assert.match(
    bridge,
    /if \(decision\.status === "Do Not Take Action" && currentStatus === "Approved for Payroll"\) \{/,
    "a day the review cleared that payroll already approved must alert every run",
  );
  assert.match(bridge, /if \(decision\.status === "Do Not Take Action"\) result\.alerts\.push\(line\);/, "a cleared day that could not be closed is money: it alerts, not warns");
  assert.match(bridge, /\.range\(from, from \+ PAGE - 1\);[\s\S]*if \(page\.length < PAGE\) break;/, "settlements are read page by page, so skipped rows cannot hide newer answers");

  // --- Choosing the days (owner, 2026-09-15 — "I want full control") -------------------------------
  // The week picker (owner, 2026-09-17 — "Show live, release any time"): every started week of the review
  // month, the running one included. It used to list only closed weeks, so on 17 September the week of
  // 14–23 September was invisible until the 24th.
  {
    const sep17 = startedReviewWeeks("2026-09", "2026-09-17");
    assert.deepEqual(sep17.map((week) => week.index), [2, 3, 4], "on 17 September weeks 2 and 3 are complete and week 4 is listed while it runs");
    assert.deepEqual(sep17.map((week) => week.running), [false, false, true]);
    assert.equal(sep17[2]!.throughIso, "2026-09-16", "the running week holds its days up to yesterday");
    assert.deepEqual(startedReviewWeeks("2026-10", "2026-10-01"), [], "on 1 October no day of October has finished yet");

    const syncedWeeks = (todayIso: string) =>
      reviewWeeksToSync(todayIso).map((week) => `${week.monthKey} week ${week.index} through ${week.throughIso}`);
    assert.deepEqual(
      syncedWeeks("2026-09-17"),
      ["2026-09 week 2 through 2026-09-06", "2026-09 week 3 through 2026-09-13", "2026-09 week 4 through 2026-09-16"],
      "the daily job brings every started week of the month up to date, the running one included",
    );
    assert.deepEqual(
      syncedWeeks("2026-10-01"),
      [
        "2026-09 week 2 through 2026-09-06",
        "2026-09 week 3 through 2026-09-13",
        "2026-09 week 4 through 2026-09-23",
        "2026-09 week 5 through 2026-09-30",
      ],
      "on 1 October September is still the month under review, through 30 September",
    );
    assert.deepEqual(
      syncedWeeks("2026-10-02"),
      ["2026-09 week 5 through 2026-09-30", "2026-10 week 1 through 2026-10-01"],
      "for the first days of October September's last week is still brought up to date, so a late excuse for 30 September reaches it",
    );
    assert.deepEqual(syncedWeeks("2026-10-04"), ["2026-09 week 5 through 2026-09-30", "2026-10 week 1 through 2026-10-03"]);
    assert.deepEqual(syncedWeeks("2026-10-05"), ["2026-10 week 1 through 2026-10-04"], "after that, September is left alone");
    assert.deepEqual(
      syncedWeeks("2026-09-02"),
      ["2026-08 week 4 through 2026-08-31", "2026-09 week 2 through 2026-09-01"],
      "August is reviewed (owner, 2026-09-17: \"build starting from 1 august\"), so its last week follows the same first-days rule as every month",
    );
    assert.deepEqual(syncedWeeks("2026-08-02"), ["2026-08 week 1 through 2026-08-01"], "nothing before August 2026 is reviewed: July has no weeks");

    assert.equal(refreshableReviewWeek("2026-09", 5, "2026-10-20")?.throughIso, "2026-09-30", "the page may still refresh last month's weeks");
    assert.equal(refreshableReviewWeek("2026-09", 5, "2026-11-02"), null, "…but not an older month's: its days are in month-end payroll by then");
    assert.equal(refreshableReviewWeek("2026-10", 4, "2026-10-10"), null, "a week that has not started cannot be refreshed");
    assert.equal(refreshableReviewWeek("2026-09", 1, "2026-09-17"), null, "September 2026 has no week 1: its days before the 1st are August's");
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
  assert.match(
    syncFn,
    /deduction_days, deduction_value, detected_days, detected_value, reason, evidence, deduct\s+\) values \(\s+v_digest\.id, v_day\.work_date, v_day\.status, coalesce\(v_day\.late_minutes, 0\), coalesce\(v_day\.short_minutes, 0\),\s+coalesce\(v_day\.worked_minutes, 0\), round\(v_day\.deduction_days, 3\), round\(v_day\.deduction_value, 2\),\s+round\(v_day\.deduction_days, 3\), round\(v_day\.deduction_value, 2\),/,
    "a new day keeps the detected days apart from the figure he may change",
  );

  // --- Bringing a week up to date (owner, 2026-09-17 — "Show live, release any time") ------------------
  {
    const syncStart = service.indexOf("async function syncReviewWeekDays");
    const syncBody = service.slice(syncStart, service.indexOf("\n}\n", syncStart));
    assert.ok(syncStart > 0 && syncBody.length < service.length / 4, "the sync slice must find its function");
    assert.match(
      syncBody,
      /\.rpc\("phx_attendance_sync_digest_days", \{/,
      "each employee's week is brought up to date in one database transaction that keeps his ticks, never a delete-and-rebuild",
    );
    assert.match(
      syncBody,
      /p_cleared_dates: waitingKeys\.has\(canonicalHrIdKey\(target\.employeeHrId\)\) \? target\.clearedDates : \[\],/,
      "cleared days are sent only for an employee with days waiting in the week",
    );
    assert.match(syncBody, /if \(error\) \{\s*failedHrIds\.push\(/, "one employee who cannot be brought up to date does not stop the others…");
    assert.match(
      service,
      /for \(const failure of result\.failures\) failures\.push\(/,
      "…and still reaches the daily job's failures, so the scheduler sees a 500",
    );
    assert.doesNotMatch(
      service,
      /from\("attendance_(weekly_digests|digest_lines)"\)\s*\.delete\(/,
      "the service never deletes a digest or a day itself: only the database function takes a cleared day off",
    );
  }

  // --- One piece of work on a week at a time (risk review, 2026-09-16; refresh and release, 2026-09-17) --
  // A release checks that the days waiting are the days the page showed, then releases them; a refresh
  // of the same week running in between would add a day after the check.
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
  {
    const dailyStart = service.indexOf("export async function syncOpenReviewWeeks");
    const daily = service.slice(dailyStart, service.indexOf("\n}\n", dailyStart));
    assert.ok(dailyStart > 0 && daily.length < service.length / 4, "the daily sync slice must find its function");
    assert.match(
      daily,
      /withWeekBuildLock\(window\.monthKey, window\.index, \(\) =>\s*syncReviewWeekDays\(/,
      "the daily job brings a week up to date only while holding that week's lock",
    );
  }
  const releaseStart = service.indexOf("export async function releaseWeek");
  const releaseGate = service.slice(releaseStart, service.indexOf("\n}\n", releaseStart));
  assert.match(
    releaseGate,
    /return withWeekBuildLock\(input\.cycleKey, input\.weekIndex, \(\) => releaseWaitingDays\(\{ \.\.\.input, seenLines \}\)\);/,
    "a release takes the week's lock too, so a refresh can never add a day between the page check and the release",
  );
  assert.ok(
    releaseGate.includes("assertCanManageWeeklyReview(input.actorRole)") &&
      releaseGate.indexOf("assertCanManageWeeklyReview(input.actorRole)") < releaseGate.indexOf("withWeekBuildLock("),
    "…and the role check still refuses before any lock is taken",
  );

  const refreshStart = service.indexOf("export async function buildReviewWeek");
  const refreshClick = service.slice(refreshStart, service.indexOf("\n}\n", refreshStart));
  const refreshableAt = refreshClick.indexOf("refreshableReviewWeek(");
  assert.ok(
    refreshableAt > 0 && refreshableAt < refreshClick.indexOf("withWeekBuildLock("),
    "a Refresh click reaches only a started week of this month or last month — an older week's days are in month-end payroll",
  );
  assert.match(
    refreshClick,
    /withWeekBuildLock\(window\.monthKey, window\.index, \(\) =>\s*syncReviewWeekDays\(/,
    "…and brings it up to date under the week's lock, after any refresh or release of it still running",
  );
}
