import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { downloadError } from "../src/lib/automated-payroll/http.ts";
import {
  assertMatchesPart2Confirm,
  assertPart2FileMatchesStamp,
  compareBankDetails,
  confirmedBeforeStampExisted,
  describeMissingPart2Stamp,
  PART2_BANK_DETAILS_KEY,
  part2BankDetails,
  readConfirmedBankDetails,
} from "../src/lib/automated-payroll/publish-guard.ts";
import { holdRun, type RunHoldDeps } from "../src/lib/automated-payroll/run-hold.ts";
import {
  assertNoTransitionInProgress,
  describeTransitionRefusal,
  isRunHoldAction,
  RUN_HOLD_ACTIONS,
} from "../src/lib/automated-payroll/transition-claim.ts";
import type { MonthlySalaryRun, RunPhase } from "../src/lib/automated-payroll/types.ts";
import { diffSalaryRecordPayloads, SALARY_RECORD_MONEY_COLUMNS } from "../src/lib/payroll/service.ts";

/**
 * WHAT GOES TO THE BANK AND TO THE PAYSLIP IS THE MONTH PART 2 CONFIRMED (audit 2026-10-23).
 *
 * F-08b — the finance sheet and both bank files were rebuilt from live data at download, and only
 * publish compared that with the totals Part 2 confirm stamped. A Part 2 file now runs the same check.
 *
 * S-PAY-08 — a run with no stamp published anyway, recording only that it had not compared. Missing
 * now refuses, and the stamp is written inside the confirm's claim, before the phase, as a required row.
 *
 * S-PAY-09 / F-18 — a batch an earlier publish left behind was finalised without looking at its
 * records, and a create that wrote the batch and then threw was reported as "nothing happened". Publish
 * now compares every record of its own batch with the rows it would write.
 *
 * F-08a / S-PAY-06 — a step save, a step confirm, an exclusion and the two resyncs checked for a
 * transition once and then wrote unconditionally, so they could land inside a Part confirm. They now
 * take the run's claim for their writes (run-hold.ts).
 *
 * Pass 8 broke the publish drift refusal and the bank file's export permission and no test noticed;
 * both are pinned here, behaviourally where the rule is a function.
 */

const STAMP = { employees: 100, firstPart: 700_000, secondPart: 500_000, monthSalary: 1_200_000, net: 1_250_000 };

function run(phase: RunPhase, holder: string | null = null): MonthlySalaryRun {
  return {
    id: "run-1",
    phase,
    transitionAction: holder,
    transitionStartedAt: holder ? new Date().toISOString() : null,
  } as unknown as MonthlySalaryRun;
}

function fakeHold(script: Array<string | null>, current: MonthlySalaryRun, clock = { t: 0 }) {
  const calls = { claims: 0, releases: [] as string[], sleeps: 0 };
  const deps: RunHoldDeps = {
    claim: async () => {
      const answer = script[Math.min(calls.claims, script.length - 1)] ?? null;
      calls.claims += 1;
      return answer;
    },
    release: async (_runId, token) => {
      calls.releases.push(token);
    },
    readRun: async () => current,
    sleep: async (ms) => {
      calls.sleeps += 1;
      clock.t += ms;
    },
    now: () => clock.t,
  };
  return { deps, calls };
}

function bodyOf(source: string, start: string): string {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `could not find ${start}`);
  const end = source.indexOf("\nexport ", at + start.length);
  return source.slice(at, end > 0 ? end : undefined);
}

