import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildEmployeeRecordGaps,
  matchesRecordGapSearch,
  recordGapBankLetterHref,
  recordGapBankStanding,
  recordGapBankWord,
  recordGapCounts,
  recordGapInsurance,
  recordGapInsuranceWord,
  recordGapRecordHref,
  recordGapRow,
  recordGapTone,
  rowHasRecordGap,
  type RecordGapSource,
} from "../src/lib/employees/record-gaps-logic.ts";

const TODAY = "2026-11-03";

function source(overrides: Partial<RecordGapSource> = {}): RecordGapSource {
  return {
    bankAccount: "BANK-SECRET-111",
    displayName: "Complete Person",
    hasBankAccount: "yes",
    hireDate: "2024-01-15",
    hrId: "A-1",
    jobTitle: "Medical Rep",
    lineName: "CNS",
    medicalInsuranceNumber: "MED-SECRET-222",
    medicalInsuranceStatus: "yes",
    payrollEligible: true,
    socialInsuranceNumber: "SOC-SECRET-333",
    socialInsuranceStatus: "yes",
    ...overrides,
  };
}

/** The bank's number is the proof, and a yes with no number is still a gap. */
function testTheBankStanding() {
  assert.equal(recordGapBankStanding({ bankAccount: "123", hasBankAccount: "yes" }), "yes");
  assert.equal(recordGapBankStanding({ bankAccount: "123", hasBankAccount: "no" }), "yes", "a number outranks the word beside it");
  assert.equal(recordGapBankStanding({ bankAccount: null, hasBankAccount: "yes" }), "marked_yes_no_number");
  assert.equal(recordGapBankStanding({ bankAccount: "   ", hasBankAccount: "yes" }), "marked_yes_no_number", "blanks are not a number");
  assert.equal(recordGapBankStanding({ bankAccount: null, hasBankAccount: "no" }), "no");
  assert.equal(recordGapBankStanding({ bankAccount: null, hasBankAccount: null }), "no", "blank reads as no");
  assert.equal(recordGapBankWord("yes"), "Yes");
  assert.equal(recordGapBankWord("no"), "No");
  assert.equal(recordGapBankWord("marked_yes_no_number"), "Marked yes, no account number");
}

/** Production holds 25 people with a social insurance number and no status: neither stands for the other. */
function testTheInsuranceStanding() {
  const read = (status: string | null, number: string | null) => recordGapInsurance(status, number);
  assert.deepEqual(read("yes", "1"), { hasNumber: true, standing: "yes" });
  assert.deepEqual(read(" YES ", "1"), { hasNumber: true, standing: "yes" }, "the status is read whatever its case");
  assert.deepEqual(read("yes", null), { hasNumber: false, standing: "marked_yes_no_number" });
  assert.deepEqual(read(null, "1"), { hasNumber: true, standing: "number_no_status" }, "a number never stands in for the status");
  assert.deepEqual(read(null, null), { hasNumber: false, standing: "not_recorded" });
  assert.deepEqual(read("pending", "1"), { hasNumber: true, standing: "pending" });
  assert.deepEqual(read("no", null), { hasNumber: false, standing: "marked_no" });
  assert.deepEqual(read("something else", null), { hasNumber: false, standing: "not_recorded" }, "an unknown word is not a status");

  assert.equal(recordGapInsuranceWord(read(null, "1")), "Number on file, status not set");
  assert.equal(recordGapInsuranceWord(read(null, null)), "Not recorded");
  assert.equal(recordGapInsuranceWord(read("pending", "1")), "Pending, number on file");
  assert.equal(recordGapInsuranceWord(read("pending", null)), "Pending, no number");
  assert.equal(recordGapInsuranceWord(read("no", "1")), "Marked no, number on file");
  assert.equal(recordGapInsuranceWord(read("no", null)), "Marked no, no number");
  assert.equal(recordGapInsuranceWord(read("yes", null)), "Marked yes, no number");
  assert.equal(recordGapInsuranceWord(read("yes", "1")), "Yes");
}

/** HR's own no or pending may be right, and nothing on this list is ever red. */
function testTheColours() {
  assert.equal(recordGapTone("yes"), "ok");
  assert.equal(recordGapTone("pending"), "muted");
  assert.equal(recordGapTone("marked_no"), "muted");
  for (const standing of ["no", "marked_yes_no_number", "number_no_status", "not_recorded"] as const) {
    assert.equal(recordGapTone(standing), "warn", `${standing} is what somebody still has to record`);
  }
  const panel = readFileSync("src/components/employees/employee-record-gaps.tsx", "utf8");
  assert.ok(!panel.includes("text-phx-danger"), "a gap is never painted as an error");
}

