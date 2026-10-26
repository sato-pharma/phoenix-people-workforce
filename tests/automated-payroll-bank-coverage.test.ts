import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { AssembledRow } from "../src/lib/automated-payroll/assemble.ts";
import {
  buildBankCoverage,
  describeBankCoverage,
  resolveBankRoute,
} from "../src/lib/automated-payroll/exports/bank-coverage.ts";
import { cibRowsForNonEmployees, cibRowsForScope } from "../src/lib/automated-payroll/exports/cib-sheet.ts";
import { fabRowsForNonEmployees, fabRowsForScope } from "../src/lib/automated-payroll/exports/fab-sheet.ts";
import { xlsxResponse } from "../src/lib/automated-payroll/http.ts";
import { validateNonEmployeePayrollInput } from "../src/lib/automated-payroll/non-employees.ts";
import type { NonEmployeePart, NonEmployeePayrollRow } from "../src/lib/automated-payroll/types.ts";
import type { SalaryValidationRow } from "../src/lib/payroll/salary-import.ts";

/**
 * Every payable row reaches a bank file, or is NAMED.
 *
 * THE DEFECT, measured on production 2026-09-10. `fabRowsForScope` and `cibRowsForScope` route on
 * an exact, case-folded match of the words "FAB" and "CIB" and silently drop everything else. The
 * only check on either finished file was whether it came out completely EMPTY, so a file missing a
 * fifth of the population downloaded clean and reported nothing anywhere.
 *
 * Three people on the live August standing roster are in neither file: Medhat Makram and Nabil Adly
 * on "QNB", Walaa Abdelwahab on "Instapay" — EGP 19,000 a month. The finance sheet's TOTALS row
 * still counted their money, because it filters on the amount column and never on the bank. So the
 * sheet certified a payment the bank files could not make, for two months, in silence.
 *
 * WHAT THIS FILE PINS, in order of what it would cost to lose:
 *
 *   1. Coverage RECONCILES. FAB + CIB + unroutable = every payable row. There is no fourth bucket
 *      and nothing falls off the edge — this is the assertion that makes the other two matter.
 *   2. The routing decision did NOT MOVE. The rows the coverage counts as FAB/CIB are exactly the
 *      rows the two sheet builders emit. If adopting the shared helper had changed who is paid,
 *      this fails.
 *   3. An unroutable row is named WITH A REASON, and the reasons are distinguishable: "QNB" and
 *      "FAB with no account number" send whoever reads them to different places.
 *   4. A paid non-employee cannot be saved with no bank or no account. Neither was required before.
 */

function buildAssembledRow(overrides: {
  hrId?: string;
  fullName?: string;
  firstPart?: number;
  secondPart?: number;
  onHold?: boolean;
  bankName?: string | null;
  bankAccount?: string | null;
}): AssembledRow {
  const row: SalaryValidationRow = {
    area: "Cairo",
    baseSalary: 10000,
    bonus: 0,
    calendarDays: 30,
    crm: 0,
    hrId: overrides.hrId ?? "B-1",
    employmentIncomeTax: 0,
    expenses: 0,
    extraCostOfLiving: 0,
    fingerPrint: 0,
    firstPart: overrides.firstPart ?? 5000,
    fuelAllowance: 0,
    governmentalDeductions: 0,
    fullName: overrides.fullName ?? "Jane Doe",
    grossSalary: 10000,
    hireDate: null,
    incentive: 0,
    jobTitle: "Rep",
    line: "Line 1",
    loans: 0,
    medicalInsurance: 0,
    monthSalary: 10000,
    nameAr: null,
    netSalary: 10000,
    otherAdditions: 0,
    otherDeductions: 0,
    overtime: 0,
    payrollComment: null,
    paymentMode: "two_parts",
    row: 1,
    secondPart: overrides.secondPart ?? 5000,
    socialInsurance: 0,
    totalAdditions: 0,
    totalDeductions: 0,
    unpaidVacations: 0,
    workingDays: 30,
  };
  return {
    row,
    compact: (overrides.hrId ?? "B-1").toLowerCase(),
    onHold: overrides.onHold ?? false,
    overpaidResidual: 0,
    // The engine's own answer for what the month owes. reconcile() compares the split against
    // THIS rather than against monthSalary, which is defined as the split itself.
    totalPayable: (overrides.firstPart ?? 5000) + (overrides.secondPart ?? 5000),
    carriedForwardApplied: 0,
    heldReleaseApplied: 0,
    payDeferralApplied: 0,
    lifecycle: "regular",
    bankName: overrides.bankName === undefined ? "FAB" : overrides.bankName,
    bankAccount: overrides.bankAccount === undefined ? "00100000001" : overrides.bankAccount,
  };
}

