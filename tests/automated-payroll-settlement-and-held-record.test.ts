import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { stripComments } from "./support/comment-strip.ts";

/**
 * Two rules about money leaving the system, both structural, both previously unguarded.
 *
 * RULE 1 — A DEBT IS SETTLED AT PUBLISH, FROM WHAT WAS PUBLISHED.
 *
 * When Part-2 deductions exceed an employee's already-paid first instalment, the excess is recorded
 * as a debt to recover next month. The mechanism is well built; the settlement was in the wrong
 * place. `confirmPart2` assembled WITH the balance, deducted it, then marked it recovered — while
 * the three artifacts finance actually executes (the finance sheet, the FAB file, the CIB file)
 * each re-assembled WITHOUT the ledger, and publish then re-assembled a third time by which point
 * `outstandingCarryForwardFor` could no longer see the balance at all, because it filters
 * `applied_run_id is null`.
 *
 * Net: the ledger read settled, the bank transfer and the payslip both paid the un-recovered
 * amount, and the money was never taken back. The ledger is empty against two published months in
 * production, so this was armed rather than fired — it arms the first time any employee's Part-2
 * deductions exceed their first instalment.
 *
 * RULE 2 — A HELD PERSON LEAVES A PERMANENT RECORD.
 *
 * Publish drops held rows, so no salary_record is written and every payslip screen shows nothing.
 * The only trace was a COUNT in the audit row plus a free-text reason on a staging row the next run
 * overwrites, so a month later nothing could answer "who was held in August, for how much, and
 * why". Production held 20 people in August carrying EGP 260,904 of already-paid first instalment,
 * 18 of them with a hold reason of a single dash.
 *
 * Both are asserted against the SOURCE because they are about call placement across an async
 * service that needs a database to run. Each assertion slices one function's own body: the same
 * lesson the additive-import guard records, where a predicate found elsewhere in the file satisfied
 * a check it was not protecting.
 */