/** 🔴 The numbers are read to say whether they exist, and never leave the server. */
function testNoNumberLeavesTheServer() {
  const row = recordGapRow(source({ medicalInsuranceStatus: "no", socialInsuranceStatus: null }), TODAY);
  const sent = JSON.stringify(row);
  for (const secret of ["BANK-SECRET-111", "MED-SECRET-222", "SOC-SECRET-333"]) {
    assert.ok(!sent.includes(secret), `${secret} must not reach the browser`);
  }
  assert.deepEqual(
    Object.keys(row).sort(),
    ["bank", "displayName", "gaps", "hireDate", "hrId", "jobTitle", "joinedRecently", "lineName", "medicalInsurance", "payrollEligible", "socialInsurance"],
    "a new field on the row is a decision, not an accident",
  );
  const data = JSON.stringify(buildEmployeeRecordGaps([source({ medicalInsuranceStatus: "no" })], TODAY));
  assert.ok(!data.includes("SECRET"), "and the whole answer carries none of them");

  const panel = readFileSync("src/components/employees/employee-record-gaps.tsx", "utf8");
  for (const field of ["bankAccount", "socialInsuranceNumber", "medicalInsuranceNumber", "nationalId", "baseSalary"]) {
    assert.ok(!panel.includes(field), `the screen never names ${field}`);
  }
  const page = readFileSync("app/(admin)/employees/record-gaps/page.tsx", "utf8");
  assert.ok(!page.includes("<EmployeeRecordGaps directory"), "the page hands over the list, never the directory");
  assert.ok(!page.includes("getEmployeeDirectory"), "the page never holds the directory at all");
}

/** Only people with a gap are listed, and everyone read is still counted. */
function testWhoIsListedAndInWhatOrder() {
  const data = buildEmployeeRecordGaps(
    [
      source({ displayName: "Complete", hrId: "A" }),
      source({ bankAccount: null, displayName: "One gap, older", hasBankAccount: "no", hireDate: "2023-05-01", hrId: "B" }),
      source({ bankAccount: null, displayName: "One gap, newer", hasBankAccount: "no", hireDate: "2026-10-20", hrId: "C" }),
      source({ bankAccount: null, displayName: "Three gaps", hasBankAccount: null, hireDate: "2026-10-25", hrId: "D", medicalInsuranceStatus: null, socialInsuranceStatus: "pending" }),
    ],
    TODAY,
  );
  assert.equal(data.activeEmployees, 4, "the denominator is everyone read");
  assert.deepEqual(data.rows.map((row) => row.displayName), ["Three gaps", "One gap, older", "One gap, newer"]);
  assert.deepEqual(data.rows.map((row) => row.gaps), [3, 1, 1]);
  assert.equal(data.todayKey, TODAY);
}

function testFiltersAndCounts() {
  const rows = buildEmployeeRecordGaps(
    [
      source({ bankAccount: null, hasBankAccount: "no", hrId: "B" }),
      source({ hrId: "S", socialInsuranceStatus: null }),
      source({ hrId: "M", medicalInsuranceStatus: "no" }),
      source({ bankAccount: null, hasBankAccount: "no", hrId: "X", medicalInsuranceStatus: null }),
    ],
    TODAY,
  ).rows;
  assert.deepEqual(recordGapCounts(rows), { all: 4, bank: 2, medical: 2, social: 1 }, "a person with two gaps counts once in each and once overall");
  assert.deepEqual(rows.filter((row) => rowHasRecordGap(row, "social")).map((row) => row.hrId), ["S"]);

  const [row] = rows.filter((candidate) => candidate.hrId === "S");
  assert.ok(matchesRecordGapSearch(row, ""));
  assert.ok(matchesRecordGapSearch(row, " complete "), "by name, whatever the case");
  assert.ok(matchesRecordGapSearch(row, "medical rep"), "by job title");
  assert.ok(matchesRecordGapSearch(row, "cns"), "by line");
  assert.ok(!matchesRecordGapSearch(row, "pedia"));
}