function buildNonEmployeeRow(overrides: {
  fullNameEn?: string;
  totalSalary?: number;
  bankName?: string | null;
  bankAccount?: string | null;
  part?: NonEmployeePart;
}): NonEmployeePayrollRow {
  return {
    id: `id-${overrides.fullNameEn ?? "x"}`,
    runId: "run",
    part: overrides.part ?? "first",
    fullNameAr: "اسم",
    fullNameEn: overrides.fullNameEn ?? "Non Employee Person",
    totalSalary: overrides.totalSalary ?? 3000,
    bankName: overrides.bankName === undefined ? "CIB" : overrides.bankName,
    bankAccount: overrides.bankAccount === undefined ? "100222220001" : overrides.bankAccount,
    recurringId: null,
    createdBy: null,
    createdAt: "",
    updatedAt: "",
  };
}

export function runAutomatedPayrollBankCoverageTests() {
  // ---- resolveBankRoute: one decision, three answers -----------------------------------------
  assert.equal(resolveBankRoute({ bankName: "FAB", bankAccount: "1" }).route, "FAB");
  assert.equal(resolveBankRoute({ bankName: "CIB", bankAccount: "1" }).route, "CIB");
  // Case and whitespace are tolerated exactly as the sheet builders always did.
  assert.equal(resolveBankRoute({ bankName: "  fab ", bankAccount: "1" }).route, "FAB");
  assert.equal(resolveBankRoute({ bankName: "cib", bankAccount: "1" }).route, "CIB");

  // The three live cases, by name, because these are the ones that were silently unpaid.
  for (const bank of ["QNB", "Instapay", "NBE", "CIB Bank", "FABMISR"]) {
    const decision = resolveBankRoute({ bankName: bank, bankAccount: "1" });
    assert.equal(decision.route, "unroutable", `${bank} must not be treated as a bulk-file bank`);
    assert.match(
      decision.reason ?? "",
      new RegExp(bank.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the reason for ${bank} must name the bank, or whoever reads it cannot act on it`,
    );
  }

  // A blank bank and a bank with no account are DIFFERENT problems and must not collapse into one
  // message: they send whoever has to fix them to different places.
  const noBank = resolveBankRoute({ bankName: "  ", bankAccount: "1" });
  const noAccount = resolveBankRoute({ bankName: "FAB", bankAccount: "" });
  assert.equal(noBank.route, "unroutable");
  assert.equal(noAccount.route, "unroutable");
  assert.match(noBank.reason ?? "", /no bank recorded/i);
  assert.match(noAccount.reason ?? "", /account number/i);
  assert.notEqual(noBank.reason, noAccount.reason);

  // ---- HEADLINE 1: coverage reconciles, and names the unroutable ------------------------------
  const rows = [
    buildAssembledRow({ hrId: "B-1", fullName: "Fab Person", bankName: "FAB", firstPart: 5000, secondPart: 2000 }),
    buildAssembledRow({ hrId: "B-2", fullName: "Cib Person", bankName: "CIB", firstPart: 4000, secondPart: 1000 }),
    // Held: not unroutable, not payable here — a hold is a decision, recorded elsewhere.
    buildAssembledRow({ hrId: "B-3", fullName: "Held Person", onHold: true, firstPart: 9000, secondPart: 9000 }),
    // Fully settled in Part 1: a zero Part-2 amount is not a coverage gap.
    buildAssembledRow({ hrId: "B-4", fullName: "Settled Leaver", firstPart: 7000, secondPart: 0 }),
    buildAssembledRow({ hrId: "B-5", fullName: "No Account Person", bankAccount: "", firstPart: 3000, secondPart: 500 }),
  ];
  const nonEmployees = [
    buildNonEmployeeRow({ fullNameEn: "Medhat Makram", bankName: "QNB", totalSalary: 7000, part: "first" }),
    buildNonEmployeeRow({ fullNameEn: "Nabil Adly", bankName: "QNB", totalSalary: 7000, part: "first" }),
    buildNonEmployeeRow({ fullNameEn: "Walaa Abdelwahab", bankName: "Instapay", totalSalary: 5000, part: "first" }),
    buildNonEmployeeRow({ fullNameEn: "Cib Consultant", bankName: "CIB", totalSalary: 90000, part: "second" }),
  ];

  const part1 = buildBankCoverage({ rows, nonEmployees, scope: "part1" });

  // The reconciliation. Every payable row is in exactly one bucket.
  assert.equal(
    part1.fab.rows + part1.cib.rows + part1.unroutable.length,
    part1.payableRows,
    "coverage must account for every payable row — FAB, CIB, or named",
  );
  assert.equal(
    Math.round((part1.fab.total + part1.cib.total + part1.unroutableTotal) * 100) / 100,
    part1.payableTotal,
    "the three bucket totals must sum to the payable total",
  );

  // The three real people are named, with their money.
  const namedPart1 = part1.unroutable.map((entry) => entry.name).sort();
  assert.deepEqual(
    namedPart1,
    ["Medhat Makram", "Nabil Adly", "No Account Person", "Walaa Abdelwahab"],
    "every payable row that reaches no bank file must be named",
  );
  assert.equal(part1.unroutableTotal, 7000 + 7000 + 5000 + 3000);
  assert.equal(part1.covered, false);

  // The held person is in NO bucket: not paid, not reported as a routing gap.
  assert.ok(
    !part1.unroutable.some((entry) => entry.name === "Held Person"),
    "a held row is a decision, not a bank-routing failure — it must not appear here",
  );

  // A zero Part-2 amount is not a gap either.
  const part2 = buildBankCoverage({ rows, nonEmployees, scope: "part2" });
  assert.ok(
    !part2.unroutable.some((entry) => entry.name === "Settled Leaver"),
    "a leaver settled in Part 1 has nothing owed in Part 2 and is not a coverage gap",
  );
  // Part 2 carries only the second-instalment non-employee plus the two payable employees.
  assert.equal(part2.cib.rows, 2, "Cib Person and the Part-2 consultant");
  assert.equal(part2.cib.total, 1000 + 90000);

  // ---- HEADLINE 2: the routing decision did not move -------------------------------------------
  // The rows coverage counts must be exactly the rows the two builders emit. If adopting the shared
  // helper had changed who is paid, this fails — which is the whole reason it is asserted.
  for (const scope of ["part1", "part2"] as const) {
    const coverage = buildBankCoverage({ rows, nonEmployees, scope });
    const fabEmitted = [...fabRowsForScope(rows, scope), ...fabRowsForNonEmployees(nonEmployees, scope)];
    const cibEmitted = [...cibRowsForScope(rows, scope), ...cibRowsForNonEmployees(nonEmployees, scope)];
    assert.equal(coverage.fab.rows, fabEmitted.length, `${scope}: coverage and the FAB file must agree on row count`);
    assert.equal(coverage.cib.rows, cibEmitted.length, `${scope}: coverage and the CIB file must agree on row count`);
    assert.equal(
      coverage.fab.total,
      Math.round(fabEmitted.reduce((sum, entry) => sum + entry.salary, 0) * 100) / 100,
      `${scope}: coverage and the FAB file must agree on money`,
    );
    assert.equal(
      coverage.cib.total,
      Math.round(cibEmitted.reduce((sum, entry) => sum + entry.salary, 0) * 100) / 100,
      `${scope}: coverage and the CIB file must agree on money`,
    );
  }

  // ---- A covered part says so EXPLICITLY -------------------------------------------------------
  // "No warning" and "not checked" have looked identical here for two months, so silence is not an
  // acceptable way to report success.
  const cleanCoverage = buildBankCoverage({
    rows: [buildAssembledRow({ hrId: "B-9", bankName: "FAB", firstPart: 1000, secondPart: 0 })],
    nonEmployees: [],
    scope: "part1",
  });
  assert.equal(cleanCoverage.covered, true);
  assert.match(describeBankCoverage(cleanCoverage), /all 1 payable rows reach a bank file/i);

  const dirtySummary = describeBankCoverage(part1);
  assert.match(dirtySummary, /reach NO bank file/i);
  for (const name of ["Medhat Makram", "Nabil Adly", "Walaa Abdelwahab"]) {
    assert.ok(dirtySummary.includes(name), `the summary must name ${name}`);
  }

  // ---- HEADLINE 3: a paid non-employee must say where the money goes ---------------------------
  // Neither field was required before, so a blank bank produced a row every total counted as paid
  // while no file carried it.
  assert.throws(
    () => validateNonEmployeePayrollInput({ fullNameAr: "ا", fullNameEn: "A", totalSalary: 5000, bankAccount: "1" }),
    /bank is required/i,
    "a paid entry with no bank must be refused",
  );
  assert.throws(
    () => validateNonEmployeePayrollInput({ fullNameAr: "ا", fullNameEn: "A", totalSalary: 5000, bankName: "CIB" }),
    /account number is required/i,
    "a paid entry with no account number must be refused",
  );
  // A zero-salary placeholder row is still allowed — it pays nobody, so it needs no route.
  assert.doesNotThrow(() =>
    validateNonEmployeePayrollInput({ fullNameAr: "ا", fullNameEn: "A", totalSalary: 0 }),
  );
  // And a bank this system cannot pay in bulk is still ACCEPTED, deliberately: three real people
  // are paid that way every month, and refusing the name would break their entry rather than
  // surface the problem. They are named by the coverage report instead.
  assert.doesNotThrow(() =>
    validateNonEmployeePayrollInput({
      fullNameAr: "ا",
      fullNameEn: "Medhat Makram",
      totalSalary: 7000,
      bankName: "QNB",
      bankAccount: "1",
    }),
  );

  // ---- HEADLINE 4: the coverage answer travels on the download ---------------------------------
  //
  // The durable half of this finding — the answer written into the publish audit row — is pinned by
  // automated-payroll-settlement-and-held-record.test.ts. The half finance actually SEES was pinned
  // by nothing: removing `[coverage]` from a download route left every test in this repository
  // green (measured 2026-09-12, re-verifying findings 2 and 3), and the workbook cover carries no
  // coverage block either, so the header is the only place a downloader is told.

  const arabicName = "مدحت مكرم";
  const uncovered = buildBankCoverage({
    rows: [],
    nonEmployees: [buildNonEmployeeRow({ fullNameEn: arabicName, bankName: "QNB", totalSalary: 7000 })],
    scope: "part1",
  });
  const covered = buildBankCoverage({
    rows: [],
    nonEmployees: [buildNonEmployeeRow({ fullNameEn: "Cib Person" })],
    scope: "part1",
  });

  const uncoveredResponse = xlsxResponse(Buffer.from("x"), "f.xlsx", [uncovered]);
  assert.equal(
    uncoveredResponse.headers.get("X-Bank-Coverage-Complete"),
    "false",
    "HEADLINE: a download whose bank file misses somebody must say so on the response — the " +
      "workbook opens perfectly well either way, which is how three people were absent from both " +
      "transfer files for two months with nothing anywhere saying so",
  );
  const summary = uncoveredResponse.headers.get("X-Bank-Coverage") ?? "";
  assert.ok(summary.length > 0, "the download must carry the coverage summary, not only the boolean");
  assert.ok(
    [...summary].every((char) => char.charCodeAt(0) <= 0xff),
    "the summary header must be percent-encoded: it names people, the names here are routinely " +
      "Arabic, and a raw non-Latin-1 header value throws rather than degrading",
  );
  assert.ok(
    decodeURIComponent(summary).includes(arabicName),
    "the decoded summary must still name the person the bank file cannot pay",
  );

  const coveredResponse = xlsxResponse(Buffer.from("x"), "f.xlsx", [covered]);
  assert.equal(
    coveredResponse.headers.get("X-Bank-Coverage-Complete"),
    "true",
    "a covered download must say so EXPLICITLY — silence has meant both 'nobody is missing' and " +
      "'nobody checked', and those must never look alike again",
  );

  // The third argument is the whole mechanism, so every finance download must pass it.
  for (const route of [
    "app/api/automated-payroll/finance/download/route.ts",
    "app/api/automated-payroll/finance/fab-download/route.ts",
    "app/api/automated-payroll/finance/cib-download/route.ts",
  ]) {
    const source = readFileSync(route, "utf8");
    const call = source.match(/xlsxResponse\(([^;]*)\)/);
    assert.ok(call, `${route}: no xlsxResponse call found — has the download been rewired?`);
    assert.ok(
      call![1].split(",").length >= 3,
      `${route}: xlsxResponse must be given the bank coverage. Without the third argument the ` +
        "download loses both headers, and nothing else on the response or in the workbook says " +
        "whether the file carries everybody",
    );
  }
}
