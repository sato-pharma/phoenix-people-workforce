import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

import {
  answerDueDate,
  balanceCoversDays,
  balanceReadIsComplete,
  buildWeekReleasedMessage,
  canManageWeeklyReview,
  deadlineApplies,
  decisionForSettlement,
  disputeSalaryFallbackText,
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

// The weekly attendance review, owner decision 2026-09-15:
//   release gate → employee chooses salary or annual balance → may then dispute →
//   no answer within 2 working days of release → salary.

/** Friday off for everyone, plus one named holiday. Egypt's weekend shape. */
function workingDayWithHoliday(holidayIso: string) {
  return (dateIso: string) => new Date(`${dateIso}T00:00:00Z`).getUTCDay() !== 5 && dateIso !== holidayIso;
}

export function runAttendanceDigestRulesTests() {
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
    "2026-09-17",
    "a calendar that never says 'working' cannot loop forever; it falls back to plain calendar days",
  );

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
    /if \(!calendar\.holidaySourceConnected\) \{\s*throw conflictError/,
    "release must refuse when the holiday calendar is unreadable — a holiday would count as a working day to answer in",
  );
  assert.match(release, /isAttendanceScheduledWorkingDay\(\{ dateIso, jobTitle, workingWeekdays \}\)/, "the deadline uses the employee's own weekly-off policy");

  const sweep = service.slice(service.indexOf("export async function settleOverdueAnswers"));
  assert.match(sweep, /\.not\("notified_at", "is", null\)/, "the deadline sweep must skip anyone who was never notified");

  const review = service.slice(service.indexOf("export async function reviewDispute"), service.indexOf("export type SweepResult"));
  assert.match(review, /if \(digest\.dryRun\) throw conflictError/, "a dispute in a trial-run week cannot be decided");
  assert.match(review, /assertNotOwnPay\(digest\.employeeHrId, input\.reviewerHrId, input\.reviewerRole\)/, "a named reviewer never rules on their own day");
  assert.match(
    review,
    /if \(balance\.refusal === "balance_unreadable"\) \{\s*throw conflictError/,
    "a balance that failed to read must refuse the ruling, never move the day to salary for good",
  );
  assert.match(review, /disputeSalaryFallbackText\(balance\.refusal\)/, "the salary fallback must record its real cause");

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
}
