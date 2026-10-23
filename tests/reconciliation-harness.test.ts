import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { systemClock, type ReconciliationClock } from "../src/lib/reconciliation/clock.ts";
import {
  classifyReconciliationOutcome,
  diffSets,
  formatCount,
  formatList,
  formatMoney,
  formatRowsAndMoney,
  moneyMatches,
  MONEY_TOLERANCE_EGP,
  shouldAlert,
  summarizeReconciliationResults,
} from "../src/lib/reconciliation/compare.ts";
import {
  expectedRemainder,
  findApprovalPanelMismatches,
  findLineFormulaMismatches,
  findOrderValueMismatches,
  findRemainderMismatches,
  type DirectOrderAuditLine,
  type DirectOrderAuditOrder,
} from "../src/lib/reconciliation/direct-order-totals.ts";
import { findDuplicateEmployeeDays } from "../src/lib/reconciliation/duplicate-days.ts";
import { partitionLoginsWithoutEmployeeRow } from "../src/lib/reconciliation/logins-without-employee-row.ts";
import { retryOnceIfBreached } from "../src/lib/reconciliation/retry.ts";
import { buildReconciliationAlertMessage, runReconciliationCheckList } from "../src/lib/reconciliation/runner.ts";
import {
  RECONCILIATION_FINDINGS_CAP,
  type ReconciliationCheck,
  type ReconciliationCheckResult,
  type ReconciliationOutcome,
} from "../src/lib/reconciliation/types.ts";

/**
 * The reconciliation harness exists because 24 defects were silent for months: payroll
 * under-reported every batch, a rep's CRM work was unattributed from April, a device outage was
 * reported as company-wide absence. Nothing announced any of it.
 *
 * These tests cover the parts that decide whether the harness itself stays trustworthy — the
 * verdict logic, the report shaping, and the guarantee that one broken check cannot blind the
 * rest. Nothing here touches a database: the domain checks are exercised against live production
 * by design, and a test that mocked Supabase would only be asserting the mock.
 */

function outcome(holds: boolean, detail = "detail"): ReconciliationOutcome {
  return {
    left: { source: "service", value: "left" },
    right: { source: "derivation", value: "right" },
    holds,
    detail,
  };
}

function check(overrides: Partial<ReconciliationCheck> & Pick<ReconciliationCheck, "id" | "run">): ReconciliationCheck {
  return {
    id: overrides.id,
    run: overrides.run,
    title: overrides.title ?? overrides.id,
    domain: overrides.domain ?? "payroll",
    severity: overrides.severity ?? "critical",
    expectation: overrides.expectation ?? "holds",
    openDefect: overrides.openDefect,
  };
}

function result(overrides: Partial<ReconciliationCheckResult>): ReconciliationCheckResult {
  return {
    id: "id",
    title: "title",
    domain: "payroll",
    severity: "critical",
    expectation: "holds",
    status: "holds",
    holds: true,
    left: null,
    right: null,
    detail: "",
    durationMs: 0,
    error: null,
    ...overrides,
  };
}

type ManualClock = ReconciliationClock & {
  /** Drives a run to completion, bringing its timers due one at a time. */
  settle: (run: Promise<unknown>) => Promise<void>;
};

/**
 * A clock the test moves by hand.
 *
 * The per-check ceiling and the run budget are both rules about elapsed time, and proving them
 * against real timers races two different clocks: the runner sizes a timer against a `Date.now()`
 * deadline, then the event loop fires it off its own monotonic clock. On 2026-08-04 a loaded
 * machine won that race — the second check below started inside a budget the run had already spent
 * and reported `holds` where the test demands `errored`.
 *
 * Here time only moves when `settle` moves it, so the assertions describe the rule rather than the
 * machine's mood, and neither run costs the suite a real second.
 */
function createManualClock(startMs = Date.parse("2026-01-15T09:00:00Z")): ManualClock {
  let currentMs = startMs;
  let nextId = 0;
  const pending = new Map<number, { dueAt: number; onDue: () => void }>();

  /** One real macrotask turn — enough to flush every microtask the run has queued. */
  const drain = () =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

  return {
    now: () => currentMs,
    setTimeout: (onDue, delayMs) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { dueAt: currentMs + delayMs, onDue });
      return {
        cancel: () => {
          pending.delete(id);
        },
      };
    },
    settle: async (run) => {
      let finished = false;
      const settled = run.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );

      // A ceiling so a run that never converges ends with a sentence rather than stalling the suite.
      for (let step = 0; step < 1_000; step += 1) {
        await Promise.race([settled, drain()]);
        if (finished) return;

        let due: { id: number; dueAt: number; onDue: () => void } | null = null;
        for (const [id, timer] of pending) {
          if (due === null || timer.dueAt < due.dueAt) due = { id, dueAt: timer.dueAt, onDue: timer.onDue };
        }
        if (due === null) {
          throw new Error("The run is still waiting and no timer is left to fire — nothing on this clock can release it.");
        }

        pending.delete(due.id);
        currentMs = Math.max(currentMs, due.dueAt);
        due.onDue();
      }

      throw new Error("The run did not settle within 1,000 timer steps.");
    },
  };
}