export function runAutomatedPayrollSettlementAndHeldRecordTests() {
  const path = "src/lib/automated-payroll/run-service.ts";
  // Line endings are normalised before anything is sliced. A checkout with CRLF makes a literal
  // "\n}\n" search find nothing, and every assertion below would then fail for a reason that has
  // nothing to do with payroll — or, worse in a differently-shaped test, pass vacuously.
  const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");

  // Comments are stripped before asserting on structure — not defensive noise. This caught a real
  // vacuous assertion while this file was being written: the check that the audit detail carries
  // `held` passed with `held: heldRecord` deleted, because the comment above it reads "who was held
  // this month". A source-scanning test that reads its own explanatory prose is checking nothing.
  // `stripComments` is the shared one (tests/support/comment-strip.ts); the private version here
  // truncated each line at its first `//`, which also cut every `https://` in the file in half and
  // saw no block comment at all.

  /** One function's body, from its signature to the next top-level closing brace. */
  function bodyOf(name: string): string {
    const start = source.search(new RegExp(`(export )?async function ${name}\\s*\\(`));
    assert.ok(start >= 0, `${path}: ${name} not found — has it been renamed?`);
    const end = source.indexOf("\n}\n", start);
    assert.ok(end > start, `${path}: could not find the end of ${name}`);
    return source.slice(start, end);
  }

  const confirmPart2 = bodyOf("confirmPart2");
  const publish = bodyOf("publishToPayslips");
  const fab = bodyOf("buildFabSheet");
  const cib = bodyOf("buildCibSheet");
  const finance = bodyOf("buildFinanceSheet");

  // ---- HEADLINE 1: settlement happens at publish, and ONLY at publish -------------------------
  assert.match(
    publish,
    /markCarryForwardApplied\(/,
    `${path}: publishToPayslips must settle the carry-forward ledger — it is the only step that ` +
      "writes salary records, so it is the only step that knows a debt was actually collected",
  );

  assert.ok(
    !/markCarryForwardApplied\(/.test(confirmPart2),
    `${path}: confirmPart2 must NOT mark carry-forward balances applied. Settling at confirm marks ` +
      "a debt collected against money that has not been written yet, and the finance sheet and both " +
      "bank files never carried the deduction at all — so the debt reads settled and nobody paid it",
  );

  // The settlement must be derived from rows that were actually published: a held row assembles
  // (so the deduction shows on the sheet) but is dropped at publish, so its debt was collected
  // from nobody.
  const settlement = publish.slice(publish.search(/markCarryForwardApplied\(/));
  assert.match(
    settlement.slice(0, 500),
    /!entry\.onHold/,
    `${path}: the settlement must exclude held rows — no salary record is written for them, so ` +
      "their balance was recovered from nobody",
  );

  // ---- HEADLINE 2: one assembly path for every payable artifact --------------------------------
  // These three build the money finance executes. Each used to call assembleRows by hand and omit
  // the carry-forward ledger; assembleForRun is the same call publish makes.
  for (const [name, body] of [
    ["buildFinanceSheet", finance],
    ["buildFabSheet", fab],
    ["buildCibSheet", cib],
  ] as const) {
    assert.match(
      body,
      /await assembleForRun\(run\)/,
      `${path}: ${name} must assemble through assembleForRun, the same path publish uses`,
    );
    assert.ok(
      !/assembleRows\(/.test(body),
      `${path}: ${name} must not call assembleRows directly — that is how it came to omit the ` +
        "carry-forward ledger, so a recovery the payslip carried reached none of the three files " +
        "finance actually executes",
    );
  }

  // assembleForRun itself must read the ledger through the loader that also answers for a PUBLISHED
  // run. `outstandingCarryForwardFor` alone returns nothing once the run has settled, so a sheet
  // re-downloaded after publish would silently lose a deduction the real payslip carries.
  const assembleForRunStart = source.search(/async function assembleForRun\s*\(/);
  assert.ok(assembleForRunStart >= 0, `${path}: assembleForRun not found`);
  const assembleForRunBody = source.slice(assembleForRunStart, source.indexOf("\n}\n", assembleForRunStart));
  assert.match(
    assembleForRunBody,
    /carryForwardForRunAssembly\(run\.id\)/,
    `${path}: assembleForRun must use carryForwardForRunAssembly — after publish, ` +
      "outstandingCarryForwardFor can no longer see the balances this run applied",
  );

  // ---- HEADLINE 3: publish records who was held, for how much, and why -------------------------
  assert.match(
    publish,
    /heldRecord/,
    `${path}: publishToPayslips must build a record of every held person before dropping them`,
  );

  const publishCode = stripComments(publish);
  const auditStart = publishCode.search(/action:\s*"published"/);
  assert.ok(auditStart >= 0, `${path}: the published audit write was not found`);
  const auditDetail = publishCode.slice(auditStart);

  // Asserted as object KEYS (`name:` or a shorthand `name,`), not as bare words. `\bheld\b` alone
  // is satisfied by the word "held" in any nearby comment, which is exactly how this assertion
  // first passed with the record deleted.
  for (const field of ["held", "heldFirstPartTotal", "heldSecondPartTotal", "heldExcluded"]) {
    assert.match(
      auditDetail,
      new RegExp(`(^|[\\s{,])${field}\\s*[:,]`),
      `${path}: the published audit detail must carry \`${field}\` — a count alone cannot answer ` +
        "who was held or what they are owed, which is the only record that survives the run",
    );
  }

  assert.match(
    publish,
    /firstPartAlreadyPaid/,
    `${path}: the held record must separate the first instalment (money that already left the ` +
      "company) from the second (what this publish withheld) — settling the person by hand needs both",
  );

  // The bank-coverage answer is captured at the same moment, for the same reason: publish is when
  // the month becomes final, and nothing else records whether both files carried everybody.
  // Asserted as a KEY for the same reason as the held fields: matching the bare word is satisfied
  // by the value expression `bankCoverage.map(...)` even after the key itself has been renamed away.
  assert.match(
    auditDetail,
    /(^|[\s{,])bankCoverage\s*[:,]/,
    `${path}: the published audit detail must record bank coverage — a bank file missing people ` +
      "downloads completely cleanly, so publish is the only place the answer is durable",
  );
}