export async function runAutomatedPayrollMoneyIntegrityTests() {
  // ==== The stamp check itself (M03 survived: the drift refusal could be removed unnoticed) ========
  assert.doesNotThrow(() => assertMatchesPart2Confirm(STAMP, { ...STAMP }, "publish"), "an unchanged month passes");
  assert.doesNotThrow(
    () => assertMatchesPart2Confirm(STAMP, { ...STAMP, net: STAMP.net + 0.004 }, "bank_file"),
    "a sub-cent difference is addition order, not a changed month",
  );
  assert.throws(
    () => assertMatchesPart2Confirm(STAMP, { ...STAMP, monthSalary: STAMP.monthSalary + 500 }, "publish"),
    /^Error: Conflict: This month has changed since Part 2 was confirmed: total month salary/,
    "HEADLINE: 500 EGP appearing after Part 2 confirm REFUSES publish",
  );
  assert.throws(
    () => assertMatchesPart2Confirm(STAMP, { ...STAMP, employees: 99 }, "bank_file"),
    /downloading it now would send the bank figures nobody confirmed/,
    "HEADLINE: and refuses a Part 2 bank file, saying it is the file that was stopped",
  );
  assert.throws(
    () => assertMatchesPart2Confirm(null, STAMP, "publish"),
    /^Error: Conflict: There is no record of the totals Part 2 confirmed/,
    "HEADLINE: no stamp is a refusal, never a pass (S-PAY-08)",
  );
  assert.match(describeMissingPart2Stamp("publish"), /Reopen Part 2 and confirm it again/, "and it names the way out");
  assert.match(describeMissingPart2Stamp("bank_file"), /build this bank file/);

  // ==== Batch record comparison (S-PAY-09) ===========================================================
  const expected = [
    { hr_id: "A-1", batch_id: "b", net_salary: 1000, first_part: 700, full_name: "One" },
    { hr_id: "A-2", batch_id: "b", net_salary: 2000, first_part: 1400, full_name: "Two" },
  ];
  assert.deepEqual(
    diffSalaryRecordPayloads(expected, [
      { hr_id: "A-1", net_salary: "1000.00", first_part: 700.004, full_name: "One" },
      { hr_id: "A-2", net_salary: 2000, first_part: 1400, full_name: "Two" },
    ], { reportExtras: true }),
    [],
    "the same records (numbers compared at 2 dp) are a match",
  );
  const partial = diffSalaryRecordPayloads(expected, [{ hr_id: "A-1", net_salary: 1000, first_part: 700, full_name: "One" }], {
    reportExtras: true,
  });
  assert.deepEqual(partial, ["A-2: row was not saved"], "HEADLINE: a partial batch is a difference");
  const moved = diffSalaryRecordPayloads(expected, [
    { hr_id: "A-1", net_salary: 1500, first_part: 700, full_name: "One" },
    { hr_id: "A-2", net_salary: 2000, first_part: 1400, full_name: "Two" },
  ]);
  assert.deepEqual(moved, ["A-1.net_salary: expected 1000, saved 1500"], "a stale figure is a difference");
  const extra = [
    { hr_id: "A-1", net_salary: 1000, first_part: 700, full_name: "One" },
    { hr_id: "A-2", net_salary: 2000, first_part: 1400, full_name: "Two" },
    { hr_id: "A-9", net_salary: 9000, first_part: 6300, full_name: "Gone" },
  ];
  assert.deepEqual(diffSalaryRecordPayloads(expected, extra), [], "the create's own check ignores extras, as before");
  assert.deepEqual(
    diffSalaryRecordPayloads(expected, extra, { reportExtras: true }),
    ["A-9: saved but not expected"],
    "HEADLINE: a leftover batch holding somebody this run does not pay is a difference",
  );

  // ==== The run hold (F-08a / S-PAY-06) ==============================================================
  {
    const { deps, calls } = fakeHold(["token-1"], run("part2"));
    const out = await holdRun({ runId: "run-1", expected: ["part2"], action: "Saving a step" }, async () => "wrote", deps);
    assert.equal(out, "wrote", "a free run is held, written and");
    assert.deepEqual(calls.releases, ["token-1"], "released");
  }
  {
    const { deps, calls } = fakeHold(["token-2"], run("part2"));
    await assert.rejects(
      holdRun({ runId: "run-1", expected: ["part2"], action: "Saving a step" }, async () => {
        throw new Error("write failed");
      }, deps),
      /write failed/,
    );
    assert.deepEqual(calls.releases, ["token-2"], "a hold is released when its work throws, too");
  }
  {
    const { deps, calls } = fakeHold([null], run("ready"));
    let wrote = false;
    await assert.rejects(
      holdRun({ runId: "run-1", expected: ["part2"], action: "Saving a step" }, async () => {
        wrote = true;
      }, deps),
      /this run is now Part 2 confirmed/,
      "HEADLINE: a save that would land after Part 2 was confirmed is refused",
    );
    assert.equal(wrote, false, "and writes nothing");
    assert.equal(calls.sleeps, 0, "and does not wait: a run that has moved on will not come back");
  }
  {
    const { deps, calls } = fakeHold([null, null, "token-3"], run("part2", "Confirming Part 2"));
    const out = await holdRun({ runId: "run-1", expected: ["part2"], action: "Saving a step" }, async () => "after", deps);
    assert.equal(out, "after", "a hold waits for another holder and then writes");
    assert.equal(calls.claims, 3);
    assert.deepEqual(calls.releases, ["token-3"]);
  }
  {
    const { deps } = fakeHold([null], run("part2", "Confirming Part 2"));
    await assert.rejects(
      holdRun({ runId: "run-1", expected: ["part2"], action: "Saving a step", waitMs: 1000 }, async () => "never", deps),
      /Confirming Part 2 is already in progress/,
      "a holder that outlasts the wait refuses with its name",
    );
  }

  // A hold is not a transition: the early check lets a second save past to WAIT at its own hold, while
  // a real transition still refuses it at once.
  assert.doesNotThrow(
    () => assertNoTransitionInProgress(run("part2", RUN_HOLD_ACTIONS.saveStep)),
    "a second quick save is not refused because the first one is still writing",
  );
  assert.throws(
    () => assertNoTransitionInProgress(run("part2", "Confirming Part 2")),
    /Confirming Part 2 is in progress on this run\. Nothing was saved/,
    "a save while Part 2 is being confirmed is still refused",
  );
  assert.equal(isRunHoldAction(RUN_HOLD_ACTIONS.deductionResync), true);
  assert.equal(isRunHoldAction("Publishing to payslips"), false);

  // ==== Runs confirmed before the stamp existed keep the old behaviour ===============================
  assert.equal(confirmedBeforeStampExisted("2026-08-28T10:00:00Z"), true, "an August confirm predates the stamp");
  assert.equal(confirmedBeforeStampExisted("2026-09-11T17:18:29Z"), true);
  assert.equal(confirmedBeforeStampExisted("2026-09-11T17:18:31Z"), false, "anything since was stamped");
  assert.equal(confirmedBeforeStampExisted(null), false, "no confirm date is never an excuse");
  assert.equal(confirmedBeforeStampExisted("not a date"), false);

  // ==== A published month's files still download (risk review of #6289) ============================
  {
    const moved = { ...STAMP, net: STAMP.net + 500 };
    const august = { phase: "published", part2ConfirmedAt: "2026-08-28T10:00:00Z" };
    const september = { phase: "published", part2ConfirmedAt: "2026-09-29T10:00:00Z" };
    assert.doesNotThrow(
      () => assertPart2FileMatchesStamp(august, null, moved),
      "HEADLINE: a month published before the stamp existed still downloads",
    );
    assert.doesNotThrow(
      () => assertPart2FileMatchesStamp(september, STAMP, moved),
      "HEADLINE: a published month edited since still downloads — reopening Part 2 is not open to it",
    );
    const october = { phase: "ready", part2ConfirmedAt: "2026-10-20T10:00:00Z" };
    assert.throws(
      () => assertPart2FileMatchesStamp(october, STAMP, moved),
      /Conflict/,
      "but a ready month whose figures moved since Part 2 confirm produces no file",
    );
    assert.throws(
      () => assertPart2FileMatchesStamp(october, null, STAMP),
      /Conflict/,
      "and a ready month confirmed since the stamp existed, with none, is refused",
    );
    assert.doesNotThrow(() => assertPart2FileMatchesStamp({ phase: "ready", part2ConfirmedAt: "2026-08-28T10:00:00Z" }, null, STAMP));
    assert.doesNotThrow(() => assertPart2FileMatchesStamp(october, STAMP, STAMP));
  }

  // ==== A changed bank or account refuses the Part 2 file (owner, 2026-10-23 — "block it") ==========
  {
    const RUN = "run-october";
    const confirmedRows = [
      { compact: "a1", bankName: "FAB", bankAccount: "1000200030004000" },
      { compact: "b2", bankName: "CIB", bankAccount: "100045678901" },
    ];
    const names = new Map([["a1", "Mona Adel"], ["b2", "Karim Samir"]]);
    const nameOf = (compact: string) => names.get(compact) ?? "a person no longer on this month's sheet";
    const confirmed = part2BankDetails(RUN, confirmedRows);
    const october = { phase: "ready", part2ConfirmedAt: "2026-10-27T10:00:00Z" };
    const newAccount = part2BankDetails(RUN, [confirmedRows[0], { ...confirmedRows[1], bankAccount: "100099999999" }]);
    assert.throws(
      () => assertPart2FileMatchesStamp(october, STAMP, STAMP, { confirmed, current: newAccount, nameOf }),
      /Conflict: Karim Samir's bank details have changed since Part 2 was confirmed/,
      "HEADLINE: an account number edited after Part 2 confirm refuses the file, naming whose — the totals did not move",
    );
    const newBank = part2BankDetails(RUN, [{ ...confirmedRows[0], bankName: "CIB" }, confirmedRows[1]]);
    assert.throws(
      () => assertPart2FileMatchesStamp(october, STAMP, STAMP, { confirmed, current: newBank, nameOf }),
      /Mona Adel's bank details have changed/,
      "a bank switched from FAB to CIB refuses too — it moves the person between the two files",
    );
    assert.doesNotThrow(
      () =>
        assertPart2FileMatchesStamp(october, STAMP, STAMP, {
          confirmed,
          current: part2BankDetails(RUN, [{ ...confirmedRows[0], bankName: " fab ", bankAccount: " 1000200030004000 " }, confirmedRows[1]]),
          nameOf,
        }),
      "the files trim the account and upper-case the bank, so neither difference is a change",
    );
    assert.doesNotThrow(
      () => assertPart2FileMatchesStamp(october, STAMP, STAMP, { confirmed: null, current: newAccount, nameOf }),
      "a stamp written before the fingerprints existed is held to its totals alone",
    );
    assert.doesNotThrow(
      () => assertPart2FileMatchesStamp({ phase: "published", part2ConfirmedAt: "2026-10-27T10:00:00Z" }, STAMP, STAMP, { confirmed, current: newAccount, nameOf }),
      "a published month still re-downloads — the same window as the totals",
    );
    assert.deepEqual(compareBankDetails(confirmed, part2BankDetails(RUN, confirmedRows.slice(0, 1))), ["b2"], "someone dropped counts as a change");
    assert.throws(
      () => assertPart2FileMatchesStamp(october, STAMP, STAMP, { confirmed, current: part2BankDetails(RUN, confirmedRows.slice(0, 1)), nameOf: (c) => (c === "b2" ? "a person no longer on this month's sheet" : nameOf(c)) }),
      /a person no longer on this month's sheet's bank details/,
    );
    const two = part2BankDetails(RUN, confirmedRows.map((row) => ({ ...row, bankAccount: `${row.bankAccount}9` })));
    assert.throws(
      () => assertPart2FileMatchesStamp(october, STAMP, STAMP, { confirmed, current: two, nameOf }),
      /The bank details of 2 people have changed since Part 2 was confirmed \(Mona Adel, Karim Samir\)/,
    );
    // The stamp is a fingerprint, never the account: the audit trail is kept for ever.
    const serialised = JSON.stringify({ [PART2_BANK_DETAILS_KEY]: confirmed });
    assert.ok(!serialised.includes("1000200030004000") && !serialised.includes("100045678901"), "no account number is stored in the stamp");
    assert.deepEqual(readConfirmedBankDetails(JSON.parse(serialised)), confirmed, "and it reads back exactly as written");
    assert.equal(readConfirmedBankDetails({ confirmedTotals: STAMP }), null, "a pre-fingerprint stamp reads as none");
    assert.notDeepEqual(part2BankDetails("another-run", confirmedRows), confirmed, "fingerprints are keyed to the run");
  }

  // ==== A refused download reads as a page in the browser, JSON elsewhere (owner, 2026-10-23) ========
  {
    const refusal = new Error("Conflict: Karim Samir's bank details have changed since Part 2 was confirmed. <b>x</b>");
    const page = downloadError(new Request("https://phx.test/api/automated-payroll/finance/fab-download", { headers: { accept: "text/html,application/xhtml+xml" } }), refusal);
    assert.equal(page.status, 409);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/, "HEADLINE: a browser download that refuses gets a page, not raw JSON");
    const body = await page.text();
    assert.match(body, /No file was produced/);
    assert.match(body, /Karim Samir&#39;s bank details have changed since Part 2 was confirmed\. &lt;b&gt;x&lt;\/b&gt;/, "the message is shown, escaped, without its Conflict prefix");
    assert.match(body, /href="\/admin\/automated-payroll\/finance"/, "with a way back");
    const json = downloadError(new Request("https://phx.test/api/automated-payroll/finance/fab-download", { headers: { accept: "*/*" } }), refusal);
    assert.match(json.headers.get("content-type") ?? "", /application\/json/, "a script or fetch still gets the JSON it parses");
    assert.equal(((await json.json()) as { error: string }).error.startsWith("Karim Samir"), true);
  }

  // ==== A claim left by a request that died says when it clears =====================================
  {
    const stuck = { transitionAction: "Confirming Part 2", transitionStartedAt: "2026-10-23T08:00:00Z", phase: "part2" as RunPhase };
    const atMs = Date.parse("2026-10-23T08:05:00Z");
    assert.match(
      describeTransitionRefusal(stuck, ["part2"], atMs),
      /If it never finishes, the run frees itself at 11:15 Cairo time\./,
      "HEADLINE: the refusal names the Cairo time the hold lapses (08:00 UTC plus 15 minutes)",
    );
    assert.throws(() => assertNoTransitionInProgress(stuck, atMs), /frees itself at 11:15 Cairo time/);
  }

  // ==== A batch whose payslips are live is compared on pay and people only ===========================
  const live = [
    { hr_id: "A-1", net_salary: 1000, first_part: 700, full_name: "One", job_title: "Medical Rep", payment_mode: "bank" },
  ];
  const renamed = [{ hr_id: "A-1", net_salary: 1000, first_part: 700, full_name: "One", job_title: "Senior Rep", payment_mode: "bank" }];
  assert.equal(diffSalaryRecordPayloads(live, renamed).length, 1, "a title edited between attempts is a difference in full");
  assert.deepEqual(
    diffSalaryRecordPayloads(live, renamed, { columns: SALARY_RECORD_MONEY_COLUMNS }),
    [],
    "HEADLINE: but not a difference in pay, so a live batch is not stranded half-published over it",
  );
  assert.deepEqual(
    diffSalaryRecordPayloads(live, [{ ...renamed[0], payment_mode: "cash" }], { columns: SALARY_RECORD_MONEY_COLUMNS }),
    ["A-1.payment_mode: expected bank, saved cash"],
    "where the money goes is part of pay",
  );
  assert.deepEqual(
    diffSalaryRecordPayloads(live, [], { columns: SALARY_RECORD_MONEY_COLUMNS, reportExtras: true }),
    ["A-1: row was not saved"],
    "and so is who is paid",
  );
  assert.ok(SALARY_RECORD_MONEY_COLUMNS.has("net_salary") && !SALARY_RECORD_MONEY_COLUMNS.has("job_title"));

  // ==== A resync's saved decision still reaches payroll when the hold never frees ====================
  {
    const clock = { t: 0 };
    const { deps, calls } = fakeHold([null], run("part2", "Confirming Part 2"), clock);
    const out = await holdRun(
      { runId: "run-1", expected: ["part1", "part2"], action: RUN_HOLD_ACTIONS.expenseResync, waitMs: 1000, whenWaitRunsOut: "proceed" },
      async () => "cleared",
      deps,
    );
    assert.equal(out, "cleared", "HEADLINE: a resync goes ahead after its wait instead of failing and leaving the old figure");
    assert.deepEqual(calls.releases, [], "with nothing to release, since it never held the run");
  }
  {
    const { deps } = fakeHold([null], run("ready"));
    await assert.rejects(
      holdRun(
        { runId: "run-1", expected: ["part1", "part2"], action: RUN_HOLD_ACTIONS.expenseResync, waitMs: 1000, whenWaitRunsOut: "proceed" },
        async () => "cleared",
        deps,
      ),
      /Part 2 confirmed/,
      "but never onto a run that has moved past the phases it may write in",
    );
  }
  for (const path of ["src/lib/automated-payroll/deduction-resync.ts", "src/lib/automated-payroll/expense-resync.ts"]) {
    assert.match(readFileSync(path, "utf8"), /whenWaitRunsOut: "proceed"/, `${path}: a resync proceeds rather than fails`);
  }

  // ==== Wiring: each rule is actually called where the money moves ===================================
  const runService = readFileSync("src/lib/automated-payroll/run-service.ts", "utf8");

  const publish = bodyOf(runService, "export async function publishToPayslips");
  assert.match(
    publish,
    /const confirmedStamp = await readPart2ConfirmedTotals\(runId\);[\s\S]{0,300}assertMatchesPart2Confirm\(confirmedStamp, part2Totals\(rows\.length, publishTotals\), "publish"\)/,
    "publish must check the rows it writes against the Part 2 stamp",
  );
  const compareAt = publish.indexOf("compareSalaryBatchRecords(batchId, publishRows)");
  const finalizeAt = publish.indexOf("await finalizeApproved(batchId, actorId(access))");
  assert.ok(compareAt > 0 && finalizeAt > compareAt, "publish compares its own batch's records BEFORE it finalises the batch");
  assert.match(publish, /isReplaceableSalaryBatch\(existing\)/, "and only rewrites a batch that is still replaceable");
  assert.match(
    publish,
    /if \(alreadyLive && moneyMismatches\.length > 0\) \{\s*throw new Error\(/,
    "a live batch is refused over pay or people, not over a directory field",
  );
  assert.match(publish, /totalsComparedToConfirm: !predatesStamp/, "the audit row says whether the totals were compared");
  assert.match(publish, /catch \(createError\)[\s\S]{0,200}findSalaryBatchForPeriod/, "a create that throws is followed by a look for the batch (F-18)");

  for (const [builder, guard] of [
    ["export async function buildFinanceSheet", `if (scope === "full") await assertFileMatchesPart2Confirm(run, rows);`],
    ["export async function buildFabSheet", `if (scope === "part2") await assertFileMatchesPart2Confirm(run, rows);`],
    ["export async function buildCibSheet", `if (scope === "part2") await assertFileMatchesPart2Confirm(run, rows);`],
  ] as const) {
    assert.ok(bodyOf(runService, builder).includes(guard), `${builder.replace("export async function ", "")} must check its Part 2 file against the stamp (F-08b)`);
  }
  {
    const fileCheck = bodyOf(runService, "async function assertFileMatchesPart2Confirm");
    assert.match(
      fileCheck,
      /assertPart2FileMatchesStamp\(run, stamp\.totals, part2Totals\(rows\.length, reconcile\(rows\)\), \{\s*confirmed: stamp\.bankDetails,\s*current: part2BankDetails\(run\.id, rows\),/,
      "the three builders run the one download rule — totals and bank details — on the rows they are about to write",
    );
    assert.match(fileCheck, /const stamp = await readPart2ConfirmedStamp\(run\.id\)/);
  }
  for (const route of ["download", "fab-download", "cib-download"]) {
    const source = readFileSync(`app/api/automated-payroll/finance/${route}/route.ts`, "utf8");
    assert.ok(!/jsonError\(/.test(source), `the ${route} route answers a refused browser download with a page (downloadError), never raw JSON`);
    assert.match(source, /return downloadError\(request, error,/);
  }

  const confirm2 = bodyOf(runService, "export async function confirmPart2");
  const stampAt = confirm2.indexOf("await writeRequiredAutomatedPayrollAudit(");
  const phaseAt = confirm2.indexOf(`{ phase: "ready", part2ConfirmedAt: nowIso()`);
  const claimAt = confirm2.indexOf("whileClaimed(runId, transition");
  assert.ok(claimAt > 0 && stampAt > claimAt && phaseAt > stampAt, "the stamp is written inside the claim, before the phase write (S-PAY-08)");
  const ledgerAt = confirm2.indexOf("await recordOverpaidCarryForward(");
  assert.ok(ledgerAt > stampAt, "and before the carry-forward ledger, so a stamp that fails leaves no debt behind");
  assert.match(confirm2, /const \{ rows: rowsUnderClaim \} = await assembleForRun\(run\)/, "Part 2 confirm re-reads the run under its claim");
  assert.equal(
    confirm2.match(/\[PART2_BANK_DETAILS_KEY\]: confirmedBankDetails/g)?.length,
    2,
    "the bank fingerprints ride on BOTH stamp rows — the reader takes the newest, and part2_confirmed is written last",
  );
  assert.match(confirm2, /compareBankDetails\(\s*confirmedBankDetails,\s*part2BankDetails\(runId, rowsUnderClaim\),?\s*\)/, "and a bank change under the claim refuses the confirm");

  assert.match(bodyOf(runService, "export async function confirmPart1"), /frozenFirstPartsDiffer\(/, "and so does Part 1");
  assert.match(
    bodyOf(runService, "export async function saveStep"),
    /await holdRun\(\{ runId, expected: stepWritablePhases\(stepKey\), action: RUN_HOLD_ACTIONS\.saveStep \}/,
    "a step save writes under the hold",
  );
  assert.match(
    bodyOf(runService, "export async function confirmStep"),
    /await holdRun\(\{ runId, expected: stepWritablePhases\(stepKey\), action: RUN_HOLD_ACTIONS\.confirmStep \}/,
    "a step confirm writes under the hold",
  );
  assert.match(
    bodyOf(runService, "async function claimTransition"),
    /isRunHoldAction\(current\.transitionAction\) \|\| !transitionInProgress\(current\)/,
    "a confirm waits out a short hold instead of refusing over a one-second save",
  );
  assert.match(readFileSync("src/lib/automated-payroll/deduction-resync.ts", "utf8"), /return await deps\.holdRun\(/, "the deduction resync clears under the hold");
  assert.match(readFileSync("src/lib/automated-payroll/expense-resync.ts", "utf8"), /held = await holdRun\(/, "the expense resync clears under the hold");

  // ==== The old payroll bank file (M07b survived: read would have been enough) =======================
  const bankRoute = readFileSync("app/api/payroll/[id]/bank-file/route.ts", "utf8");
  assert.match(bankRoute, /assertPermission\(access, "payroll", "export"\)/, "HEADLINE: the bank file needs payroll EXPORT, not read");
  assert.doesNotMatch(bankRoute, /assertPermission\(access, "payroll", "read"\)/);
  assert.match(bankRoute, /"Cache-Control": "no-store"/, "and is never cached (F-21)");
  assert.match(bankRoute, /await writeAuditLog\(\{/, "and every download leaves an audit row");

  // ==== Copilot does not start over an open Automated run (F-11) =====================================
  const copilot = bodyOf(readFileSync("src/lib/payroll/copilot/service.ts", "utf8"), "export async function startRun");
  assert.match(copilot, /\.from\("automated_payroll_runs"\)[\s\S]{0,200}\.in\("phase", \["part1", "part2", "ready"\]\)/, "Copilot checks for an open Automated run");
  assert.match(copilot, /if \(automatedRunsError\) \{[\s\S]{0,400}throw new CopilotError/, "and fails closed when it cannot look");
}
