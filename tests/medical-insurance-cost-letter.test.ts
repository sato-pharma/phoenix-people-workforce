import assert from "node:assert/strict";

import { buildCostLetter, costLetterFileName, renderCostLetterHtml } from "../src/lib/medical-insurance/cost-letter.ts";
import { costLetterRows, type MonthlySplitPerson, type MonthlySplitRow } from "../src/lib/medical-insurance/monthly-split.ts";

// Owner, 21 Nov 2026: a PDF per employee showing his grade, what he pays each month, his family beside him with
// a total, and his table of benefits — "ما يظهرلوش برسنتج 30%، يظهر له المبلغ على طول". These pin that the paper
// prints the Cost tab's own numbers to the piastre, never the split's percentages, and refuses a short figure.

const POLICY = { endsOn: "2027-11-26", insurer: "Libano-Suisse Takaful Egypt", policyNumber: "50048950", startsOn: "2026-11-22" };

function person(overrides: Partial<MonthlySplitPerson>): MonthlySplitPerson {
  return { band: "26 to 35", category: "B", memberId: "m-employee", memberType: "employee", monthly: 1000.55, name: "Test Employee Name", startsOn: null, unpricedReason: null, ...overrides };
}

/** A row as buildMonthlySplit makes it: own share 300.17 (30% of 1000.55), a spouse and a child in full, EGP 85 each. */
function familyRow(): MonthlySplitRow {
  const family = [
    person({ category: "B", memberId: "m-spouse", memberType: "spouse", monthly: 900.4, name: "Test Spouse Name" }),
    person({ category: "C", memberId: "m-child", memberType: "child", monthly: 410.25, name: "Test Child Name", startsOn: "2026-12-01" }),
  ];
  return {
    companyPays: 700.38,
    employee: person({}),
    employeeOwnShare: 300.17,
    employeePays: 300.17 + 900.4 + 410.25 + 3 * 85,
    family,
    familyMonthly: 1310.65,
    hrId: "TEST-1",
    key: "row-1",
    lifeInsurance: 255,
    ownMonthly: 1000.55,
    people: 3,
    raisedToMinimum: false,
    unpriced: 0,
  };
}

/** The lines are the Cost tab's figures: his own share plus life, each relative in full plus life, adding to employeePays. */
function testTheLinesAreTheCostTabsFigures() {
  const row = familyRow();
  const letter = buildCostLetter(row, POLICY);
  assert.equal(letter.plan, "B");
  assert.deepEqual(
    letter.people.map((p) => [p.name, p.memberType, p.plan, p.medical, p.life, p.monthly]),
    [
      ["Test Employee Name", "employee", "B", 300.17, 85, 385.17],
      ["Test Spouse Name", "spouse", "B", 900.4, 85, 985.4],
      ["Test Child Name", "child", "C", 410.25, 85, 495.25],
    ],
  );
  assert.equal(letter.own, 385.17);
  assert.equal(letter.family, 1480.65);
  assert.equal(letter.total, 1865.82);
  assert.equal(Math.round(letter.total * 100), Math.round(row.employeePays * 100), "the paper's total is the Cost tab's, to the piastre");
  assert.equal(letter.people[2].startsOn, "2026-12-01");
}

/** The paper shows amounts, never the split: no 30%, 70%, company share or minimum anywhere in it. */
function testThePaperNeverShowsTheSplit() {
  const html = renderCostLetterHtml(buildCostLetter(familyRow(), POLICY), "21 November 2026");
  const text = html.replace(/<style>[\s\S]*?<\/style>/, "");
  for (const forbidden of [/30\s*%/, /70\s*%/, /company (pays|carries|share)/i, /minimum/i, /\bshare of\b/i]) {
    assert.doesNotMatch(text, forbidden, `the statement never says ${forbidden}`);
  }
  for (const shown of ["EGP 385.17", "EGP 985.40", "EGP 495.25", "EGP 1,480.65", "EGP 1,865.82", "Test Spouse Name", "Test Child Name", "Cover from 1 December 2026", "Policy 50048950"]) {
    assert.ok(text.includes(shown), `the statement shows ${shown}`);
  }
  assert.match(text, /Grade B at a glance/);
  assert.match(text, /Table of Benefits · Grade B/, "the second page is his grade's table of benefits");
  assert.match(text, /Shared room/, "his grade's room, from the signed table");
  assert.match(text, /dir="rtl" lang="ar"/, "the signed Arabic is beneath each benefit");
  assert.doesNotMatch(text, /border-radius/, "square corners: the word is not in the paper");
  assert.equal(costLetterFileName({ employeeName: "Test Employee Name" }), "Test-Employee-Name-Medical-Cover-Statement.pdf");
}

/** On his own, the family figure is not printed and the total is his line. */
function testAnEmployeeAlone() {
  const row = { ...familyRow(), employeePays: 385.17, family: [], familyMonthly: 0, lifeInsurance: 85, people: 1 };
  const letter = buildCostLetter(row, POLICY);
  assert.equal(letter.people.length, 1);
  assert.equal(letter.total, 385.17);
  assert.doesNotMatch(renderCostLetterHtml(letter, "21 November 2026"), /Your family, a month/);
}

/** A short figure is refused, never printed. */
function testAShortFigureIsRefused() {
  const unpriced = { ...familyRow(), family: [person({ memberId: "m-x", memberType: "spouse", monthly: null, name: "No Birth Date", unpricedReason: "no date of birth" })] };
  assert.throws(() => buildCostLetter(unpriced, POLICY), /No Birth Date cannot be priced yet \(no date of birth\)/);
  assert.throws(() => buildCostLetter({ ...familyRow(), employeePays: 1000 }, POLICY), /nothing was made/);
  assert.throws(() => buildCostLetter({ ...familyRow(), employee: null }, POLICY), /no one to hand the statement to/);
}

/** The picker lists employees still on the register, by name; a relative whose employee left is not one. */
function testThePickerListsEmployeesByName() {
  const a = { ...familyRow(), employee: person({ memberId: "a", name: "Zeinab" }), key: "a" };
  const b = { ...familyRow(), employee: person({ memberId: "b", name: "Ahmed" }), key: "b" };
  const stray = { ...familyRow(), employee: null, key: "stray" };
  assert.deepEqual(costLetterRows([a, stray, b]).map((row) => row.key), ["b", "a"]);
}

export async function runMedicalInsuranceCostLetterTests() {
  testTheLinesAreTheCostTabsFigures();
  testThePaperNeverShowsTheSplit();
  testAnEmployeeAlone();
  testAShortFigureIsRefused();
  testThePickerListsEmployeesByName();
}