export async function runReconciliationHarnessTests() {
  // ── Money comparison: a tolerance wide enough for float noise, narrow enough to matter ───────
  assert.equal(moneyMatches(2_667_500, 2_667_500.004), true, "half a piastre of float noise must not be reported as a payroll defect");
  assert.equal(
    moneyMatches(2_267_000, 2_667_500),
    false,
    "the real Jun-2026 gap of 400,500 EGP between the card and the dashboard must never round away",
  );
  assert.equal(moneyMatches(100, 100.02), false, `two piastres is outside the ${MONEY_TOLERANCE_EGP} EGP tolerance and must be reported`);
  assert.equal(
    moneyMatches(100, 100.02, 0.05),
    true,
    "a caller-widened tolerance must apply — the per-employee/per-category paths round in a different order",
  );
  assert.equal(
    moneyMatches(Number.NaN, 0),
    false,
    "a NaN side means the read failed; treating it as a match would report a broken read as a healthy one",
  );

  // ── Money is never rendered as a bare, contextless number ────────────────────────────────────
  assert.equal(formatMoney(2667500), "2,667,500.00 EGP", "a payroll total without separators or a currency is how EGP gets read as piastres");
  assert.equal(formatMoney(0), "0.00 EGP", "a real zero must still render as money, so it can be told apart from a failed read");
  assert.match(formatMoney(Number.NaN), /unavailable/, "an unreadable figure must say so rather than silently render as 0");
  assert.equal(formatCount(1, "person", "people"), "1 person");
  assert.equal(formatCount(123, "person", "people"), "123 people");
  assert.equal(
    formatRowsAndMoney(123, 2667500),
    "123 rows / 2,667,500.00 EGP",
    "membership and money always travel together — a row count alone hides a wrong total, and vice versa",
  );

  // ── Lists state their cap instead of trailing off ────────────────────────────────────────────
  assert.equal(formatList([]), "none");
  assert.equal(formatList(["a", "b"]), "a; b");
  const capped = formatList(Array.from({ length: 46 }, (_value, index) => `row-${index}`), 10);
  assert.match(capped, /first 10 of 46/, "the reader must be told how much is behind the cap");
  assert.equal(capped.includes("…"), false, "user-facing text is never truncated with an ellipsis");

  // ── Sets, not tallies: the payroll defect swapped membership, not just totals ────────────────
  const sets = diffSets(["A-1", "B-2"], ["B-2", "C-3"]);
  assert.deepEqual(sets.onlyInLeft, ["A-1"]);
  assert.deepEqual(sets.onlyInRight, ["C-3"]);
  assert.equal(sets.identical, false);
  assert.equal(
    diffSets(["A-1", "B-2"], ["B-2", "A-1"]).identical,
    true,
    "the same people in a different order are the same people",
  );
  assert.equal(
    diffSets(["A-1", "X-9"], ["A-1", "Y-9"]).identical,
    false,
    "two sides of equal SIZE can still be paying different people — that is exactly the defect this catches",
  );

  // ── Verdicts: a known-open defect reads as a finding, never as a broken check ────────────────
  assert.equal(classifyReconciliationOutcome("holds", true), "holds");
  assert.equal(classifyReconciliationOutcome("holds", false), "breached");
  assert.equal(
    classifyReconciliationOutcome("known-open", false),
    "known-open",
    "a documented, still-unfixed defect must not page anyone nightly — that is how a whole harness gets ignored",
  );
  assert.equal(
    classifyReconciliationOutcome("known-open", true),
    "holds",
    "the day a known-open defect starts agreeing, it must report as holding rather than stay labelled open",
  );

  // ── What raises an alarm ─────────────────────────────────────────────────────────────────────
  const counts = summarizeReconciliationResults([
    result({ status: "holds" }),
    result({ status: "known-open", holds: false, expectation: "known-open" }),
    result({ status: "breached", holds: false }),
    result({ status: "errored", holds: null, error: "boom" }),
  ]);
  assert.deepEqual(counts, { total: 4, holding: 1, breached: 1, knownOpen: 1, errored: 1 });
  assert.equal(shouldAlert(counts), true);
  assert.equal(
    shouldAlert({ total: 3, holding: 2, breached: 0, knownOpen: 1, errored: 0 }),
    false,
    "known-open findings alone must stay quiet, or the alert becomes noise everyone filters out",
  );
  assert.equal(
    shouldAlert({ total: 1, holding: 0, breached: 0, knownOpen: 0, errored: 1 }),
    true,
    '"we could not tell" is an alert — mistaking it for "everything is fine" is the exact failure this harness ends',
  );

  // ── One broken check must not blind the rest ─────────────────────────────────────────────────
  const report = await runReconciliationCheckList(
    [
      check({ id: "healthy", run: async () => outcome(true, "agrees") }),
      check({
        id: "explodes",
        run: async () => {
          throw new Error("Supabase statement timeout");
        },
      }),
      check({ id: "disagrees", run: async () => outcome(false, "123 rows vs 103 rows") }),
      check({
        id: "documented",
        expectation: "known-open",
        openDefect: "Verified on production: 165 rows short.",
        run: async () => outcome(false, "still short"),
      }),
    ],
    { concurrency: 2 },
  );

  assert.equal(report.results.length, 4, "a throwing check must produce a result, not remove itself from the report");
  assert.deepEqual(
    report.results.map((entry) => entry.id),
    ["healthy", "explodes", "disagrees", "documented"],
    "report order must follow the registry however the workers interleave, or nobody can diff two nights",
  );
  assert.equal(report.results[1].status, "errored");
  assert.equal(report.results[1].holds, null, "a check that could not run must never report a boolean verdict");
  assert.match(report.results[1].detail, /Supabase statement timeout/, "the reader needs the real cause, not a generic failure");
  assert.equal(report.results[2].status, "breached");
  assert.equal(report.results[3].status, "known-open");
  assert.match(
    report.results[3].detail,
    /165 rows short/,
    "a known-open finding must carry its evidence, so it reads as a documented defect rather than a flaky check",
  );
  assert.deepEqual(report.counts, { total: 4, holding: 1, breached: 1, knownOpen: 1, errored: 1 });
  assert.equal(report.alerting, true);
  assert.match(report.generatedAt, /\d{4}/, "the report is stamped in Cairo local time, never raw UTC");

  // ── A hung check is abandoned rather than taking the cron with it ────────────────────────────
  const timeoutClock = createManualClock();
  const timedOutRun = runReconciliationCheckList(
    [
      check({ id: "hangs", run: () => new Promise<ReconciliationOutcome>(() => {}) }),
      check({ id: "fine", run: async () => outcome(true) }),
    ],
    { timeoutMs: 1_000, clock: timeoutClock },
  );
  await timeoutClock.settle(timedOutRun);
  const timedOut = await timedOutRun;
  assert.equal(timedOut.results[0].status, "errored", "a check that never settles must be recorded as unanswerable");
  assert.equal(timedOut.results[1].status, "holds", "and the checks behind it must still run");
  assert.match(
    timedOut.results[0].error ?? "",
    /exceeded 1s and was abandoned/,
    "the per-check ceiling is what ended this one, and the reader must be able to tell that from the whole run running out of time",
  );
  assert.equal(
    timedOut.results[0].durationMs,
    1_000,
    "it is abandoned at its ceiling exactly, not at whatever the machine's timers happened to deliver",
  );

  // ── The run has a budget of its own, below the route's maxDuration ───────────────────────────
  let neverReachedRuns = 0;
  const budgetClock = createManualClock();
  const overBudgetRun = runReconciliationCheckList(
    [
      check({ id: "eats-the-budget", run: () => new Promise<ReconciliationOutcome>(() => {}) }),
      check({
        id: "never-reached",
        run: async () => {
          neverReachedRuns += 1;
          return outcome(true);
        },
      }),
    ],
    { concurrency: 1, timeoutMs: 60_000, runBudgetMs: 1_000, clock: budgetClock },
  );
  await budgetClock.settle(overBudgetRun);
  const overBudget = await overBudgetRun;
  assert.equal(overBudget.results[0].status, "errored", "the check that consumed the budget is still recorded");
  assert.equal(
    overBudget.results[1].status,
    "errored",
    "a check the run never reached must be reported as unanswered — without a run budget the request dies at maxDuration and the night produces no report at all",
  );
  assert.equal(
    neverReachedRuns,
    0,
    "and it must genuinely never have been started — a check that ran and was then relabelled would be throwing away an answer the run actually had",
  );
  assert.equal(overBudget.results[1].holds, null, "a check that never ran must never report a boolean verdict");
  assert.equal(overBudget.alerting, true, "running out of time is an alert, never a silent pass");
  assert.equal(
    overBudget.durationMs,
    1_000,
    "the run must stop at its own budget rather than at the far larger per-check ceiling",
  );
  assert.match(
    overBudget.generatedAt,
    /15 Jan 2026/,
    "the report is stamped from the same clock its budget is measured on, so a run and its own timestamp can never disagree",
  );

  // ── The seam's production side is the real clock ─────────────────────────────────────────────
  // The two runs above assert the rules on a clock the test controls; these assert the clock the
  // nightly cron actually runs on, so a broken default can never hide behind a passing manual one.
  const beforeReading = Date.now();
  const systemReading = systemClock.now();
  assert.ok(
    systemReading >= beforeReading && systemReading <= Date.now(),
    "the production clock reads real wall time — the manual clock is a test seam and must never become the default",
  );
  let cancelledTimerFired = false;
  systemClock.setTimeout(() => {
    cancelledTimerFired = true;
  }, 1).cancel();
  await new Promise<void>((resolve) => {
    systemClock.setTimeout(resolve, 20);
  });
  assert.equal(
    cancelledTimerFired,
    false,
    "cancelling must really stop a timer — one left armed behind a check that already answered rejects a race nobody is listening to",
  );

  // ── Every check runs even when several fail ──────────────────────────────────────────────────
  let executed = 0;
  const allRan = await runReconciliationCheckList(
    Array.from({ length: 5 }, (_value, index) =>
      check({
        id: `check-${index}`,
        run: async () => {
          executed += 1;
          if (index % 2 === 0) throw new Error(`fail-${index}`);
          return outcome(true);
        },
      }),
    ),
    { concurrency: 1 },
  );
  assert.equal(executed, 5, "every registered check must be attempted regardless of how many earlier ones threw");
  assert.equal(allRan.counts.errored, 3);
  assert.equal(allRan.counts.holding, 2);

  // ── The alert names the numbers, not just the count ──────────────────────────────────────────
  const message = buildReconciliationAlertMessage({
    generatedAt: "4 Aug 2026, 03:47",
    durationMs: 1234,
    counts: { total: 4, holding: 1, breached: 1, knownOpen: 1, errored: 1 },
    alerting: true,
    results: [
      result({
        id: "payroll-dashboard-matches-its-own-salary-records",
        title: "Payroll dashboard vs its own rows",
        status: "breached",
        holds: false,
        left: { source: "getPayrollDashboard", value: "103 people / 2,267,000.00 EGP" },
        right: { source: "salary_records", value: "123 rows / 2,667,500.00 EGP" },
        detail: "Jun-2026: 20 people and 400,500.00 EGP missing from the screen",
      }),
      result({ id: "quiet", status: "holds" }),
      result({ id: "documented", title: "A documented finding", status: "known-open", holds: false, expectation: "known-open" }),
      result({ id: "unanswered", title: "A check that timed out", status: "errored", holds: null, error: "timeout", detail: "Could not run: timeout" }),
    ],
  });
  assert.match(message, /2,267,000\.00 EGP/, "the alert must carry the figure the screen shows");
  assert.match(message, /2,667,500\.00 EGP/, "and the figure underneath it, so the reader can act without opening the database");
  assert.match(message, /4 Aug 2026, 03:47 Cairo/, "the timestamp is Cairo local time");
  assert.match(
    message,
    /Already known and unchanged: A documented finding/,
    "known-open findings are listed separately so a persistent defect never reads as a new emergency",
  );
  assert.equal(message.includes("quiet"), false, "a holding check must not add noise to a breach alert");
  assert.equal(
    message.split("\n")[0],
    "⚠️ Reconciliation breach — 1 of 4 checks disagree, 1 could not be answered — 4 Aug 2026, 03:47 Cairo",
    "the checks that could not be answered are in the TITLE, so a night of errors never reads as a quiet one",
  );
  assert.match(
    message,
    /Second source: 123 rows \/ 2,667,500\.00 EGP/,
    "the right side is the same fact derived another way — labelled the second source, never prejudged as the actual figure",
  );
  assert.equal(message.includes("Actual:"), false);
  assert.match(message, /Full report → \/admin\/system-audit/, "the report lives on the System Audit page now");

  // ── The rows behind a disagreement ride through, capped per check, and the cap is said ───────
  const manyFindings = Array.from({ length: RECONCILIATION_FINDINGS_CAP + 7 }, (_value, index) => ({
    hrId: `B-${index}`,
    detail: `row ${index} disagrees`,
  }));
  const withFindings = await runReconciliationCheckList(
    [
      check({ id: "names-people", run: async () => ({ ...outcome(false, "507 people disagree"), findings: manyFindings }) }),
      check({
        id: "documented-again",
        expectation: "known-open",
        openDefect: "Verified on production: 165 rows short.",
        run: async () => outcome(false, "still short"),
      }),
      check({ id: "plain", run: async () => outcome(true) }),
    ],
    { concurrency: 1 },
  );
  assert.equal(withFindings.results[0].findings?.length, RECONCILIATION_FINDINGS_CAP, "one runaway check cannot bloat the stored report");
  assert.equal(withFindings.results[0].findingsTruncated, 7, "the rows left off are counted, never dropped in silence");
  assert.equal(withFindings.results[0].findings?.[0].hrId, "B-0", "the findings arrive untouched, in the check's order");
  assert.equal(
    withFindings.results[1].openDefect,
    "Verified on production: 165 rows short.",
    "the documented open defect is carried on the result, so the ledger can store it as the probable cause",
  );
  assert.equal("findings" in withFindings.results[2], false, "a check that names nobody carries no findings field at all");
  assert.equal("openDefect" in withFindings.results[2], false);

  // ── Retry absorbs a read race without weakening the check ────────────────────────────────────
  let attempts = 0;
  const flaky = retryOnceIfBreached(async () => {
    attempts += 1;
    return outcome(attempts > 1);
  });
  const settled = await flaky();
  assert.equal(attempts, 2, "a disagreement is re-read once, because an upload landing mid-check looks exactly like a defect");
  assert.equal(settled.holds, true, "a disagreement that does not survive a fresh read was a race, not a defect");

  attempts = 0;
  const stable = retryOnceIfBreached(async () => {
    attempts += 1;
    return outcome(true);
  });
  await stable();
  assert.equal(attempts, 1, "the healthy path must not pay for a retry it never needs");

  attempts = 0;
  const persistent = retryOnceIfBreached(async () => {
    attempts += 1;
    return outcome(false, "still wrong");
  });
  const stillBroken = await persistent();
  assert.equal(stillBroken.holds, false, "a disagreement that survives a re-read is a real defect and must still be reported");
  assert.equal(attempts, 2, "and it must be re-read exactly once, not retried in a loop");

  // ── The duplicate-day derivation must NOT inherit the publish gate's cross-category rule ─────
  const sameCategoryTwoFeeders = findDuplicateEmployeeDays([
    {
      employeeHrIdCompact: "b185",
      employeeHrId: "B-185",
      employeeName: "Ahmed El Maraghy",
      category: "unpaid_vacation",
      sourceSystem: "vacation_balance",
      dates: ["2026-07-07"],
    },
    {
      employeeHrIdCompact: "b185",
      employeeHrId: "B-185",
      employeeName: "Ahmed El Maraghy",
      category: "unpaid_vacation",
      sourceSystem: "crm_vacation_signal",
      dates: ["2026-07-07"],
    },
  ]);
  assert.equal(
    sameCategoryTwoFeeders.length,
    1,
    "two feeders inside ONE category can each claim the same day — the publish gate's categories>1 rule cannot see it, which is why this derivation must be independent",
  );
  assert.deepEqual(sameCategoryTwoFeeders[0].claims, [
    "unpaid_vacation/vacation_balance",
    "unpaid_vacation/crm_vacation_signal",
  ], "the alert must name BOTH claiming sources, or nobody can tell which feeder to correct");
  assert.equal(sameCategoryTwoFeeders[0].employeeName, "Ahmed El Maraghy", "HR acts on a person; a bare HR code makes them go and look it up");

  assert.deepEqual(
    findDuplicateEmployeeDays([
      { employeeHrIdCompact: "a12", employeeHrId: "A-12", employeeName: null, category: "crm", sourceSystem: "crm_visits_mirror", dates: ["2026-07-01", "2026-07-02"] },
      { employeeHrIdCompact: "ai0001", employeeHrId: "AI-0001", employeeName: null, category: "fingerprint", sourceSystem: "attendance", dates: ["2026-07-01"] },
    ]),
    [],
    "two different employees on the same day are not a duplicate — grouping on the name (both null in production) once produced exactly this false positive",
  );

  assert.deepEqual(
    findDuplicateEmployeeDays([
      { employeeHrIdCompact: "a12", employeeHrId: "A-12", employeeName: null, category: "crm", sourceSystem: "crm_visits_mirror", dates: ["2026-07-01"] },
      { employeeHrIdCompact: "a12", employeeHrId: "A-12", employeeName: null, category: "crm", sourceSystem: "crm_visits_mirror", dates: [] },
    ]),
    [],
    "a candidate whose days a reviewer cleared to none claims nothing, and must not collide with anything",
  );

  // ── The one login allowed to carry no HR_ID, and only that one ───────────────────────────────
  // This check is scheduled nightly. `admin-HR` is the break-glass Super Admin, production holds
  // no employees row for it, and the standing rule is that one must never be created — so without
  // this allowance the job alarms every night on a condition ruled permanent, which is how a job
  // becomes one nobody reads.
  const liveShape = partitionLoginsWithoutEmployeeRow([{ login: "admin-HR" }]);
  assert.deepEqual(
    liveShape.unexplained,
    [],
    "admin-HR is spelled mixed-case in production — an exact-match allowlist would breach nightly while still reading, in source, as though it were handled",
  );
  assert.equal(liveShape.explained.length, 1, "the allowed login must still be accounted for, not dropped");
  assert.match(
    liveShape.explained[0].reason,
    /break-glass Super Admin/,
    "the exception has to carry its reason into the report — an allowance nobody can see becomes folklore",
  );

  const withAStranger = partitionLoginsWithoutEmployeeRow([{ login: "admin-HR" }, { login: "ZZ-TOUR" }]);
  assert.deepEqual(
    withAStranger.unexplained,
    ["ZZ-TOUR"],
    "a SECOND account with no HR_ID is the thing worth paging on — allowlisting the class instead of the one login would hide exactly that",
  );

  // ── Test accounts carry no HR_ID BY DESIGN, and used to breach every night ────────────────────
  // 43 consecutive 04:40 Telegram alerts, 30 Aug – 15 Oct 2026, every one of them the design
  // working as intended: a test account has its own TEST-… login and no hr_id of its own, with
  // test_persona_of_hr_id naming the employee it mirrors (src/lib/auth/test-persona.ts).
  const withTestAccounts = partitionLoginsWithoutEmployeeRow([
    { login: "admin-HR" },
    { login: "TEST-AYA", isTestPersona: true },
    { login: "TEST-RAGAA", isTestPersona: true },
  ]);
  assert.deepEqual(
    withTestAccounts.unexplained,
    [],
    "a test account holds no HR_ID by design — leaving the class out of the allowance is what paged the owner 43 mornings running",
  );
  assert.equal(
    withTestAccounts.explained.length,
    3,
    "every excluded login is still named in the report, test accounts included — the reasons collapse, the names never do",
  );
  assert.match(
    withTestAccounts.explained[1].reason,
    /test account/,
    "a test account's exclusion has to say what it is, or the next reader cannot tell it from a silent hole",
  );

  // Fail-CLOSED, and this is the half worth pinning: the flag alone must not buy silence.
  const flagOnARealLogin = partitionLoginsWithoutEmployeeRow([
    { login: "AYA-IBRAHIM", isTestPersona: true },
    { login: "TEST-AYA", isTestPersona: false },
    { login: "TEST-AYA", isTestPersona: null },
  ]);
  assert.deepEqual(
    flagOnARealLogin.unexplained,
    ["AYA-IBRAHIM", "TEST-AYA", "TEST-AYA"],
    "is_test_persona on a login that is not a valid TEST-… id, or a TEST-… login without the flag, stays a breach — flipping one column must never silence this check for a real person's account",
  );

  // ── Direct orders: the stored value, each line, the approval panel and the remainder ──────────
  // 18 Oct 2026: a requester added Lacto Advanced 2 and the order's total stayed at line one's
  // 24,750 EGP (#6085). The read-only audit that followed checked these four things by hand.
  const order = (overrides: Partial<DirectOrderAuditOrder> & Pick<DirectOrderAuditOrder, "id">): DirectOrderAuditOrder => ({
    label: `order ${overrides.id}`,
    dealType: "bonus",
    qty: 0,
    bonus: 0,
    discountPct: null,
    publicPriceSnapshot: null,
    pharmacyPriceSnapshot: null,
    salesValue: 0,
    paidAmount: null,
    remainingAmount: null,
    ...overrides,
  });
  const line = (overrides: Partial<DirectOrderAuditLine> & Pick<DirectOrderAuditLine, "requestId">): DirectOrderAuditLine => ({
    lineNo: 1,
    productName: "Lacto Advanced 1",
    dealType: "bonus",
    qty: 0,
    discountPct: null,
    publicPriceSnapshot: null,
    pharmacyPriceSnapshot: null,
    salesValue: 0,
    ...overrides,
  });

  // The 18 Oct basket, as it was stored before #6085 and as it is stored now.
  const lactoLine1 = line({ requestId: "lacto", lineNo: 1, qty: 300, pharmacyPriceSnapshot: 82.5, salesValue: 24750 });
  const lactoLine2 = line({ requestId: "lacto", lineNo: 2, productName: "Lacto Advanced 2", qty: 300, pharmacyPriceSnapshot: 75, salesValue: 22500 });
  const lactoBefore = order({ id: "lacto", qty: 300, bonus: 30, pharmacyPriceSnapshot: 82.5, salesValue: 24750 });
  const lactoNow = { ...lactoBefore, salesValue: 47250 };

  const stale = findOrderValueMismatches([lactoBefore], [lactoLine1, lactoLine2]);
  assert.equal(stale.length, 1, "an order still holding line one's value beside a two-line basket is the 18 Oct defect itself");
  assert.equal(stale[0].linesTotal, 47250, "the finding has to carry what the lines add up to, or nobody can tell how far off it is");
  assert.equal(stale[0].lineCount, 2);
  assert.deepEqual(findOrderValueMismatches([lactoNow], [lactoLine1, lactoLine2]), [], "the corrected basket holds");

  const lineless = findOrderValueMismatches([order({ id: "empty", salesValue: 0 })], []);
  assert.equal(
    lineless.length,
    1,
    "an order with NO lines is a finding even when its value reads 0 — every order since the items migration has at least one, and 0 = 0 would wave it through",
  );
  assert.equal(lineless[0].lineCount, 0);

  // A bonus line valued on the PUBLIC price (99 × 100) instead of the pharmacy price it is sold at.
  const wrongBasis = line({ requestId: "basis", qty: 100, publicPriceSnapshot: 99, pharmacyPriceSnapshot: 74.25, salesValue: 9900 });
  const wrongBasisFound = findLineFormulaMismatches([order({ id: "basis" })], [wrongBasis]);
  assert.equal(wrongBasisFound.length, 1, "a bonus line priced on the public price instead of the pharmacy price is credited 2,475 EGP too much");
  assert.equal(wrongBasisFound[0].formulaValue, 7425);
  assert.equal(wrongBasisFound[0].order?.label, "order basis", "the line is named by its order, never by an id");

  const noPrice = line({ requestId: "noprice", dealType: "discount", qty: 10, discountPct: 10, publicPriceSnapshot: null, salesValue: 0 });
  const noPriceFound = findLineFormulaMismatches([], [noPrice]);
  assert.equal(noPriceFound.length, 1, "a line with no price is refused by the server, so one that exists is a finding even at a matching 0");
  assert.equal(noPriceFound[0].basisPrice, null);
  assert.equal(noPriceFound[0].order, null, "a line whose order is gone is still reported, not dropped");

  // Zamzam Hospital's Ivyronc order, 7 Sep 2026: the line keeps the discount to 4 decimals, the order
  // row to 3. Until 19 Oct the panel priced the row and printed 6,999.975; it now prices the line.
  const zamzamLine = line({ requestId: "zamzam", productName: "Ivyronc", dealType: "discount", qty: 500, discountPct: 68.8889, publicPriceSnapshot: 45, salesValue: 7000 });
  const zamzam = order({ id: "zamzam", dealType: "discount", qty: 500, discountPct: 68.889, publicPriceSnapshot: 45, salesValue: 7000 });
  assert.deepEqual(findLineFormulaMismatches([zamzam], [zamzamLine]), [], "the Zamzam line itself is priced exactly by the locked formula");
  assert.deepEqual(
    findApprovalPanelMismatches([zamzam], [zamzamLine]),
    [],
    "the panel works out the LINE's 4-decimal discount, so Zamzam's working reaches its 7,000.00",
  );

  assert.deepEqual(
    findApprovalPanelMismatches([lactoNow], [lactoLine1, lactoLine2]),
    [],
    "the panel works out every line of the basket and arrives at its 47,250 total",
  );
  // The check still catches a working and a value that have parted: the pre-#6085 order, stored at
  // line one's 24,750 beside two lines, works out at 47,250.
  const partedPanel = findApprovalPanelMismatches([lactoBefore], [lactoLine1, lactoLine2]);
  assert.equal(partedPanel.length, 1, "a working that does not reach the stored value is still a finding");
  assert.equal(partedPanel[0].panelValue, 47250, "the finding reports the total the panel actually prints");
  assert.equal(partedPanel[0].lineCount, 2);

  // A rounding tie: 50 × 32.7375 = 1,636.875 before rounding, 1,636.87 stored. Not a gap.
  const tieLine = line({ requestId: "tie", qty: 50, pharmacyPriceSnapshot: 32.7375, salesValue: 1636.87 });
  const tie = order({ id: "tie", qty: 50, pharmacyPriceSnapshot: 32.7375, salesValue: 1636.87 });
  assert.deepEqual(findLineFormulaMismatches([tie], [tieLine]), [], "the line is the formula's own rounding of the tie");
  assert.deepEqual(findOrderValueMismatches([tie], [tieLine]), []);
  assert.deepEqual(
    findApprovalPanelMismatches([tie], [tieLine]),
    [],
    "a rounding tie is arithmetic, not a defect — paging on it would train everyone to ignore the panel check",
  );

  // The remainder: null until money moves, then value − cash − marketing settlements.
  assert.equal(expectedRemainder({ salesValue: 10000, paidAmount: null, offsetTotal: 0 }), null, "an untouched order owes nothing on record yet");
  assert.equal(expectedRemainder({ salesValue: 10000, paidAmount: 4000, offsetTotal: 0 }), 6000);
  assert.equal(expectedRemainder({ salesValue: 10000, paidAmount: null, offsetTotal: 2500 }), 7500, "a settlement alone starts the remainder");
  assert.equal(expectedRemainder({ salesValue: 10000, paidAmount: 4000, offsetTotal: 2500 }), 3500);

  const remainderOrders = [
    order({ id: "untouched", salesValue: 10000 }),
    order({ id: "paid", salesValue: 10000, paidAmount: 4000, remainingAmount: 6000 }),
    order({ id: "offset-only", salesValue: 10000, remainingAmount: 7500 }),
    order({ id: "stale", salesValue: 10000, paidAmount: 4000, remainingAmount: 10000 }),
    order({ id: "null-with-offset", salesValue: 10000 }),
    order({ id: "negative", salesValue: 10000, paidAmount: 12000, remainingAmount: -2000 }),
  ];
  const remainderOffsets = [
    { directOrderId: "offset-only", amount: 2500 },
    { directOrderId: "null-with-offset", amount: 1000 },
  ];
  const remainderFound = findRemainderMismatches(remainderOrders, remainderOffsets);
  assert.deepEqual(
    remainderFound.map((mismatch) => mismatch.order.id),
    ["stale", "null-with-offset", "negative"],
    "untouched, paid and offset-only orders agree; a stale remainder, a settlement that never reached the remainder and a negative debt are each a finding",
  );
  assert.equal(remainderFound[0].expected, 6000, "the stale finding says what the remainder should read");
  assert.equal(remainderFound[1].expected, 9000);
  assert.equal(remainderFound[1].offsetTotal, 1000);
  assert.equal(
    remainderFound[2].expected,
    -2000,
    "a negative remainder is a finding even when the arithmetic agrees — it reads on a Finance screen as a credit nobody agreed",
  );

  // The four checks are registered, and none may sit open: the panel check was tightened to "holds"
  // the day the panel began pricing every line (19 Oct 2026).
  const directOrderChecks = readFileSync("src/lib/reconciliation/checks/direct-orders.ts", "utf8");
  assert.match(
    readFileSync("src/lib/reconciliation/checks/index.ts", "utf8"),
    /\.\.\.directOrdersReconciliationChecks/,
    "a check that is not in the registry never runs — the nightly cron reads the registry and nothing else",
  );
  assert.equal(
    directOrderChecks.match(/expectation: "holds"/g)?.length,
    4,
    "all four direct-order checks page when they break — a known-open panel check would let the line-one working come back unnoticed",
  );
  assert.equal(/expectation: "known-open"|openDefect:/.test(directOrderChecks), false, "no direct-order check carries a known-open note any more");
}