/** A recent joiner often waits on these details, and someone off payroll may never need a bank. */
function testTheRowSaysWhatMayExplainAGap() {
  const row = (hireDate: string | null) => recordGapRow(source({ hireDate }), TODAY);
  assert.equal(row("2026-10-04").joinedRecently, true, "30 days is still recent");
  assert.equal(row("2026-10-03").joinedRecently, false, "31 is not");
  assert.equal(row(null).joinedRecently, false);
  assert.equal(row("2026-10-04T00:00:00+00:00").hireDate, "2026-10-04", "a stored timestamp reads as its day");
  assert.equal(recordGapRow(source({ payrollEligible: false }), TODAY).payrollEligible, false);

  const panel = readFileSync("src/components/employees/employee-record-gaps.tsx", "utf8");
  assert.ok(panel.includes("Recent joiner, these details often come later"));
  assert.ok(panel.includes("Not on payroll"));
}

/** 🔴 Server-side: the master's own read, the viewer's own filter, the master's own idea of active. */
function testTheReadAndTheGate() {
  const reader = readFileSync("src/lib/employees/record-gaps.ts", "utf8");
  assert.ok(reader.includes("filterEmployeeDirectoryForAccess(await getEmployeeDirectory(), access)"), "the list is scoped to the viewer");
  assert.ok(reader.includes("directory.employees.filter(isActiveDirectoryEmployee)"), "the master's rule decides who is active");

  const page = readFileSync("app/(admin)/employees/record-gaps/page.tsx", "utf8");
  assert.ok(page.includes('canAccess(access, "employees", "read")'), "the page is gated on the Employee Master's own grant");
  assert.ok(page.includes('canAccess(access, "employees", "update")'), "Open record goes only to a seat that can save");
  assert.ok(page.includes("forms.canRead && forms.paperScope === null"), "the bank letter link goes only to a seat its page admits");

  const panel = readFileSync("src/components/employees/employee-record-gaps.tsx", "utf8");
  assert.ok(panel.includes("if (!canEdit) return null;"), "a reader is offered no form");
  assert.ok(panel.includes("canOpenBankLetter ?"), "and no letter it would be refused");
  assert.ok(panel.includes("The record gaps could not be read"), "a failed read says so");
  assert.ok(panel.includes("{data ? ("), "and draws no figures, because a row of zeros would read as an answer");
  assert.ok(!/fetch\(|method: "POST"/u.test(panel), "this screen writes nothing");
}

/** An HR seat stays under /hr, so the redirect off a bare address never has to carry the person. */
function testTheLinksStayInTheirShell() {
  assert.equal(recordGapRecordHref("/hr/employees/record-gaps", "B-1"), "/hr/employees?edit=B-1");
  assert.equal(recordGapRecordHref("/employees/record-gaps", "B-1"), "/employees?edit=B-1");
  assert.equal(recordGapRecordHref(null, "B 1"), "/employees?edit=B%201", "and the id is encoded");
  assert.equal(recordGapBankLetterHref("/hr/employees/record-gaps"), "/hr/hiring-pack/bank-account-letter");
  assert.equal(recordGapBankLetterHref("/employees/record-gaps"), "/hiring-pack/bank-account-letter");
  assert.equal(recordGapBankLetterHref(null), "/hiring-pack/bank-account-letter");
}

function testTheLayoutRules() {
  const panel = readFileSync("src/components/employees/employee-record-gaps.tsx", "utf8");
  assert.ok(panel.includes('className="w-full table-fixed'), "the desktop table fits the screen");
  assert.ok(panel.includes("<colgroup>"));
  assert.ok(panel.includes('className="hidden md:block"'), "a table on desktop");
  assert.ok(panel.includes('className="space-y-3 p-4 md:hidden"'), "cards on a phone");
  for (const banned of ["overflow-x-auto", "truncate", "rounded"]) {
    assert.ok(!panel.includes(banned), `${banned} breaks a golden rule`);
  }
}

function testTheRowIsOnTheRails() {
  const nav = readFileSync("src/config/system-navigation.ts", "utf8");
  assert.ok(nav.includes('href: "/hr/employees/record-gaps"'), "the HR rail has the row");
  assert.ok(nav.includes('href: "/employees/record-gaps"'), "the People Management hub has the card");
  assert.ok(nav.includes('"/employees/record-gaps",'), "and it sits with the Employee Records group");
}

export function runEmployeeRecordGapsTests() {
  testTheBankStanding();
  testTheInsuranceStanding();
  testTheColours();
  testNoNumberLeavesTheServer();
  testWhoIsListedAndInWhatOrder();
  testFiltersAndCounts();
  testTheRowSaysWhatMayExplainAGap();
  testTheReadAndTheGate();
  testTheLinksStayInTheirShell();
  testTheLayoutRules();
  testTheRowIsOnTheRails();
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("tests/employee-record-gaps.test.ts")) {
  runEmployeeRecordGapsTests();
  console.log("employee-record-gaps: pass");
}
